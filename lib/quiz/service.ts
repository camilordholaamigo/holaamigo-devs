import { db, unwrap, mustWrite, tryWrite } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import { AdaptiveQuestionsSchema } from '@/lib/ai/schemas';
import { ADAPTIVE_QUESTION_SYSTEM } from '@/config/prompts';
import { findingsForOrganization } from '@/lib/research/run';
import {
  FIXED_QUESTIONS,
  CLOSING_QUESTION,
  FALLBACK_ADAPTIVE,
  ADAPTIVE_SLOTS,
  type QuizQuestion,
} from '@/lib/quiz/bank';
import { track } from '@/lib/events';

/**
 * El quiz (PRD §4.2, §6).
 *
 * Estructura: 6 fijas → hasta 5 adaptadas → 1 de cierre. Tope duro de 12 en
 * pantalla, como pide el PRD.
 *
 * Cada respuesta persiste al instante (§4.2 — guardado incremental). Si el
 * usuario abandona en la pregunta 4, tenemos data parcial y un lead
 * recuperable. Eso es más importante que la elegancia del flujo.
 *
 * Ver docs/wiki/05-quiz-adaptativo.md
 */

const MAX_ADAPTIVE = 5;
/** Piso de adaptativas. `ensureAdaptive` completa con el respaldo hasta acá. */
const MIN_ADAPTIVE = 4;
/** Cuánto esperamos al research antes de generar las adaptativas sin él. */
const RESEARCH_WAIT_MS = 12_000;

export interface QuizState {
  sessionId: string;
  organizationId: string;
  question: QuizQuestion | null;
  answeredCount: number;
  totalEstimate: number;
  done: boolean;
  /** Respuestas ya dadas, para poder volver atrás. */
  answers: Record<string, unknown>;
}

async function fixedQuestions(): Promise<QuizQuestion[]> {
  try {
    const { data } = await db()
      .from('quiz_questions')
      .select('*')
      .eq('active', true)
      .neq('id', CLOSING_QUESTION.id)
      .order('sort_order');
    if (data && data.length > 0) {
      return data.map((row) => ({
        id: row.id,
        category: row.category,
        prompt: row.prompt,
        help_text: row.help_text,
        input_type: row.input_type,
        options: row.options ?? [],
        required: row.required,
        sort_order: row.sort_order ?? 0,
        kind: 'fixed' as const,
      }));
    }
  } catch {
    // La tabla puede no existir todavía en un entorno recién creado.
  }
  return FIXED_QUESTIONS;
}

async function closingQuestion(): Promise<QuizQuestion> {
  try {
    const { data } = await db()
      .from('quiz_questions')
      .select('*')
      .eq('id', CLOSING_QUESTION.id)
      .maybeSingle();
    if (data) {
      return {
        id: data.id,
        category: data.category,
        prompt: data.prompt,
        help_text: data.help_text,
        input_type: data.input_type,
        options: data.options ?? [],
        required: data.required,
        sort_order: data.sort_order ?? 900,
        kind: 'closing',
      };
    }
  } catch {
    /* fallback abajo */
  }
  return CLOSING_QUESTION;
}

export async function getAnswers(sessionId: string): Promise<Record<string, unknown>> {
  const { data } = await db()
    .from('quiz_responses')
    .select('question_id, slot, answer')
    .eq('session_id', sessionId);

  const answers: Record<string, unknown> = {};
  for (const row of data ?? []) {
    const key = row.question_id ?? row.slot;
    if (key) answers[key] = row.answer;
  }
  return answers;
}

