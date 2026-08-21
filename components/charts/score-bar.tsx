import { cn } from '@/lib/utils';

/**
 * §9.1 — fit e intent sobre la misma barra de 100.
 *
 * La ficha 360 mostraba `"32 / 25"` como texto. El problema no es que sea feo:
 * es que los dos números tienen techos distintos (60 y 40) y leerlos juntos
 * como una fracción induce a error. Sobre una barra de 100 con los dos topes
 * marcados, la pregunta que importa —"¿le falta negocio o le falta ganas?"— se
 * contesta de un vistazo, y esa respuesta cambia qué se hace con el prospecto:
 * fit bajo se descarta, intent bajo se trabaja.
 *
 * Los umbrales de banda van dibujados encima: 45 (ASSIST) y 70 (ATTACK).
 */

const FIT_MAX = 60;
const INTENT_MAX = 40;
const THRESHOLDS = [
  { at: 45, label: 'ASSIST' },
  { at: 70, label: 'ATTACK' },
];

export function ScoreBar({
  fit,
  intent,
  className,
}: {
  fit: number;
  intent: number;
  className?: string;
}) {
  const f = Math.max(0, Math.min(FIT_MAX, fit));
  const i = Math.max(0, Math.min(INTENT_MAX, intent));

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-4 text-[12px]">
        <span className="text-ink-soft">
          <span className="tnum font-semibold text-ink">{f}</span> fit
          <span className="text-ink-faint"> / {FIT_MAX}</span>
        </span>
        <span className="text-ink-soft">
          <span className="tnum font-semibold text-money">{i}</span> intent
          <span className="text-ink-faint"> / {INTENT_MAX}</span>
        </span>
      </div>

      <div
        className="relative h-3 w-full rounded-full bg-paper-sunken"
        role="img"
        aria-label={`Fit ${f} de ${FIT_MAX}, intent ${i} de ${INTENT_MAX}, total ${f + i} de 100.`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-l-full bg-ink"
          style={{ width: `${f}%` }}
        />
        {/* 2px de superficie entre los dos segmentos: sin ese respiro el
            apilado se lee como una sola barra y se pierde el reparto. */}
        <div
          className="absolute inset-y-0 rounded-r-full bg-money"
          style={{ left: `calc(${f}% + 2px)`, width: `max(0px, calc(${i}% - 2px))` }}
        />

        {THRESHOLDS.map((t) => (
          <span
            key={t.at}
            title={`Umbral ${t.label}: ${t.at} puntos`}
            className="absolute -top-0.5 h-4 w-px bg-line-strong"
            style={{ left: `${t.at}%` }}
          />
        ))}
      </div>

      <div className="relative h-3 text-[10px] text-ink-faint">
        {THRESHOLDS.map((t) => (
          <span key={t.at} className="absolute -translate-x-1/2" style={{ left: `${t.at}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
