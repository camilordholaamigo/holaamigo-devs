'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { AjusteDisponible, Ajustes } from '@/lib/feed/adjust';

/**
 * La cola de decisiones. El producto (§13.6).
 *
 * Es un componente aparte de `FeedCard` —que sigue pintando el historial— y no
 * un refactor de aquel, porque la diferencia no es visual: acá la selección, el
 * foco y el teclado viven en el PADRE. Una lista donde cada fila maneja su
 * propio foco no puede tener navegación con J/K, y una donde cada fila maneja su
 * propia selección no puede aprobar en lote.
 *
 * Cuatro reglas de interacción, todas del plan P3:
 *
 *  1. **"Ajustar" nunca abre una caja de texto.** Abre los controles que la
 *     propuesta declaró: sliders sobre números reales, checkboxes sobre ítems
 *     reales. Si el cliente quiere aprobar *pero no así*, mueve el número.
 *  2. **Teclado.** J/K para moverse, A aprobar, R rechazar, E expandir, X
 *     marcar. Las herramientas serias tienen teclado.
 *  3. **Lote solo para lo de baja severidad.** Lo caro cuesta un clic propio.
 *  4. **Severidad sobria:** un punto de color, no un banner. Serio, no
 *     alarmista.
 */

export interface QueueItem {
  id: string;
  kind: string;
  role: string;
  title: string;
  body: string;
  rationale: string | null;
  evidence: Record<string, unknown>;
  requires: 'approval' | 'input' | 'nothing';
  severity: 'low' | 'normal' | 'high';
  created_at: string;
  payload: Record<string, unknown>;
  motivo: string;
  puesto: number;
  deliberation_id?: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  president: 'PRESIDENT',
  cmo: 'CMO',
  sales: 'SALES',
  system: 'SISTEMA',
};

