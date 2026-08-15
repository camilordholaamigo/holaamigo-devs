import { cn } from '@/lib/utils';

/**
 * §7.2 — la matriz de dos ejes con posición relativa.
 *
 * SVG inline, sin librería de gráficos. Son 6 puntos y dos ejes: cualquier
 * librería sería 40 KB para dibujar cinco círculos, y el control fino del
 * etiquetado —que las etiquetas no se pisen— es más fácil a mano.
 *
 * Los ejes los elige el President según el mercado. No están fijos en
 * "precio vs calidad" a propósito: si el mercado se ordena por otra cosa, la
 * matriz tiene que poder decirlo.
 */

export interface Point {
  name: string;
  x: number;
  y: number;
  isYou?: boolean;
}

export function PositionMatrix({
  axisX,
  axisY,
  points,
  className,
}: {
  axisX: string;
  axisY: string;
  points: Point[];
  className?: string;
}) {
  const W = 480;
  const H = 400;
  const PAD = 48;

  const toX = (value: number) => PAD + (clamp(value) / 100) * (W - PAD * 2);
  // El eje Y del SVG crece hacia abajo; el conceptual crece hacia arriba.
  const toY = (value: number) => H - PAD - (clamp(value) / 100) * (H - PAD * 2);

  return (
    <div className={cn('overflow-x-auto', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[340px]"
        role="img"
        aria-label={`Matriz de posicionamiento. Eje horizontal: ${axisX}. Eje vertical: ${axisY}.`}
      >
        {/* Cuadrantes */}
        <rect
          x={PAD}
          y={PAD}
          width={W - PAD * 2}
          height={H - PAD * 2}
          fill="var(--color-paper-sunken)"
          rx="8"
        />
        <line
          x1={W / 2}
          y1={PAD}
          x2={W / 2}
          y2={H - PAD}
          stroke="var(--color-line-strong)"
          strokeDasharray="4 5"
        />
        <line
          x1={PAD}
          y1={H / 2}
          x2={W - PAD}
          y2={H / 2}
          stroke="var(--color-line-strong)"
          strokeDasharray="4 5"
        />

        {/* Ejes */}
        <text
          x={W / 2}
          y={H - 14}
          textAnchor="middle"
          className="fill-[var(--color-ink-faint)] text-[12px] font-medium"
        >
          {axisX} →
        </text>
        <text
          x={16}
          y={H / 2}
          textAnchor="middle"
          transform={`rotate(-90 16 ${H / 2})`}
          className="fill-[var(--color-ink-faint)] text-[12px] font-medium"
        >
          {axisY} →
        </text>

        {/* Puntos */}
        {points.map((point, index) => {
          const cx = toX(point.x);
          const cy = toY(point.y);
          const labelAbove = cy > H / 2;
          return (
            <g key={`${point.name}-${index}`}>
              <circle
                cx={cx}
                cy={cy}
                r={point.isYou ? 9 : 6}
                fill={point.isYou ? 'var(--color-money)' : 'var(--color-ink-faint)'}
                stroke="var(--color-paper-raised)"
                strokeWidth="2.5"
              />
              <text
                x={cx}
                y={labelAbove ? cy - 16 : cy + 26}
                textAnchor="middle"
                className={cn(
                  'text-[11.5px]',
                  point.isYou
                    ? 'fill-[var(--color-money)] font-semibold'
                    : 'fill-[var(--color-ink-soft)] font-medium',
                )}
              >
                {truncate(point.name, 22)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
