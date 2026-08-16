import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { destilarTodo } from '@/lib/learning/distill';

/**
 * GET /api/cron/destilar — la noche del sustrato (P1).
 *
 * Corre a las 07:00 UTC (2 a.m. en Bogotá) y hace cuatro cosas, en este orden:
 *
 *   1. Destila lecciones por organización a partir de decisiones ya medidas.
 *   2. Calcula los vectores de las lecciones nuevas.
 *   3. Imputa el costo de cada corrida a las decisiones que produjo.
 *   4. Purga trazas de más de 90 días.
 *
 * De noche y no en vivo porque nada de esto es urgente y todo es pesado: son
 * agregaciones sobre la tabla más grande del sistema. Que una lección tarde
 * hasta 24 horas en activarse es aceptable; que una corrida del cliente espere
 * por una agregación, no.
 *
 * Protegido con CRON_SECRET, igual que /api/cron/sweep.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (env.cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
  }

  try {
    const reporte = await destilarTodo();
    const totales = reporte.resumenes.reduce(
      (acc, r) => ({
        creadas: acc.creadas + r.creadas,
        activadas: acc.activadas + r.activadas,
        retiradas: acc.retiradas + r.retiradas,
        fallidas: acc.fallidas + (r.error ? 1 : 0),
      }),
      { creadas: 0, activadas: 0, retiradas: 0, fallidas: 0 },
    );

    return NextResponse.json({
      ok: true,
      organizaciones: reporte.organizaciones,
      ...totales,
      costos_imputados: reporte.costos_imputados,
      trazas_purgadas: reporte.trazas_purgadas,
    });
  } catch (err) {
    console.error('[cron/destilar] fallo', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'destilado incompleto' },
      { status: 500 },
    );
  }
}
