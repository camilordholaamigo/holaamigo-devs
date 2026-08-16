import { db, mustWrite, unwrap } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';
import type { Evidence } from '@/lib/decisions/types';

/**
 * La Sala: la conversación entre agentes, visible y en la que se puede entrar.
 *
 * Un resultado sin proceso es un oráculo: se cree o no se cree, y no hay nada
 * que hacer al respecto. Esto es lo que convierte la salida de los agentes en
 * algo que el cliente puede discutir, y en el punto donde puede meter la mano.
 *
 * Dos reglas viven en SQL y no acá, a propósito — el código se puede saltar:
 *
 *   · No se resuelve sin `what_would_change_my_mind` (mínimo 20 caracteres).
 *   · Si el humano habló en el hilo, la recomendación tiene que citarlo.
 *
 * Ver docs/adr/0019-la-deliberacion-como-objeto.md
 */

export type Stance = 'propose' | 'support' | 'object' | 'question' | 'concede' | 'decide';
export type Speaker = AgentRole | 'system' | 'client' | 'operator' | (string & {});

export interface DissentPosition {
  agent: string;
  position: string;
  argument: string;
}

export interface Recommendation {
  option: string;
  summary: string;
  evidence: Evidence[];
}

export interface DeliberationRow {
  id: string;
  organization_id: string;
  opened_by_role: string | null;
  question: string;
  context: Record<string, unknown>;
  status: 'open' | 'resolved' | 'escalated' | 'abandoned';
  recommendation: Recommendation | null;
  confidence: number | null;
  what_would_change_my_mind: string | null;
  dissent: DissentPosition[];
  decision_id: string | null;
  opened_at: string;
  resolved_at: string | null;
  reopened_count: number;
}

export interface TurnRow {
  id: number;
  deliberation_id: string;
  speaker: string;
  speaker_type: 'agent' | 'human';
  body: string;
  evidence: Evidence[];
  stance: Stance;
  human_input_id: string | null;
  created_at: string;
}

export async function openDeliberation(args: {
  organizationId: string;
  question: string;
  openedByRole: AgentRole | 'system';
  agentId?: string | null;
  context?: Record<string, unknown>;
  /** El primer turno, casi siempre la propuesta de quien abre. */
  opening?: { speaker: Speaker; body: string; stance?: Stance; evidence?: Evidence[] };
}): Promise<string> {
  const row = unwrap(
    await db()
      .from('deliberations')
      .insert({
        organization_id: args.organizationId,
        opened_by: args.agentId ?? null,
        opened_by_role: args.openedByRole,
        question: args.question,
        context: args.context ?? {},
      })
      .select('id')
      .single(),
    'deliberations.insert',
  ) as { id: string };

  if (args.opening) {
    await addTurn({
      deliberationId: row.id,
      speaker: args.opening.speaker,
      speakerType: 'agent',
      body: args.opening.body,
      stance: args.opening.stance ?? 'propose',
      evidence: args.opening.evidence,
    });
  }

  return row.id;
}

export async function addTurn(args: {
  deliberationId: string;
  speaker: Speaker;
  speakerType: 'agent' | 'human';
  body: string;
  stance: Stance;
  evidence?: Evidence[];
  humanInputId?: string | null;
}): Promise<void> {
  await mustWrite(
    db().from('deliberation_turns').insert({
      deliberation_id: args.deliberationId,
      speaker: args.speaker,
      speaker_type: args.speakerType,
      body: args.body,
      stance: args.stance,
      evidence: args.evidence ?? [],
      human_input_id: args.humanInputId ?? null,
    }),
    'deliberation_turns.insert',
  );
}

/**
 * Registra el desacuerdo explícito.
 *
 * Se guarda aparte de los turnos aunque la información esté en los dos lados:
 * los turnos son la conversación —larga, con matices, con concesiones— y
 * `dissent` es el resumen de las posiciones que quedaron enfrentadas. La
 * pantalla necesita las dos cosas: el hilo para leer, el resumen para no tener
 * que leerlo entero antes de entender qué se está discutiendo.
 */
export async function recordDissent(
  deliberationId: string,
  positions: DissentPosition[],
): Promise<void> {
  await mustWrite(
    db().from('deliberations').update({ dissent: positions }).eq('id', deliberationId),
    'deliberations.dissent',
  );
}

