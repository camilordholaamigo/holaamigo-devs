import { db } from '@/lib/supabase/admin';
import { hasOpenAI } from '@/lib/env';
import { runStructured } from '@/lib/ai/client';
import { FeedProposalSchema, type FeedProposal } from '@/lib/ai/schemas';
import { FEED_PROPOSAL_SYSTEM } from '@/config/prompts';
import { PLAYBOOKS, type PlaybookKey } from '@/config/campaigns';
import { LOW_BALANCE_CREDITS, creditsForCampaign } from '@/config/credits';
import { balance } from '@/lib/credits';
import { capacityToday } from '@/lib/email/mailboxes';
import { resolveAudience } from '@/lib/campaigns/segment';
import { evaluateIteration } from '@/lib/campaigns/math';
import { pauseCampaign } from '@/lib/campaigns/activate';
import { pushFeedItem, openCount } from '@/lib/feed/items';
import { ajustesDeEnvio } from '@/lib/feed/adjust';
import { agentIdFor } from '@/lib/agents/contracts';

/**
 * El President habla: digest, propuestas y peticiones (ADR 0012).
 *
 * La regla que gobierna este archivo es **no saturar**. El operador tiene que
 * estar involucrado, no ahogado: si ya hay cosas esperando su decisión, el
 * President se calla y espera. Un feed con doce propuestas abiertas no es más
 * información, es ruido — y el primer día que alguien aprueba sin leer, todo
 * el modelo de "el humano decide" se volvió teatro.
 *
 * Todas las cifras vienen calculadas antes de llamar al modelo. El President
 * redacta; no estima (§13.1, ADR 0007).
 *
 * Ver docs/wiki/13-feed-y-autonomia.md
 */

/** Con esto abierto, el President no propone nada nuevo. */
const MAX_OPEN_ITEMS = 4;

export interface BriefingReport {
  organization_id: string;
  digest: boolean;
  proposals: number;
  asks: number;
  alerts: number;
  skipped_reason?: string;
}

