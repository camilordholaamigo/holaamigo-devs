'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * El indicador vivo del research (PRD §4.2).
 *
 * "No es decorativo: es lo que sostiene la atención durante el quiz."
 * Cada línea que aparece aquí corresponde a algo que de verdad pasó: una
 * página que se abrió, un competidor que se encontró. Nada se inventa para
 * llenar el tiempo — si el research se demora, el ticker se queda quieto, y
 * eso también es información honesta.
 *
 * **Por qué es una línea de tiempo y no una sola línea.** `progress_log` guarda
 * hasta 40 entradas con su timestamp y esto renderizaba únicamente la última.
 * Una línea que cambia cada tanto se lee como un spinner con texto: no prueba
 * nada. La lista con los tiempos reales sí — se ve que abrimos la home, que
 * después fuimos a precios, y cuánto tardó cada cosa. Ese acumulado es lo único
 * que distingue "está pensando" de "está cargando".
 *
 * Se muestran las últimas cuatro. Vive encima de la pregunta del quiz: si
 * crece más, empuja la pregunta fuera de la pantalla en un teléfono y el quiz
 * pierde más de lo que el ticker gana.
 *
 * Transporte: SSE. Si el navegador o un proxy corporativo corta
 * `text/event-stream`, cae solo a polling contra /api/research/status.
 * Ver docs/adr/0002-sse-en-vez-de-realtime.md
 */

/** Cuántos pasos se ven a la vez. */
const VENTANA = 4;

interface Entry {
  t: string;
  step: string;
  detail: string;
}

export function ResearchTicker({
  runId,
  domain,
  onFinished,
}: {
  runId: string | null;
  domain: string;
  onFinished?: (status: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'running' | 'done' | 'partial' | 'failed'>('running');
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!runId) return;

    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const finish = (next: string) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setStatus(next as typeof status);
      onFinished?.(next);
    };

    const startPolling = () => {
      const tick = async () => {
        if (cancelled) return;
        try {
          const response = await fetch(`/api/research/status/${runId}`, { cache: 'no-store' });
          const data = await response.json();
          if (Array.isArray(data.progress)) setEntries(data.progress);
          if (data.finished) {
            finish(data.status);
            return;
          }
        } catch {
          /* reintentamos en el siguiente tick */
        }
        pollTimer = setTimeout(tick, 2500);
      };
      void tick();
    };

    try {
      source = new EventSource(`/api/research/stream/${runId}`);

      source.addEventListener('progress', (event) => {
        const entry = JSON.parse((event as MessageEvent).data) as Entry;
        setEntries((prev) => (prev.some((e) => e.t === entry.t && e.detail === entry.detail) ? prev : [...prev, entry]));
      });

      source.addEventListener('finished', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { status: string };
        finish(data.status);
        source?.close();
      });

      source.onerror = () => {
        source?.close();
        source = null;
        if (!finishedRef.current && !cancelled) startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [runId, onFinished]);

  const running = status === 'running';
  const visibles = entries.slice(-VENTANA);
  const origen = entries[0] ? Date.parse(entries[0].t) : null;
  const transcurrido =
    origen !== null && entries.length > 1
      ? Math.round((Date.parse(entries[entries.length - 1].t) - origen) / 1000)
      : null;

  return (
    <div className="rounded-xl border border-line bg-paper-sunken px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              running ? 'pulse-dot bg-money-bright' : status === 'failed' ? 'bg-leak' : 'bg-money'
            }`}
            aria-hidden
          />
          {running ? `Analizando ${domain}` : status === 'failed' ? 'Análisis incompleto' : 'Análisis listo'}
        </p>
        {entries.length > 1 ? (
          <span className="tnum shrink-0 text-[11px] text-ink-faint">
            {entries.length} {entries.length === 1 ? 'paso' : 'pasos'}
            {transcurrido !== null ? ` · ${transcurrido}s` : ''}
          </span>
        ) : null}
      </div>

      <ol className="mt-2.5 space-y-1.5" aria-live="polite">
        {visibles.length === 0 ? (
          <li className="text-[13.5px] font-medium text-ink-faint">Poniendo el análisis en cola…</li>
        ) : (
          visibles.map((entry, index) => {
            const ultimo = index === visibles.length - 1;
            const segundos =
              origen !== null ? Math.max(0, Math.round((Date.parse(entry.t) - origen) / 1000)) : null;

            return (
              <li
                key={`${entry.t}-${entry.step}`}
                className="slide-in flex items-baseline gap-2.5"
                // Los pasos viejos se apagan en vez de desaparecer: el que
                // llega tiene que verse llegar, si no la lista parece estática.
                style={{ opacity: ultimo ? 1 : 0.45 }}
              >
                <span
                  className="tnum w-9 shrink-0 text-right text-[11px] text-ink-faint"
                  aria-hidden
                >
                  {segundos !== null ? `+${segundos}s` : ''}
                </span>
                <span
                  className={`min-w-0 flex-1 text-[13px] leading-snug ${
                    ultimo ? 'font-medium text-ink' : 'text-ink-soft'
                  }`}
                >
                  {entry.detail}
                </span>
              </li>
            );
          })
        )}
      </ol>
    </div>
  );
}