export interface ResolveResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolver. Puede fallar, y sus fallos son la funcionalidad.
 *
 * Devuelve `{ok:false, error}` en vez de lanzar porque los dos errores posibles
 * —falta el campo, no citaste al humano— son mensajes que el agente (o el
 * operador) tiene que poder leer y corregir, no excepciones de infraestructura.
 */
export async function resolveDeliberation(args: {
  deliberationId: string;
  recommendation: Recommendation;
  confidence: number;
  whatWouldChangeMyMind: string;
  decisionId?: string | null;
}): Promise<ResolveResult> {
  const { error } = await db().rpc('resolver_deliberacion', {
    p_id: args.deliberationId,
    p_recommendation: args.recommendation,
    p_confidence: args.confidence,
    p_what_would_change: args.whatWouldChangeMyMind,
    p_decision_id: args.decisionId ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * El cliente entra al hilo.
 *
 * Peso 2.0 por defecto: lo que el humano escribe pesa MÁS que la evidencia del
 * sistema en la próxima corrida. Es la palanca del titiritero y es deliberada —
 * un agente que "considera" el aporte del cliente y decide lo mismo de siempre
 * es peor que uno que no pregunta.
 */
export async function interject(args: {
  deliberationId: string;
  author: string;
  authorType: 'client' | 'operator';
  body: string;
  stance?: Stance;
  weight?: number;
}): Promise<{ ok: boolean; humanInputId?: string; reabierta?: boolean; error?: string }> {
  const { data, error } = await db().rpc('interponer', {
    p_deliberation_id: args.deliberationId,
    p_author: args.author,
    p_author_type: args.authorType,
    p_body: args.body,
    p_stance: args.stance ?? 'object',
    p_weight: args.weight ?? 2.0,
  });

  if (error) return { ok: false, error: error.message };
  const result = (data ?? {}) as { human_input_id?: string; reabierta?: boolean };
  return { ok: true, humanInputId: result.human_input_id, reabierta: result.reabierta };
}

export async function deliberationWithTurns(
  id: string,
): Promise<{ deliberation: DeliberationRow; turns: TurnRow[] } | null> {
  const { data: deliberation } = await db()
    .from('deliberations')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!deliberation) return null;

  const { data: turns } = await db()
    .from('deliberation_turns')
    .select('*')
    .eq('deliberation_id', id)
    .order('created_at');

  return {
    deliberation: deliberation as DeliberationRow,
    turns: (turns ?? []) as TurnRow[],
  };
}

/**
 * La Sala completa, cronológica.
 *
 * Trae los turnos de todas las deliberaciones en una sola consulta y los
 * reagrupa en memoria. La alternativa —una consulta por hilo— hace N+1 viajes
 * para pintar una pantalla de lectura, que es justo donde menos se perdona la
 * espera.
 */
export async function room(
  organizationId: string,
  opts: { limit?: number; soloAbiertas?: boolean } = {},
): Promise<Array<DeliberationRow & { turns: TurnRow[] }>> {
  let query = db()
    .from('deliberations')
    .select('*')
    .eq('organization_id', organizationId)
    .order('opened_at', { ascending: false })
    .limit(opts.limit ?? 20);

  if (opts.soloAbiertas) query = query.eq('status', 'open');

  const { data: deliberations } = await query;
  const rows = (deliberations ?? []) as DeliberationRow[];
  if (rows.length === 0) return [];

  const { data: turns } = await db()
    .from('deliberation_turns')
    .select('*')
    .in(
      'deliberation_id',
      rows.map((d) => d.id),
    )
    .order('created_at');

  const porHilo = new Map<string, TurnRow[]>();
  for (const turn of (turns ?? []) as TurnRow[]) {
    const lista = porHilo.get(turn.deliberation_id) ?? [];
    lista.push(turn);
    porHilo.set(turn.deliberation_id, lista);
  }

  return rows.map((d) => ({ ...d, turns: porHilo.get(d.id) ?? [] }));
}

/** Cuántas deliberaciones abiertas hay. Alimenta el badge de la navegación. */
export async function openDeliberations(organizationId: string): Promise<number> {
  const { count } = await db()
    .from('deliberations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'open');
  return count ?? 0;
}
