import { toCurrency } from '@/config/assumptions';
import { formatMoney, cn } from '@/lib/utils';

/**
 * §7.3 — la cascada de fugas.
 *
 * Las cuatro fugas se venían mostrando como cuatro renglones de texto con un
 * total arriba. Eso dice cuánto, pero no dice *cuánto de qué*: sin proporción
 * entre ellas, el cliente no sabe cuál abrir primero, y abrir la más grande y
 * discutirla es exactamente la acción que queremos.
 *
 * La lectura es una sola: la barra de arriba es el techo (lo que entraría si
 * ninguna fuga existiera), cada barra naranja es el pedazo que se cae, y la
 * verde de abajo es lo que queda. Cada barra arranca donde termina la
 * anterior — de ahí la escalera.
 *
 * HTML y CSS, no SVG. Los nombres de las fugas son frases largas en español
 * ("Los que se abandonan antes del quinto toque"): en SVG habría que truncarlas
 * o medirlas a mano, y truncar el nombre de la fuga más grande es perder
 * justamente el renglón que mueve la venta. En HTML el texto envuelve solo.
 *
 * Sin hooks a propósito: se usa dentro de `MoneyPanel` (cliente, recalculando
 * en cada frame mientras arrastran un control) y dentro de la ficha 360 del
 * admin (Server Component). Un `use client` acá obligaría a marcar la ficha.
 */

export interface WaterfallLeak {
  key: string;
  name: string;
  monthly_value_usd: number;
}

/** Ancho mínimo en porcentaje para que una fuga chica no desaparezca. */
const MIN_WIDTH_PCT = 1.2;

export function LeakWaterfall({
  leaks,
  baselineUsd,
  currency,
  className,
}: {
  leaks: WaterfallLeak[];
  /** Facturación mensual declarada. El piso de la cascada. */
  baselineUsd: number;
  currency: string;
  className?: string;
}) {
  const total = leaks.reduce((sum, leak) => sum + Number(leak.monthly_value_usd ?? 0), 0);
  // `Number.isFinite` y no `> 0`: en la ficha de admin las fugas salen de un
  // `jsonb`, y un diagnóstico viejo o a medio escribir puede traer `undefined`.
  // `undefined <= 0` es false, así que sin este guardia el componente seguiría
  // hasta pintar barras de ancho NaN.
  if (leaks.length === 0 || !Number.isFinite(total) || total <= 0) return null;

  const baseline = Number.isFinite(baselineUsd) ? Math.max(0, baselineUsd) : 0;
  const ceiling = baseline + total;
  const money = (usd: number) => formatMoney(toCurrency(usd, currency), currency);
  const pct = (usd: number) => (usd / ceiling) * 100;

  // El offset de cada barra es lo que ya se descontó: la fuga i arranca donde
  // terminó la i-1. Es lo que produce la escalera.
  //
  // Se re-suma el prefijo en vez de acumular en una variable: son cuatro fugas
  // como máximo (§7.3), y un acumulador mutado dentro del callback es lo que el
  // compilador de React marca — con razón, porque este componente se re-ejecuta
  // en cada frame mientras el cliente arrastra un control.
  const rows = leaks.map((leak, index) => {
    const before = leaks
      .slice(0, index)
      .reduce((sum, previous) => sum + pct(previous.monthly_value_usd), 0);
    const width = Math.max(MIN_WIDTH_PCT, pct(leak.monthly_value_usd));
    const left = Math.max(0, 100 - before - width);
    return { leak, width, left, share: (leak.monthly_value_usd / ceiling) * 100 };
  });

  return (
    <div
      className={cn('space-y-4', className)}
      role="img"
      aria-label={`Cascada de fugas. Techo alcanzable ${money(ceiling)}, del que se caen ${money(total)} al mes.`}
    >
      <Row
        label="Techo alcanzable"
        hint="lo que entraría sin ninguna fuga"
        value={money(ceiling)}
        left={0}
        width={100}
        tone="neutral"
      />

      {rows.map(({ leak, width, left, share }) => (
        <Row
          key={leak.key}
          label={leak.name}
          hint={`${share.toFixed(share < 10 ? 1 : 0)}% del techo`}
          value={money(leak.monthly_value_usd)}
          left={left}
          width={width}
          tone="leak"
        />
      ))}

      {baseline > 0 ? (
        <Row
          label="Lo que entra hoy"
          hint="tu facturación declarada"
          value={money(baseline)}
          left={0}
          width={Math.max(MIN_WIDTH_PCT, pct(baseline))}
          tone="money"
        />
      ) : null}
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  left,
  width,
  tone,
}: {
  label: string;
  hint: string;
  value: string;
  left: number;
  width: number;
  tone: 'neutral' | 'leak' | 'money';
}) {
  const fill = {
    neutral: 'var(--color-line-strong)',
    leak: 'var(--color-leak)',
    money: 'var(--color-money)',
  }[tone];

  const text = {
    neutral: 'text-ink-soft',
    leak: 'text-leak',
    money: 'text-money',
  }[tone];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="min-w-0 text-[13.5px] font-medium leading-snug text-ink">
          {label}
          <span className="ml-2 text-[11.5px] font-normal text-ink-faint">{hint}</span>
        </p>
        <p className={cn('tnum shrink-0 text-[14px] font-semibold', text)}>{value}</p>
      </div>
      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-paper-sunken">
        <div
          className="h-full rounded-full transition-[width,margin] duration-300 ease-out"
          style={{ marginLeft: `${left}%`, width: `${width}%`, background: fill }}
        />
      </div>
    </div>
  );
}
