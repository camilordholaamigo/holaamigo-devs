'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Los dos botones de una señal de upsell, en nuestro admin.
 *
 * La asimetría es la misma del feed del cliente y por la misma razón: promover
 * es un clic, descartar exige nota. La nota de descarte es la única señal de
 * aprendizaje que tenemos sobre qué detecciones no sirven — sin ella, la CMO
 * vuelve a detectar lo mismo la semana siguiente y el admin se llena de ruido
 * que ya rechazamos.
 */

const SIGUIENTE: Record<string, string> = {
  detected: 'Pasar a propuesta interna',
  proposed_internal: 'Ofrecérselo al cliente',
};

export function SignalActions({ signalId, status }: { signalId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [descartando, setDescartando] = useState(false);
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);

  const etiqueta = SIGUIENTE[status];

  function enviar(accion: 'promover' | 'descartar') {
    setError(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/senales', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signalId, accion, nota: nota || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No se pudo.');
        return;
      }
      setDescartando(false);
      setNota('');
      router.refresh();
    });
  }

  if (descartando) {
    return (
      <div className="space-y-2">
        <textarea
          value={nota}
          onChange={(event) => setNota(event.target.value)}
          rows={2}
          autoFocus
          placeholder="¿Por qué no sirve? Una línea."
          className="w-full rounded-lg border border-line-strong bg-paper-raised px-3 py-2 text-[13px] outline-none focus:border-ink"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending || nota.trim().length === 0}
            onClick={() => enviar('descartar')}
            className="rounded-lg bg-leak px-3 py-1.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
          >
            Descartar
          </button>
          <button
            type="button"
            onClick={() => setDescartando(false)}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-soft"
          >
            Cancelar
          </button>
        </div>
        {error ? <p className="text-[12px] text-leak">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {etiqueta ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => enviar('promover')}
          className="rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
        >
          {etiqueta}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setDescartando(true)}
        className="rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition hover:border-ink"
      >
        No sirve
      </button>
      {error ? <p className="text-[12px] text-leak">{error}</p> : null}
    </div>
  );
}