export function FeedQueue({
  items: todos,
  orgId,
  explicacion,
  postergados,
}: {
  items: QueueItem[];
  orgId: string;
  explicacion: string | null;
  postergados: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resueltos, setResueltos] = useState<Set<string>>(new Set());
  const items = todos.filter((item) => !resueltos.has(item.id));
  const [cursor, setCursor] = useState(0);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [ajustando, setAjustando] = useState<string | null>(null);
  const [rechazando, setRechazando] = useState<string | null>(null);
  const [nota, setNota] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLLIElement | null>>({});

  const responder = useCallback(
    (id: string, decision: 'approved' | 'rejected' | 'dismissed', extra?: { nota?: string; ajustes?: Ajustes }) => {
      // La tarjeta desaparece YA, sin esperar al servidor. Aprobar con el
      // teclado y quedarse mirando la misma tarjeta 800 ms mientras vuelve el
      // fetch es lo que hace que una cola se sienta lenta aunque el trabajo real
      // tarde lo mismo. Si el servidor falla, `router.refresh()` la devuelve y
      // el aviso dice por qué — un rebote visible es mejor que una espera muda.
      setResueltos((prev) => new Set(prev).add(id));
      startTransition(async () => {
        const res = await fetch(`/api/feed/${id}/respond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            organizationId: orgId,
            decision,
            note: extra?.nota ?? null,
            ajustes: extra?.ajustes ?? null,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; effect?: string };
        if (!res.ok) {
          setResueltos((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
        setAviso(res.ok ? (data.effect ?? 'Listo.') : (data.error ?? 'No pudimos registrarlo.'));
        setRechazando(null);
        setAjustando(null);
        setNota('');
        router.refresh();
      });
    },
    [orgId, router],
  );

  const aprobarLote = useCallback(() => {
    if (marcados.size === 0) return;
    const enVuelo = [...marcados];
    setResueltos((prev) => new Set([...prev, ...enVuelo]));
    startTransition(async () => {
      const res = await fetch('/api/feed/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, ids: [...marcados] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        aprobadas?: number;
        excluidas_por_severidad?: number;
        error?: string;
      };
      if (!res.ok) {
        setResueltos((prev) => {
          const next = new Set(prev);
          for (const id of enVuelo) next.delete(id);
          return next;
        });
      }
      setAviso(
        res.ok
          ? `${data.aprobadas ?? 0} aprobadas.` +
              (data.excluidas_por_severidad
                ? ` ${data.excluidas_por_severidad} quedaron fuera: las de severidad alta se aprueban de a una.`
                : '')
          : (data.error ?? 'No pudimos aprobarlas.'),
      );
      setMarcados(new Set());
      router.refresh();
    });
  }, [marcados, orgId, router]);

  // El teclado se escucha en el documento y no en cada fila: es lo que permite
  // moverse sin haber hecho clic en nada. Se ignora cuando el foco está en un
  // campo de texto, porque ahí "a" es la letra a.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (items.length === 0) return;

      const actual = items[Math.min(cursor, items.length - 1)];
      const mover = (delta: number) => {
        const siguiente = Math.max(0, Math.min(items.length - 1, cursor + delta));
        setCursor(siguiente);
        refs.current[items[siguiente].id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };

      switch (event.key.toLowerCase()) {
        case 'j':
          event.preventDefault();
          mover(1);
          break;
        case 'k':
          event.preventDefault();
          mover(-1);
          break;
        case 'e':
          event.preventDefault();
          setExpandido((prev) => (prev === actual.id ? null : actual.id));
          break;
        case 'x':
          event.preventDefault();
          if (actual.severity === 'high') {
            setAviso('Las de severidad alta se aprueban de a una: no entran al lote.');
            break;
          }
          setMarcados((prev) => {
            const next = new Set(prev);
            if (next.has(actual.id)) next.delete(actual.id);
            else next.add(actual.id);
            return next;
          });
          break;
        case 'a':
          event.preventDefault();
          if (marcados.size > 0) aprobarLote();
          else if (actual.requires === 'approval') responder(actual.id, 'approved');
          break;
        case 'r':
          event.preventDefault();
          if (actual.requires === 'approval') setRechazando(actual.id);
          break;
        default:
          break;
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, cursor, marcados, aprobarLote, responder]);

  if (items.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[12.5px] text-ink-faint">
          <kbd className="rounded border border-line-strong bg-paper-sunken px-1.5 py-0.5 text-[11px]">J</kbd>{' '}
          <kbd className="rounded border border-line-strong bg-paper-sunken px-1.5 py-0.5 text-[11px]">K</kbd>{' '}
          moverse ·{' '}
          <kbd className="rounded border border-line-strong bg-paper-sunken px-1.5 py-0.5 text-[11px]">A</kbd>{' '}
          aprobar ·{' '}
          <kbd className="rounded border border-line-strong bg-paper-sunken px-1.5 py-0.5 text-[11px]">R</kbd>{' '}
          rechazar ·{' '}
          <kbd className="rounded border border-line-strong bg-paper-sunken px-1.5 py-0.5 text-[11px]">X</kbd>{' '}
          marcar ·{' '}
          <kbd className="rounded border border-line-strong bg-paper-sunken px-1.5 py-0.5 text-[11px]">E</kbd>{' '}
          ver más
        </p>

        {marcados.size > 0 ? (
          <button
            type="button"
            onClick={aprobarLote}
            disabled={pending}
            className="ml-auto rounded-xl bg-ink px-4 py-2 text-[13px] font-semibold text-paper disabled:opacity-40"
          >
            Aprobar {marcados.size} marcadas
          </button>
        ) : null}
      </div>

      {aviso ? (
        <p className="rounded-xl border border-line bg-paper-sunken px-4 py-2.5 text-[13px] text-ink-soft">
          {aviso}
        </p>
      ) : null}

      <ul className="space-y-3">
        {items.map((item, index) => {
          const enfocada = index === Math.min(cursor, items.length - 1);
          const ajustes = (item.payload?.ajustes_disponibles ?? []) as AjusteDisponible[];

          return (
            // El `ref` va en el `li` y no en `Card`: `Card` es un componente sin
            // reenvío de ref, y agregárselo para esta pantalla obligaría a
            // tocar el componente que usan las otras cinco.
            <li
              key={item.id}
              ref={(el) => {
                refs.current[item.id] = el;
              }}
            >
            <Card
              className={cn(
                'space-y-3 p-5 transition',
                enfocada ? 'border-ink/30 shadow-[0_2px_10px_rgb(18_16_14_/_0.06)]' : '',
                marcados.has(item.id) ? 'bg-paper-sunken' : '',
              )}
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    item.severity === 'high'
                      ? 'bg-leak'
                      : item.severity === 'normal'
                        ? 'bg-ink-faint'
                        : 'bg-line-strong',
                  )}
                  title={`severidad ${item.severity}`}
                />
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  {ROLE_LABEL[item.role] ?? item.role}
                </span>
                {item.deliberation_id ? (
                  <a
                    href={`/consola/${orgId}/sala#d-${item.deliberation_id}`}
                    className="text-[12px] text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-money"
                  >
                    ver la deliberación
                  </a>
                ) : null}
                <span className="ml-auto text-[12px] text-ink-faint">
                  {new Date(item.created_at).toLocaleString('es-CO', {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                {item.severity !== 'high' ? (
                  <input
                    type="checkbox"
                    checked={marcados.has(item.id)}
                    onChange={() =>
                      setMarcados((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                    aria-label={`Marcar «${item.title}» para aprobar en lote`}
                    className="h-4 w-4 accent-[color:var(--color-ink)]"
                  />
                ) : null}
              </div>

              <div className="space-y-1.5">
                <h3 className="text-[15.5px] font-semibold tracking-tight text-ink">{item.title}</h3>
                <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink-soft">
                  {item.body}
                </p>
                {expandido === item.id && item.rationale ? (
                  <p className="text-[12.5px] leading-snug text-ink-faint">{item.rationale}</p>
                ) : null}
              </div>

              {expandido === item.id ? <Evidencia evidence={item.evidence} /> : null}

              {ajustando === item.id ? (
                <PanelDeAjustes
                  ajustes={ajustes}
                  pending={pending}
                  onCancelar={() => setAjustando(null)}
                  onAprobar={(valores) => responder(item.id, 'approved', { ajustes: valores })}
                />
              ) : rechazando === item.id ? (
                <div className="space-y-2 border-t border-line pt-3">
                  <textarea
                    value={nota}
                    onChange={(event) => setNota(event.target.value)}
                    rows={2}
                    autoFocus
                    placeholder="¿Por qué no? Con una línea basta, y es lo que evita que te lo vuelva a proponer."
                    className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={pending || nota.trim().length === 0}
                      onClick={() => responder(item.id, 'rejected', { nota })}
                      className="rounded-xl bg-leak px-4 py-2 text-[13px] font-semibold text-paper disabled:opacity-40"
                    >
                      Rechazar
                    </button>
                    <button
                      type="button"
                      onClick={() => setRechazando(null)}
                      className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-soft"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  {item.requires === 'approval' ? (
                    <>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => responder(item.id, 'approved')}
                        className="rounded-xl bg-ink px-4 py-2 text-[13px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
                      >
                        Apruebo
                      </button>
                      {ajustes.length > 0 ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setAjustando(item.id)}
                          className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-soft transition hover:border-ink"
                        >
                          Ajustar
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setRechazando(item.id)}
                        className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-soft transition hover:border-ink"
                      >
                        Ahora no
                      </button>
                    </>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => setExpandido((prev) => (prev === item.id ? null : item.id))}
                    className="text-[12.5px] text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-ink"
                  >
                    {expandido === item.id ? 'menos' : 'ver más'}
                  </button>

                  <span className="ml-auto text-[12px] text-ink-faint">{item.motivo}</span>
                </div>
              )}
            </Card>
            </li>
          );
        })}
      </ul>

      {explicacion ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-3 text-[12.5px] leading-relaxed text-ink-faint">
          {explicacion}
          {postergados > 0 ? null : null}
        </p>
      ) : null}
    </div>
  );
}

