import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateDiagnostic } from '@/lib/diagnostic/generate';
import { db, explainDbError } from '@/lib/supabase/admin';

/**
 * POST /api/diagnostic/generate — el President ensambla y devuelve el enlace.
 *
 * Es idempotente por sesión: llamarla dos veces devuelve el mismo diagnóstico.
 * Importante porque el cliente la llama al terminar el quiz y React puede
 * disparar el efecto dos veces en desarrollo.
 *
 * Espera al research si todavía corre, pero con techo: pasados 45 segundos
 * genera con lo que haya. Nunca dejamos al usuario sin salida (§8.3.5).
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({ sessionId: z.string().uuid() });

const RESEARCH_WAIT_MS = 45_000;

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'sessionId inválido' }, { status: 400 });
  }

  const { sessionId } = parsed.data;

  try {
    const { data: session } = await db()
      .from('intake_sessions')
      .select('id, organization_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (!session) {
      return NextResponse.json({ error: 'Sesión no encontrada' }, { status: 404 });
    }

    // Si el research sigue vivo, le damos margen: el diagnóstico con research
    // completo vale mucho más, y el usuario ya está mirando una pantalla de
    // carga que le explica qué está pasando.
    const deadline = Date.now() + RESEARCH_WAIT_MS;
    for (;;) {
      const { data: run } = await db()
        .from('research_runs')
        .select('status')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const status = run?.status ?? 'none';
      if (!['queued', 'running'].includes(status)) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const result = await generateDiagnostic({
      sessionId,
      organizationId: session.organization_id,
    });

    return NextResponse.json({
      shareToken: result.shareToken,
      next: `/diagnostico/${result.shareToken}`,
      researchQuality: result.researchQuality,
      degraded: result.degraded,
    });
  } catch (err) {
    console.error('[diagnostic/generate] fallo:', explainDbError(err), '· diagnóstico completo en GET /api/health');
    return NextResponse.json(
      { error: 'No pudimos armar el diagnóstico. Ya nos llegó la alerta.' },
      { status: 500 },
    );
  }
}
