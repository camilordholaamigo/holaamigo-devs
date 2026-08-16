import { db } from '@/lib/supabase/admin';
import { PLAYBOOKS, type PlaybookKey } from '@/config/campaigns';
import { resolveAudience } from '@/lib/campaigns/segment';
import { capacityToday, listMailboxes } from '@/lib/email/mailboxes';
import { measurementSchedule } from '@/lib/campaigns/math';
import { authorize } from '@/lib/governance/authorize';
import { explicarVeredicto } from '@/lib/governance/types';
import { track } from '@/lib/events';

/**
 * Activar una campaña: pasar del plan a envíos programados.
 *
 * Acá se MATERIALIZA la cola completa: una fila en `messages` por contacto y
 * por paso, con `scheduled_for` real. Podríamos generarla paso a paso el día
 * que toque y ahorrar filas, pero entonces "qué está programado para esta
 * semana" no se podría contestar con una consulta — y esa pregunta es la mitad
 * de la observabilidad que el operador necesita (§14).
 *
 * El cuerpo del correo NO se guarda acá: se renderiza en el despachador con
 * los datos del contacto. Guardarlo ahora congelaría el copy y haría inútil
 * cualquier iteración sobre una campaña ya lanzada.
 */

export interface SequenceStep {
  day_offset: number;
  purpose: string;
  subject: string;
  body: string;
  include_asset: boolean;
}

/** Segundos entre un envío y el siguiente. 500 correos saliendo en el mismo
 *  minuto es el patrón que los filtros marcan primero; repartidos a uno cada
 *  45 segundos parecen una persona trabajando. */
const SECONDS_BETWEEN_SENDS = 45;

