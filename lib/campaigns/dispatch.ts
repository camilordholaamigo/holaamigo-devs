import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { sendEmail, newMessageId } from '@/lib/email/sendgrid';
import { renderEmail } from '@/lib/email/render';
import { pickMailbox, recordSend, type Mailbox } from '@/lib/email/mailboxes';
import { trackedUrlFor, type Asset } from '@/lib/assets/links';
import { balance, debit } from '@/lib/credits';
import { LOW_BALANCE_CREDITS } from '@/config/credits';
import { pushFeedItem } from '@/lib/feed/items';
import { pauseCampaign } from '@/lib/campaigns/activate';
import type { SequenceStep } from '@/lib/campaigns/activate';

/**
 * El despachador: lo único en todo el sistema que le manda un correo a un
 * tercero humano.
 *
 * Cinco cosas se verifican por CADA correo, aunque la campaña esté aprobada.
 * Una aprobación autoriza el gasto; no autoriza saltarse ninguna de estas:
 *
 *   1. El contacto no está en la lista de supresión global.
 *   2. El contacto no respondió ya — quien contestó sale de la secuencia.
 *   3. Hay una bandeja con cupo hoy (tope duro + calentamiento).
 *   4. Hay saldo de créditos.
 *   5. La campaña sigue activa.
 *
 * Ver docs/wiki/10-correo-y-bandejas.md
 */

const BATCH = 60;

export interface DispatchReport {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  reasons: Record<string, number>;
}

