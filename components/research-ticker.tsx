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
 * Transporte: SSE. Si el navegador o un proxy corporativo corta
 * `text/event-stream`, cae solo a polling contra /api/research/status.
 * Ver docs/adr/0002-sse-en-vez-de-realtime.md
 */

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

  const latest = entries.at(-1);
  const running = status === 'running';

  return (
    <div className="rounded-xl border border-line bg-paper-sunken px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            running ? 'pulse-dot bg-money-bright' : status === 'failed' ? 'bg-leak' : 'bg-money'
          }`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            {running ? `Analizando ${domain}` : status === 'failed' ? 'Análisis incompleto' : 'Análisis listo'}
          </p>
          <p
            key={latest?.detail}
            className="slide-in mt-0.5 truncate text-[13.5px] font-medium text-ink"
            aria-live="polite"
          >
            {latest?.detail ?? 'Poniendo el análisis en cola…'}
          </p>
        </div>
        {entries.length > 1 ? (
          <span className="tnum shrink-0 pt-1 text-[11px] text-ink-faint">
            {entries.length} pasos
          </span>
        ) : null}
      </div>
    </div>
  );
}
