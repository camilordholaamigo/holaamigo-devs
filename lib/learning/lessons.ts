import { db, mustWrite, tryWrite } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';
import { cosine, embedMany, jaccard, EMBEDDING_MODEL } from '@/lib/learning/embed';

/**
 * Lecciones: lo que la empresa aprendió, en forma de regla usable.
 *
 * La regla de diseño que gobierna todo este archivo: **las lecciones no se
 * hornean en el prompt**. Se recuperan en cada corrida y se inyectan como un
 * bloque de contexto. Si estuvieran en el prompt, cambiar lo que el sistema
 * cree exigiría desplegar, y no habría forma de saber qué creía el agente el
 * día que tomó una decisión concreta. Inyectadas, quedan registradas en
 * `traces` y la atribución es posible.
 *
 * La escalera de alcances va de lo específico a lo general, y pesa en ese
 * orden: lo que aprendió ESTE agente en ESTA empresa manda sobre lo que
 * aprendimos del producto entero.
 *
 * Ver docs/wiki/15-sustrato-decisiones-y-aprendizaje.md
 */

export type LessonScope = 'agent' | 'organization' | 'industry' | 'global';

export interface LessonRow {
  id: string;
  scope: LessonScope;
  scope_ref: string | null;
  statement: string;
  applies_to: { kinds?: string[]; channels?: string[]; segments?: string[]; contexto?: string; metric?: string };
  n_support: number;
  confidence: number;
  best_option: string | null;
  lift: number | null;
  status: string;
  version: number;
  embedding: number[] | null;
}

/**
 * Cuánto pesa cada alcance. No son porcentajes: son la respuesta a "si dos
 * lecciones dicen cosas parecidas, ¿cuál leo primero?".
 */
const PESO_ALCANCE: Record<LessonScope, number> = {
  agent: 1.0,
  organization: 0.85,
  industry: 0.6,
  global: 0.5,
};

export interface RecallArgs {
  organizationId: string;
  role?: AgentRole | null;
  industry?: string | null;
  /** La tarea concreta de esta corrida. Es contra esto que se mide la similitud. */
  task: string;
  kind?: string | null;
  segment?: string | null;
  channel?: string | null;
  limit?: number;
}

function refDeAgente(organizationId: string, role?: AgentRole | null): string | null {
  return role ? `${organizationId}:${role}` : null;
}

/**
 * Las 5–8 lecciones más relevantes para esta corrida.
 *
 * El puntaje mezcla tres cosas y no una: la similitud sola trae lecciones
 * parecidas pero flojas; la confianza sola trae lecciones sólidas pero de otro
 * tema; el alcance solo trae lo específico aunque no aplique.
 */
export async function recallLessons(args: RecallArgs): Promise<LessonRow[]> {
  const limit = Math.min(8, Math.max(1, args.limit ?? 6));
  const agentRef = refDeAgente(args.organizationId, args.role);

  const { data } = await db()
    .from('lessons')
    .select('id, scope, scope_ref, statement, applies_to, n_support, confidence, best_option, lift, status, version, embedding')
    .eq('status', 'active')
    .limit(400);

  const candidatas = ((data ?? []) as LessonRow[]).filter((l) => {
    if (l.scope === 'agent') return agentRef !== null && l.scope_ref === agentRef;
    if (l.scope === 'organization') return l.scope_ref === args.organizationId;
    if (l.scope === 'industry') return Boolean(args.industry) && l.scope_ref === args.industry;
    return true; // global
  });

  const aplicables = candidatas.filter((l) => {
    const kinds = l.applies_to?.kinds;
    // Si la lección declara para qué tipos de decisión sirve y esta no está,
    // se descarta en vez de penalizarse: en un bloque de 6 líneas, una lección
    // que no aplica desplaza a una que sí, y el agente no tiene cómo saberlo.
    if (args.kind && Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(args.kind)) {
      return false;
    }
    const segments = l.applies_to?.segments;
    if (args.segment && Array.isArray(segments) && segments.length > 0 && !segments.includes(args.segment)) {
      return false;
    }
    return true;
  });

  const vectorTarea = await vectorDe(args.task);

  const puntuadas = aplicables.map((l) => {
    const sim = vectorTarea && l.embedding
      ? cosine(vectorTarea, l.embedding)
      : jaccard(args.task, l.statement);
    const score = 0.5 * sim + 0.3 * Number(l.confidence ?? 0) + 0.2 * PESO_ALCANCE[l.scope];
    return { lesson: l, score };
  });

  return puntuadas
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p) => p.lesson);
}

