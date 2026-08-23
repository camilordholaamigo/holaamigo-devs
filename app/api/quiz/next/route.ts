import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getQuizState } from '@/lib/quiz/service';
import { buildQuizPreview } from '@/lib/quiz/preview';
import { db, explainDbError } from '@/lib/supabase/admin';

/**
 * POST /api/quiz/next — devuelve la siguiente pregunta.
 *
 * Es POST y no GET porque la primera llamada después de las fijas dispara la
 * generación de las adaptativas: tiene efecto de escritura y no debe cachearse
 * ni pre-fetchearse por el navegador.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({ sessionId: z.string().uuid() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'sessionId inválido' }, { status: 400 });
  }

  try {
    const state = await getQuizState(parsed.data.sessionId);

    // El runId lo necesita el quiz para abrir el stream de progreso.
    const { data: run } = await db()
      .from('research_runs')
      .select('id, status')
      .eq('session_id', parsed.data.sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json(
      {
        question: state.question,
        answeredCount: state.answeredCount,
        total: state.totalEstimate,
        done: state.done,
        answers: state.answers,
        organizationId: state.organizationId,
        runId: run?.id ?? null,
        researchStatus: run?.status ?? 'none',
        // Sin `track`: acá el adelanto se devuelve para que sobreviva a un
        // refresco de la página, no porque sea la primera vez que se muestra.
        // Contarlo también aquí inflaría `quiz_preview_shown` con recargas.
        preview: buildQuizPreview(state.answers),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    console.error('[quiz/next] fallo:', explainDbError(err), '· diagnóstico completo en GET /api/health');
    return NextResponse.json({ error: 'No pudimos cargar la pregunta.' }, { status: 500 });
  }
}
