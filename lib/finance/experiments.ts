import { db, mustWrite, unwrap } from '@/lib/supabase/admin';

/**
 * El motor de experimentos: pre-registro obligatorio.
 *
 * > **Ninguna acción consecuente se ejecuta sin declarar antes qué esperamos,
 * > cómo lo mediremos y cuándo decidiremos.**
 *
 * El pre-registro es lo que impide que el agente —o nosotros— racionalice el
 * resultado después. Un experimento cuyo efecto esperado se puede ajustar
 * cuando ya se vio el número siempre acierta, y una racionalización con formato
 * de dato es peor que no tener dato: contamina el aprendizaje de P1 con
 * calibraciones perfectas y falsas.
 *
 * Por eso la inmutabilidad vive en un trigger de Postgres y no acá.
 *
 * La `decision_rule` es un objeto y no una frase. "Si mejora bastante,
 * seguimos" no se puede aplicar literalmente, y una regla que no se aplica
 * literalmente no es un pre-registro: es una intención.
 *
 * Ver docs/adr/0020-pre-registro-y-economia-por-canal.md
 */

export type Comparador = '>=' | '>' | '<=' | '<';

export interface DecisionRule {
  comparador: Comparador;
  umbral: number;
  gana?: 'won';
  pierde?: 'lost';
}

export interface ExperimentRow {
  id: string;
  organization_id: string;
  decision_id: string | null;
  deliberation_id: string | null;
  channel_id: string | null;
  hypothesis: string;
  primary_metric: string;
  expected_effect: number;
  decision_rule: DecisionRule;
  min_sample: number;
  guardrail_metric: string | null;
  guardrail_threshold: number | null;
  status: 'draft' | 'running' | 'won' | 'lost' | 'inconclusive' | 'aborted';
  actual_effect: number | null;
  actual_sample: number | null;
  guardrail_actual: number | null;
  readout_note: string | null;
  cost_usd: number | null;
  created_at: string;
  started_at: string | null;
  readout_at: string | null;
}

export interface PreRegistro {
  organizationId: string;
  hypothesis: string;
  primaryMetric: string;
  expectedEffect: number;
  decisionRule: DecisionRule;
  minSample: number;
  guardrailMetric?: string | null;
  guardrailThreshold?: number | null;
  decisionId?: string | null;
  deliberationId?: string | null;
  channelId?: string | null;
  /** `true` arranca ya; `false` lo deja como borrador editable. */
  arrancar?: boolean;
}

export function validarPreRegistro(pre: PreRegistro): string[] {
  const problemas: string[] = [];
  if (!pre.hypothesis?.trim() || pre.hypothesis.trim().length < 15) {
    problemas.push('la hipótesis tiene que decir qué se espera y por qué, no solo qué se va a probar.');
  }
  if (!pre.primaryMetric?.trim()) problemas.push('falta la métrica principal.');
  if (!Number.isFinite(pre.expectedEffect)) problemas.push('falta el efecto esperado.');
  if (!Number.isFinite(pre.minSample) || pre.minSample <= 0) {
    problemas.push('la muestra mínima tiene que ser un número mayor a cero: es lo que evita concluir con tres datos.');
  }
  if (!['>=', '>', '<=', '<'].includes(pre.decisionRule?.comparador)) {
    problemas.push('el comparador de la regla de decisión tiene que ser >=, >, <= o <.');
  }
  if (!Number.isFinite(pre.decisionRule?.umbral)) problemas.push('la regla de decisión necesita umbral.');
  return problemas;
}

export async function preRegistrar(pre: PreRegistro): Promise<string> {
  const problemas = validarPreRegistro(pre);
  if (problemas.length > 0) {
    throw new Error(`[experimento] no se puede pre-registrar — ${problemas.join(' · ')}`);
  }

  const row = unwrap(
    await db()
      .from('experiments')
      .insert({
        organization_id: pre.organizationId,
        decision_id: pre.decisionId ?? null,
        deliberation_id: pre.deliberationId ?? null,
        channel_id: pre.channelId ?? null,
        hypothesis: pre.hypothesis,
        primary_metric: pre.primaryMetric,
        expected_effect: pre.expectedEffect,
        decision_rule: pre.decisionRule,
        min_sample: pre.minSample,
        guardrail_metric: pre.guardrailMetric ?? null,
        guardrail_threshold: pre.guardrailThreshold ?? null,
        status: pre.arrancar === false ? 'draft' : 'running',
        started_at: pre.arrancar === false ? null : new Date().toISOString(),
      })
      .select('id')
      .single(),
    'experiments.insert',
  ) as { id: string };

  return row.id;
}

export interface Readout {
  status: string;
  nota: string;
  calibracion: number | null;
  guardrail_roto: boolean;
}

/**
 * Aplica la regla declarada, literalmente, y cierra la decisión asociada.
 *
 * Ese encadenamiento —experimento → decisión → calibración → lección— es todo
 * el sistema de aprendizaje en una llamada. Por eso vive en SQL: si el readout
 * se olvidara de escribir el `outcome`, la decisión quedaría sin medir para
 * siempre y nadie se enteraría.
 */
export async function readout(args: {
  experimentId: string;
  actual: number;
  sample: number;
  guardrail?: number | null;
}): Promise<Readout> {
  const { data, error } = await db().rpc('readout_experimento', {
    p_id: args.experimentId,
    p_actual: args.actual,
    p_sample: args.sample,
    p_guardrail: args.guardrail ?? null,
  });

  if (error) throw new Error(`[experimento:readout] ${error.message}`);
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    status: String(result.status ?? 'inconclusive'),
    nota: String(result.nota ?? ''),
    calibracion: result.calibracion === null || result.calibracion === undefined
      ? null
      : Number(result.calibracion),
    guardrail_roto: Boolean(result.guardrail_roto),
  };
}

export async function abortar(experimentId: string, motivo: string): Promise<void> {
  await mustWrite(
    db()
      .from('experiments')
      .update({ status: 'aborted', readout_note: motivo, readout_at: new Date().toISOString() })
      .eq('id', experimentId),
    'experiments.abort',
  );
}

export async function experimentsFor(
  organizationId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<ExperimentRow[]> {
  let query = db()
    .from('experiments')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 50);

  if (opts.status) query = query.eq('status', opts.status);

  const { data } = await query;
  return (data ?? []) as ExperimentRow[];
}

/**
 * Los que están corriendo y ya podrían tener readout.
 *
 * No mide solo: el que sabe leer la métrica es quien la produce (las campañas,
 * el CRM, el canal). Esto devuelve la lista para que el job de cada dominio la
 * recorra. Es a propósito — un motor de experimentos que adivina de dónde sale
 * cada métrica termina con una función gigante que conoce todo el producto.
 */
export async function pendientesDeReadout(organizationId: string): Promise<ExperimentRow[]> {
  const { data } = await db()
    .from('experiments')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'running')
    .order('started_at');
  return (data ?? []) as ExperimentRow[];
}
