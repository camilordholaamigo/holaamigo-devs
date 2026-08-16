import type { AgentRole } from '@/lib/agents/contracts';

/**
 * La microdecisión: la unidad atómica de todo el sistema.
 *
 * Este archivo no importa nada de servidor a propósito — lo van a leer también
 * los componentes que rendericen el feed y La Sala (P3), igual que
 * `lib/diagnostic/math.ts` corre en el navegador para el recálculo en vivo.
 *
 * Ver docs/adr/0016-la-microdecision-como-unidad.md
 */

/**
 * Tipos de decisión conocidos. La columna en la base es `text` sin `check`
 * porque la lista crece con cada parte del plan; este tipo es la lista de lo
 * que existe hoy y sirve para que el editor avise cuando alguien inventa uno.
 */
export type DecisionKind =
  | 'angle_select'
  | 'segment_pick'
  | 'outreach_send'
  | 'budget_shift'
  | 'allocation'
  | 'campaign_launch'
  | 'pause'
  | 'partnership_outreach'
  | 'content_publish'
  | 'skill_request'
  | 'escalate'
  | 'handoff';

/** Las dos que no predicen nada: transfieren el control a un humano. */
export const KINDS_SIN_PREDICCION: DecisionKind[] = ['escalate', 'handoff'];

export interface OptionConsidered {
  label: string;
  pros?: string[];
  cons?: string[];
  est_cost_usd?: number | null;
  est_impact?: string | null;
}

/**
 * Lo que el agente cree que va a pasar, registrado ANTES de que pase.
 *
 * `direction` existe porque hay métricas donde bajar es ganar (costo por lead).
 * El destilador de v1 solo aprende de las de `up`; las de `down` se registran
 * igual y entran al aprendizaje en P4, con el motor de experimentos.
 */
export interface Prediction {
  metric: string;
  expected_value: number;
  horizon_days: number;
  confidence?: number;
  direction?: 'up' | 'down';
}

export interface Outcome {
  metric: string;
  actual_value: number;
  measured_at: string;
}

export interface Evidence {
  type: 'metric' | 'lesson' | 'human' | 'source' | 'experiment';
  ref: string;
  note?: string;
  weight?: number;
}

/** Contexto de agrupación del destilador. Lo que hace comparables dos decisiones. */
export interface DecisionContext {
  segment?: string | null;
  channel?: string | null;
  industry?: string | null;
  [key: string]: unknown;
}

export interface DecisionInput {
  organizationId: string;
  agentId?: string | null;
  role?: AgentRole | null;
  runId?: string | null;
  kind: DecisionKind | (string & {});
  /** En lenguaje natural y en español: el cliente la va a leer tal cual. */
  question: string;
  context?: DecisionContext;
  optionsConsidered: OptionConsidered[];
  chosen: { label: string; payload?: Record<string, unknown> };
  rationale: string;
  evidence?: Evidence[];
  lessonIds?: string[];
  humanInputIds?: string[];
  prediction?: Prediction | null;
  reversible?: boolean;
  experimentId?: string | null;
  approvalId?: string | null;
}

export interface DecisionRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  role: AgentRole | null;
  run_id: string | null;
  created_at: string;
  kind: string;
  question: string;
  context: DecisionContext;
  options_considered: OptionConsidered[];
  chosen: { label: string; payload?: Record<string, unknown> };
  rationale: string;
  evidence: Evidence[];
  lesson_ids: string[];
  human_input_ids: string[];
  prediction: Prediction | null;
  outcome: Outcome | null;
  calibration: number | null;
  reversible: boolean;
  cost_usd: number | null;
  experiment_id: string | null;
  approval_id: string | null;
}

/**
 * La calibración, en TypeScript, SOLO para pintar y proyectar en el navegador.
 *
 * La fuente de verdad es `holaamigo.calibracion()` en SQL: es la que se escribe
 * en la tabla y la que el destilador lee. Esta copia existe porque el feed y el
 * libro de resultados necesitan mostrar "si esto sale en X, la calibración
 * sería Y" sin ir a la base. Si las dos alguna vez difieren, manda la de SQL.
 */
export function calibracion(esperado: number, real: number): number {
  if (!Number.isFinite(esperado) || !Number.isFinite(real)) return 0;
  if (esperado === 0 && real === 0) return 1;
  const denom = Math.max(Math.abs(esperado), Math.abs(real));
  if (denom === 0) return 1;
  const score = 1 - Math.abs(real - esperado) / denom;
  return Math.round(Math.max(0, score) * 10_000) / 10_000;
}