export async function saveAnswer(
  sessionId: string,
  key: string,
  answer: unknown,
): Promise<void> {
  const isGenerated = (ADAPTIVE_SLOTS as readonly string[]).includes(key);

  const row: {
    session_id: string;
    question_id: string | null;
    slot: string | null;
    answer: unknown;
  } = isGenerated
    ? { session_id: sessionId, question_id: null, slot: key, answer: normalizeAnswer(answer) }
    : { session_id: sessionId, question_id: key, slot: null, answer: normalizeAnswer(answer) };

  // Clave única: `answer_key` es una columna generada = coalesce(question_id,
  // slot), con un índice único PLANO encima. Antes había dos índices parciales
  // y dos `onConflict` distintos, y ninguno de los dos funcionaba: Postgres no
  // puede usar un índice parcial como árbitro de un ON CONFLICT que no repite
  // su predicado, así que cada respuesta fallaba con 42P10.
  // Ver supabase/migrations/0005 y docs/adr/0015.
  await mustWrite(
    db().from('quiz_responses').upsert(row, { onConflict: 'session_id,answer_key' }),
    'quiz_responses.upsert',
  );

  await mustWrite(
    db()
      .from('intake_sessions')
      .update({ status: 'quiz', last_seen_at: new Date().toISOString() })
      .eq('id', sessionId)
      .in('status', ['started', 'quiz']),
    'intake_sessions.touch',
  );
}

/**
 * `answer` es `jsonb not null`: guardar SQL NULL falla, y ese NOT NULL es
 * deliberado — es lo que hace distinguibles "respondió y saltó" (cadena vacía)
 * de "no ha respondido" (no hay fila). Una pregunta saltada tiene que contar
 * como respondida o el quiz nunca avanza de ella.
 */
function normalizeAnswer(answer: unknown): unknown {
  return answer === undefined || answer === null ? '' : answer;
}

/** Preguntas adaptativas ya generadas para esta sesión. */
async function generatedQuestions(sessionId: string): Promise<QuizQuestion[]> {
  const { data } = await db()
    .from('quiz_generated')
    .select('*')
    .eq('session_id', sessionId)
    .order('sort_order');

  return (data ?? []).map((row) => ({
    id: `gen_${row.slot}`,
    slot: row.slot,
    category: 'adaptada',
    prompt: row.prompt,
    help_text: row.help_text,
    input_type: row.input_type,
    options: row.options ?? [],
    required: row.slot === 'goal_90d',
    sort_order: row.sort_order,
    kind: 'generated' as const,
  }));
}

/**
 * Genera las adaptativas. Se llama una sola vez por sesión, cuando el usuario
 * termina las fijas. Si el research todavía corre, esperamos un poco: llegar
 * con hallazgos vale mucho más que llegar rápido, y el usuario acaba de pasar
 * dos minutos respondiendo.
 */
async function ensureAdaptive(
  sessionId: string,
  organizationId: string,
  answers: Record<string, unknown>,
): Promise<QuizQuestion[]> {
  const existing = await generatedQuestions(sessionId);
  if (existing.length > 0) return existing;

  const deadline = Date.now() + RESEARCH_WAIT_MS;
  let research = await findingsForOrganization(organizationId);
  while (
    (research.status === 'queued' || research.status === 'running') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    research = await findingsForOrganization(organizationId);
  }

  let questions: QuizQuestion[] = [];

  const hasFindings = Object.keys(research.sections).length > 0;
  if (hasFindings) {
    try {
      const org = unwrap(
        await db()
          .from('organizations')
          .select('name, domain, website_url')
          .eq('id', organizationId)
          .single(),
        'organizations.get',
      );

      const result = await runStructured({
        step: 'adaptive_question',
        schemaName: 'adaptive_questions',
        schema: AdaptiveQuestionsSchema,
        system: ADAPTIVE_QUESTION_SYSTEM,
        input: [
          `EMPRESA: ${org.name ?? org.domain} (${org.website_url})`,
          '',
          'HALLAZGOS DEL RESEARCH:',
          JSON.stringify(research.sections, null, 1).slice(0, 12_000),
          '',
          'YA RESPONDIÓ ESTO:',
          JSON.stringify(answers, null, 1).slice(0, 3_000),
        ].join('\n'),
        organizationId,
        role: 'cmo',
        trigger: 'intake',
      });

      questions = result.data.questions
        .filter((q) => (ADAPTIVE_SLOTS as readonly string[]).includes(q.slot))
        .slice(0, MAX_ADAPTIVE)
        .map((q, index) => ({
          id: `gen_${q.slot}`,
          slot: q.slot,
          category: 'adaptada',
          prompt: q.prompt,
          help_text: q.help_text,
          input_type: q.input_type,
          options: q.options,
          required: q.slot === 'goal_90d',
          sort_order: 100 + index * 10,
          kind: 'generated' as const,
        }));
    } catch (err) {
      console.error('[quiz] fallo generando adaptativas, usando respaldo', err);
    }
  }

  // goal_90d es obligatoria: alimenta la cuenta al revés. Si el modelo no la
  // devolvió (o no hubo modelo), la ponemos nosotros.
  if (!questions.some((q) => q.slot === 'goal_90d')) {
    const fallbackGoal = FALLBACK_ADAPTIVE.find((q) => q.slot === 'goal_90d')!;
    questions = [...questions.slice(0, MAX_ADAPTIVE - 1), fallbackGoal];
  }

  // Si quedaron muy pocas, completamos con el respaldo.
  if (questions.length < MIN_ADAPTIVE) {
    for (const fallback of FALLBACK_ADAPTIVE) {
      if (questions.length >= MIN_ADAPTIVE) break;
      if (questions.some((q) => q.slot === fallback.slot)) continue;
      questions.push(fallback);
    }
  }

  questions = questions
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((q, index) => ({ ...q, sort_order: 100 + index * 10 }));

  // Si esta escritura se pierde, la siguiente pantalla del quiz vuelve a
  // llamar al modelo: cobra dos veces y puede cambiar las preguntas a mitad de
  // camino. Por eso `mustWrite` y no un await pelado.
  await mustWrite(
    db()
      .from('quiz_generated')
      .upsert(
        questions.map((q) => ({
          session_id: sessionId,
          slot: q.slot!,
          prompt: q.prompt,
          help_text: q.help_text,
          input_type: q.input_type,
          options: q.options,
          sort_order: q.sort_order,
        })),
        { onConflict: 'session_id,slot' },
      ),
    'quiz_generated.upsert',
  );

  return questions;
}

