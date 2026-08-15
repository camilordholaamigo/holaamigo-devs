'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Band } from '@/lib/scoring';

/**
 * §9.1 — override manual de banda.
 *
 * La nota es obligatoria y el botón está deshabilitado sin ella. No es
 * burocracia: el score se recalcula solo cada vez que pasa algo, y un override
 * sin explicación es un número que nadie va a saber por qué está ahí en dos
 * semanas.
 */

const BANDS: { value: Band; label: string }[] = [
  { value: 'auto', label: 'AUTO' },
  { value: 'assist', label: 'ASSIST' },
  { value: 'attack', label: 'ATTACK' },
];

export function BandOverride({
  organizationId,
  current,
}: {
  organizationId: string;
  current: Band;
}) {
  const router = useRouter();
  const [band, setBand] = useState<Band>(current);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/band', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, band, note }),
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data.error ?? 'No se pudo cambiar la banda.');
        setBusy(false);
        return;
      }
      setNote('');
      router.refresh();
    } catch {
      setError('Sin conexión.');
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {BANDS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setBand(option.value)}
            className={`rounded-lg px-3.5 py-2 text-[12.5px] font-semibold transition ${
              band === option.value
                ? 'bg-ink text-paper'
                : 'border border-line-strong text-ink-soft hover:border-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Por qué cambias la banda (obligatorio)"
        className="w-full rounded-lg border border-line bg-paper px-3.5 py-2.5 text-[13.5px] text-ink placeholder:text-ink-faint/70 focus:border-money-bright focus:outline-none"
      />

      {error ? <p className="text-[12.5px] text-leak">{error}</p> : null}

      <button
        type="button"
        disabled={busy || !note.trim() || band === current}
        onClick={submit}
        className="rounded-lg bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
      >
        {busy ? 'Guardando…' : 'Cambiar banda'}
      </button>
    </div>
  );
}
