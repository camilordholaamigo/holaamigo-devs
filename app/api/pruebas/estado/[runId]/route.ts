import { NextResponse, after } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { leerPrueba, recogerSiEstancada, avanzarCola } from '@/lib/pruebas/motor';
import { evaluarCerradasSinEvaluar } from '@/lib/pruebas/evaluador';
import { resumenDeCorrida } from '@/lib/pruebas/resumen';

/**
 * GET /api/pruebas/estado/[runId] — el estado de una corrida, y la red de
 * seguridad que de verdad funciona.
 *
 * Hace dos cosas y la segunda no es obvia:
 *
 * 1. Devuelve el resumen que pintan el diagnóstico del cliente y el admin. Es
 *    el fallback de polling del SSE (mismo criterio que ADR 0002).
 *
 * 2. **RECOGE LAS PRUEBAS ESTANCADAS.** Si el negocio nunca contesta no hay
 *    webhook, y sin webhook no hay quien cierre la prueba: queda en `running`
 *    para siempre. Hay un cron que barre eso, pero un cron cada cinco minutos
 *    no rescata una conversación mientras el cliente la está mirando. Esta
 *    ruta ya se consulta cada pocos segundos mientras hay algo vivo, así que
 *    la red sale gratis y corre con la frecuencia del problema.
 *
 *    El cron sigue existiendo para lo que esta ruta no ve: las corridas de
 *    clientes que cerraron la pestaña.
 *
 * Público a propósito: la conoce quien tiene el `runId`, que es el mismo
 * criterio del stream del research. No expone nada que el cliente no vaya a
 * ver en su propio diagnóstico.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const { data: vivas } = await db()
    .from('smoke_probes')
    .select('id')
    .eq('run_id', runId)
    .eq('estado', 'running');

  let recogidas = 0;
  for (const fila of vivas ?? []) {
    try {
      const prueba = await leerPrueba(fila.id);
      if (await recogerSiEstancada(prueba)) recogidas += 1;
    } catch (err) {
      // Que falle la recolección de una no puede impedir devolver el estado de
      // las demás: el cliente está mirando la pantalla.
      console.error('[pruebas] no se pudo recoger', err);
    }
  }

  // Una cola cuyo avanzador murió —la prueba anterior terminó pero la
  // siguiente nunca arrancó— se despierta acá. Barato: solo si no quedó
  // ninguna corriendo y sí quedan pendientes.
  if (recogidas > 0) {
    const { data: pendientes } = await db()
      .from('smoke_probes')
      .select('target_id, channel_id')
      .eq('run_id', runId)
      .eq('estado', 'pending');

    // Por par (línea, número): con dos de nuestras líneas contra el mismo
    // negocio, despertar solo por número dejaba la segunda dormida.
    const colas = new Map((pendientes ?? []).map((p) => [
      `${p.target_id}:${p.channel_id}`,
      p,
    ]));
    for (const p of colas.values()) {
      await avanzarCola(runId, p.target_id, p.channel_id).catch(() => {});
    }
  }

  const resumen = await resumenDeCorrida(runId);
  if (!resumen) {
    return NextResponse.json({ error: 'corrida no encontrada' }, { status: 404 });
  }

  // Las que cerraron y no tienen nota se califican después de responder. Es la
  // segunda red del disparo automático: la primera vive en el webhook, y no
  // corre cuando la prueba la cerró un timeout —porque justamente en ese caso
  // no hubo webhook.
  if (resumen.pruebas.some((p) => p.estado === 'cerrada' && !p.evaluacion)) {
    after(() => evaluarCerradasSinEvaluar(runId).catch(() => {}));
  }

  return NextResponse.json(resumen, {
    headers: { 'cache-control': 'no-store' },
  });
}
