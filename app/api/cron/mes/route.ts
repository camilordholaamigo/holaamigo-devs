import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { organizacionesConAgentes } from '@/lib/feed/chapter';
import { importarCostosDeAgentes, periodoActual } from '@/lib/finance/economics';
import { forecast, guardarForecast } from '@/lib/finance/forecast';
import { proponerReasignacion } from '@/lib/finance/allocation';

/**
 * GET /api/cron/mes — el cierre del President (P4).
 *
 * Corre el día 1 a las 13:00 UTC (8 a.m. Bogotá), después del capítulo.
 * Tres cosas, en este orden:
 *
 *   1. Importa el costo de los agentes al P&G. Va primero: sin eso, la
 *      reasignación compara canales con un costo incompleto.
 *   2. Guarda el pronóstico del trimestre con sus supuestos.
 *   3. Propone cómo repartir el presupuesto del mes que arranca.
 *
 * La propuesta abre una deliberación y registra una decisión con predicción,
 * pero **no mueve un peso**: `budget.shift` tiene techo de plataforma L2. El
 * agente que razona sobre dinero no toca dinero (§13.1).
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

  const orgs = await organizacionesConAgentes();
  const reporte = {
    organizaciones: orgs.length,
    costos_importados: 0,
    pronosticos: 0,
    propuestas: 0,
    saltadas: [] as string[],
    fallidas: 0,
  };

  const finDeTrimestre = finDelTrimestre();

  for (const org of orgs) {
    try {
      reporte.costos_importados += await importarCostosDeAgentes(org);

      const pronostico = await forecast({ organizationId: org, horizonEnd: finDeTrimestre });
      await guardarForecast(org, pronostico);
      reporte.pronosticos += 1;

      const propuesta = await proponerReasignacion({
        organizationId: org,
        periodo: periodoActual(),
      });
      if (propuesta.proposalId) reporte.propuestas += 1;
      else if (propuesta.saltado) reporte.saltadas.push(propuesta.saltado);
    } catch (err) {
      reporte.fallidas += 1;
      console.error(`[cron/mes] ${org}`, err);
    }
  }

  return NextResponse.json({ ok: true, ...reporte });
}

/** El último día del trimestre en curso. */
function finDelTrimestre(hoy = new Date()): Date {
  const mes = hoy.getUTCMonth();
  const finMes = Math.floor(mes / 3) * 3 + 3;
  return new Date(Date.UTC(hoy.getUTCFullYear(), finMes, 0));
}
