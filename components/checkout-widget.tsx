'use client';

import { useState, useTransition } from 'react';

/**
 * El botón de pago de Hola Amigo (ADR 0010 y 0013).
 *
 * HONESTIDAD EN PANTALLA: la pasarela no está conectada. En vez de simular un
 * cobro que no ocurre, el widget lo dice: el pedido queda registrado y el
 * equipo escribe con el link de pago. Fingir un flujo de pago completo sería
 * la forma más rápida de tener un cliente furioso y una venta perdida.
 *
 * Lo que sí es real desde ya: el cupo se reserva y la venta queda atribuida a
 * la campaña y al correo que trajo a esta persona.
 */

export interface CheckoutProduct {
  id: string;
  name: string;
  description: string | null;
  price_usd: number;
  currency: string;
  available: number | null;
}

export function CheckoutWidget({
  slug,
  search,
  products,
  collectPhone,
}: {
  slug: string;
  search: string;
  products: CheckoutProduct[];
  collectPhone: boolean;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const items = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([product_id, qty]) => ({ product_id, qty }));

  const total = items.reduce((sum, item) => {
    const product = products.find((p) => p.id === item.product_id);
    return sum + (product ? product.price_usd * item.qty : 0);
  }, 0);

  const currency = products[0]?.currency ?? 'USD';

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/checkout/${slug}?${search}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          items,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        order?: { payment_instructions: string };
      };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos registrar tu pedido.');
        return;
      }
      setDone(data.order?.payment_instructions ?? 'Tu pedido quedó registrado.');
    });
  }

  if (done) {
    return (
      <div className="space-y-2 rounded-[14px] border border-line bg-paper-raised p-6 text-center">
        <p className="text-[16px] font-semibold text-ink">Pedido registrado</p>
        <p className="text-[14px] leading-relaxed text-ink-soft">{done}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        {products.map((product) => {
          const soldOut = product.available !== null && product.available <= 0;
          const qty = quantities[product.id] ?? 0;
          return (
            <li
              key={product.id}
              className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-paper-raised p-4"
            >
              <div className="min-w-40 flex-1">
                <p className="text-[14px] font-medium text-ink">{product.name}</p>
                {product.description ? (
                  <p className="text-[12.5px] leading-snug text-ink-faint">{product.description}</p>
                ) : null}
                {product.available !== null && product.available > 0 && product.available <= 20 ? (
                  <p className="text-[12px] text-leak">Quedan {product.available}</p>
                ) : null}
              </div>

              <span className="tnum text-[14px] font-semibold text-ink">
                {money(product.price_usd, product.currency)}
              </span>

              {soldOut ? (
                <span className="text-[12.5px] text-ink-faint">Agotado</span>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setQuantities({ ...quantities, [product.id]: Math.max(0, qty - 1) })
                    }
                    className="h-8 w-8 rounded-lg border border-line-strong text-ink-soft"
                  >
                    −
                  </button>
                  <span className="tnum w-6 text-center text-[14px] text-ink">{qty}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setQuantities({
                        ...quantities,
                        [product.id]: Math.min(product.available ?? 99, qty + 1),
                      })
                    }
                    className="h-8 w-8 rounded-lg border border-line-strong text-ink-soft"
                  >
                    +
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {items.length > 0 ? (
        <div className="space-y-3 border-t border-line pt-5">
          <div className="flex items-baseline justify-between">
            <span className="text-[13.5px] text-ink-soft">Total</span>
            <span className="tnum text-[18px] font-semibold text-ink">{money(total, currency)}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Tu nombre"
              className={INPUT}
            />
            <input
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="Tu correo"
              inputMode="email"
              className={INPUT}
            />
            {collectPhone ? (
              <input
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
                placeholder="Teléfono"
                inputMode="tel"
                className={`${INPUT} sm:col-span-2`}
              />
            ) : null}
          </div>

          {error ? <p className="text-[13px] text-leak">{error}</p> : null}

          <button
            type="button"
            disabled={pending || form.name.trim().length === 0 || !form.email.includes('@')}
            onClick={submit}
            className="w-full rounded-xl bg-ink px-5 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
          >
            {pending ? 'Registrando…' : 'Reservar mi cupo'}
          </button>

          <p className="text-center text-[12px] leading-snug text-ink-faint">
            Reservamos tu cupo ahora y te escribimos con el link de pago. Todavía no cobramos acá.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const INPUT =
  'w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-ink';

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
