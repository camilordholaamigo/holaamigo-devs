import type { AgentRole } from '@/lib/agents/contracts';
import { recallLessons, lessonBlock } from '@/lib/learning/lessons';
import { activeHumanInputs, humanInputBlock } from '@/lib/humans/inputs';
import { trace } from '@/lib/traces/record';

/**
 * El contexto aprendido que se le inyecta a un agente antes de que razone.
 *
 * Esto es lo que hace que el sistema mejore sin que nadie lo reprograme: el
 * agente de hoy razona con las lecciones que dejaron las decisiones medidas de
 * ayer, y con lo que el humano escribió anteanoche.
 *
 * Devuelve además los ids, y esa es la mitad del valor: sin saber QUÉ leyó el
 * agente cuando decidió, no se puede atribuir el resultado a una lección ni
 * decir "esta regla te ahorró X". Los ids van a `decisions.lesson_ids` y a una
 * traza `lecciones_inyectadas`.
 *
 * Ver docs/wiki/15-sustrato-decisiones-y-aprendizaje.md
 */

export interface LearningContext {
  /** Markdown listo para concatenar al input del agente. Vacío si no hay nada. */
  block: string;
  lessonIds: string[];
  humanInputIds: string[];
}

export async function buildLearningContext(args: {
  organizationId: string;
  role?: AgentRole | null;
  industry?: string | null;
  /** Qué va a hacer el agente en esta corrida. Contra esto se mide la similitud. */
  task: string;
  kind?: string | null;
  segment?: string | null;
  channel?: string | null;
  /** Si viene, se registra la inyección como traza de la corrida. */
  runId?: string | null;
  agentId?: string | null;
  limit?: number;
}): Promise<LearningContext> {
  const [lessons, humans] = await Promise.all([
    recallLessons({
      organizationId: args.organizationId,
      role: args.role,
      industry: args.industry,
      task: args.task,
      kind: args.kind,
      segment: args.segment,
      channel: args.channel,
      limit: args.limit,
    }),
    activeHumanInputs({
      organizationId: args.organizationId,
      role: args.role,
      kind: args.kind,
    }),
  ]);

  const bloques = [lessonBlock(lessons), humanInputBlock(humans)].filter(Boolean);
  const context: LearningContext = {
    block: bloques.join('\n\n'),
    lessonIds: lessons.map((l) => l.id),
    humanInputIds: humans.map((h) => h.id),
  };

  if (args.runId && context.block) {
    await trace({
      organizationId: args.organizationId,
      agentId: args.agentId ?? null,
      role: args.role ?? null,
      runId: args.runId,
      stepType: 'think',
      name: 'lecciones_inyectadas',
      // El enunciado va en la traza, no solo el id: una lección puede subir de
      // versión mañana, y entonces el id ya no dice qué leyó el agente hoy.
      output: {
        lesson_ids: context.lessonIds,
        human_input_ids: context.humanInputIds,
        statements: lessons.map((l) => l.statement),
      },
    });
  }

  return context;
}
