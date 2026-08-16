import { db } from '@/lib/supabase/admin';
import { PLAYBOOKS, type PlaybookKey } from '@/config/campaigns';
import { balance, consumptionByKind } from '@/lib/credits';
import { listMailboxes, remainingToday, warmupCapFor } from '@/lib/email/mailboxes';
import { attributedRevenue } from '@/lib/commerce/orders';

/**
 * Observabilidad: lo que necesita ver alguien que opera Hola Amigo.
 *
 * El criterio de qué entra acá y qué no: **una métrica que no cambia una
 * decisión es ruido**. Por eso no hay gráficas de aperturas por hora ni mapas
 * de calor. Hay cuatro preguntas y sus respuestas:
 *
 *   1. ¿Qué va a pasar y por qué?          → `scheduled`
 *   2. ¿Lo que pasó se parece a lo que dijimos que iba a pasar? → `campaigns`
 *   3. ¿Algo se está rompiendo?            → `health`
 *   4. ¿En qué se está yendo la plata?     → `spend`
 *
 * Ver docs/wiki/14-observabilidad.md
 */

export interface ScheduledView {
  id: string;
  title: string;
  why: string;
  how_measured: string;
  run_at: string;
  status: string;
  campaign_name: string | null;
}

export interface CampaignPerformance {
  id: string;
  name: string;
  playbook: string | null;
  status: string;
  started_at: string | null;
  audience: number;
  /** Lo que dijimos que iba a pasar cuando se aprobó. */
  expected: { replies: number; bookings: number; closes_low: number; closes_high: number };
  /** Lo que pasó. */
  actual: { sent: number; delivered: number; replied: number; positive: number; booked: number; orders: number };
  /** Diferencia en la métrica que importa, en puntos porcentuales. */
  reply_rate_actual: number;
  reply_rate_expected: number;
  credits_spent: number;
  next_checkpoint: { kpi: string; date: string } | null;
}

export interface HealthView {
  mailboxes: {
    address: string;
    status: string;
    used_today: number;
    cap_today: number;
    bounce_rate: number;
    complaint_rate: number;
  }[];
  agent_failures_7d: number;
  degraded_runs_7d: number;
  threads_waiting: number;
}

export interface SpendView {
  credits_balance: number;
  by_kind: { kind: string; credits: number }[];
  ai_cost_usd_30d: number;
  attributed: Awaited<ReturnType<typeof attributedRevenue>>;
}

export interface ObservabilitySummary {
  scheduled: ScheduledView[];
  campaigns: CampaignPerformance[];
  health: HealthView;
  spend: SpendView;
}

export async function observabilityFor(organizationId: string): Promise<ObservabilitySummary> {
  const [scheduled, campaigns, health, spend] = await Promise.all([
    upcoming(organizationId),
    campaignPerformance(organizationId),
    healthFor(organizationId),
    spendFor(organizationId),
  ]);
  return { scheduled, campaigns, health, spend };
}

export async function upcoming(organizationId: string, limit = 25): Promise<ScheduledView[]> {
  const { data } = await db()
    .from('scheduled_actions')
    .select('id, title, why, how_measured, run_at, status, campaign_id')
    .eq('organization_id', organizationId)
    .in('status', ['scheduled', 'running'])
    .order('run_at')
    .limit(limit);

  const rows = data ?? [];
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))] as string[];

  const names = new Map<string, string>();
  if (campaignIds.length > 0) {
    const { data: campaigns } = await db().from('campaigns').select('id, name').in('id', campaignIds);
    for (const campaign of campaigns ?? []) names.set(campaign.id, campaign.name ?? '');
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    why: row.why,
    how_measured: row.how_measured,
    run_at: row.run_at,
    status: row.status,
    campaign_name: row.campaign_id ? (names.get(row.campaign_id) ?? null) : null,
  }));
}

