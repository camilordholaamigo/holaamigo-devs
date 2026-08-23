import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import {
  avanzarCola,
  cerrarPrueba,
  cerrarRunSiTerminó,
  leerPrueba,
  recogerSiEstancada,
} from '@/lib/pruebas/motor';
import { evaluarCerradasSinEvaluar } from '@/lib/pruebas/evaluador';
import { avanzarLote, cerrarLoteSiTerminó } from '@/lib/pruebas/lote';
import { ZOMBI_MS } from '@/lib/pruebas/types';

/**
 * GET /api/cron/pruebas — el watchdog del smoke tester.
 *
 * La red que recoge lo que las otras dos no ven. Las otras dos son el GET de
 * estado y el stream, que corren cada pocos segundos **mientras alguien tiene
 * la pestaña abierta**; ésta corre aunque no haya nadie mirando.
 *
 * Cuatro casos, en orden de cuánto daño hacen si no se atienden:
 *
 *   A · CONVERSACIÓN ESTANCADA. El negocio dejó de contestar. Se cierra con el
 *       veredicto que corresponde: `sin_respuesta` si nunca contestó,
 *       `incompleto` si se cortó a mitad.
 *
 *   B · COLA HUÉRFANA. La prueba anterior terminó pero la siguiente nunca
 *       arrancó, porque el proceso que la iba a arrancar murió. Se despierta.
 *
 *   C · ZOMBI. Una prueba en `running` sin ninguna actividad hace hora y
 *       media. Es la peor de las cuatro: mientras existe, se lleva los
 *       mensajes entrantes de las pruebas que sí están vivas contra ese
 *       número. Se mata.
 *
 *   D · SIN CALIFICAR. Pruebas cerradas por timeout —donde no hubo webhook y
 *       por lo tanto no corrió el disparo automático— que se quedaron sin
 *       evaluación.
 *
 * ── POR QUÉ HOY CORRE UNA VEZ AL DÍA, Y POR QUÉ IGUAL FUNCIONA ─────────────
 *
 * La lección del paquete de Rentmies es que **la red de seguridad tiene que
 * correr con la frecuencia del problema**: una conversación dura veinte
 * minutos, y un cron diario no rescata nada — limpia cadáveres al otro día.
 *
 * El plan Hobby de Vercel topa los crons a uno diario, así que esta ruta corre
 * a las 11:30 UTC y no cada cinco minutos. El smoke tester sobrevive a eso
 * porque la red REAL nunca fue este cron: es el GET de estado y el stream, que
 * la interfaz ya consulta cada pocos segundos y que cierran las pruebas
 * estancadas en el momento. Eso se diseñó así a propósito, antes de saber en
 * qué plan íbamos a estar.
 *
 * Lo que sí se pierde con el cron diario: una prueba de un cliente que cerró
 * la pestaña se queda `running` hasta el otro día. No corrompe nada —la
 * correlación es por número, así que no se lleva los mensajes de las
 * siguientes— pero ensucia el conteo de `resumen_de_pruebas` durante unas
 * horas.
 *
 * Con un plan Pro, devolverle a esta ruta su cron de cada cinco minutos en
 * `vercel.json` es la única línea que hay que cambiar.
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

  const reporte = { estancadas: 0, zombis: 0, colas: 0, evaluadas: 0, runs_cerrados: 0, lotes: 0 };

  try {
    // ── A y C · pruebas vivas ────────────────────────────────────────────
    const { data: vivas } = await db()
      .from('smoke_probes')
      .select('id, run_id, target_id, updated_at')
      .eq('estado', 'running')
      .limit(100);

    for (const fila of vivas ?? []) {
      try {
        const prueba = await leerPrueba(fila.id);

        if (Date.now() - Date.parse(prueba.updated_at) > ZOMBI_MS) {
          await cerrarPrueba(prueba.id, {
            estado: 'failed',
            cerroCon: null,
            motivo:
              'Zombi: sin actividad hace más de hora y media. Se cierra para que no se lleve los mensajes de las pruebas siguientes.',
          });
          reporte.zombis += 1;
          continue;
        }

        if (await recogerSiEstancada(prueba)) reporte.estancadas += 1;
      } catch (err) {
        console.error('[cron:pruebas] no se pudo revisar una prueba', err);
      }
    }

    // ── B · colas huérfanas ───────────────────────────────────────────────
    const { data: pendientes } = await db()
      .from('smoke_probes')
      .select('run_id, target_id')
      .eq('estado', 'pending')
      .limit(200);

    const combinaciones = new Map<string, { runId: string; targetId: string }>();
    for (const p of pendientes ?? []) {
      combinaciones.set(`${p.run_id}:${p.target_id}`, {
        runId: p.run_id,
        targetId: p.target_id,
      });
    }

    for (const { runId, targetId } of combinaciones.values()) {
      try {
        // `avanzarCola` es idempotente: si ya hay una corriendo, se retira.
        await avanzarCola(runId, targetId);
        reporte.colas += 1;
      } catch (err) {
        console.error('[cron:pruebas] no se pudo avanzar una cola', err);
      }
    }

    // ── D · sin calificar ─────────────────────────────────────────────────
    const { data: sinNota } = await db()
      .from('smoke_probes')
      .select('run_id')
      .in('estado', ['completed', 'timeout'])
      .is('evaluacion', null)
      .limit(50);

    for (const runId of new Set((sinNota ?? []).map((p) => p.run_id))) {
      reporte.evaluadas += await evaluarCerradasSinEvaluar(runId);
      await cerrarRunSiTerminó(runId);
      reporte.runs_cerrados += 1;
    }

    // ── E · lotes vivos ───────────────────────────────────────────────────
    //
    // Un lote avanza solo mientras las pruebas van cerrando: cada cierre libera
    // un cupo y empuja el siguiente arranque desde el webhook. Si el lote se
    // queda sin conversaciones vivas —porque todas fallaron al enviar, o porque
    // un despliegue mató el proceso que iba a arrancar la siguiente— nadie lo
    // vuelve a tocar. Éste es el único que lo despierta cuando no hay nadie
    // mirando la pantalla.
    const { data: lotesVivos } = await db()
      .from('smoke_batches')
      .select('id')
      .eq('estado', 'running')
      .limit(10);

    for (const lote of lotesVivos ?? []) {
      try {
        const { arrancadas } = await avanzarLote(lote.id);
        reporte.lotes += arrancadas;
        await cerrarLoteSiTerminó(lote.id);
      } catch (err) {
        console.error('[cron:pruebas] no se pudo avanzar un lote', err);
      }
    }
  } catch (err) {
    console.error('[cron:pruebas] falló', err);
    return NextResponse.json({ ok: false, reporte, error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...reporte });
}
