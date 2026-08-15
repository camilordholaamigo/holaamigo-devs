import { db } from '@/lib/supabase/admin';
import { alertSlack } from '@/lib/notify';
import { env } from '@/lib/env';

/**
 * Salud de agentes (PRD §9.4).
 *
 * Los detectores vienen del QA de Inacar. La idea de fondo: un agente no se
 * cae, se degrada. Deja de responder bien antes de dejar de responder, y para
 * cuando alguien lo nota ya mandó 400 mensajes malos. Estos detectores buscan
 * la degradación, no la caída.
 *
 * Cualquier detector en rojo → agents.status = 'degraded' + alerta.
 */

export interface HealthDetector {
  key: string;
  label: string;
  /** 0 a 1: cuánto descuenta del health_score. */
  weight: number;
}

export const DETECTORS: HealthDetector[] = [
  { key: 'no_successful_runs', label: 'Sin corridas exitosas en 24 h', weight: 0.4 },
  { key: 'structured_output_drop', label: 'Caída de salida estructurada válida', weight: 0.3 },
  { key: 'escalation_spike', label: 'Escalamientos por encima del umbral', weight: 0.2 },
  { key: 'deliverability_drop', label: 'Caída de deliverability o rebotes altos', weight: 0.4 },
  { key: 'length_drift', label: 'Deriva de longitud contra la línea base', weight: 0.1 },
];

const WINDOW_HOURS = 24;
const MIN_RUNS_FOR_RATIO = 5;
const ESCALATION_THRESHOLD = 0.25;
const BOUNCE_THRESHOLD = 0.05;
const LENGTH_DRIFT_TOLERANCE = 0.6;

/** Recalcula la salud de todos los agentes activos. Devuelve cuántos revisó. */
export async function refreshAgentHealth(): Promise<number> {
  const { data: agents } = await db()
    .from('agents')
    .select('id, organization_id, role, status, health_score')
    .in('status', ['active', 'degraded']);

  if (!agents || agents.length === 0) return 0;

  const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  for (const agent of agents) {
    const reasons: string[] = [];
    let score = 1;

    const { data: runs } = await db()
      .from('agent_runs')
      .select('status, output, created_at')
      .eq('organization_id', agent.organization_id)
      .eq('role', agent.role)
      .gte('created_at', since);

    const total = runs?.length ?? 0;
    const ok = (runs ?? []).filter((r) => r.status === 'ok').length;
    const failed = (runs ?? []).filter((r) => r.status === 'failed').length;
    const degradedRuns = (runs ?? []).filter((r) => r.status === 'degraded').length;

    // 1 · Sin corridas exitosas. Solo aplica si hubo intentos: un agente
    //     ocioso no está enfermo, está esperando trabajo.
    if (total > 0 && ok === 0) {
      score -= weight('no_successful_runs');
      reasons.push(`${total} corridas en ${WINDOW_HOURS} h, ninguna exitosa`);
    }

    // 2 · Caída de la tasa de salida estructurada válida.
    if (total >= MIN_RUNS_FOR_RATIO) {
      const invalidRatio = (failed + degradedRuns) / total;
      if (invalidRatio > 0.3) {
        score -= weight('structured_output_drop');
        reasons.push(`${Math.round(invalidRatio * 100)}% de salidas inválidas o degradadas`);
      }
    }

    // 3 · Escalamientos por encima del umbral.
    const { data: escalations } = await db()
      .from('approvals')
      .select('id')
      .eq('agent_id', agent.id)
      .eq('kind', 'escalation')
      .gte('created_at', since);

    if (total >= MIN_RUNS_FOR_RATIO && (escalations?.length ?? 0) / total > ESCALATION_THRESHOLD) {
      score -= weight('escalation_spike');
      reasons.push(`${escalations?.length} escalamientos sobre ${total} corridas`);
    }

    // 4 · Deliverability. Solo aplica a SALES: es el único que envía.
    if (agent.role === 'sales') {
      const { data: messages } = await db()
        .from('messages')
        .select('status')
        .gte('created_at', since)
        .in('status', ['sent', 'delivered', 'bounced', 'failed']);

      const sent = messages?.length ?? 0;
      const bounced = (messages ?? []).filter(
        (m) => m.status === 'bounced' || m.status === 'failed',
      ).length;

      if (sent >= 20 && bounced / sent > BOUNCE_THRESHOLD) {
        score -= weight('deliverability_drop');
        reasons.push(`${Math.round((bounced / sent) * 100)}% de rebotes sobre ${sent} envíos`);
      }
    }

    // 5 · Deriva de longitud contra la línea base de las últimas 200 corridas.
    const drift = await lengthDrift(agent.organization_id, agent.role, since);
    if (drift !== null && Math.abs(drift) > LENGTH_DRIFT_TOLERANCE) {
      score -= weight('length_drift');
      reasons.push(`la longitud de salida se movió ${Math.round(drift * 100)}% contra la base`);
    }

    score = Math.max(0, Math.min(1, Number(score.toFixed(2))));
    const nextStatus = reasons.length > 0 ? 'degraded' : 'active';
    const wasDegraded = agent.status === 'degraded';

    await db()
      .from('agents')
      .update({ health_score: score, health_reasons: reasons, status: nextStatus })
      .eq('id', agent.id);

    if (nextStatus === 'degraded' && !wasDegraded) {
      const { data: org } = await db()
        .from('organizations')
        .select('name, domain')
        .eq('id', agent.organization_id)
        .maybeSingle();

      await alertSlack({
        title: `Agente degradado · ${agent.role.toUpperCase()} · ${org?.name ?? org?.domain ?? ''}`,
        lines: [`*Salud:* ${score}`, ...reasons.map((r) => `• ${r}`)],
        url: `${env.siteUrl}/admin/agents`,
        urgent: score < 0.5,
      });
    }
  }

  return agents.length;
}

function weight(key: string): number {
  return DETECTORS.find((d) => d.key === key)?.weight ?? 0.1;
}

/** Longitud media de salida reciente vs. la histórica. Devuelve la variación
 *  relativa, o null si no hay suficiente historia para comparar. */
async function lengthDrift(
  organizationId: string,
  role: string,
  since: string,
): Promise<number | null> {
  const { data: history } = await db()
    .from('agent_runs')
    .select('output, created_at')
    .eq('organization_id', organizationId)
    .eq('role', role)
    .eq('status', 'ok')
    .order('created_at', { ascending: false })
    .limit(200);

  if (!history || history.length < 20) return null;

  const size = (row: { output: unknown }) =>
    row.output ? JSON.stringify(row.output).length : 0;

  const recent = history.filter((r) => r.created_at >= since);
  const baseline = history.filter((r) => r.created_at < since);
  if (recent.length < 5 || baseline.length < 10) return null;

  const avg = (rows: typeof history) =>
    rows.reduce((sum, r) => sum + size(r), 0) / rows.length;

  const base = avg(baseline);
  if (base === 0) return null;

  return (avg(recent) - base) / base;
}
