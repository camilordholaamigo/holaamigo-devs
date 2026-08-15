import { NextResponse } from 'next/server';
import { z } from 'zod';
import { saveAnswer, getQuizState, markQuizCompleted } from '@/lib/quiz/service';
import { track } from '@/lib/events';

/**
 * POST /api/quiz/answer — persiste una respuesta y devuelve la siguiente.
 *
 * Guardado incremental (§4.2): cada respuesta persiste al instante. Si el
 * usuario cierra la pestaña en la pregunta 4, tenemos data parcial y un lead
 * recuperable. Nunca acumulamos respuestas en el cliente para mandarlas al
 * final: perder ese estado es perder el lead.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  sessionId: z.string().uuid(),
  key: z.string().min(1).max(60),
  answer: z.unknown(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Respuesta inválida' }, { status: 400 });
  }

  const { sessionId, key, answer } = parsed.data;

  try {
    await saveAnswer(sessionId, key, answer ?? null);

    const state = await getQuizState(sessionId);

    await track('quiz_answered', {
      organizationId: state.organizationId,
      sessionId,
      props: { key, answered: state.answeredCount },
    });

    if (state.done) {
      await markQuizCompleted(sessionId, state.organizationId);
    }

    return NextResponse.json(
      {
        question: state.question,
        answeredCount: state.answeredCount,
        total: state.totalEstimate,
        done: state.done,
        organizationId: state.organizationId,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    console.error('[quiz/answer] fallo', err);
    return NextResponse.json({ error: 'No pudimos guardar tu respuesta.' }, { status: 500 });
  }
}