export async function dispatchDue(now = new Date()): Promise<DispatchReport> {
  const report: DispatchReport = { considered: 0, sent: 0, skipped: 0, failed: 0, reasons: {} };

  const { data: due } = await db()
    .from('messages')
    .select('id, organization_id, campaign_id, lead_id, step_index, scheduled_for, to_address')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now.toISOString())
    .order('scheduled_for')
    .limit(BATCH);

  const rows = due ?? [];
  report.considered = rows.length;
  if (rows.length === 0) return report;

  // Cachés por corrida: sin esto son cuatro consultas por correo.
  const campaigns = new Map<string, CampaignRow>();
  const assets = new Map<string, Asset | null>();
  const balances = new Map<string, number>();
  const mailboxes = new Map<string, Mailbox | null>();

  for (const message of rows) {
    const skip = (reason: string) => {
      report.skipped += 1;
      report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
      return db()
        .from('messages')
        .update({ status: 'skipped', error: reason })
        .eq('id', message.id);
    };

    if (!message.campaign_id || !message.lead_id) {
      await skip('mensaje sin campaña o sin contacto');
      continue;
    }

    // ── 5 · ¿La campaña sigue viva? ────────────────────────────────────────
    let campaign = campaigns.get(message.campaign_id);
    if (!campaign) {
      const { data } = await db()
        .from('campaigns')
        .select('id, organization_id, name, status, sequence, asset_id, playbook, mailbox_ids')
        .eq('id', message.campaign_id)
        .maybeSingle();
      campaign = (data as CampaignRow | null) ?? undefined;
      if (campaign) campaigns.set(message.campaign_id, campaign);
    }
    if (!campaign || campaign.status !== 'active') {
      await skip(`campaña en estado ${campaign?.status ?? 'inexistente'}`);
      continue;
    }

    // ── 2 · ¿Ya contestó? ──────────────────────────────────────────────────
    const { data: lead } = await db()
      .from('leads')
      .select('id, full_name, email, company, title, status')
      .eq('id', message.lead_id)
      .maybeSingle();

    if (!lead?.email) {
      await skip('contacto sin correo');
      continue;
    }
    if (['replied', 'booked', 'qualified', 'suppressed', 'lost'].includes(lead.status)) {
      await skip(`el contacto ya está en ${lead.status}`);
      continue;
    }

    // ── 1 · Supresión global ───────────────────────────────────────────────
    const { data: suppressed } = await db()
      .from('suppressions')
      .select('id')
      .eq('email', lead.email.toLowerCase())
      .limit(1);
    if ((suppressed ?? []).length > 0) {
      await skip('en la lista de supresión');
      await db().from('leads').update({ status: 'suppressed' }).eq('id', lead.id);
      continue;
    }

    // ── 4 · Saldo ──────────────────────────────────────────────────────────
    let orgBalance = balances.get(campaign.organization_id);
    if (orgBalance === undefined) {
      orgBalance = await balance(campaign.organization_id);
      balances.set(campaign.organization_id, orgBalance);
    }
    if (orgBalance <= 0) {
      await skip('sin créditos');
      await notifyNoCredits(campaign);
      continue;
    }

    // ── 3 · Bandeja con cupo ───────────────────────────────────────────────
    const cacheKey = `${campaign.organization_id}:${campaign.id}`;
    let mailbox = mailboxes.get(cacheKey);
    if (mailbox === undefined) {
      mailbox = await pickMailbox(campaign.organization_id, campaign.mailbox_ids ?? []);
    }
    if (!mailbox) {
      // No es un fallo: es el tope funcionando. El correo se queda programado
      // y sale mañana. Por eso NO se marca como skipped.
      report.reasons['sin cupo en las bandejas de hoy'] =
        (report.reasons['sin cupo en las bandejas de hoy'] ?? 0) + 1;
      mailboxes.set(cacheKey, null);
      continue;
    }

    // ── Armar y enviar ─────────────────────────────────────────────────────
    const sequence = (campaign.sequence ?? []) as SequenceStep[];
    const step = sequence[message.step_index];
    if (!step) {
      await skip('el paso ya no existe en la secuencia');
      continue;
    }

    let asset = assets.get(campaign.asset_id ?? '');
    if (asset === undefined && campaign.asset_id) {
      const { data } = await db().from('assets').select('*').eq('id', campaign.asset_id).maybeSingle();
      asset = (data as Asset | null) ?? null;
      assets.set(campaign.asset_id, asset);
    }

    const thread = await ensureThread({
      campaign,
      mailbox,
      leadId: lead.id,
      contactEmail: lead.email,
      subject: step.subject,
      stepIndex: message.step_index,
    });

    const { data: org } = await db()
      .from('organizations')
      .select('name, domain')
      .eq('id', campaign.organization_id)
      .maybeSingle();

    const assetUrl =
      step.include_asset && asset
        ? trackedUrlFor(asset, {
            campaignId: campaign.id,
            leadId: lead.id,
            messageId: message.id,
          })
        : null;

    const rendered = renderEmail(step.body, {
      lead: {
        full_name: lead.full_name,
        email: lead.email,
        company: lead.company,
        title: lead.title,
      },
      sender: {
        name: mailbox.display_name ?? org?.name ?? 'el equipo',
        company: org?.name ?? org?.domain ?? '',
        signatureHtml: mailbox.signature_html,
      },
      assetUrl,
      assetLabel: asset?.kind === 'checkout' ? 'Comprar acá' : 'Agenda 30 minutos acá',
      unsubscribeUrl: `${env.siteUrl}/api/baja/${message.id}`,
    });

    const messageIdHeader = newMessageId(mailbox.address.split('@')[1] ?? 'holaamigo.co');

    const result = await sendEmail({
      organizationId: campaign.organization_id,
      from: { email: mailbox.address, name: mailbox.display_name },
      to: lead.email,
      toName: lead.full_name,
      // Los pasos 2+ van como respuesta al mismo hilo: el asunto con "Re:" y el
      // In-Reply-To hacen que caigan en la conversación existente en vez de
      // parecer un correo nuevo de alguien que no se acuerda de haber escrito.
      subject: message.step_index === 0 ? step.subject : `Re: ${thread.subject ?? step.subject}`,
      html: rendered.html,
      text: rendered.text,
      replyTo: mailbox.reply_to ?? mailbox.inbound_address,
      messageIdHeader,
      inReplyTo: message.step_index > 0 ? thread.root_message_id : null,
      customArgs: {
        message_id: message.id,
        campaign_id: campaign.id,
        organization_id: campaign.organization_id,
        mailbox_id: mailbox.id,
      },
      categories: [campaign.playbook ?? 'campaign'],
      unsubscribeUrl: `${env.siteUrl}/api/baja/${message.id}`,
    });

    const credits = result.sent
      ? await debit({
          organizationId: campaign.organization_id,
          action: 'email_send',
          referenceTable: 'messages',
          referenceId: message.id,
          note: campaign.name,
        })
      : 0;

    await db()
      .from('messages')
      .update({
        status: result.sent ? 'sent' : 'failed',
        sent_at: result.sent ? new Date().toISOString() : null,
        external_id: result.externalId,
        mailbox_id: mailbox.id,
        thread_id: thread.id,
        from_address: mailbox.address,
        to_address: lead.email,
        body: rendered.text,
        subject: message.step_index === 0 ? step.subject : `Re: ${thread.subject ?? step.subject}`,
        headers: { 'Message-ID': result.messageIdHeader },
        credits,
        error: result.sent ? null : (result.reason ?? 'fallo de envío'),
      })
      .eq('id', message.id);

    if (result.sent) {
      report.sent += 1;
      balances.set(campaign.organization_id, orgBalance - credits);
      await Promise.all([
        recordSend(mailbox.id),
        db()
          .from('leads')
          .update({ status: 'contacted' })
          .eq('id', lead.id)
          .eq('status', 'new'),
        db()
          .from('email_threads')
          .update({
            last_direction: 'out',
            last_message_at: new Date().toISOString(),
            root_message_id: thread.root_message_id ?? result.messageIdHeader,
            snippet: rendered.text.slice(0, 160),
          })
          .eq('id', thread.id),
        bumpMetric(campaign, { sent: 1, credits }),
      ]);
      // Vuelve a leerse en el siguiente correo: el cupo bajó en uno.
      mailboxes.delete(cacheKey);
    } else {
      report.failed += 1;
    }
  }

  return report;
}

