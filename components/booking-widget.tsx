'use client';

import { useEffect, useState, useTransition } from 'react';

/**
 * El agendador que ve quien recibe el correo.
 *
 * Tres decisiones que definen si esto convierte:
 *
 *  1. Los horarios se muestran en LA ZONA DE QUIEN AGENDA, detectada del
 *     navegador. Hacer que alguien calcule "las 10 de Bogotá qué hora es acá"
 *     es la forma más barata de perder una reunión.
 *  2. Nombre y correo se piden DESPUÉS de escoger el horario. Pedirlos antes
 *     convierte el agendador en un formulario, y los formularios se abandonan.
 *  3. Sin cuenta, sin contraseña, sin verificación. Es un link que llegó por
 *     correo: cualquier fricción extra la paga la tasa de agendamiento.
 */

interface Slot {
  start: string;
  end: string;
  label: string;
}

interface Day {
  date: string;
  label: string;
  slots: Slot[];
}

export function BookingWidget({ slug, search }: { slug: string; search: string }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const timezone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (timezone) params.set('tz', timezone);
    fetch(`/api/agendar/${slug}?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { days?: Day[]; error?: string }) => {
        if (data.error) setError(data.error);
        setDays(data.days ?? []);
      })
      .catch(() => setError('No pudimos cargar los horarios.'));
  }, [slug, search, timezone]);

  function book() {
    if (!slot) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/agendar/${slug}?${search}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          notes: form.notes.trim() || null,
          start: slot.start,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        booking?: { human_label: string };
      };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos agendar.');
        // Si el cupo se cayó, recargamos los horarios: mostrarle el mismo
        // horario muerto es hacerlo intentar dos veces.
        setSlot(null);
        return;
      }
      setConfirmed(data.booking?.human_label ?? 'Listo');
    });
  }

  if (confirmed) {
    return (
      <div className="space-y-2 rounded-[14px] border border-line bg-paper-raised p-6 text-center">
        <p className="text-[16px] font-semibold text-ink">Quedó agendado</p>
        <p className="tnum text-[14px] text-ink-soft">{confirmed}</p>
        <p className="text-[13px] text-ink-faint">Te llega la confirmación al correo.</p>
      </div>
    );
  }

  if (days === null) {
    return <p className="text-[13.5px] text-ink-faint">Cargando horarios…</p>;
  }

  if (days.length === 0) {
    return (
      <p className="text-[13.5px] text-ink-faint">
        {error ?? 'No hay horarios disponibles en este momento. Responde el correo y lo coordinamos.'}
      </p>
    );
  }

  const day = days[Math.min(dayIndex, days.length - 1)];

  return (
    <div className="space-y-5">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {days.map((item, index) => (
          <button
            key={item.date}
            type="button"
            onClick={() => {
              setDayIndex(index);
              setSlot(null);
            }}
            className={`shrink-0 rounded-xl border px-3.5 py-2 text-[13px] font-medium transition ${
              index === dayIndex
                ? 'border-ink bg-ink text-paper'
                : 'border-line-strong text-ink-soft hover:border-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {day.slots.map((item) => (
          <button
            key={item.start}
            type="button"
            onClick={() => setSlot(item)}
            className={`tnum rounded-xl border px-3 py-2.5 text-[13.5px] font-medium transition ${
              slot?.start === item.start
                ? 'border-money-bright bg-money-soft text-money'
                : 'border-line-strong text-ink hover:border-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {timezone ? (
        <p className="text-[12px] text-ink-faint">Horarios en tu zona: {timezone}</p>
      ) : null}

      {slot ? (
        <div className="space-y-3 border-t border-line pt-5">
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
            <input
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              placeholder="Teléfono (opcional)"
              inputMode="tel"
              className={INPUT}
            />
            <input
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
              placeholder="¿De qué quieres hablar? (opcional)"
              className={INPUT}
            />
          </div>

          {error ? <p className="text-[13px] text-leak">{error}</p> : null}

          <button
            type="button"
            disabled={pending || form.name.trim().length === 0 || !form.email.includes('@')}
            onClick={book}
            className="w-full rounded-xl bg-ink px-5 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
          >
            {pending ? 'Agendando…' : `Confirmar ${slot.label}`}
          </button>
        </div>
      ) : error ? (
        <p className="text-[13px] text-leak">{error}</p>
      ) : null}
    </div>
  );
}

const INPUT =
  'w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-ink';
