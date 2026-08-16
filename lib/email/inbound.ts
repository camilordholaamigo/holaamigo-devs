import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { runStructured } from '@/lib/ai/client';
import { EmailReplyDecisionSchema, type EmailReplyDecision } from '@/lib/ai/schemas';
import { EMAIL_REPLY_SYSTEM } from '@/config/prompts';
import { mailboxByInbound, type Mailbox } from '@/lib/email/mailboxes';
import { sendEmail, newMessageId } from '@/lib/email/sendgrid';
import { renderEmail } from '@/lib/email/render';
import { trackedUrlFor, type Asset } from '@/lib/assets/links';
import { createBooking } from '@/lib/scheduling/bookings';
import { bumpMetric } from '@/lib/campaigns/dispatch';
import { pushFeedItem } from '@/lib/feed/items';
import { alertSlack } from '@/lib/notify';
import { debit } from '@/lib/credits';
import { agentIdFor } from '@/lib/agents/contracts';
import { hasOpenAI } from '@/lib/env';

/**
 * Recepción de respuestas (Inbound Parse de SendGrid).
 *
 * El principio que gobierna todo este archivo: **el agente escala de más, no de
 * menos**. Un escalamiento innecesario cuesta dos minutos de un humano; una
 * respuesta automática a alguien que estaba pidiendo hablar con el dueño cuesta
 * el cliente. Ante cualquier duda, `needs_human`.
 *
 * Lo único que el agente SALES puede cerrar solo sin aprobación previa es
 * agendar: no gasta dinero, no promete precio, y es reversible con un correo.
 * Todo lo demás depende de la autonomía configurada por el cliente
 * (docs/wiki/13-feed-y-autonomia.md).
 */

export interface InboundEmail {
  to: string;
  from: string;
  fromName: string | null;
  subject: string;
  text: string;
  html: string | null;
  /** Headers crudos, para sacar In-Reply-To y References. */
  headers: string;
  spamScore: number | null;
}

export interface InboundResult {
  handled: boolean;
  action?: EmailReplyDecision['action'];
  reason?: string;
  threadId?: string;
}

