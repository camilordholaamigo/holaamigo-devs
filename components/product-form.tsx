'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

/**
 * Alta de producto.
 *
 * El primer producto crea automáticamente el link de pago. Sin eso, cargar un
 * producto no produce nada visible y el cliente se queda preguntando para qué
 * lo hizo — que es la forma más rápida de que no vuelva a la pantalla.
 */
export function ProductForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    priceUsd: '',
    kind: 'ticket',
    inventory: '',
    description: '',
  });

  function submit() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await fetch('/api/productos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: orgId,
          name: form.name.trim(),
          priceUsd: Number(form.priceUsd) || 0,
          kind: form.kind,
          description: form.description.trim() || null,
          inventory: form.inventory.trim() === '' ? null : Number(form.inventory),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; checkout_slug?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos guardar.');
        return;
      }
      setDone(data.checkout_slug ? `Listo. Tu link de pago es /pagar/${data.checkout_slug}` : 'Listo.');
      setForm({ name: '', priceUsd: '', kind: 'ticket', inventory: '', description: '' });
      router.refresh();
    });
  }

  return (
    <Card className="space-y-3 p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        Agregar algo que vendes
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre">
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Entrada general"
            className={INPUT}
          />
        </Field>
        <Field label="Precio (USD)">
          <input
            value={form.priceUsd}
            onChange={(event) => setForm({ ...form, priceUsd: event.target.value })}
            inputMode="decimal"
            placeholder="25"
            className={INPUT}
          />
        </Field>
        <Field label="Tipo">
          <select
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value })}
            className={INPUT}
          >
            <option value="ticket">Entrada / evento</option>
            <option value="course">Curso</option>
            <option value="service">Servicio</option>
            <option value="subscription">Suscripción</option>
            <option value="physical">Producto físico</option>
            <option value="other">Otro</option>
          </select>
        </Field>
        <Field label="Cupos (vacío = ilimitado)">
          <input
            value={form.inventory}
            onChange={(event) => setForm({ ...form, inventory: event.target.value })}
            inputMode="numeric"
            placeholder="120"
            className={INPUT}
          />
        </Field>
      </div>

      <Field label="Descripción">
        <input
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          placeholder="Lo que ve quien va a comprar"
          className={INPUT}
        />
      </Field>

      {error ? <p className="text-[13px] text-leak">{error}</p> : null}
      {done ? <p className="text-[13px] text-money">{done}</p> : null}

      <button
        type="button"
        disabled={pending || form.name.trim().length === 0}
        onClick={submit}
        className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
      >
        {pending ? 'Guardando…' : 'Guardar'}
      </button>
    </Card>
  );
}

const INPUT =
  'w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-ink-faint">{label}</span>
      {children}
    </label>
  );
}
