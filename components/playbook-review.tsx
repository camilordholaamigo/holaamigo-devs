'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import type { Cobertura } from '@/lib/playbook/types';

/**
 * "Confirmá estas cuatro cosas" en vez de "llená esta ficha".
 *
 * Es la pantalla que reemplaza las dos semanas de correos. La diferencia no es
 * cosmética: un formulario le pide al cliente que produzca información; esto le
 * pide que corrija la que ya tenemos. Producir cuesta media hora y se pospone;
 * corregir cuatro campos ya escritos cuesta un minuto y se hace ahí mismo.
 *
 * Cada campo dice POR QUÉ importa. Sin eso, "¿quién atiende la cita?" es una
 * pregunta más de un formulario; con eso —"un nombre concreto agenda más que
 * 'un asesor'"— es un consejo, y la gente contesta los consejos.
 *
 * El porcentaje sube mientras se corrige, y eso es a propósito: es lo que hace
 * que valga la pena corregir el segundo campo.
 */

export function PlaybookReview({
  organizationId,
  cobertura: coberturaInicial,
}: {
  organizationId: string;
  cobertura: Cobertura;
}) {
  const [cobertura, setCobertura] = useState(coberturaInicial);
  const [editando, setEditando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function confirmar(ruta: string, valor: string) {
    setGuardando(true);
    try {
      const response = await fetch('/api/agent/playbook', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, ruta, valor }),
      });
      const data = await response.json();
      if (data.ok && data.cobertura) setCobertura(data.cobertura);
      setEditando(null);
    } finally {
      setGuardando(false);
    }
  }

  if (cobertura.a_confirmar.length === 0) {
    return (
      <Card className="space-y-2 p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-money-soft text-[12px] text-money">
            ✓
          </span>
          <p className="text-[15px] font-semibold tracking-tight text-ink">
            No queda nada por confirmar.
          </p>
        </div>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Todo lo que tu agente dice se sostiene en tu sitio o en lo que nos contaste. Puedes
          seguir afinando el guion completo desde la consola cuando quieras.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[15px] font-semibold tracking-tight text-ink">
            Confirma {cobertura.a_confirmar.length}{' '}
            {cobertura.a_confirmar.length === 1 ? 'cosa' : 'cosas'}
          </p>
          <span className="text-[12.5px] text-ink-faint">
            {cobertura.porcentaje}% sale de tu sitio
          </span>
        </div>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Esto lo dedujimos nosotros. Ya está escrito y tu agente lo va a usar tal cual — solo
          dinos si está bien o corrígelo.
        </p>
        <div className="h-1 overflow-hidden rounded-full bg-paper-sunken">
          <div
            className="h-full rounded-full bg-money-bright transition-[width] duration-500"
            style={{ width: `${Math.max(cobertura.porcentaje, 4)}%` }}
          />
        </div>
      </div>

      <ul className="space-y-3">
        {cobertura.a_confirmar.map((item) => {
          const abierto = editando === item.ruta;

          return (
            <li key={item.ruta} className="rounded-xl border border-line bg-paper p-4">
              <p className="text-[13px] font-semibold text-ink">{item.etiqueta}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-faint">
                {item.por_que_importa}
              </p>

              {abierto ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    value={borrador}
                    onChange={(e) => setBorrador(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none focus:border-ink"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={guardando || !borrador.trim()}
                      onClick={() => confirmar(item.ruta, borrador.trim())}
                      className="rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-paper disabled:opacity-40"
                    >
                      Guardar
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditando(null)}
                      className="rounded-lg px-3 py-2 text-[13px] text-ink-faint hover:text-ink"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="mt-2.5 rounded-lg bg-paper-sunken px-3 py-2 text-[13.5px] leading-relaxed text-ink-soft">
                    {item.valor || <span className="text-ink-faint">(vacío)</span>}
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      disabled={guardando}
                      onClick={() => confirmar(item.ruta, item.valor)}
                      className="rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-semibold text-ink transition hover:border-ink disabled:opacity-40"
                    >
                      Está bien
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditando(item.ruta);
                        setBorrador(item.valor);
                      }}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-faint hover:text-ink"
                    >
                      Corregir
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
