import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { track } from '@/lib/events';
import { refreshScore } from '@/lib/scoring';
import { alertSlack } from '@/lib/notify';
import { env } from '@/lib/env';

/**
 * POST /api/channels/connect — conexión de canal (PRD §4.5).
 *
 * HONESTIDAD DE ALCANCE: el OAuth de Meta y el de Google/Microsoft NO están
 * implementados. Esta ruta registra la INTENCIÓN de conectar, deja el canal en
 * `pending`, y dispara una alerta para que un humano complete la provisión.
 *
 * Es exactamente lo que manda el Principio §13.3: nada se automatiza antes de
 * haberse hecho tres veces a mano. Con 5 clientes fundadores, provisionar un
 * número de WhatsApp a mano toma 20 minutos y nos enseña qué automatizar. Un
 * OAuth de Meta a medio construir toma tres días y nos enseña nada.
 *
 * QUÉ CAMBIÓ CON P7: lo que ya NO es manual es armar el agente. Antes esta
 * alerta decía "alguien quiere WhatsApp, averigüen qué vende"; ahora dice
 * "alguien quiere WhatsApp, su agente ya está armado y probado, solo falta el
 * número". El `meta` trae el teléfono y quién atiende, que son las dos
 * preguntas que el operador iba a mandar por correo mañana.
 *
 * El `skip` es visible y no penaliza (§13.5): lleva directo a carga de leads,
 * que es el camino de menor fricción y mayor valor inmediato.
 */

export const runtime = 'nodejs';

const Body = z.object({
  organizationId: z.string().uuid(),
  sessionId: z.string().uuid().nullish(),
  channel: z.enum(['whatsapp', 'email_inbox', 'email_outbound']),
  action: z.enum(['request', 'skip']),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  const { organizationId, sessionId, channel, action, meta } = parsed.data;

  try {
    if (action === 'skip') {
      await track('channel_skipped', {
        organizationId,
        sessionId,
        props: { channel },
      });
      return NextResponse.json({ ok: true, next: `/leads/${organizationId}` });
    }

    await db()
      .from('channel_connections')
      .upsert(
        {
          organization_id: organizationId,
          channel,
          status: 'pending',
          provider: channel === 'whatsapp' ? 'meta' : 'google',
          meta: meta ?? {},
        },
        { onConflict: 'organization_id,channel' },
      );

    await db()
      .from('intake_sessions')
      .update({ status: 'connected' })
      .eq('organization_id', organizationId)
      .in('status', ['diagnosed', 'quiz']);

    await track('channel_connected', {
      organizationId,
      sessionId,
      props: { channel, status: 'pending' },
    });

    await refreshScore(organizationId);

    if (channel === 'whatsapp') {
      await track('whatsapp_number_requested', {
        organizationId,
        sessionId,
        props: { tipo_de_numero: meta?.tipo_de_numero ?? null },
      });
    }

    const [{ data: org }, { data: playbook }] = await Promise.all([
      db()
        .from('organizations')
        .select('name, domain, owner_email')
        .eq('id', organizationId)
        .maybeSingle(),
      db()
        .from('agent_playbooks')
        .select('version, cobertura')
        .eq('organization_id', organizationId)
        .eq('is_current', true)
        .maybeSingle(),
    ]);

    const cobertura = (playbook?.cobertura ?? {}) as { porcentaje?: number };

    await alertSlack({
      title: `Solicitud de canal · ${channel}`,
      lines: [
        `*Empresa:* ${org?.name ?? org?.domain ?? organizationId}`,
        `*Contacto:* ${org?.owner_email ?? '—'}`,
        ...(channel === 'whatsapp'
          ? [
              `*Número:* ${meta?.telefono ?? 'no lo dio — hay que conseguirle uno'}`,
              `*Tipo:* ${meta?.tipo_de_numero === 'nuevo' ? 'necesita número nuevo' : 'ya es suyo'}`,
              `*Atiende las citas:* ${meta?.quien_atiende ?? '—'}`,
              playbook
                ? `*Agente:* guion v${playbook.version} listo · ${cobertura.porcentaje ?? 0}% con fuente`
                : '*Agente:* SIN PLAYBOOK. Revisar por qué no se compiló antes de provisionar.',
              '*Siguiente paso manual:* verificar número con Meta y enviar plantillas a aprobación. El agente ya está armado.',
            ]
          : ['*Siguiente paso manual:* conectar el buzón de recepción.']),
      ],
      url: `${env.siteUrl}/admin/prospects/${organizationId}`,
    });

    return NextResponse.json({
      ok: true,
      status: 'pending',
      message:
        channel === 'whatsapp'
          ? 'Recibimos la solicitud. Te escribimos hoy mismo para verificar el número con Meta. Tu agente ya está armado: el día que Meta apruebe, empieza a contestar.'
          : 'Recibimos la solicitud. Te escribimos hoy mismo para conectar el buzón.',
      next: channel === 'whatsapp' ? `/agente/${organizationId}` : `/leads/${organizationId}`,
    });
  } catch (err) {
    console.error('[channels/connect] fallo', err);
    return NextResponse.json({ error: 'No pudimos registrar la conexión.' }, { status: 500 });
  }
}