interface CampaignRow {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  sequence: unknown;
  asset_id: string | null;
  playbook: string | null;
  mailbox_ids: string[] | null;
}

interface ThreadRow {
  id: string;
  subject: string | null;
  root_message_id: string | null;
}

async function ensureThread(args: {
  campaign: CampaignRow;
  mailbox: Mailbox;
  leadId: string;
  contactEmail: string;
  subject: string;
  stepIndex: number;
}): Promise<ThreadRow> {
  const { data: existing } = await db()
    .from('email_threads')
    .select('id, subject, root_message_id')
    .eq('organization_id', args.campaign.organization_id)
    .eq('lead_id', args.leadId)
    .eq('campaign_id', args.campaign.id)
    .maybeSingle();

  if (existing) return existing as ThreadRow;

  const { data } = await db()
    .from('email_threads')
    .insert({
      organization_id: args.campaign.organization_id,
      mailbox_id: args.mailbox.id,
      lead_id: args.leadId,
      campaign_id: args.campaign.id,
      subject: args.subject,
      contact_email: args.contactEmail,
      status: 'open',
      last_direction: 'out',
      last_message_at: new Date().toISOString(),
    })
    .select('id, subject, root_message_id')
    .single();

  return data as ThreadRow;
}

/** Rollup diario. Se hace acá y no con una vista porque la observabilidad tiene
 *  que responder rápido con meses de historia. */
export async function bumpMetric(
  campaign: { id: string; organization_id: string },
  delta: Partial<{
    sent: number;
    delivered: number;
    bounced: number;
    opened: number;
    clicked: number;
    replied: number;
    positive: number;
    booked: number;
    orders: number;
    revenue_usd: number;
    credits: number;
  }>,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const { data: existing } = await db()
      .from('campaign_metrics')
      .select('*')
      .eq('campaign_id', campaign.id)
      .eq('day', day)
      .maybeSingle();

    if (!existing) {
      await db()
        .from('campaign_metrics')
        .insert({ campaign_id: campaign.id, organization_id: campaign.organization_id, day, ...delta });
      return;
    }

    const merged: Record<string, number> = {};
    for (const [key, value] of Object.entries(delta)) {
      merged[key] = Number(existing[key] ?? 0) + Number(value ?? 0);
    }
    await db().from('campaign_metrics').update(merged).eq('id', existing.id);
  } catch (err) {
    console.error('[dispatch] no se pudo actualizar la métrica', err);
  }
}

async function notifyNoCredits(campaign: CampaignRow): Promise<void> {
  await pauseCampaign(campaign.id, 'sin créditos');
  await pushFeedItem({
    organizationId: campaign.organization_id,
    kind: 'alert',
    title: 'Se acabaron los créditos y pausé los envíos',
    body: `La campaña "${campaign.name}" se detuvo en el correo que iba a salir. Nada se perdió: los envíos siguen programados y arrancan solos apenas haya saldo.`,
    rationale: `Por debajo de ${LOW_BALANCE_CREDITS} créditos avisamos antes; llegamos a cero.`,
    requires: 'nothing',
    severity: 'high',
    campaignId: campaign.id,
    dedupeKey: `no-credits-${campaign.id}`,
  });
}
