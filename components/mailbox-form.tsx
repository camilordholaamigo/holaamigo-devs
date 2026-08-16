'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

/**
 * Alta de bandeja.
 *
 * El aviso de verificación va ANTES del botón, no después de guardar: si el
 * cliente se entera de que hay un correo por confirmar recién cuando ya guardó,
 * la mitad de las bandejas se quedan en `pending` para siempre y nadie entiende
 * por qué la campaña no envía.
 */
export function MailboxForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [form, setForm] = useState({ address: '', displayName: '', dailyCap: '40' });

  function submit() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await fetch('/api/mailboxes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: orgId,
          address: form.address.trim(),
          displayName: form.displayName.trim() || form.address.split('@')[0],
          dailyCap: Number(form.dailyCap) || 40,
          startWarmup: true,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; next_step?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos registrar la bandeja.');
        return;
      }
      setDone(data.next_step ?? 'Listo.');
      setForm({ address: '', displayName: '', dailyCap: '40' });
      router.refresh();
    });
  }

  return (
    <Card className="space-y-3 p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        Agregar una bandeja
      </p>
      <p className="text-[12.5px] leading-snug text-ink-faint">
        Vas a recibir un correo de verificación en esa dirección. Hasta que lo confirmes, la bandeja
        no envía nada — no podemos verificar una casilla que no es nuestra y no lo vamos a evadir.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[12px] text-ink-faint">Dirección</span>
          <input
            value={form.address}
            onChange={(event) => setForm({ ...form, address: event.target.value })}
            placeholder="camilo@tuempresa.com"
            className={INPUT}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-ink-faint">Tope diario</span>
          <input
            value={form.dailyCap}
            inputMode="numeric"
            onChange={(event) => setForm({ ...form, dailyCap: event.target.value })}
            className={INPUT}
          />
        </label>
        <label className="block space-y-1 sm:col-span-3">
          <span className="text-[12px] text-ink-faint">Nombre que ve quien recibe</span>
          <input
            value={form.displayName}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            placeholder="Camilo · Tu Empresa"
            className={INPUT}
          />
        </label>
      </div>

      {error ? <p className="text-[13px] text-leak">{error}</p> : null}
      {done ? <p className="text-[13px] text-money">{done}</p> : null}

      <button
        type="button"
        disabled={pending || form.address.trim().length === 0}
        onClick={submit}
        className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
      >
        {pending ? 'Registrando…' : 'Agregar bandeja'}
      </button>
    </Card>
  );
}

const INPUT =
  'w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink';
