'use client';

import { useMemo, useRef, useState } from 'react';
import {
  computeLeaks,
  computeInverseMath,
  totalLeakUsd,
  type LeakContext,
  type Leak,
} from '@/lib/diagnostic/math';
import { toCurrency } from '@/config/assumptions';
import type { Assumptions } from '@/config/assumptions';
import { formatMoney, formatNumber } from '@/lib/utils';
import { Card, SourceMark, SectionTitle } from '@/components/ui';

/**
 * §7.3 Dónde se te está cayendo la plata · §7.4 La cuenta al revés.
 *
 * El corazón emocional del diagnóstico, y la razón por la que
 * `lib/diagnostic/math.ts` es TypeScript puro sin dependencias de servidor:
 * las MISMAS funciones que calcularon estos números en el servidor corren aquí
 * en el navegador. Cuando el cliente arrastra un control, el número se mueve
 * en el mismo frame — sin ida al servidor, sin spinner, sin desincronización
 * posible entre lo que ve y lo que guardamos.
 *
 * "Cada fuga muestra el supuesto usado y permite editarlo en pantalla. Eso
 * convierte el diagnóstico en algo suyo y no en algo nuestro."
 *
 * La persistencia va por detrás, con debounce. Si falla, el usuario no se
 * entera: ya vio su número. Lo que no puede fallar es el evento
 * `assumption_edited` — vale 5 puntos de intent y es la señal más honesta de
 * que alguien se apropió del diagnóstico.
 */

interface Props {
  shareToken: string;
  initialAssumptions: Assumptions;
  initialLeaks: Leak[];
  currency: string;
  languageChannelDetected: boolean;
}

type EditableKey =
  | 'dormant_contacts'
  | 'avg_ticket_usd'
  | 'leads_per_month'
  | 'close_rate'
  | 'reactivation_rate'
  | 'after_hours_share'
  | 'followup_abandon_share'
  | 'goal_customers_90d'
  | 'close_from_meeting'
  | 'booking_rate'
  | 'touches_per_contact';

const CONTROLS: Record<
  EditableKey,
  { label: string; min: number; max: number; step: number; kind: 'count' | 'money' | 'rate' }
> = {
  dormant_contacts: { label: 'Contactos dormidos', min: 0, max: 50_000, step: 50, kind: 'count' },
  avg_ticket_usd: { label: 'Ticket promedio', min: 0, max: 100_000, step: 100, kind: 'money' },
  leads_per_month: { label: 'Leads nuevos al mes', min: 0, max: 5_000, step: 10, kind: 'count' },
  close_rate: { label: 'Tasa de cierre', min: 0.01, max: 0.8, step: 0.01, kind: 'rate' },
  reactivation_rate: { label: 'Reactivación de la base', min: 0.005, max: 0.2, step: 0.005, kind: 'rate' },
  after_hours_share: { label: 'Leads fuera de horario', min: 0, max: 0.8, step: 0.01, kind: 'rate' },
  followup_abandon_share: { label: 'Leads sin seguimiento', min: 0, max: 0.9, step: 0.01, kind: 'rate' },
  goal_customers_90d: { label: 'Clientes nuevos en 90 días', min: 1, max: 2_000, step: 1, kind: 'count' },
  close_from_meeting: { label: 'Cierre desde reunión', min: 0.02, max: 0.9, step: 0.01, kind: 'rate' },
  booking_rate: { label: 'Contactados que agendan', min: 0.005, max: 0.4, step: 0.005, kind: 'rate' },
  touches_per_contact: { label: 'Toques por contacto', min: 1, max: 15, step: 1, kind: 'count' },
};

