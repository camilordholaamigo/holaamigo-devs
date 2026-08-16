import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { organizacionesConAgentes } from '@/lib/feed/chapter';
import { detectarCasos, redactarCaso } from '@/lib/cmo/proof';
import { evaluarSaturacion, proponerReemplazo } from '@/lib/cmo/angles';
import { snapshotCompetidor, competidoresDe } from '@/lib/cmo/competitors';
import { detectarSenales, registrarSenales } from '@/lib/cmo/upsell';

/**
 * GET /api/cron/cmo — el trabajo de la CMO (P5).
 *
 * Corre todos los días a las 14:00 UTC (9 a.m. Bogotá) y hace dos cosas
 * distintas según el día:
 *
 *   TODOS LOS DÍAS
 *   · Detecta deals cerrados y redacta el caso de estudio. El criterio es
 *     "menos de 24 horas": un caso que llega tres semanas después del cierre ya
 *     no tiene al cliente contento al teléfono.
 *   · Evalúa saturación de ángulos y propone reemplazo para los quemados.
 *
 *   LOS LUNES
 *   · Revisa los sitios de los competidores y alerta lo que cambió.
 *   · Detecta señales de upsell y las deja en NUESTRO admin.
 *
 * Es un solo cron con una rama y no dos crons, porque la mitad diaria y la
 * semanal comparten el recorrido de organizaciones y los mismos errores de
 * red. Dos rutas serían dos lugares donde arreglar lo mismo.
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

  const forzarSemanal = new URL(request.url).searchParams.get('semanal') === '1';
  const esLunes = new Date().getUTCDay() === 1 || forzarSemanal;

  const orgs = await organizacionesConAgentes();
  const reporte = {
    organizaciones: orgs.length,
    semanal: esLunes,
    casos_detectados: 0,
    casos_redactados: 0,
    angulos_evaluados: 0,
    reemplazos_propuestos: 0,
    competidores_revisados: 0,
    cambios_detectados: 0,
    senales_nuevas: 0,
    fallidas: 0,
  };

  for (const org of orgs) {
    try {
      // ── Prueba social ───────────────────────────────────────────────────
      const casos = await detectarCasos({ organizationId: org });
      reporte.casos_detectados += casos.length;
      for (const caso of casos) {
        const redactado = await redactarCaso(caso.id);
        if (redactado.ok) reporte.casos_redactados += 1;
      }

      // ── Fábrica de ángulos ──────────────────────────────────────────────
      const saturacion = await evaluarSaturacion(org);
      reporte.angulos_evaluados += saturacion.length;
      for (const angulo of saturacion.filter((s) => s.saturado)) {
        const reemplazo = await proponerReemplazo({ organizationId: org, saturado: angulo });
        if (reemplazo) reporte.reemplazos_propuestos += 1;
      }

      if (!esLunes) continue;

      // ── Inteligencia competitiva (semanal) ──────────────────────────────
      const competidores = await competidoresDe(org);
      for (const competidor of competidores) {
        reporte.competidores_revisados += 1;
        const cambios = await snapshotCompetidor({
          organizationId: org,
          competitor: competidor.name,
          url: competidor.url,
        });
        reporte.cambios_detectados += cambios.length;
      }

      // ── Señales de upsell (semanal, y solo para nosotros) ────────────────
      const senales = await detectarSenales(org);
      reporte.senales_nuevas += await registrarSenales(org, senales);
    } catch (err) {
      reporte.fallidas += 1;
      console.error(`[cron/cmo] ${org}`, err);
    }
  }

  return NextResponse.json({ ok: true, ...reporte });
}
