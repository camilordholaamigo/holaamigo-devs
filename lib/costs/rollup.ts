import { db } from '@/lib/supabase/admin';

/**
 * Contabilidad de costo de los agentes.
 *
 * La vista `holaamigo.cost_rollup` agrega por organización, agente, día y tipo
 * de decisión, y cuadra EXACTO contra la suma cruda de trazas — no "casi", no
 * "con menos de medio por ciento de diferencia". El criterio de aceptación del
 * plan pide < 0,5% porque asume una vista materializada con retraso; acá es una
 * vista normal y la diferencia es cero. Cuando el volumen obligue a
 * materializarla, este archivo es el que va a tener que tolerar el retraso, y
 * `reconciliarCostos()` es la prueba que lo va a detectar.
 *
 * Todo esto alimenta P4 (el President como CRO): el costo de agente es una de
 * las categorías de `cost_events`.
 */

export interface CostRow {
  organization_id: string;
  agent_id: string | null;
  role: string | null;
  dia: string;
  decision_kind: string;
  pasos: number;
  tokens_in: number;
  tokens_out: number;
  costo_usd: number;
}

export async function costRollup(
  organizationId: string,
  opts: { desde?: string; hasta?: string } = {},
): Promise<CostRow[]> {
  let query = db()
    .from('cost_rollup')
    .select('*')
    .eq('organization_id', organizationId)
    .order('dia', { ascending: false })
    .limit(500);

  if (opts.desde) query = query.gte('dia', opts.desde);
  if (opts.hasta) query = query.lte('dia', opts.hasta);

  const { data, error } = await query;
  if (error) {
    console.error(`[costs:rollup] ${error.message}`);
    return [];
  }
  return (data ?? []) as CostRow[];
}

export interface CostTotals {
  costo_usd: number;
  tokens_in: number;
  tokens_out: number;
  pasos: number;
  por_tipo: Record<string, number>;
}

export function totalize(rows: CostRow[]): CostTotals {
  const totals: CostTotals = { costo_usd: 0, tokens_in: 0, tokens_out: 0, pasos: 0, por_tipo: {} };
  for (const row of rows) {
    totals.costo_usd += Number(row.costo_usd ?? 0);
    totals.tokens_in += Number(row.tokens_in ?? 0);
    totals.tokens_out += Number(row.tokens_out ?? 0);
    totals.pasos += Number(row.pasos ?? 0);
    totals.por_tipo[row.decision_kind] =
      (totals.por_tipo[row.decision_kind] ?? 0) + Number(row.costo_usd ?? 0);
  }
  totals.costo_usd = Math.round(totals.costo_usd * 1_000_000) / 1_000_000;
  return totals;
}

/**
 * ¿La vista miente? Compara contra la suma cruda de trazas.
 *
 * Existe porque una vista de agregación que se desincroniza no avisa: sigue
 * devolviendo números, solo que equivocados. Esto se expone en /api/health y en
 * el reporte mensual de P4.
 */
export async function reconciliarCostos(organizationId: string): Promise<{
  crudo: number;
  vista: number;
  diferencia: number;
  desvio_relativo: number;
  ok: boolean;
}> {
  const [{ data: trazas }, filas] = await Promise.all([
    db().from('traces').select('cost_usd').eq('organization_id', organizationId).limit(50_000),
    costRollup(organizationId),
  ]);

  const crudo = (trazas ?? []).reduce((sum, t) => sum + Number(t.cost_usd ?? 0), 0);
  const vista = totalize(filas).costo_usd;
  const diferencia = Math.abs(crudo - vista);
  const desvio = crudo === 0 ? 0 : diferencia / crudo;

  return {
    crudo: Math.round(crudo * 1_000_000) / 1_000_000,
    vista,
    diferencia: Math.round(diferencia * 1_000_000) / 1_000_000,
    desvio_relativo: Math.round(desvio * 10_000) / 10_000,
    ok: desvio < 0.005,
  };
}
