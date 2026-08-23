import { NextResponse } from 'next/server';
import { z } from 'zod';
import { saveAnswer, getQuizState, markQuizCompleted } from '@/lib/quiz/service';
import { buildQuizPreview } from '@/lib/quiz/preview';
import { track } from '@/lib/events';
import { explainDbError } from '@/lib/supabase/admin';

/** Las dos respuestas que desbloquean el adelanto de la primera fuga. */
const PREVIEW_KEYS = new Set(['ticket_band', 'dormant_db']);

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
    await saveAnswer(sessionId, key, answer);

    const state = await getQuizState(sessionId);

    // Red de seguridad contra el bug que dejó el quiz muerto: si después de
    // guardar la respuesta el servidor devuelve la MISMA pregunta, algo no se
    // escribió. Antes eso salía como un 200 con la pantalla congelada y sin una
    // sola línea en los logs. Ahora es un 500 con nombre propio.
    if (state.question && (state.question.slot ?? state.question.id) === key) {
      throw new Error(
        `la respuesta a "${key}" no quedó guardada: el servidor devolvió la misma pregunta`,
      );
    }

    await track('quiz_answered', {
      organizationId: state.organizationId,
      sessionId,
      props: { key, answered: state.answeredCount },
    });

    if (state.done) {
      await markQuizCompleted(sessionId, state.organizationId);
    }

    // El adelanto solo se manda en la respuesta que lo desbloquea. Si se
    // mandara siempre que se puede calcular, la tarjeta reaparecería en cada
    // pregunta restante del quiz y dejaría de ser un momento para volverse
    // decorado. El número lo pone el servidor y no el navegador por la razón
    // de siempre: una sola fuente para la cifra (ADR 0007).
    const preview = PREVIEW_KEYS.has(key) ? buildQuizPreview(state.answers) : null;

    if (preview) {
      await track('quiz_preview_shown', {
        organizationId: state.organizationId,
        sessionId,
        props: { leak_usd: Math.round(preview.leak_usd), trigger: key },
      });
    }

    return NextResponse.json(
      {
        question: state.question,
        answeredCount: state.answeredCount,
        total: state.totalEstimate,
        done: state.done,
        organizationId: state.organizationId,
        preview,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    console.error('[quiz/answer] fallo:', explainDbError(err), '· diagnóstico completo en GET /api/health');
    return NextResponse.json(
      { error: 'No pudimos guardar tu respuesta. Ya nos llegó la alerta — vuelve a intentar.' },
      { status: 500 },
    );
  }
}
