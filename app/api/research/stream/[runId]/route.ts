import { db } from '@/lib/supabase/admin';

/**
 * GET /api/research/stream/[runId] — progreso del research por SSE.
 *
 * DESVÍO DEL PRD, deliberado: el PRD (§8.3.3) dice Supabase Realtime. Usamos
 * Server-Sent Events desde una ruta de servidor.
 *
 * Por qué: Realtime respeta RLS, así que para que el navegador se suscriba
 * habría que abrir una política de SELECT sobre `research_runs` para `anon`.
 * Con solo el runId como secreto, eso deja el progress_log de cualquier
 * corrida a un UUID de distancia. SSE mantiene RLS en deny-by-default, evita
 * publicar la anon key, y le da al cliente exactamente el mismo efecto:
 * eventos empujados, sin polling visible.
 *
 * El costo es una función abierta ~2 min por sesión, que con Fluid Compute se
 * comparte entre invocaciones y no cuesta prácticamente nada.
 *
 * Fallback de polling: /api/research/status/[runId]
 * Ver docs/adr/0002-sse-en-vez-de-realtime.md
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const POLL_MS = 1200;
const MAX_MS = 240_000;

interface ProgressEntry {
  t: string;
  step: string;
  detail: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const startedAt = Date.now();
      let sentCount = 0;

      send('open', { runId });

      while (!closed && Date.now() - startedAt < MAX_MS) {
        const { data, error } = await db()
          .from('research_runs')
          .select('status, progress_log, error')
          .eq('id', runId)
          .maybeSingle();

        if (error) {
          send('error', { message: 'no se pudo leer el progreso' });
          break;
        }
        if (!data) {
          send('error', { message: 'corrida no encontrada' });
          break;
        }

        const log: ProgressEntry[] = Array.isArray(data.progress_log) ? data.progress_log : [];
        for (let i = sentCount; i < log.length; i += 1) {
          send('progress', log[i]);
        }
        sentCount = log.length;

        if (['done', 'partial', 'failed'].includes(data.status)) {
          send('finished', { status: data.status, error: data.error ?? null });
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }

      if (!closed) {
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      }
    },
    cancel() {
      closed = true;
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