export async function handleInbound(email: InboundEmail): Promise<InboundResult> {
  const mailbox = await mailboxByInbound(cleanAddress(email.to));
  if (!mailbox) {
    // Correo a una dirección que no reconocemos. No es un error nuestro: la
    // Inbound Parse recibe todo el dominio.
    return { handled: false, reason: 'bandeja desconocida' };
  }

  const from = cleanAddress(email.from);
  const thread = await findThread({ mailbox, from, headers: email.headers });

  // Sin hilo no hay contexto y no hay a quién atribuir. Se registra igual para
  // que el operador lo vea en la bandeja: un correo perdido es una venta que
  // nadie sabe que llegó.
  const organizationId = thread?.organization_id ?? mailbox.organization_id;

  const { data: inserted } = await db()
    .from('messages')
    .insert({
      organization_id: organizationId,
      campaign_id: thread?.campaign_id ?? null,
      lead_id: thread?.lead_id ?? null,
      thread_id: thread?.id ?? null,
      mailbox_id: mailbox.id,
      channel: 'email',
      direction: 'in',
      status: 'replied',
      subject: email.subject,
      from_address: from,
      to_address: mailbox.address,
      body: email.text.slice(0, 20_000),
      headers: { raw: email.headers.slice(0, 4000), spam_score: email.spamScore },
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  const decision = await classify({
    organizationId,
    email,
    threadSubject: thread?.subject ?? email.subject,
  });

  // La clasificación se guarda en el mensaje entrante, no solo en el hilo: la
  // bandeja usa `suggested_reply` para dejar el borrador ya escrito en la caja
  // de respuesta, y eso es la diferencia entre ayudar y dejar tarea.
  if (inserted?.id) {
    await db()
      .from('messages')
      .update({ classification: decision, needs_human: decision.needs_human })
      .eq('id', inserted.id);
  }

  const effects = await applyDecision({
    decision,
    thread,
    mailbox,
    organizationId,
    from,
    fromName: email.fromName,
    inboundMessageId: inserted?.id ?? null,
    quoted: email.text,
  });

  if (thread) {
    await db()
      .from('email_threads')
      .update({
        last_direction: 'in',
        last_message_at: new Date().toISOString(),
        snippet: email.text.slice(0, 160),
        intent: decision.intent,
        needs_human: decision.needs_human || decision.action === 'escalate',
        human_reason: decision.needs_human ? decision.reason : null,
        status: statusForIntent(decision.intent, thread.status),
      })
      .eq('id', thread.id);

    await bumpMetric(
      { id: thread.campaign_id ?? '', organization_id: organizationId },
      {
        replied: 1,
        positive: decision.sentiment === 'positive' ? 1 : 0,
        booked: effects.booked ? 1 : 0,
      },
    );
  }

  if (thread?.lead_id) {
    await db()
      .from('leads')
      .update({
        status: effects.booked
          ? 'booked'
          : decision.intent === 'opt_out'
            ? 'suppressed'
            : decision.sentiment === 'positive'
              ? 'qualified'
              : 'replied',
        last_interaction_at: new Date().toISOString(),
      })
      .eq('id', thread.lead_id);
  }

  return { handled: true, action: decision.action, threadId: thread?.id };
}

// ═══════════════════════════════════════════════════════════════════════════

function cleanAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

interface ThreadRow {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  lead_id: string | null;
  subject: string | null;
  status: string;
  root_message_id: string | null;
  mailbox_id: string | null;
}

/**
 * Emparejar la respuesta con su hilo. Dos caminos, en este orden:
 *   1. `In-Reply-To` / `References` contra el Message-ID que nosotros pusimos.
 *      Es exacto y sobrevive a que la persona cambie el asunto.
 *   2. Correo del remitente + bandeja. Es el respaldo cuando el cliente de
 *      correo del contacto no propaga los headers, que pasa más de lo que
 *      debería.
 */
async function findThread(args: {
  mailbox: Mailbox;
  from: string;
  headers: string;
}): Promise<ThreadRow | null> {
  const ids = [...args.headers.matchAll(/<([^<>@\s]+@[^<>\s]+)>/g)].map((m) => `<${m[1]}>`);

  if (ids.length > 0) {
    const { data } = await db()
      .from('email_threads')
      .select('id, organization_id, campaign_id, lead_id, subject, status, root_message_id, mailbox_id')
      .in('root_message_id', ids)
      .limit(1)
      .maybeSingle();
    if (data) return data as ThreadRow;
  }

  const { data } = await db()
    .from('email_threads')
    .select('id, organization_id, campaign_id, lead_id, subject, status, root_message_id, mailbox_id')
    .eq('organization_id', args.mailbox.organization_id)
    .eq('contact_email', args.from)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as ThreadRow | null) ?? null;
}

const SAFE_DEFAULT: EmailReplyDecision = {
  intent: 'other',
  sentiment: 'neutral',
  action: 'escalate',
  needs_human: true,
  reason: 'No pudimos clasificar la respuesta. Entra un humano.',
  suggested_reply: null,
  proposed_time_iso: null,
};

async function classify(args: {
  organizationId: string;
  email: InboundEmail;
  threadSubject: string;
}): Promise<EmailReplyDecision> {
  // Sin IA configurada TODO escala. Es lo correcto: el modo degradado de un
  // sistema que le habla a clientes es "que conteste una persona".
  if (!hasOpenAI()) return SAFE_DEFAULT;

  const agentId = await agentIdFor(args.organizationId, 'sales');

  try {
    const result = await runStructured({
      step: 'classify',
      schemaName: 'email_reply_decision',
      schema: EmailReplyDecisionSchema,
      system: EMAIL_REPLY_SYSTEM,
      input: [
        `ASUNTO DEL HILO: ${args.threadSubject}`,
        `DE: ${args.email.from}`,
        'RESPUESTA:',
        args.email.text.slice(0, 4000),
      ].join('\n'),
      organizationId: args.organizationId,
      agentId,
      role: 'sales',
      trigger: 'inbound',
    });
    await debit({
      organizationId: args.organizationId,
      action: 'ai_classify',
      referenceTable: 'messages',
    });
    return result.data;
  } catch (err) {
    console.error('[inbound] fallo la clasificación, escala', err);
    return SAFE_DEFAULT;
  }
}

function statusForIntent(intent: string, current: string): string {
  if (intent === 'opt_out' || intent === 'not_interested') return 'lost';
  if (intent === 'complaint' || intent === 'legal') return 'lost';
  if (intent === 'out_of_office') return current;
  return 'open';
}

// ═══════════════════════════════════════════════════════════════════════════
// EFECTOS
// ═══════════════════════════════════════════════════════════════════════════

async function applyDecision(args: {
  decision: EmailReplyDecision;
  thread: ThreadRow | null;
  mailbox: Mailbox;
  organizationId: string;
  from: string;
  fromName: string | null;
  inboundMessageId: string | null;
  quoted: string;
}): Promise<{ booked: boolean }> {
  const { decision } = args;

  // ── Se quiere ir: se suprime YA y no se contesta ────────────────────────
  if (decision.action === 'suppress' || decision.intent === 'opt_out') {
    await db().from('suppressions').insert({
      organization_id: args.organizationId,
      email: args.from,
      reason: 'opt_out',
      source: 'email_reply',
    });
    if (args.thread?.lead_id) {
      await db().from('leads').update({ status: 'suppressed' }).eq('id', args.thread.lead_id);
    }
    return { booked: false };
  }

  if (decision.action === 'ignore') return { booked: false };

  // ── Autonomía configurada por el cliente ────────────────────────────────
  const { data: agent } = await db()
    .from('agents')
    .select('autonomy, config, status')
    .eq('organization_id', args.organizationId)
    .eq('role', 'sales')
    .maybeSingle();

  const autonomy = (agent?.autonomy as string) ?? 'propose';
  const config = (agent?.config ?? {}) as { auto_reply?: boolean; auto_book?: boolean };
  const canAutoBook = autonomy !== 'propose' && config.auto_book !== false;
  const canAutoReply = autonomy === 'auto_within_limits' && config.auto_reply !== false;

  // ── Agendar: lo único que el agente cierra solo ─────────────────────────
  if (decision.action === 'book' && !decision.needs_human && canAutoBook) {
    const asset = await schedulerFor(args.organizationId);
    if (asset && decision.proposed_time_iso) {
      const booking = await createBooking({
        asset,
        start: decision.proposed_time_iso,
        contactName: args.fromName ?? args.from,
        contactEmail: args.from,
        source: 'reply',
        leadId: args.thread?.lead_id ?? null,
        campaignId: args.thread?.campaign_id ?? null,
        threadId: args.thread?.id ?? null,
        notes: 'Agendada por el agente desde una respuesta de correo.',
      });

      if (booking.ok && booking.booking) {
        await replyInThread({
          ...args,
          body: `${decision.suggested_reply ?? 'Listo.'}\n\nQuedó para ${booking.booking.human_label}. Te llega la invitación al correo.`,
        });
        return { booked: true };
      }
    }

    // Quiere reunirse pero no dijo cuándo, o el horario ya no estaba: se le
    // manda el link en vez de proponerle una hora que quizá no exista.
    if (asset) {
      const url = trackedUrlFor(asset, {
        campaignId: args.thread?.campaign_id ?? null,
        leadId: args.thread?.lead_id ?? null,
        messageId: args.inboundMessageId,
      });
      await replyInThread({
        ...args,
        body: `${decision.suggested_reply ?? 'Con gusto.'}\n\nEscoge el horario que te sirva acá: ${url}`,
      });
      return { booked: false };
    }
  }

  // ── Contestar dentro de lo permitido ────────────────────────────────────
  if (decision.action === 'reply' && !decision.needs_human && canAutoReply && decision.suggested_reply) {
    await replyInThread({ ...args, body: decision.suggested_reply });
    return { booked: false };
  }

  // ── Todo lo demás: entra un humano ──────────────────────────────────────
  await escalate(args);
  return { booked: false };
}

async function schedulerFor(organizationId: string): Promise<Asset | null> {
  const { data } = await db()
    .from('assets')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('kind', 'scheduler')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  return (data as Asset | null) ?? null;
}

async function replyInThread(args: {
  thread: ThreadRow | null;
  mailbox: Mailbox;
  organizationId: string;
  from: string;
  fromName: string | null;
  body: string;
}): Promise<void> {
  const { data: org } = await db()
    .from('organizations')
    .select('name, domain')
    .eq('id', args.organizationId)
    .maybeSingle();

  const rendered = renderEmail(args.body, {
    lead: { full_name: args.fromName, email: args.from, company: null, title: null },
    sender: {
      name: args.mailbox.display_name ?? org?.name ?? 'el equipo',
      company: org?.name ?? org?.domain ?? '',
      signatureHtml: args.mailbox.signature_html,
    },
    assetUrl: null,
    assetLabel: null,
    unsubscribeUrl: null,
  });

  const subject = args.thread?.subject ? `Re: ${args.thread.subject}` : 'Re:';
  const messageIdHeader = newMessageId(args.mailbox.address.split('@')[1] ?? 'holaamigo.co');

  const result = await sendEmail({
    organizationId: args.organizationId,
    from: { email: args.mailbox.address, name: args.mailbox.display_name },
    to: args.from,
    toName: args.fromName,
    subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: args.mailbox.reply_to ?? args.mailbox.inbound_address,
    messageIdHeader,
    inReplyTo: args.thread?.root_message_id ?? null,
    customArgs: { organization_id: args.organizationId, mailbox_id: args.mailbox.id },
  });

  await db().from('messages').insert({
    organization_id: args.organizationId,
    campaign_id: args.thread?.campaign_id ?? null,
    lead_id: args.thread?.lead_id ?? null,
    thread_id: args.thread?.id ?? null,
    mailbox_id: args.mailbox.id,
    channel: 'email',
    direction: 'out',
    status: result.sent ? 'sent' : 'failed',
    subject,
    from_address: args.mailbox.address,
    to_address: args.from,
    body: rendered.text,
    external_id: result.externalId,
    sent_at: new Date().toISOString(),
    credits: result.sent
      ? await debit({
          organizationId: args.organizationId,
          action: 'email_reply',
          referenceTable: 'email_threads',
          referenceId: args.thread?.id ?? null,
          note: 'respuesta automática del agente',
        })
      : 0,
  });
}

async function escalate(args: {
  decision: EmailReplyDecision;
  thread: ThreadRow | null;
  organizationId: string;
  from: string;
  fromName: string | null;
  quoted: string;
}): Promise<void> {
  const urgent = ['complaint', 'legal'].includes(args.decision.intent);

  await pushFeedItem({
    organizationId: args.organizationId,
    kind: 'alert',
    role: 'sales',
    title: `Respuesta de ${args.fromName ?? args.from}: necesita que entres`,
    body: args.quoted.slice(0, 400),
    rationale: args.decision.reason,
    evidence: {
      intencion: args.decision.intent,
      sentimiento: args.decision.sentiment,
      contacto: args.from,
      borrador_sugerido: args.decision.suggested_reply,
    },
    requires: 'input',
    inputKind: 'respuesta',
    threadId: args.thread?.id ?? null,
    severity: urgent ? 'high' : 'normal',
    payload: { thread_id: args.thread?.id ?? null, contact: args.from },
    dedupeKey: args.thread ? `escalation-${args.thread.id}-${new Date().toISOString().slice(0, 10)}` : null,
  });

  if (urgent) {
    await alertSlack({
      title: `Escalamiento de correo · ${args.decision.intent}`,
      lines: [args.from, args.decision.reason, args.quoted.slice(0, 200)],
      url: `${env.siteUrl}/consola/${args.organizationId}/bandeja`,
      urgent: true,
    });
  }
}
