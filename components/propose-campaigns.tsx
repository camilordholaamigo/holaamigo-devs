'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Disparar el armado de las tres campañas.
 *
 * Tarda entre 20 y 60 segundos porque el CMO escribe el copy de las tres
 * secuencias. Lo decimos en el botón: un spinner sin explicación hace que la
 * gente recargue a los 15 segundos y dispare el trabajo dos veces.
 */
export function ProposeCampaigns({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function propose() {
    setError(null);
    startTransition(async () => {
      const res = await fetch('/api/campaigns/propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos armar las campañas.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={propose}
        className="rounded-xl bg-ink px-5 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
      >
        {pending ? 'El CMO está escribiendo… (hasta un minuto)' : 'Armar mis tres campañas'}
      </button>
      {error ? <p className="text-[13px] text-leak">{error}</p> : null}
    </div>
  );
}
