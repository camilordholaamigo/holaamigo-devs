import { randomUUID } from 'node:crypto';
import { db, tryWrite } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';

/**
 * Trazas: cada paso de ejecución de un agente.
 *
 * Es la capa de abajo del sustrato (P1). La diferencia con `agent_runs` no es
 * de forma sino de propósito: `agent_runs` responde "¿cuánto costó este
 * diagnóstico?"; `traces` responde "¿qué pasó adentro, en qué orden, y qué
 * evidencia tenía el agente cuando decidió lo que decidió?".
 *
 * Dos reglas:
 *
 *  1. **Nunca lanzan.** Una traza perdida es un dato menos; una excepción
 *     escribiendo la traza mata la corrida real. `tryWrite` y seguimos.
 *  2. **Siempre llevan `run_id`.** Es la única forma de imputarle costo a una
 *     decisión: el costo se mide por corrida y se reparte entre lo que la
 *     corrida decidió (`holaamigo.imputar_costos`).
 *
 * Se purgan a los 90 días con `holaamigo.purgar_trazas()`. Las decisiones no.
 *
 * Ver docs/wiki/15-sustrato-decisiones-y-aprendizaje.md
 */

export type StepType = 'think' | 'tool_call' | 'tool_result' | 'output' | 'error';

export interface TraceInput {
  organizationId?: string | null;
  agentId?: string | null;
  role?: AgentRole | null;
  runId: string;
  parentTraceId?: number | null;
  stepType: StepType;
  /** Qué paso es, en snake_case: `research`, `lecciones_inyectadas`, `linkedin.search`. */
  name: string;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number | null;
}

/** Identificador de corrida. Se crea una vez y se pasa a todo lo que participe. */
export function newRunId(): string {
  return randomUUID();
}

/**
 * Recorta lo que va a la traza.
 *
 * Un `input` de agente puede ser un Brief entero más 8.000 tokens de contexto.
 * Guardarlo completo por cada paso multiplica el tamaño de la tabla por el
 * número de pasos sin agregar información: lo que importa para auditar es qué
 * se le pasó, no la copia exacta. El tope es generoso a propósito — recortar de
 * más convierte la auditoría en adivinanza.
 */
function trim(value: unknown, max = 20_000): unknown {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  if (json && json.length <= max) return value;
  return { truncated: true, preview: (json ?? String(value)).slice(0, max) };
}

export async function trace(step: TraceInput): Promise<void> {
  await tryWrite(
    db()
      .from('traces')
      .insert({
        organization_id: step.organizationId ?? null,
        agent_id: step.agentId ?? null,
        role: step.role ?? null,
        run_id: step.runId,
        parent_trace_id: step.parentTraceId ?? null,
        step_type: step.stepType,
        name: step.name,
        input: trim(step.input),
        output: trim(step.output),
        model: step.model ?? null,
        tokens_in: step.tokensIn ?? 0,
        tokens_out: step.tokensOut ?? 0,
        cost_usd: step.costUsd ?? 0,
        duration_ms: step.durationMs ?? null,
      }),
    `traces.${step.name}`,
  );
}

/** Costo acumulado de una corrida. Base de la imputación a decisiones. */
export async function runCostUsd(runId: string): Promise<number> {
  const { data } = await db().from('traces').select('cost_usd').eq('run_id', runId);
  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
}

export async function tracesFor(runId: string) {
  const { data } = await db()
    .from('traces')
    .select('id, step_type, name, model, tokens_in, tokens_out, cost_usd, duration_ms, created_at, output')
    .eq('run_id', runId)
    .order('created_at');
  return data ?? [];
}
