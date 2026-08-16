'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Resolver un pedido de habilidad.
 *
 * Otorgar hace dos cosas en una: enciende la habilidad para ese rol en esa
 * organización y marca el pedido como resuelto. Que sea un solo clic es
 * deliberado — si otorgar exigiera después ir a otra pantalla a encender la
 * habilidad, la mitad de los pedidos quedarían "aprobados" y sin efecto.
 *
 * Rechazar exige nota, igual que en todos los rechazos del producto: es lo
 * único que le dice al agente por qué no, y sin eso vuelve a pedir lo mismo la
 * semana siguiente.
 */

export function SkillRequestActions({
  requestId,
  skillId,
  organizationId,
  role,
}: {
  requestId: string;
  skillId: string | null;
  organizationId: string | null;
  role: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rechazando, setRechazando] = useState(false);
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);

  function enviar(accion: 'otorgar' | 'rechazar') {
    setError(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/habilidades', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, accion, nota: nota || null, skillId, organizationId, role }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No se pudo.');
        return;
      }
      setRechazando(false);
      setNota('');
      router.refresh();
    });
  }

  if (rechazando) {
    return (
      <div className="space-y-2">
        <textarea
          value={nota}
          onChange={(event) => setNota(event.target.value)}
          rows={2}
          autoFocus
          placeholder="¿Por qué no? El agente lo va a leer la próxima vez que lo intente."
          className="w-full rounded-lg border border-line-strong bg-paper-raised px-3 py-2 text-[13px] outline-none focus:border-ink"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending || nota.trim().length === 0}
            onClick={() => enviar('rechazar')}
            className="rounded-lg bg-leak px-3 py-1.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
          >
            Rechazar
          </button>
          <button
            type="button"
            onClick={() => setRechazando(false)}
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
      {skillId ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => enviar('otorgar')}
          className="rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
        >
          Otorgar a {role}
        </button>
      ) : (
        <span className="text-[12.5px] text-ink-faint">
          Pidió algo que no está en el catálogo: hay que crearlo en una migración primero.
        </span>
      )}
      <button
        type="button"
        onClick={() => setRechazando(true)}
        className="rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition hover:border-ink"
      >
        No va
      </button>
      {error ? <p className="text-[12px] text-leak">{error}</p> : null}
    </div>
  );
}
