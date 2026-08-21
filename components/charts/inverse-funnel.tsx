import type { InverseMath } from '@/lib/diagnostic/math';
import { formatNumber, cn } from '@/lib/utils';

/**
 * §7.4 — el embudo de la cuenta al revés.
 *
 * `computeInverseMath` ya produce la cadena entera y se venía mostrando como
 * una lista numerada. La lista es la transparencia —cada paso con su fórmula—
 * pero no transmite la escala: que para 70 clientes haya que tocar 5.600
 * puertas es un dato que se lee distinto en una tabla y en una figura.
 *
 * Dos decisiones que hay que conocer:
 *
 * **El embudo va al derecho aunque la cuenta vaya al revés.** El cálculo parte
 * de la meta y sube; el dibujo baja de contactos a clientes. Es el mismo
 * número por los dos lados, y de arriba hacia abajo es como se lee un embudo.
 * La derivación con sus fórmulas sigue debajo, sin cambios: quien quiera
 * auditar el número lo audita ahí.
 *
 * **El ancho es lineal y la última banda es una astilla.** Se podría comprimir
 * en escala logarítmica para que las tres bandas se vean parecidas, y sería
 * mentir con la geometría: el 1,25% que sobrevive es exactamente el punto.
 * Solo hay un piso de píxeles para que no desaparezca del todo.
 *
 * Detrás de cada banda va un riel del ancho completo. Sin él, las dos bandas
 * de abajo son dos rayitas flotando en un espacio vacío y se leen como un error
 * de renderizado; con él se leen como lo que son, la fracción que sobrevive.
 * El riel no agrega información: le da al ojo contra qué comparar la astilla.
 */

const W = 600;
const FUNNEL_W = 300;
const CENTER = 150;
const BAND_H = 74;
const GAP = 26;
const MIN_W = 7;

export function InverseFunnel({
  inverse,
  weeks,
  bookingRate,
  closeFromMeeting,
  className,
}: {
  inverse: InverseMath;
  weeks: number;
  bookingRate: number;
  closeFromMeeting: number;
  className?: string;
}) {
  const stages = [
    { label: 'Contactos que hay que tocar', value: inverse.contacts_needed, fill: 'var(--color-line-strong)' },
    { label: 'Reuniones sostenidas', value: inverse.meetings_needed, fill: 'var(--color-ink-faint)' },
    { label: 'Clientes nuevos', value: inverse.goal_customers, fill: 'var(--color-money)' },
  ];

  // Mismo motivo que en la cascada: acá `inverse` puede venir de un `jsonb` de
  // la base. `undefined <= 0` es false y dejaría pasar geometría NaN.
  const top = stages[0].value;
  if (!stages.every((s) => Number.isFinite(s.value)) || top <= 0) return null;

  const widthOf = (value: number) => Math.max(MIN_W, (value / top) * FUNNEL_W);
  const H = stages.length * BAND_H + (stages.length - 1) * GAP;

  // Las conversiones que explican cada caída. Van entre banda y banda porque
  // es donde la pregunta aparece: "¿y por qué se cae tanto?".
  const drops = [
    `${pct(bookingRate)} acepta reunión`,
    `${pct(closeFromMeeting)} cierra desde reunión`,
  ];

  return (
    <div className={cn('overflow-x-auto', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[320px]"
        role="img"
        aria-label={`Embudo: ${formatNumber(inverse.contacts_needed)} contactos producen ${formatNumber(inverse.meetings_needed)} reuniones y ${formatNumber(inverse.goal_customers)} clientes en ${weeks} semanas.`}
      >
        {stages.map((stage, index) => {
          const yTop = index * (BAND_H + GAP);
          const yBottom = yTop + BAND_H;
          const wTop = widthOf(stage.value);
          // La última banda no se sigue cerrando: es el resultado, no un paso
          // intermedio. Cerrarla en punta sugeriría que todavía se pierde algo.
          const wBottom = index === stages.length - 1 ? wTop : widthOf(stages[index + 1].value);

          return (
            <g key={stage.label}>
              <rect
                x={CENTER - FUNNEL_W / 2}
                y={yTop}
                width={FUNNEL_W}
                height={BAND_H}
                fill="var(--color-paper-sunken)"
                rx="3"
              />
              <polygon
                points={[
                  `${CENTER - wTop / 2},${yTop}`,
                  `${CENTER + wTop / 2},${yTop}`,
                  `${CENTER + wBottom / 2},${yBottom}`,
                  `${CENTER - wBottom / 2},${yBottom}`,
                ].join(' ')}
                fill={stage.fill}
              />

              <text
                x={FUNNEL_W + 40}
                y={yTop + 26}
                className="fill-[var(--color-ink)] text-[19px] font-semibold"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatNumber(stage.value)}
              </text>
              <text
                x={FUNNEL_W + 40}
                y={yTop + 46}
                className="fill-[var(--color-ink-soft)] text-[13px]"
              >
                {stage.label}
              </text>

              {index < drops.length ? (
                <>
                  <line
                    x1={CENTER}
                    y1={yBottom + 6}
                    x2={CENTER}
                    y2={yBottom + GAP - 6}
                    stroke="var(--color-line-strong)"
                    strokeDasharray="3 4"
                  />
                  <text
                    x={FUNNEL_W + 40}
                    y={yBottom + GAP - 8}
                    className="fill-[var(--color-ink-faint)] text-[11.5px]"
                  >
                    {drops[index]}
                  </text>
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