function Evidencia({ evidence }: { evidence: Record<string, unknown> }) {
  const filas = Object.entries(evidence ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && typeof value !== 'object',
  );
  if (filas.length === 0) return null;

  return (
    <dl className="grid gap-x-6 gap-y-1.5 border-t border-line pt-3 sm:grid-cols-2">
      {filas.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-3">
          <dt className="text-[12.5px] text-ink-faint">{key.replace(/_/g, ' ')}</dt>
          <dd className="tnum text-[13px] font-medium text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * El panel de "Ajustar".
 *
 * Renderiza lo que la propuesta declaró y nada más. No hay un caso `default`
 * que muestre un input de texto: un tipo de ajuste que este componente no sabe
 * pintar no se pinta, porque la alternativa —caer a texto libre— es
 * exactamente lo que esta pantalla existe para evitar.
 */
function PanelDeAjustes({
  ajustes,
  pending,
  onAprobar,
  onCancelar,
}: {
  ajustes: AjusteDisponible[];
  pending: boolean;
  onAprobar: (valores: Ajustes) => void;
  onCancelar: () => void;
}) {
  const [valores, setValores] = useState<Ajustes>(() =>
    Object.fromEntries(ajustes.map((a) => [a.key, a.valor])),
  );

  return (
    <div className="space-y-4 border-t border-line pt-4">
      {ajustes.map((ajuste) => (
        <div key={ajuste.key} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label className="text-[13px] font-medium text-ink">{ajuste.label}</label>
            {ajuste.tipo === 'slider' ? (
              <span className="tnum text-[13px] font-semibold text-ink">
                {String(valores[ajuste.key])} {ajuste.unidad ?? ''}
              </span>
            ) : null}
          </div>

          {ajuste.tipo === 'slider' ? (
            <input
              type="range"
              min={ajuste.min ?? 0}
              max={ajuste.max ?? 100}
              step={ajuste.paso ?? 1}
              value={Number(valores[ajuste.key] ?? 0)}
              onChange={(event) =>
                setValores((prev) => ({ ...prev, [ajuste.key]: Number(event.target.value) }))
              }
              className="w-full accent-[color:var(--color-ink)]"
            />
          ) : null}

          {ajuste.tipo === 'checkboxes' ? (
            <div className="space-y-1.5">
              {(ajuste.opciones ?? []).map((opcion) => {
                const seleccionadas = (valores[ajuste.key] as string[]) ?? [];
                return (
                  <label key={opcion.value} className="flex items-center gap-2.5 text-[13px] text-ink-soft">
                    <input
                      type="checkbox"
                      checked={seleccionadas.includes(opcion.value)}
                      onChange={(event) =>
                        setValores((prev) => {
                          const actuales = new Set((prev[ajuste.key] as string[]) ?? []);
                          if (event.target.checked) actuales.add(opcion.value);
                          else actuales.delete(opcion.value);
                          return { ...prev, [ajuste.key]: [...actuales] };
                        })
                      }
                      className="h-4 w-4 accent-[color:var(--color-ink)]"
                    />
                    {opcion.label}
                  </label>
                );
              })}
            </div>
          ) : null}

          {ajuste.efecto ? (
            <p className="text-[12px] leading-snug text-ink-faint">{ajuste.efecto}</p>
          ) : null}
        </div>
      ))}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => onAprobar(valores)}
          className="rounded-xl bg-ink px-4 py-2 text-[13px] font-semibold text-paper disabled:opacity-40"
        >
          Aprobar así
        </button>
        <button
          type="button"
          onClick={onCancelar}
          className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-soft"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
