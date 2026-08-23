'use client';

import { useState } from 'react';

/**
 * Las tres formas de sacar el informe de la pantalla.
 *
 * ── POR QUÉ UN LINK Y NO UN PDF ADJUNTO ────────────────────────────────────
 *
 * El pedido era «que se pueda mandar por WhatsApp». La respuesta obvia es
 * generar un PDF y adjuntarlo, y es la peor de las tres:
 *
 *   · Un PDF de dos megas por WhatsApp lo abre menos gente que un link.
 *   · No se previsualiza: llega como un ícono gris con un nombre de archivo.
 *   · Y sobre todo — **no se puede medir**. Un adjunto es un agujero negro
 *     comercial: mandaste algo y no sabés si lo abrieron. El link cuenta las
 *     aperturas, y saber que el prospecto lo abrió tres veces es la señal de
 *     compra más barata que vamos a tener nunca.
 *
 * El PDF sigue existiendo, por si alguien lo necesita para imprimirlo o
 * adjuntarlo a una propuesta: es `window.print()`, con el CSS de impresión de
 * esta misma página. Cero dependencias — el mismo argumento de
 * `components/print-button.tsx`.
 */

export function InformeAcciones({ url, negocio }: { url: string; negocio: string }) {
  const [copiado, setCopiado] = useState(false);

  const texto = `Le escribimos a la línea de ${negocio} como lo haría un cliente. Esto fue lo que pasó: ${url}`;

  async function copiar() {
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2200);
    } catch {
      // Sin permiso de portapapeles —Safari en algunos contextos, o http— el
      // botón no puede hacer nada útil. Se muestra la URL para que se pueda
      // seleccionar a mano en vez de dejar un botón que no responde.
      window.prompt('Copiá el enlace:', url);
    }
  }

  return (
    <div className="no-print flex flex-wrap items-center gap-2.5">
      <a
        href={`https://wa.me/?text=${encodeURIComponent(texto)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-xl bg-money-bright px-4 py-2 text-[13px] font-semibold text-paper transition hover:bg-money"
      >
        Enviar por WhatsApp
      </a>

      <button
        type="button"
        onClick={copiar}
        className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-paper-sunken"
      >
        {copiado ? 'Enlace copiado' : 'Copiar enlace'}
      </button>

      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-paper-sunken"
      >
        Guardar como PDF
      </button>
    </div>
  );
}

/**
 * Una conversación que se abre.
 *
 * Va cerrada por defecto y eso es deliberado: el informe tiene que caber en
 * una pantalla para que se lea. Pero la transcripción **tiene que estar** —
 * es la única prueba de todo lo que afirmamos, y un informe que dice «tardaron
 * 34 minutos» sin poder mostrarlo es una opinión con tipografía bonita.
 */
export function Transcripcion({
  titulo,
  subtitulo,
  mensajes,
}: {
  titulo: string;
  subtitulo: string;
  mensajes: Array<{ role: string; text: string; timestamp: string }>;
}) {
  const [abierta, setAbierta] = useState(false);

  return (
    <div className="rounded-xl border border-line">
      <button
        type="button"
        onClick={() => setAbierta((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-paper-sunken"
      >
        <span>
          <span className="block text-[14px] font-medium text-ink">{titulo}</span>
          <span className="block text-[12.5px] text-ink-faint">{subtitulo}</span>
        </span>
        <span className="shrink-0 text-[12.5px] text-ink-faint">
          {abierta ? 'Ocultar' : `Ver los ${mensajes.length} mensajes`}
        </span>
      </button>

      {abierta ? (
        <div className="space-y-2.5 border-t border-line bg-paper-sunken px-4 py-4">
          {mensajes.map((m, i) => (
            <div
              key={`${m.timestamp}-${i}`}
              className={m.role === 'comprador' ? 'flex justify-end' : 'flex justify-start'}
            >
              <p
                className={
                  m.role === 'comprador'
                    ? 'max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ink px-3.5 py-2 text-[13px] leading-relaxed text-paper'
                    : 'max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-paper-raised px-3.5 py-2 text-[13px] leading-relaxed text-ink shadow-[0_1px_2px_rgb(18_16_14_/_0.06)]'
                }
              >
                {m.text}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