export async function campaignPerformance(organizationId: string): Promise<CampaignPerformance[]> {
  const { data: campaigns } = await db()
    .from('campaigns')
    .select('id, name, playbook, status, started_at, audience_size, expected, measurement')
    .eq('organization_id', organizationId)
    .in('status', ['scheduled', 'active', 'paused', 'done'])
    .order('created_at', { ascending: false })
    .limit(20);

  const result: CampaignPerformance[] = [];

  for (const campaign of campaigns ?? []) {
    const { data: metrics } = await db()
      .from('campaign_metrics')
      .select('sent, delivered, replied, positive, booked, orders, credits')
      .eq('campaign_id', campaign.id);

    const rows = metrics ?? [];
    const sum = (key: keyof (typeof rows)[number]) =>
      rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

    const expected = (campaign.expected ?? {}) as {
      replies?: number;
      bookings?: number;
      range?: { low: number; high: number };
      benchmarks?: { reply_rate?: number };
    };
    const playbook = PLAYBOOKS[campaign.playbook as PlaybookKey];

    const delivered = sum('delivered');
    const replied = sum('replied');

    const points = ((campaign.measurement ?? {}) as { points?: { kpi: string; iso: string; date: string }[] })
      .points ?? [];
    const next = points.find((point) => new Date(point.iso).getTime() > Date.now());

    result.push({
      id: campaign.id,
      name: campaign.name ?? 'sin nombre',
      playbook: campaign.playbook,
      status: campaign.status,
      started_at: campaign.started_at,
      audience: campaign.audience_size ?? 0,
      expected: {
        replies: expected.replies ?? 0,
        bookings: expected.bookings ?? 0,
        closes_low: expected.range?.low ?? 0,
        closes_high: expected.range?.high ?? 0,
      },
      actual: {
        sent: sum('sent'),
        delivered,
        replied,
        positive: sum('positive'),
        booked: sum('booked'),
        orders: sum('orders'),
      },
      reply_rate_actual: delivered > 0 ? Math.round((replied / delivered) * 1000) / 10 : 0,
      reply_rate_expected:
        Math.round(
          (expected.benchmarks?.reply_rate ?? playbook?.benchmarks.reply_rate ?? 0) * 1000,
        ) / 10,
      credits_spent: sum('credits'),
      next_checkpoint: next ? { kpi: next.kpi, date: next.date } : null,
    });
  }

  return result;
}

export async function healthFor(organizationId: string): Promise<HealthView> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [mailboxes, { data: runs }, { count: waiting }] = await Promise.all([
    listMailboxes(organizationId),
    db()
      .from('agent_runs')
      .select('status')
      .eq('organization_id', organizationId)
      .gte('created_at', since)
      .limit(2000),
    db()
      .from('email_threads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('needs_human', true),
  ]);

  const runRows = runs ?? [];

  return {
    mailboxes: mailboxes.map((mailbox) => ({
      address: mailbox.address,
      status: mailbox.status,
      used_today:
        mailbox.sent_today_date === new Date().toISOString().slice(0, 10) ? mailbox.sent_today : 0,
      cap_today: warmupCapFor(mailbox),
      bounce_rate: Number(mailbox.bounce_rate ?? 0),
      complaint_rate: Number(mailbox.complaint_rate ?? 0),
      // remainingToday se recalcula en la UI si hace falta; acá interesa el
      // par usado/tope, que es lo que explica por qué algo no salió hoy.
    })),
    agent_failures_7d: runRows.filter((run) => run.status === 'failed').length,
    degraded_runs_7d: runRows.filter((run) => run.status === 'degraded').length,
    threads_waiting: waiting ?? 0,
  };
}

export async function spendFor(organizationId: string): Promise<SpendView> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [credits, byKind, { data: runs }, attributed] = await Promise.all([
    balance(organizationId),
    consumptionByKind(organizationId, 30),
    db()
      .from('agent_runs')
      .select('cost_usd')
      .eq('organization_id', organizationId)
      .gte('created_at', since)
      .limit(5000),
    attributedRevenue(organizationId),
  ]);

  return {
    credits_balance: credits,
    by_kind: byKind,
    ai_cost_usd_30d:
      Math.round((runs ?? []).reduce((sum, run) => sum + Number(run.cost_usd ?? 0), 0) * 100) / 100,
    attributed,
  };
}

/** Cupo restante de hoy por bandeja. Se expone aparte porque la página de
 *  bandejas lo necesita y la de observabilidad no. */
export async function mailboxCapacity(organizationId: string) {
  const mailboxes = await listMailboxes(organizationId);
  return mailboxes.map((mailbox) => ({
    ...mailbox,
    remaining_today: remainingToday(mailbox),
    cap_today: warmupCapFor(mailbox),
  }));
}
