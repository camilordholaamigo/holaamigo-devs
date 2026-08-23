import { resumenDeCorrida } from '@/lib/pruebas/resumen';
import { db } from '@/lib/supabase/admin';
import { leerPrueba, recogerSiEstancada } from '@/lib/pruebas/motor';

/**
 * GET /api/pruebas/stream/[runId] — la conversación creciendo, en vivo.
 *
 * Mismo transporte y mismo argumento que el stream del research (ADR 0002):
 * SSE desde una ruta de servidor, en vez de Realtime, para no tener que abrir
 * una política de SELECT sobre estas tablas para `anon`.
 *
 * DIFERENCIA CON EL DEL RESEARCH: aquel manda las líneas nuevas del log; éste
 * manda **el resumen completo** cada vez que algo cambia. Es más gordo por
 * evento y es lo correcto acá: el cliente no está viendo una lista que crece,
 * está viendo tres conversaciones que avanzan cada una por su lado, y
 * reconstruir ese estado a partir de deltas en el navegador sería inventarse
 * una máquina de estados en el cliente para ahorrar unos kilobytes.
 *
 * Solo se emite cuando el resumen cambió de verdad —se compara la huella—, así
 * que una conversación quieta no manda nada. Un evento por segundo diciendo lo
 * mismo es lo que hace que las pestañas quemen batería.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const POLL_MS = 2_000;
const MAX_MS = 280_000;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const encoder = new TextEncoder();
  let cerrado = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (cerrado) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cerrado = true;
        }
      };

      const desde = Date.now();
      let huella = '';

      send('open', { runId });

      while (!cerrado && Date.now() - desde < MAX_MS) {
        // La misma red de seguridad del endpoint de estado: mientras alguien
        // mira, una prueba que se colgó se cierra sola. Es gratis porque ya
        // estamos leyendo la corrida.
        await recogerEstancadas(runId);

        const resumen = await resumenDeCorrida(runId);
        if (!resumen) {
          send('error', { message: 'corrida no encontrada' });
          break;
        }

        const nueva = huellaDe(resumen);
        if (nueva !== huella) {
          huella = nueva;
          send('estado', resumen);
        }

        if (resumen.vivas === 0) {
          send('finished', { estado: resumen.estado, titular: resumen.titular });
          break;
        }

        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      if (!cerrado) {
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      }
    },
    cancel() {
      cerrado = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

async function recogerEstancadas(runId: string): Promise<void> {
  const { data } = await db()
    .from('smoke_probes')
    .select('id')
    .eq('run_id', runId)
    .eq('estado', 'running');

  for (const fila of data ?? []) {
    try {
      await recogerSiEstancada(await leerPrueba(fila.id));
    } catch {
      /* se reintenta en el ciclo siguiente */
    }
  }
}

/**
 * Qué cuenta como «cambió».
 *
 * El cronómetro de espera NO entra en la huella a propósito: cambia cada
 * segundo y volvería el stream en un latido constante. Ese contador lo corre
 * el navegador con el `enviado_at` que ya tiene, que es igual de real y no
 * cuesta una petición.
 */
function huellaDe(r: Awaited<ReturnType<typeof resumenDeCorrida>>): string {
  if (!r) return '';
  return [
    r.estado,
    r.progreso.length,
    ...r.pruebas.map((p) =>
      [p.id, p.estado, p.turno, p.conversation.length, p.avance, p.cerro_con ?? '', p.evaluacion ? 1 : 0].join(':'),
    ),
  ].join('|');
}
