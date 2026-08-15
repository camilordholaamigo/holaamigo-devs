import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';

/**
 * Webhook de eventos de correo (Resend / proveedor de envío).
 *
 * ALCANCE v1: registra entregas, rebotes y quejas. Los rebotes duros y las
 * quejas de spam entran a la lista de supresión global de inmediato — es la
 * mitigación de §10 y lo que protege la reputación de los dominios.
 *
 * La clasificación de respuestas entrantes de correo llega cuando conectemos
 * el buzón de recepción; hoy la recepción es manual.
 */

export const runtime = 'nodejs';

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string };
  };
}

export async function POST(request: Request) {
  let event: ResendEvent;
  try {
    event = (await request.json()) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'json inválido' }, { status: 400 });
  }

  const type = event.type ?? '';
  const recipients = Array.isArray(event.data?.to)
    ? event.data!.to
    : event.data?.to
      ? [event.data.to]
      : [];
  const email = recipients[0]?.toLowerCase();

  try {
    if (event.data?.email_id) {
      const status = statusFor(type);
      if (status) {
        await db()
          .from('messages')
          .update({ status })
          .eq('external_id', event.data.email_id);
      }
    }

    const isHardBounce =
      type === 'email.bounced' && event.data?.bounce?.type?.toLowerCase() !== 'transient';
    const isComplaint = type === 'email.complained';

    if (email && (isHardBounce || isComplaint)) {
      const { data: lead } = await db()
        .from('leads')
        .select('id, organization_id')
        .eq('email', email)
        .limit(1)
        .maybeSingle();

      await db().from('suppressions').insert({
        organization_id: lead?.organization_id ?? null,
        email,
        reason: isComplaint ? 'complaint' : 'bounce',
        source: 'email_webhook',
      });

      if (lead) {
        await db().from('leads').update({ status: 'suppressed' }).eq('id', lead.id);
      }
    }
  } catch (err) {
    console.error('[webhook/email] fallo', err);
  }

  return NextResponse.json({ received: true });
}

function statusFor(type: string): string | null {
  switch (type) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.opened':
      return 'read';
    case 'email.bounced':
      return 'bounced';
    case 'email.complained':
    case 'email.delivery_delayed':
      return 'failed';
    default:
      return null;
  }
}
