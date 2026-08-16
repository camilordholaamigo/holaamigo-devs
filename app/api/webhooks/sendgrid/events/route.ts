import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import {
  verifyEventSignature,
  statusForEvent,
  type SendGridEvent,
} from '@/lib/email/sendgrid';
import { bumpMetric } from '@/lib/campaigns/dispatch';
import { refreshMailboxHealth } from '@/lib/email/mailboxes';

/**
 * POST /api/webhooks/sendgrid/events — entregas, rebotes, aperturas y quejas.
 *
 * La firma se verifica SIEMPRE en producción. Sin eso, cualquiera que conozca
 * la URL puede meter contactos a la lista de supresión reportando rebotes
 * falsos, o marcar como entregado algo que nunca salió — que es peor, porque
 * envenena las métricas con las que el President propone.
 *
 * Rebote duro y queja de spam entran a `suppressions` en el acto. Es la
 * mitigación de PRD §10 y lo único que protege la reputación del dominio.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  const payload = await request.text();

  const verified = verifyEventSignature({
    publicKeyBase64: env.sendgridWebhookPublicKey,
    payload,
    signature: request.headers.get('x-twilio-email-event-webhook-signature'),
    timestamp: request.headers.get('x-twilio-email-event-webhook-timestamp'),
  });

  if (!verified && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Firma inválida' }, { status: 401 });
  }

  let events: SendGridEvent[];
  try {
    events = JSON.parse(payload) as SendGridEvent[];
  } catch {
    return NextResponse.json({ error: 'json inválido' }, { status: 400 });
  }

  const touchedMailboxes = new Set<string>();
  let processed = 0;

  for (const event of Array.isArray(events) ? events : []) {
    try {
      const status = statusForEvent(event.event);
      const email = (event.email ?? '').toLowerCase();

      // `message_id` vuelve porque lo mandamos en custom_args. Es la llave
      // directa; `sg_message_id` es el respaldo cuando falta.
      if (event.message_id && status) {
        await db().from('messages').update({ status }).eq('id', event.message_id);
      } else if (event.sg_message_id && status) {
        const external = event.sg_message_id.split('.')[0];
        await db().from('messages').update({ status }).eq('external_id', external);
      }

      if (event.mailbox_id) touchedMailboxes.add(event.mailbox_id);

      if (event.campaign_id && event.organization_id) {
        const target = { id: event.campaign_id, organization_id: event.organization_id };
        if (event.event === 'delivered') await bumpMetric(target, { delivered: 1 });
        if (event.event === 'open') await bumpMetric(target, { opened: 1 });
        if (event.event === 'click') await bumpMetric(target, { clicked: 1 });
        if (event.event === 'bounce' || event.event === 'blocked') {
          await bumpMetric(target, { bounced: 1 });
        }
      }

      // `blocked` y `deferred` son transitorios: el servidor del otro lado dijo
      // "ahora no". Suprimir por eso sería quemar un contacto bueno.
      const hardBounce = event.event === 'bounce' && event.type !== 'blocked';
      const complaint = event.event === 'spamreport';

      if (email && (hardBounce || complaint)) {
        const { data: lead } = await db()
          .from('leads')
          .select('id, organization_id')
          .eq('email', email)
          .limit(1)
          .maybeSingle();

        await db().from('suppressions').insert({
          organization_id: lead?.organization_id ?? event.organization_id ?? null,
          email,
          reason: complaint ? 'complaint' : 'bounce',
          source: 'sendgrid_webhook',
        });

        if (lead) {
          await db().from('leads').update({ status: 'suppressed' }).eq('id', lead.id);
        }
      }

      processed += 1;
    } catch (err) {
      console.error('[webhook/sendgrid] evento fallido', err);
    }
  }

  // La salud de la bandeja se recalcula después de procesar el lote: cada
  // rebote individual no dice nada, la tasa sobre los últimos 500 sí.
  for (const mailboxId of touchedMailboxes) {
    await refreshMailboxHealth(mailboxId);
  }

  return NextResponse.json({ received: true, processed });
}
