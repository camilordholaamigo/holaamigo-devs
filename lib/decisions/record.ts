import { db, unwrap } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';
import {
  KINDS_SIN_PREDICCION,
  type DecisionInput,
  type DecisionRow,
  type Prediction,
} from '@/lib/decisions/types';

/**
 * Escribir y cerrar decisiones.
 *
 * La escritura lanza (`unwrap`, misma semántica que `mustWrite` pero
 * devolviendo el id): una traza perdida es un dato menos, pero una decisión
 * perdida es una empresa que no puede explicar por qué hizo lo que hizo. La
 * cola de decisiones es el producto (§13.6).
 *
 * Las tres invariantes —dos opciones, predicción, forma de la predicción— están
 * en `check` constraints de la base. Acá se validan otra vez, antes de la
 * escritura, con un solo objetivo: el error de Postgres dice
 * `violates check constraint "decisions_dos_opciones"`, y el de acá dice qué
 * agente, qué decisión y qué le faltó.
 *
 * Ver docs/adr/0016-la-microdecision-como-unidad.md
 */

export function validarDecision(input: DecisionInput): string[] {
  const problemas: string[] = [];

  if (!input.optionsConsidered || input.optionsConsidered.length < 2) {
    problemas.push(
      `«${input.question}» enumera ${input.optionsConsidered?.length ?? 0} opción(es). ` +
        'Una decisión con una sola opción no es una decisión, es una justificación.',
    );
  }

  if (input.optionsConsidered?.some((o) => !o.label?.trim())) {
    problemas.push('toda opción necesita `label`: es la clave con la que el destilador agrupa.');
  }

  if (!input.chosen?.label?.trim()) {
    problemas.push('`chosen.label` es obligatorio y tiene que coincidir con una de las opciones.');
  } else if (
    input.optionsConsidered?.length >= 2 &&
    !input.optionsConsidered.some((o) => o.label === input.chosen.label)
  ) {
    problemas.push(
      `eligió «${input.chosen.label}», que no está entre las opciones consideradas ` +
        `(${input.optionsConsidered.map((o) => o.label).join(', ')}).`,
    );
  }

  if (!input.rationale?.trim()) problemas.push('falta `rationale`.');

  const exenta = KINDS_SIN_PREDICCION.includes(input.kind as never);
  if (!input.prediction && !exenta) {
    problemas.push(
      `la decisión de tipo «${input.kind}» necesita predicción. Sin ella no hay forma ` +
        'de saber después si el agente acertó o racionalizó.',
    );
  }
  if (input.prediction) {
    const p = input.prediction;
    if (!p.metric?.trim()) problemas.push('la predicción necesita `metric`.');
    if (!Number.isFinite(p.expected_value)) problemas.push('la predicción necesita `expected_value` numérico.');
    if (!Number.isFinite(p.horizon_days) || p.horizon_days <= 0) {
      problemas.push('la predicción necesita `horizon_days` > 0: sin horizonte no se puede medir.');
    }
  }

  return problemas;
}

export async function recordDecision(input: DecisionInput): Promise<string> {
  const problemas = validarDecision(input);
  if (problemas.length > 0) {
    throw new Error(`[decision:${input.kind}] no se puede registrar — ${problemas.join(' · ')}`);
  }

  const row = unwrap(
    await db()
      .from('decisions')
      .insert({
        organization_id: input.organizationId,
        agent_id: input.agentId ?? null,
        role: input.role ?? null,
        run_id: input.runId ?? null,
        kind: input.kind,
        question: input.question,
        context: input.context ?? {},
        options_considered: input.optionsConsidered,
        chosen: input.chosen,
        rationale: input.rationale,
        evidence: input.evidence ?? [],
        lesson_ids: input.lessonIds ?? [],
        human_input_ids: input.humanInputIds ?? [],
        prediction: input.prediction ?? null,
        reversible: input.reversible ?? true,
        experiment_id: input.experimentId ?? null,
        approval_id: input.approvalId ?? null,
      })
      .select('id')
      .single(),
    'decisions.insert',
  );

  return (row as { id: string }).id;
}

/**
 * Cierra el ciclo: mide el resultado y calcula la calibración.
 *
 * Va por RPC y no por `update` para que sea imposible escribir un `outcome` sin
 * su calibración. La fórmula vive en SQL (`holaamigo.calibracion`) porque
 * tenerla en dos lugares garantiza que en seis meses digan cosas distintas.
 */
export async function settleDecision(
  decisionId: string,
  actualValue: number,
  measuredAt: Date = new Date(),
): Promise<number> {
  const { data, error } = await db().rpc('cerrar_decision', {
    p_decision_id: decisionId,
    p_real: actualValue,
    p_medido_en: measuredAt.toISOString(),
  });
  if (error) throw new Error(`[decision:cerrar:${decisionId}] ${error.message}`);
  return Number(data ?? 0);
}

/** Decisiones cuyo horizonte ya venció y que siguen sin medirse. */
export async function decisionesPorMedir(organizationId: string, limit = 50) {
  const { data } = await db()
    .from('decisions')
    .select('id, kind, question, prediction, created_at, run_id')
    .eq('organization_id', organizationId)
    .is('outcome', null)
    .not('prediction', 'is', null)
    .order('created_at')
    .limit(200);

  const ahora = Date.now();
  return (data ?? [])
    .filter((d) => {
      const horizonte = Number((d.prediction as Prediction | null)?.horizon_days ?? 0);
      if (!horizonte) return false;
      return new Date(d.created_at).getTime() + horizonte * 86_400_000 <= ahora;
    })
    .slice(0, limit);
}

export async function decisionsFor(
  organizationId: string,
  opts: { limit?: number; kind?: string; role?: AgentRole } = {},
): Promise<DecisionRow[]> {
  let query = db()
    .from('decisions')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 50);

  if (opts.kind) query = query.eq('kind', opts.kind);
  if (opts.role) query = query.eq('role', opts.role);

  const { data } = await query;
  return (data ?? []) as DecisionRow[];
}

/**
 * Reparte el costo de cada corrida entre las decisiones que produjo.
 *
 * Se llama después de la corrida, no durante: mientras el agente trabaja no se
 * sabe cuántas decisiones va a tomar, y dividir por un denominador que todavía
 * está creciendo da números que no cuadran con nada.
 */
export async function imputarCostos(organizationId?: string): Promise<number> {
  const { data, error } = await db().rpc('imputar_costos', {
    p_org: organizationId ?? null,
  });
  if (error) {
    // No lanza: es contabilidad, no el camino del producto. Pero deja rastro —
    // un P&G que se queda sin actualizar en silencio es peor que uno que falta.
    console.error(`[decisions:imputar_costos] ${error.message}`);
    return 0;
  }
  return Number(data ?? 0);
}