export async function activateCampaign(args: {
  campaignId: string;
  approvedBy: string;
  approvalId?: string | null;
  feedItemId?: string | null;
}): Promise<{ ok: boolean; summary: string; scheduled: number }> {
  const { data: campaign } = await db()
    .from('campaigns')
    .select('*')
    .eq('id', args.campaignId)
    .maybeSingle();

  if (!campaign) return { ok: false, summary: 'La campaña ya no existe.', scheduled: 0 };
  if (['active', 'done'].includes(campaign.status)) {
    return { ok: false, summary: 'Ya estaba corriendo.', scheduled: 0 };
  }

  const playbook = PLAYBOOKS[campaign.playbook as PlaybookKey];
  const sequence = (campaign.sequence ?? []) as SequenceStep[];
  if (sequence.length === 0) {
    return { ok: false, summary: 'La campaña no tiene secuencia. No se puede activar.', scheduled: 0 };
  }

  const mailboxes = await listMailboxes(campaign.organization_id);
  const usable = mailboxes.filter((m) => m.purpose !== 'inbound' && m.status !== 'blocked');
  if (usable.length === 0) {
    return {
      ok: false,
      summary: 'No hay bandejas configuradas. Conecta al menos una antes de lanzar.',
      scheduled: 0,
    };
  }

  // El calentamiento no es negociable ni con la campaña aprobada. Si el
  // playbook exige dominios calientes y las bandejas llevan menos de dos
  // semanas, esto no arranca: prometer 24 horas en frío quema el dominio y no
  // se recupera (PRD §4.6).
  if (playbook?.requires_warmup) {
    const coldest = usable.filter((m) => {
      if (!m.warmup_started_at) return true;
      const days = (Date.now() - new Date(m.warmup_started_at).getTime()) / 86_400_000;
      return days < 14;
    });
    if (coldest.length === usable.length) {
      return {
        ok: false,
        summary:
          'Esta campaña es en frío y las bandejas todavía se están calentando. Faltan días de warmup antes de poder enviar.',
        scheduled: 0,
      };
    }
  }

  const audience = await resolveAudience({
    organizationId: campaign.organization_id,
    rules: campaign.segment_rules,
  });

  if (audience.leads.length === 0) {
    return {
      ok: false,
      summary: `Sin audiencia: ${audience.excluded.suppressed} suprimidos, ${audience.excluded.already_scheduled} ya tienen otro envío programado.`,
      scheduled: 0,
    };
  }

  // ── La correa (P2) ───────────────────────────────────────────────────────
  //
  // Va DESPUÉS de resolver la audiencia porque el sobre se mide en volumen y
  // hasta acá no sabemos cuánta gente hay. Y va antes de escribir una sola fila
  // en `messages`: una campaña a medio programar es peor que una no programada.
  //
  // `approvalId` es lo que evita la segunda tarjeta: quien llega hasta acá casi
  // siempre viene de que un humano aprobó en el feed, y volver a preguntarle lo
  // que acaba de responder es la forma más rápida de que deje de responder.
  const auth = await authorize({
    organizationId: campaign.organization_id,
    capabilityId: 'campaign.launch',
    approvalId: args.approvalId ?? null,
    title: `Lanzar «${campaign.name}» a ${audience.leads.length} contactos`,
    payload: {
      volume: audience.leads.length,
      // Una campaña lanzada no se deshace: los correos ya enviados no vuelven.
      // Por eso declara su irreversibilidad en runtime en vez de heredarla del
      // catálogo — el número real depende de cuánto dura la secuencia.
      reversibility_hours: 72,
      discloses_agent: true,
      campaign_id: campaign.id,
    },
  });

  if (auth.accion_permitida !== 'ejecutar') {
    return {
      ok: false,
      scheduled: 0,
      summary: `No se lanzó. ${explicarVeredicto(auth)}${
        auth.approval_id ? ' Te dejamos la tarjeta en el feed.' : ''
      }`,
    };
  }

  const startsAt = campaign.scheduled_for ? new Date(campaign.scheduled_for) : new Date();
  const rows: Record<string, unknown>[] = [];

  // De qué ángulo sale cada mensaje (P5).
  //
  // Se estampa SOLO si la campaña prueba exactamente un ángulo. Con dos o más,
  // la atribución sería una repartija inventada, y una tasa de respuesta
  // atribuida a medias es peor que ninguna: la fábrica de ángulos retiraría el
  // que funciona por culpa del que no.
  const angleIds = (campaign.angle_ids ?? []) as string[];
  const angleId = angleIds.length === 1 ? angleIds[0] : null;

  sequence.forEach((step, stepIndex) => {
    audience.leads.forEach((lead, leadIndex) => {
      const when = new Date(
        startsAt.getTime() +
          step.day_offset * 86_400_000 +
          leadIndex * SECONDS_BETWEEN_SENDS * 1000,
      );
      rows.push({
        organization_id: campaign.organization_id,
        campaign_id: campaign.id,
        lead_id: lead.id,
        angle_id: angleId,
        channel: 'email',
        direction: 'out',
        status: 'scheduled',
        step_index: stepIndex,
        scheduled_for: when.toISOString(),
        subject: step.subject,
        to_address: lead.email,
      });
    });
  });

  // Insert por lotes: 20.000 filas en un solo insert revienta el límite de
  // PostgREST y deja la campaña a medio programar.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db().from('messages').insert(rows.slice(i, i + 500));
    if (error) {
      console.error('[campaigns] fallo al programar el lote', error);
      break;
    }
  }

  const checkpoints = playbook ? measurementSchedule(playbook, startsAt) : [];

  const actions = sequence.map((step, index) => ({
    organization_id: campaign.organization_id,
    kind: 'campaign_step',
    title: `${campaign.name} · paso ${index + 1}: ${step.purpose}`,
    why:
      index === 0
        ? campaign.hypothesis ?? 'Primer toque de la secuencia.'
        : `Toque ${index + 1}. ${step.purpose}`,
    how_measured:
      checkpoints[index]?.kpi ??
      'Respuestas y citas atribuidas a esta campaña, contra lo proyectado.',
    run_at: new Date(startsAt.getTime() + step.day_offset * 86_400_000).toISOString(),
    campaign_id: campaign.id,
    feed_item_id: args.feedItemId ?? null,
    approval_id: args.approvalId ?? null,
    payload: { step_index: index, audience: audience.leads.length },
  }));

  await db().from('scheduled_actions').insert(actions);

  const startsNow = startsAt.getTime() <= Date.now() + 60_000;
  await db()
    .from('campaigns')
    .update({
      status: startsNow ? 'active' : 'scheduled',
      approved_by: args.approvedBy,
      approved_at: new Date().toISOString(),
      started_at: startsNow ? new Date().toISOString() : null,
      audience_size: audience.leads.length,
      scheduled_for: startsAt.toISOString(),
    })
    .eq('id', campaign.id);

  const { capacity } = await capacityToday(campaign.organization_id, campaign.mailbox_ids ?? []);

  await track('approval_decided', {
    organizationId: campaign.organization_id,
    props: { campaign_id: campaign.id, action: 'activated', audience: audience.leads.length },
  });

  const capacityNote =
    capacity < audience.leads.length
      ? ` Hoy caben ${capacity} envíos por los topes de las bandejas; el resto sale mañana.`
      : '';

  return {
    ok: true,
    scheduled: rows.length,
    summary: `${audience.leads.length} contactos programados en ${sequence.length} pasos.${capacityNote}`,
  };
}

export async function rejectCampaign(campaignId: string, note: string): Promise<void> {
  await db()
    .from('campaigns')
    .update({ status: 'rejected', paused_reason: note })
    .eq('id', campaignId);

  // Los envíos ya programados se cancelan. Una campaña rechazada que sigue
  // mandando correos es la peor forma posible de perder la confianza.
  await db()
    .from('messages')
    .update({ status: 'skipped', error: 'campaña rechazada' })
    .eq('campaign_id', campaignId)
    .eq('status', 'scheduled');

  await db()
    .from('scheduled_actions')
    .update({ status: 'cancelled' })
    .eq('campaign_id', campaignId)
    .eq('status', 'scheduled');
}

export async function pauseCampaign(campaignId: string, reason: string): Promise<void> {
  await db()
    .from('campaigns')
    .update({ status: 'paused', paused_reason: reason })
    .eq('id', campaignId);
}