/** El vector de la tarea. Si no hay API key o falla, devuelve null y se usa Jaccard. */
async function vectorDe(task: string): Promise<number[] | null> {
  const [vector] = await embedMany([task]);
  return vector;
}

/**
 * El bloque que se le inyecta al agente.
 *
 * Lleva n y confianza a propósito: un agente que ve "n=9, confianza 0,72" trata
 * la lección distinto que uno que ve "n=140, confianza 0,94", y eso es
 * exactamente lo que queremos. Una regla sin su respaldo es dogma.
 */
export function lessonBlock(lessons: LessonRow[]): string {
  if (lessons.length === 0) return '';
  const lineas = lessons.map(
    (l, i) =>
      `${i + 1}. ${l.statement} ` +
      `[alcance: ${l.scope} · n=${l.n_support} · confianza ${Number(l.confidence).toFixed(2)}]`,
  );
  return [
    '## Lo que hemos aprendido',
    '',
    'Reglas destiladas de decisiones anteriores que YA se midieron. No son órdenes:',
    'si la evidencia de hoy las contradice, decídelo distinto y explica por qué.',
    '',
    ...lineas,
  ].join('\n');
}

/**
 * Promueve una lección a un alcance más amplio. Solo nosotros.
 *
 * La base exige `promoted_by` para dejar activa una lección de `industry` o
 * `global` (constraint `lessons_alcance_amplio_requiere_humano`). Esta función
 * es el único camino que lo satisface: un cliente con un negocio raro no puede
 * envenenar a los demás por acumulación de datos.
 */
export async function promoteLesson(
  lessonId: string,
  args: { scope: Exclude<LessonScope, 'organization' | 'agent'>; scopeRef?: string | null; by: string },
): Promise<void> {
  await mustWrite(
    db()
      .from('lessons')
      .update({
        scope: args.scope,
        scope_ref: args.scope === 'industry' ? (args.scopeRef ?? null) : null,
        status: 'active',
        promoted_by: args.by,
        promoted_at: new Date().toISOString(),
        // La huella incluye el alcance: al promover cambia, y así la lección
        // promovida deja de ser pisada por el destilador de la organización que
        // la originó, que la seguiría recalculando cada noche.
        fingerprint: `${args.scope}|${args.scopeRef ?? '—'}|${lessonId}`,
      })
      .eq('id', lessonId),
    'lessons.promote',
  );
}

export async function retireLesson(lessonId: string, reason: string, by: string): Promise<void> {
  await mustWrite(
    db()
      .from('lessons')
      .update({ status: 'retired', retired_reason: `${reason} — ${by}` })
      .eq('id', lessonId),
    'lessons.retire',
  );
}

export async function rejectLesson(lessonId: string, reason: string, by: string): Promise<void> {
  await mustWrite(
    db()
      .from('lessons')
      .update({ status: 'rejected', retired_reason: `${reason} — ${by}` })
      .eq('id', lessonId),
    'lessons.reject',
  );
}

/**
 * Calcula los vectores que faltan.
 *
 * Corre después del destilador: el destilador es SQL puro y no puede llamar a
 * OpenAI, así que las lecciones nuevas nacen sin vector y se recuperan por
 * solape de palabras hasta que este job pase. Es degradación aceptable y
 * explícita, no un olvido.
 */
export async function backfillEmbeddings(limit = 50): Promise<number> {
  const { data } = await db()
    .from('lessons')
    .select('id, statement')
    .is('embedding', null)
    .in('status', ['candidate', 'active'])
    .limit(limit);

  const pendientes = data ?? [];
  if (pendientes.length === 0) return 0;

  const vectores = await embedMany(pendientes.map((l) => l.statement));

  let escritos = 0;
  for (const [i, leccion] of pendientes.entries()) {
    const vector = vectores[i];
    if (!vector) continue;
    const ok = await tryWrite(
      db()
        .from('lessons')
        .update({ embedding: vector, embedding_model: EMBEDDING_MODEL })
        .eq('id', leccion.id),
      'lessons.embedding',
    );
    if (ok) escritos += 1;
  }
  return escritos;
}

export async function lessonsFor(
  organizationId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<LessonRow[]> {
  let query = db()
    .from('lessons')
    .select('id, scope, scope_ref, statement, applies_to, n_support, confidence, best_option, lift, status, version, embedding')
    .or(`scope_ref.eq.${organizationId},scope_ref.like.${organizationId}:%`)
    .order('confidence', { ascending: false })
    .limit(opts.limit ?? 50);

  if (opts.status) query = query.eq('status', opts.status);

  const { data } = await query;
  return (data ?? []) as LessonRow[];
}
