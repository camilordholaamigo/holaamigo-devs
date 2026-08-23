import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { executeResearch, pushProgress } from '@/lib/research/run';
import { refreshAgentHealth } from '@/lib/agents/health';
import { expirarAprobaciones } from '@/lib/governance/approvals';
import { track } from '@/lib/events';

/**
 * GET /api/cron/sweep — el barrendero (PRD §8.3.4).
 *
 * `after()` mantiene la función viva después de responder, pero Vercel puede
 * matarla: despliegue en curso, timeout, error de infraestructura. Cuando eso
 * pasa, un `research_run` queda en `running` para siempre y el usuario ve una
 * barra de progreso que nunca avanza.
 *
 * Este cron es el seguro. Cada corrida:
 *   1. Reintenta corridas atascadas (máx. 2 intentos) o las marca `partial`.
 *   2. Recalcula la salud de los agentes (§9.4).
 *   3. Marca como abandonadas las sesiones muertas y registra los regresos.
 *
 * Protegido con CRON_SECRET. Vercel manda el header `authorization` con el
 * valor de la variable; sin ella la ruta queda abierta y cualquiera puede
 * disparar reintentos.
 *
 * OJO CON LA FRECUENCIA: se diseñó para correr cada 2 minutos y hoy corre una
 * vez al día, porque el plan Hobby de Vercel no permite más. La diferencia es
 * real y le pega al cliente: un research que se cuelga —la función murió a
 * mitad, hubo un despliegue en el medio— se queda colgado hasta el otro día, y
 * el cliente ve un diagnóstico que nunca carga. Es la primera razón para pasar
 * a Pro, y el arreglo es una línea en `vercel.json`.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const STUCK_MINUTES = 5;
const MAX_ATTEMPTS = 2;

export async function GET(request: Request) {
  if (env.cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
  }

  const report = {
    retried: 0,
    abandoned_runs: 0,
    sessions_abandoned: 0,
    returns: 0,
    agents_checked: 0,
    aprobaciones_vencidas: 0,
    aprobaciones_por_silencio: 0,
  };
  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();

  try {
    // ── 1 · Corridas atascadas ────────────────────────────────────────────
    const { data: stuck } = await db()
      .from('research_runs')
      .select('id, status, attempts, created_at, started_at')
      .in('status', ['queued', 'running'])
      .lt('created_at', cutoff)
      .limit(20);

    for (const run of stuck ?? []) {
      if ((run.attempts ?? 0) >= MAX_ATTEMPTS) {
        await pushProgress(
          run.id,
          'partial',
          'El análisis se quedó a medias — seguimos con lo que sí pudimos leer',
        );
        await db()
          .from('research_runs')
          .update({
            status: 'partial',
            finished_at: new Date().toISOString(),
            error: 'agotó los reintentos (barrido por cron)',
          })
          .eq('id', run.id);
        report.abandoned_runs += 1;
        continue;
      }

      try {
        await executeResearch(run.id);
        report.retried += 1;
      } catch (err) {
        console.error(`[cron] reintento fallido de ${run.id}`, err);
      }
    }

    // ── 2 · Salud de agentes ──────────────────────────────────────────────
    report.agents_checked = await refreshAgentHealth();

    // ── 2b · Tarjetas vencidas (P2) ───────────────────────────────────────
    //
    // Esto se escribió para correr cada 2 minutos: el SLA más corto es de 4
    // horas (pausar una campaña que está perdiendo plata), y ese tipo se
    // aprueba solo porque no hacerlo ES el daño.
    //
    // En Hobby el cron corre una vez al día, así que hoy ese SLA de 4 h es en
    // la práctica uno de 24 h con letra chica. Está dicho acá y en el
    // CHANGELOG para que nadie lo descubra el día que importe.
    const vencimientos = await expirarAprobaciones();
    report.aprobaciones_vencidas = vencimientos.rechazadas;
    report.aprobaciones_por_silencio = vencimientos.aprobadas;

    // ── 3 · Sesiones abandonadas y regresos ───────────────────────────────
    const abandonCutoff = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const { data: dead } = await db()
      .from('intake_sessions')
      .select('id, organization_id')
      .in('status', ['started', 'quiz'])
      .lt('last_seen_at', abandonCutoff)
      .limit(200);

    if (dead && dead.length > 0) {
      await db()
        .from('intake_sessions')
        .update({ status: 'abandoned' })
        .in(
          'id',
          dead.map((s) => s.id),
        );
      for (const session of dead) {
        await track('quiz_abandoned', {
          organizationId: session.organization_id,
          sessionId: session.id,
        });
      }
      report.sessions_abandoned = dead.length;
    }

    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    console.error('[cron/sweep] fallo', err);
    return NextResponse.json({ error: 'barrido incompleto', ...report }, { status: 500 });
  }
}