export function MoneyPanel({
  shareToken,
  initialAssumptions,
  initialLeaks,
  currency,
  languageChannelDetected,
}: Props) {
  const [assumptions, setAssumptions] = useState<Assumptions>(initialAssumptions);
  const [openLeak, setOpenLeak] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // La evidencia de cada fuga viene del President y NO cambia cuando el
  // cliente edita un número: cambió el monto, no la razón.
  const context: LeakContext = useMemo(
    () => ({
      languageChannelDetected,
      evidence: Object.fromEntries(
        initialLeaks.map((l) => [
          l.key,
          { text: l.evidence, source_url: l.source_url, confidence: l.confidence },
        ]),
      ),
    }),
    [initialLeaks, languageChannelDetected],
  );

  const leaks = useMemo(() => computeLeaks(assumptions, context), [assumptions, context]);
  const inverse = useMemo(() => computeInverseMath(assumptions), [assumptions]);
  const total = totalLeakUsd(leaks);

  const money = (usd: number) => formatMoney(toCurrency(usd, currency), currency);

  function update(key: EditableKey, value: number) {
    setTouched(true);
    const next = { ...assumptions, [key]: value };
    setAssumptions(next);

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void fetch('/api/diagnostic/assumptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shareToken, assumptions: next, changed: key }),
      }).catch(() => {
        /* el número ya se mostró; el guardado es secundario */
      });
    }, 900);
  }

  return (
    <>
      {/* ── §7.3 LAS FUGAS ─────────────────────────────────────────────── */}
      <section className="reveal space-y-8" style={{ '--i': 2 } as React.CSSProperties}>
        <SectionTitle
          eyebrow="Sección 3"
          title="Dónde se te está cayendo la plata"
          subtitle="Cada cifra viene de una fórmula que puedes abrir y de un supuesto que puedes cambiar. Si crees que un número está mal, muévelo — se recalcula al instante."
        />

        <Card className="overflow-hidden">
          <div className="border-b border-line bg-leak-soft px-6 py-7 sm:px-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-leak">
              Total mensual estimado
            </p>
            <p className="tnum mt-1 text-4xl font-semibold tracking-tight text-leak sm:text-5xl">
              {money(total)}
            </p>
            <p className="tnum mt-2 text-[13px] text-leak/80">
              {money(total * 12)} al año · sobre {formatNumber(assumptions.leads_per_month)} leads
              al mes y una base de {formatNumber(assumptions.dormant_contacts)} contactos
            </p>
          </div>

          <ul className="divide-y divide-line">
            {leaks.map((leak) => {
              const open = openLeak === leak.key;
              return (
                <li key={leak.key}>
                  <button
                    type="button"
                    onClick={() => setOpenLeak(open ? null : leak.key)}
                    className="flex w-full items-start justify-between gap-6 px-6 py-5 text-left transition hover:bg-paper-sunken sm:px-8"
                    aria-expanded={open}
                  >
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="block text-[15px] font-semibold tracking-tight text-ink">
                        {leak.name}
                      </span>
                      <span className="block text-[13.5px] leading-relaxed text-ink-soft">
                        {leak.evidence}
                        <SourceMark url={leak.source_url} inferred={!leak.source_url} />
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="tnum block text-xl font-semibold text-leak">
                        {money(leak.monthly_value_usd)}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        {open ? 'ocultar cálculo' : 'ver cálculo'}
                      </span>
                    </span>
                  </button>

                  {open ? (
                    <div className="slide-in space-y-5 border-t border-line bg-paper-sunken px-6 py-6 sm:px-8">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                          La fórmula
                        </p>
                        <p className="tnum mt-1.5 font-mono text-[13px] leading-relaxed text-ink-soft">
                          {leak.formula}
                        </p>
                      </div>
                      <div className="grid gap-5 sm:grid-cols-2">
                        {leak.inputs
                          .filter((input): input is EditableKey => input in CONTROLS)
                          .map((input) => (
                            <Control
                              key={input}
                              name={input}
                              value={assumptions[input]}
                              currency={currency}
                              onChange={(value) => update(input, value)}
                            />
                          ))}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>

        {touched ? (
          <p className="slide-in text-[13px] text-ink-faint">
            Guardamos tus supuestos. El diagnóstico ahora es tuyo, no nuestro.
          </p>
        ) : null}
      </section>

      {/* ── §7.4 LA CUENTA AL REVÉS ────────────────────────────────────── */}
      <section className="reveal space-y-8" style={{ '--i': 3 } as React.CSSProperties}>
        <SectionTitle
          eyebrow="Sección 4"
          title="La cuenta al revés"
          subtitle="Desde tu meta hacia atrás, hasta el número de envíos por semana. Toda la aritmética a la vista."
        />

        {!inverse.feasible ? (
          <Card className="border-leak/30 bg-leak-soft p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-leak">
              El President escaló esto
            </p>
            <p className="mt-2 text-[15px] leading-relaxed text-ink">{inverse.infeasible_reason}</p>
          </Card>
        ) : null}

        <Card className="overflow-hidden">
          <div className="border-b border-line px-6 py-6 sm:px-8">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
              <p className="tnum text-3xl font-semibold tracking-tight text-ink">
                {formatNumber(assumptions.goal_customers_90d)}
              </p>
              <p className="pb-1 text-[15px] text-ink-soft">
                clientes nuevos en {assumptions.weeks_available} semanas
              </p>
            </div>
          </div>

          <ol className="divide-y divide-line">
            {inverse.steps.map((step, index) => (
              <li
                key={step.label}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-6 py-4 sm:px-8"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">
                    <span className="tnum mr-2 text-ink-faint">{index + 1}</span>
                    {step.label}
                  </p>
                  <p className="tnum mt-0.5 font-mono text-[12px] text-ink-faint">{step.formula}</p>
                </div>
                <p className="tnum shrink-0 text-lg font-semibold text-ink">
                  {formatNumber(step.value)}
                  <span className="ml-1.5 text-[12px] font-normal text-ink-faint">{step.unit}</span>
                </p>
              </li>
            ))}
          </ol>

          <div className="grid gap-5 border-t border-line bg-paper-sunken px-6 py-6 sm:grid-cols-2 sm:px-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint sm:col-span-2">
              Los supuestos que usamos — cámbialos si conoces mejor tu negocio
            </p>
            {(
              ['goal_customers_90d', 'close_from_meeting', 'booking_rate', 'touches_per_contact'] as EditableKey[]
            ).map((key) => (
              <Control
                key={key}
                name={key}
                value={assumptions[key]}
                currency={currency}
                onChange={(value) => update(key, value)}
              />
            ))}
          </div>
        </Card>
      </section>
    </>
  );
}

function Control({
  name,
  value,
  currency,
  onChange,
}: {
  name: EditableKey;
  value: number;
  currency: string;
  onChange: (value: number) => void;
}) {
  const config = CONTROLS[name];

  const display =
    config.kind === 'rate'
      ? `${Math.round(value * 1000) / 10}%`
      : config.kind === 'money'
        ? formatMoney(toCurrency(value, currency), currency)
        : formatNumber(value);

  return (
    <label className="block space-y-2">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-ink-soft">{config.label}</span>
        <span className="tnum text-[13px] font-semibold text-ink">{display}</span>
      </span>
      <input
        type="range"
        min={config.min}
        max={config.max}
        step={config.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full"
        aria-label={config.label}
      />
    </label>
  );
}