export async function getQuizState(sessionId: string): Promise<QuizState> {
  const session = unwrap(
    await db()
      .from('intake_sessions')
      .select('id, organization_id, status')
      .eq('id', sessionId)
      .single(),
    'intake_sessions.get',
  );

  const [fixed, closing, answers] = await Promise.all([
    fixedQuestions(),
    closingQuestion(),
    getAnswers(sessionId),
  ]);

  const pendingFixed = fixed.find((q) => !(q.id in answers));
  if (pendingFixed) {
    return {
      sessionId,
      organizationId: session.organization_id,
      question: pendingFixed,
      answeredCount: Object.keys(answers).length,
      // Todavía no sabemos cuántas adaptativas van a salir. Se estima con el
      // PISO (4, el mínimo que garantiza `ensureAdaptive`) y no con el techo,
      // para que el total solo pueda crecer. Una barra de progreso que retrocede
      // se lee como un error del producto.
      totalEstimate: fixed.length + MIN_ADAPTIVE + 1,
      done: false,
      answers,
    };
  }

  const adaptive = await ensureAdaptive(sessionId, session.organization_id, answers);
  const pendingAdaptive = adaptive.find((q) => !(q.slot! in answers));
  const total = fixed.length + adaptive.length + 1;

  if (pendingAdaptive) {
    return {
      sessionId,
      organizationId: session.organization_id,
      question: pendingAdaptive,
      answeredCount: Object.keys(answers).length,
      totalEstimate: total,
      done: false,
      answers,
    };
  }

  if (!(closing.id in answers)) {
    return {
      sessionId,
      organizationId: session.organization_id,
      question: closing,
      answeredCount: Object.keys(answers).length,
      totalEstimate: total,
      done: false,
      answers,
    };
  }

  return {
    sessionId,
    organizationId: session.organization_id,
    question: null,
    answeredCount: Object.keys(answers).length,
    totalEstimate: total,
    done: true,
    answers,
  };
}

export async function markQuizCompleted(sessionId: string, organizationId: string) {
  // `tryWrite`: el quiz ya terminó y el diagnóstico se va a generar igual. No
  // vale la pena devolverle un 500 al cliente por un cambio de estado que el
  // cron de barrido puede corregir después.
  await tryWrite(
    db()
      .from('intake_sessions')
      .update({ status: 'diagnosed', completed_at: new Date().toISOString() })
      .eq('id', sessionId),
    'intake_sessions.completed',
  );
  await track('quiz_completed', { organizationId, sessionId });
}
