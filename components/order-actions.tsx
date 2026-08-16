'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Marcar una orden como pagada, a mano.
 *
 * Es el paso manual del ADR 0013: cobramos por fuera —transferencia, el link
 * de pago que el cliente ya usa— y acá se confirma. Cuando conectemos la
 * pasarela, este botón se queda para las ventas cobradas por otro medio.
 */
export function OrderActions({ orderId, orgId }: { orderId: string; orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await fetch(`/api/orders/${orderId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ organizationId: orgId, action: 'mark_paid' }),
            });
            if (!res.ok) {
              const data = (await res.json().catch(() => ({}))) as { error?: string };
              setError(data.error ?? 'No pudimos actualizar.');
              return;
            }
            router.refresh();
          })
        }
        className="rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition hover:border-ink"
      >
        {pending ? 'Un momento…' : 'Marcar como pagada'}
      </button>
      {error ? <span className="text-[12px] text-leak">{error}</span> : null}
    </div>
  );
}