export async function runDailyBriefing(organizationId: string): Promise<BriefingReport> {
  const report: BriefingReport = {
    organization_id: organizationId,
    digest: false,
    proposals: 0,
    asks: 0,
    alerts: 0,
  };

  const yesterday = await yesterdayNumbers(organizationId);

  // ── 1 · El resumen. Siempre, aunque no haya nada que proponer ──────────
  if (yesterday.sent > 0 || yesterday.replied > 0 || yesterday.booked > 0) {
    const digest = await pushFeedItem({
      organizationId,
      kind: 'digest',
      title: `Ayer: ${yesterday.sent} correos, ${yesterday.replied} respuestas, ${yesterday.booked} citas`,
      body: buildDigestBody(yesterday),
      evidence: yesterday as unknown as Record<string, unknown>,
      requires: 'nothing',
      severity: 'low',
      dedupeKey: `digest-${new Date().toISOString().slice(0, 10)}`,
    });
    report.digest = Boolean(digest);
  }

  // ── 2 · Reglas de iteración: ¿alguna campaña se salió de rango? ────────
  report.alerts += await checkIterationRules(organizationId);

  // ── 3 · Saldo bajo ─────────────────────────────────────────────────────
  const credits = await balance(organizationId);
  if (credits < LOW_BALANCE_CREDITS) {
    const alert = await pushFeedItem({
      organizationId,
      kind: 'alert',
      title: `Te quedan ${credits} créditos`,
      body: `Con eso alcanzan unos ${credits} correos más. Cuando llegue a cero los envíos se pausan solos y no se pierde nada, pero la secuencia se enfría.`,
      evidence: { saldo: credits, umbral: LOW_BALANCE_CREDITS },
      requires: 'nothing',
      severity: credits <= 0 ? 'high' : 'normal',
      dedupeKey: `low-balance-${new Date().toISOString().slice(0, 10)}`,
    });
    if (alert) report.alerts += 1;
  }

  // ── 4 · ¿Hay espacio en la cabeza del operador? ────────────────────────
  const open = await openCount(organizationId);
  if (open >= MAX_OPEN_ITEMS) {
    report.skipped_reason = `${open} decisiones abiertas: no proponemos más hasta que baje`;
    return report;
  }

  // ── 5 · La propuesta de envío de mañana ────────────────────────────────
  const proposal = await proposeNextSend(organizationId, { credits, yesterday });
  if (proposal) report.proposals += 1;

  // ── 6 · Lo que necesitamos del humano ──────────────────────────────────
  const ask = await askForAssets(organizationId);
  if (ask) report.asks += 1;

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════

interface DayNumbers {
  sent: number;
  delivered: number;
  replied: number;
  positive: number;
  booked: number;
  orders: number;
  revenue_usd: number;
  credits: number;
  top_campaign: string | null;
}

async function yesterdayNumbers(organizationId: string): Promise<DayNumbers> {
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const [{ data: metrics }, { data: bookings }] = await Promise.all([
    db()
      .from('campaign_metrics')
      .select('sent, delivered, replied, positive, booked, orders, revenue_usd, credits, campaign_id')
      .eq('organization_id', organizationId)
      .eq('day', day),
    db()
      .from('bookings')
      .select('id')
      .eq('organization_id', organizationId)
      .gte('created_at', `${day}T00:00:00Z`)
      .lt('created_at', `${day}T23:59:59Z`),
  ]);

  const rows = metrics ?? [];
  const sum = (key: keyof (typeof rows)[number]) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

  const top = [...rows].sort((a, b) => Number(b.sent ?? 0) - Number(a.sent ?? 0))[0];
  let topName: string | null = null;
  if (top?.campaign_id) {
    const { data } = await db().from('campaigns').select('name').eq('id', top.campaign_id).maybeSingle();
    topName = data?.name ?? null;
  }

  return {
    sent: sum('sent'),
    delivered: sum('delivered'),
    replied: sum('replied'),
    positive: sum('positive'),
    booked: Math.max(sum('booked'), (bookings ?? []).length),
    orders: sum('orders'),
    revenue_usd: sum('revenue_usd'),
    credits: sum('credits'),
    top_campaign: topName,
  };
}

function buildDigestBody(n: DayNumbers): string {
  const replyRate = n.delivered > 0 ? Math.round((n.replied / n.delivered) * 1000) / 10 : 0;
  const parts = [
    `Salieron ${n.sent} correos${n.top_campaign ? ` (la mayoría de "${n.top_campaign}")` : ''} y contestaron ${n.replied}: ${replyRate}%.`,
  ];
  if (n.positive > 0) parts.push(`${n.positive} respuestas con intención real.`);
  if (n.booked > 0) parts.push(`${n.booked} citas quedaron en la agenda.`);
  if (n.orders > 0) parts.push(`${n.orders} compras por el link, ${Math.round(n.revenue_usd)} USD.`);
  parts.push(`Se gastaron ${n.credits} créditos.`);
  return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════

async function checkIterationRules(organizationId: string): Promise<number> {
  const { data: campaigns } = await db()
    .from('campaigns')
    .select('id, name, playbook, started_at, iteration')
    .eq('organization_id', organizationId)
    .eq('status', 'active');

  let alerts = 0;

  for (const campaign of campaigns ?? []) {
    const playbook = PLAYBOOKS[campaign.playbook as PlaybookKey];
    if (!playbook) continue;

    const { data: metrics } = await db()
      .from('campaign_metrics')
      .select('sent, delivered, bounced, opened, replied, positive, booked')
      .eq('campaign_id', campaign.id);

    const rows = metrics ?? [];
    if (rows.length === 0) continue;

    const sum = (key: keyof (typeof rows)[number]) =>
      rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

    const daysRunning = campaign.started_at
      ? Math.floor((Date.now() - new Date(campaign.started_at).getTime()) / 86_400_000)
      : 0;

    const verdicts = evaluateIteration(playbook, {
      sent: sum('sent'),
      delivered: sum('delivered'),
      bounced: sum('bounced'),
      opened: sum('opened'),
      replied: sum('replied'),
      positive: sum('positive'),
      booked: sum('booked'),
      complaints: 0,
      days_running: daysRunning,
    });

    for (const verdict of verdicts.filter((v) => v.fired)) {
      if (verdict.auto_pause) await pauseCampaign(campaign.id, verdict.rule);

      const item = await pushFeedItem({
        organizationId,
        kind: 'alert',
        title: verdict.auto_pause
          ? `Pausé "${campaign.name}": ${verdict.rule}`
          : `"${campaign.name}" necesita un ajuste`,
        body: `${verdict.action}\n\nLo que observamos: ${verdict.observed}.`,
        rationale: `Regla de iteración del playbook: ${verdict.rule}.`,
        evidence: { regla: verdict.rule, observado: verdict.observed, dias: daysRunning },
        requires: 'nothing',
        severity: verdict.auto_pause ? 'high' : 'normal',
        campaignId: campaign.id,
        // Una alerta por regla por campaña por día. Sin esto el cron de la
        // mañana repite la misma alerta hasta que alguien la arregle.
        dedupeKey: `iteration-${campaign.id}-${slug(verdict.rule)}-${new Date().toISOString().slice(0, 10)}`,
      });
      if (item) alerts += 1;
    }
  }

  return alerts;
}

// ═══════════════════════════════════════════════════════════════════════════

async function proposeNextSend(
  organizationId: string,
  context: { credits: number; yesterday: DayNumbers },
): Promise<boolean> {
  // Campañas aprobadas por el cliente que todavía tienen gente sin tocar.
  const { data: campaigns } = await db()
    .from('campaigns')
    .select('id, name, playbook, status, segment_rules, audience_size, expected')
    .eq('organization_id', organizationId)
    .in('status', ['proposed', 'draft'])
    .order('created_at', { ascending: false })
    .limit(1);

  const campaign = (campaigns ?? [])[0];
  if (!campaign) return false;

  const playbook = PLAYBOOKS[campaign.playbook as PlaybookKey];
  if (!playbook) return false;

  const audience = await resolveAudience({
    organizationId,
    rules: campaign.segment_rules,
    limit: 1,
  });
  if (audience.total === 0) return false;

  const { capacity, mailboxes } = await capacityToday(organizationId);
  if (mailboxes === 0) return false;

  // Se propone lo que REALMENTE cabe hoy. Proponer 2.000 envíos cuando las
  // bandejas aguantan 180 es pedir permiso para algo que no va a pasar.
  const sendToday = Math.min(audience.total, capacity);
  const creditsNeeded = creditsForCampaign({
    audience: sendToday,
    steps: playbook.steps.length,
    expectedReplyRate: playbook.benchmarks.reply_rate,
  });

  const expectedReplies = Math.round(sendToday * playbook.benchmarks.deliverability * playbook.benchmarks.reply_rate);
  const expectedBookings = Math.round(
    expectedReplies * playbook.benchmarks.positive_share * playbook.benchmarks.booking_from_positive,
  );

  const evidence = {
    campana: campaign.name,
    segmento: playbook.name,
    contactos_disponibles: audience.total,
    envios_que_caben_hoy: sendToday,
    bandejas_con_cupo: mailboxes,
    creditos_estimados: creditsNeeded,
    saldo_actual: context.credits,
    saldo_despues: context.credits - creditsNeeded,
    respuestas_esperadas: expectedReplies,
    citas_esperadas: expectedBookings,
    ayer_enviamos: context.yesterday.sent,
    ayer_contestaron: context.yesterday.replied,
  };

  const written = await writeProposal({ organizationId, playbook: playbook.name, evidence });

  const item = await pushFeedItem({
    organizationId,
    kind: 'proposal',
    role: 'president',
    title: written.title,
    body: written.body,
    rationale: written.rationale,
    evidence,
    requires: 'approval',
    campaignId: campaign.id,
    severity: 'normal',
    payload: {
      campaign_id: campaign.id,
      send_today: sendToday,
      credits: creditsNeeded,
      // "Ajustar" nunca abre una caja de texto (P3): la propuesta declara qué
      // se puede mover y la pantalla lo pinta. Cuando el cliente quiere aprobar
      // *pero no así*, mueve un número en vez de escribir un párrafo que
      // después alguien tiene que interpretar.
      ajustes_disponibles: ajustesDeEnvio({
        sendToday,
        pasos: playbook.steps.map((step) => ({ purpose: step.purpose })),
      }),
    },
    dedupeKey: `send-proposal-${campaign.id}-${new Date().toISOString().slice(0, 10)}`,
    approval: {
      kind: 'campaign_launch',
      if_approved: written.if_approved,
      if_rejected: written.if_rejected,
      payload: { campaign_id: campaign.id },
    },
  });

  return Boolean(item);
}

const FALLBACK_PROPOSAL = (playbook: string, e: Record<string, unknown>): FeedProposal => ({
  title: `¿Arrancamos ${playbook.toLowerCase()} con ${e.envios_que_caben_hoy} contactos?`,
  body: `Hay ${e.contactos_disponibles} personas en el segmento y hoy caben ${e.envios_que_caben_hoy} envíos por los topes de las bandejas. Cuesta ${e.creditos_estimados} créditos y te quedarían ${e.saldo_despues}. Esperamos ${e.respuestas_esperadas} respuestas y ${e.citas_esperadas} citas.`,
  rationale: 'Es la audiencia más barata de convertir que tienes disponible ahora.',
  if_approved: 'Los primeros correos salen hoy y el resto se reparte en los próximos días.',
  if_rejected: 'No pasa nada: la campaña se queda guardada y te propongo otra cosa mañana.',
});

async function writeProposal(args: {
  organizationId: string;
  playbook: string;
  evidence: Record<string, unknown>;
}): Promise<FeedProposal> {
  if (!hasOpenAI()) return FALLBACK_PROPOSAL(args.playbook, args.evidence);

  try {
    const agentId = await agentIdFor(args.organizationId, 'president');
    const result = await runStructured({
      step: 'angles',
      schemaName: 'feed_proposal',
      schema: FeedProposalSchema,
      system: FEED_PROPOSAL_SYSTEM,
      input: [
        `CAMPAÑA: ${args.playbook}`,
        'CIFRAS YA CALCULADAS (no las cambies, no agregues otras):',
        JSON.stringify(args.evidence, null, 2),
      ].join('\n'),
      organizationId: args.organizationId,
      agentId,
      role: 'president',
      trigger: 'cron',
    });
    return result.data;
  } catch (err) {
    console.error('[president] no pudo redactar la propuesta', err);
    return FALLBACK_PROPOSAL(args.playbook, args.evidence);
  }
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que el sistema NO puede producir solo: la cara del fundador, un dato del
 * negocio, una foto del producto. Se pide una vez y no se vuelve a pedir hasta
 * que responda o lo descarte.
 */
async function askForAssets(organizationId: string): Promise<boolean> {
  const { data: campaigns } = await db()
    .from('campaigns')
    .select('id, name, playbook, status')
    .eq('organization_id', organizationId)
    .in('status', ['proposed', 'scheduled', 'active']);

  for (const campaign of campaigns ?? []) {
    const playbook = PLAYBOOKS[campaign.playbook as PlaybookKey];
    const ask = playbook?.requires_human_input;
    if (!ask) continue;

    const { data: existing } = await db()
      .from('feed_items')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('campaign_id', campaign.id)
      .eq('kind', 'ask')
      .limit(1);

    if ((existing ?? []).length > 0) continue;

    const item = await pushFeedItem({
      organizationId,
      kind: 'ask',
      role: 'cmo',
      title: `Necesito algo tuyo para "${campaign.name}"`,
      body: ask.ask,
      rationale:
        'Esto no lo podemos producir nosotros y sin eso la campaña rinde bastante menos. Es lo único que te pedimos.',
      evidence: { campana: campaign.name, tipo: ask.kind },
      requires: 'input',
      inputKind: ask.kind,
      campaignId: campaign.id,
      payload: { campaign_id: campaign.id },
    });

    if (item) return true;
  }

  return false;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}
