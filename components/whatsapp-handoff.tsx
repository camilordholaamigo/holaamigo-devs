'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';

/**
 * El único paso que NO pudimos colapsar, dicho como es.
 *
 * Armar el agente pasó de dos semanas a cuarenta segundos. Verificar un número
 * con Meta sigue tardando de 24 a 48 horas, y eso no depende de nosotros: es la
 * cola de revisión de Meta. Fingir que ese paso también es instantáneo sería la
 * clase de promesa que se rompe sola al día siguiente.
 *
 * Entonces se dice al revés de como se suele decir: **tu agente ya está listo;
 * lo que falta es el número, y eso lo demora Meta.** El cliente ya lo probó, así
 * que la espera es por algo que vio funcionar, no por algo que le prometimos.
 *
 * Los tres campos que se piden acá son exactamente los que un operador nuestro
 * necesitaría preguntar por correo mañana. Pedirlos ahora, mientras el cliente
 * está mirando su agente funcionar, es lo que evita el primer correo de ida y
 * vuelta. Principio §13.3: seguimos provisionando a mano, pero ya no
 * preguntando a mano.
 */

export function WhatsappHandoff({
  organizationId,
  sessionId,
  estado,
}: {
  organizationId: string;
  sessionId: string | null;
  estado: string | null;
}) {
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(estado === 'pending' || estado === 'connected');
  const [telefono, setTelefono] = useState('');
  const [quienAtiende, setQuienAtiende] = useState('');
  const [tieneNumero, setTieneNumero] = useState<'nuevo' | 'existente'>('existente');

  async function solicitar() {
    setEnviando(true);
    try {
      const response = await fetch('/api/channels/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          sessionId,
          channel: 'whatsapp',
          action: 'request',
          meta: {
            telefono: telefono.trim() || null,
            quien_atiende: quienAtiende.trim() || null,
            tipo_de_numero: tieneNumero,
            agente_listo: true,
          },
        }),
      });
      if (response.ok) setEnviado(true);
    } finally {
      setEnviando(false);
    }
  }

  if (estado === 'connected') {
    return (
      <Card className="space-y-2 border-money/20 p-6">
        <p className="text-[15px] font-semibold tracking-tight text-ink">
          WhatsApp conectado. Tu agente está trabajando.
        </p>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Cada conversación que entre por tu número la contesta el agente que acabas de probar,
          con este mismo guion.
        </p>
      </Card>
    );
  }

  if (enviado) {
    return (
      <Card className="space-y-3 p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-money-soft text-[12px] text-money">
            ✓
          </span>
          <p className="text-[15px] font-semibold tracking-tight text-ink">
            Recibimos la solicitud del número.
          </p>
        </div>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Te escribimos hoy mismo para verificarlo con Meta. Su revisión tarda entre 24 y 48 horas
          y no la podemos acelerar. Tu agente ya está armado: el día que el número quede
          aprobado, empieza a contestar sin que tengas que configurar nada más.
        </p>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          Mientras tanto puedes seguir probándolo acá arriba y corrigiendo el guion. Los cambios
          que hagas hoy son los que van a estar el día que arranque.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <p className="text-[15px] font-semibold tracking-tight text-ink">
          Lo último: el número de WhatsApp.
        </p>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Tu agente ya está listo. Lo que falta es el número, y esa parte la demora Meta: entre 24
          y 48 horas de revisión. Déjanos estos tres datos y arrancamos la verificación hoy.
        </p>
      </div>

      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-ink">
            ¿Qué número quieres usar?
          </span>
          <input
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            placeholder="+57 300 123 4567"
            className="w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
          />
          <span className="block text-[12px] leading-relaxed text-ink-faint">
            Tiene que ser un número que no esté usando la app normal de WhatsApp. Si no tienes
            uno libre, déjalo vacío y te conseguimos uno.
          </span>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-ink">Ese número…</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['existente', 'Ya es mío'],
                ['nuevo', 'Necesito uno nuevo'],
              ] as const
            ).map(([valor, etiqueta]) => (
              <button
                key={valor}
                type="button"
                onClick={() => setTieneNumero(valor)}
                className={[
                  'rounded-full px-4 py-2 text-[13px] font-medium transition',
                  tieneNumero === valor
                    ? 'bg-ink text-paper'
                    : 'border border-line-strong text-ink-soft hover:border-ink',
                ].join(' ')}
              >
                {etiqueta}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-ink">
            ¿Quién atiende las citas que agende?
          </span>
          <input
            value={quienAtiende}
            onChange={(e) => setQuienAtiende(e.target.value)}
            placeholder="Camila, del equipo comercial"
            className="w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
          />
          <span className="block text-[12px] leading-relaxed text-ink-faint">
            Un nombre concreto agenda más que “un asesor”. El agente lo usa cuando le preguntan
            con quién es la reunión.
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={solicitar}
          disabled={enviando}
          className="rounded-xl bg-ink px-6 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-50"
        >
          {enviando ? 'Enviando…' : 'Empezar la verificación'}
        </button>
        {/* El skip sigue visible (§13.5). Un cliente que no quiere dar su número
            todavía no pierde nada: el agente ya está armado y probable. */}
        <a
          href={`/leads/${organizationId}`}
          className="text-[13.5px] text-ink-faint underline underline-offset-4 hover:text-ink"
        >
          Después. Quiero cargar mi base primero
        </a>
      </div>
    </Card>
  );
}
