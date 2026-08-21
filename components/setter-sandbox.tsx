'use client';

import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui';

/**
 * El banco de pruebas: el cliente le escribe a su propio agente.
 *
 * Es la pantalla que hace entendible todo lo anterior. Un guion es un documento
 * y nadie confía en un documento; una conversación de cuatro turnos donde el
 * agente pregunta lo correcto, consulta la agenda de verdad y propone dos
 * horarios que existen, se entiende en treinta segundos.
 *
 * LO QUE SE MUESTRA Y NO SE SUELE MOSTRAR: las herramientas que usó cada turno.
 * "Consultó tu agenda" al lado del mensaje es la diferencia entre creerle al
 * agente y poder verificarlo. Es la misma idea que las fuentes en el
 * diagnóstico (§13.4) aplicada a las acciones en vez de a las afirmaciones.
 */

interface Turno {
  quien: 'contacto' | 'agente';
  texto: string;
  herramientas?: Array<{ name: string; ok: boolean }>;
  stage?: string;
}

const ETIQUETA_DE_HERRAMIENTA: Record<string, string> = {
  consultar_horarios: 'Consultó tu agenda',
  agendar_cita: 'Reservó la cita',
  registrar_calificacion: 'Anotó lo que descubrió',
  escalar_a_humano: 'Pidió ayuda a un humano',
  no_contactar: 'Sacó al contacto de la lista',
};

const ETIQUETA_DE_ESCALON: Record<string, string> = {
  apertura: 'Apertura',
  descubrimiento: 'Descubriendo',
  calificacion: 'Calificando',
  objecion: 'Objeción',
  oferta_de_cita: 'Proponiendo horario',
  agendamiento: 'Agendando',
  confirmado: 'Cita confirmada',
  cerrado: 'Cerrada',
};

/** Arranques que el cliente puede probar de un clic. Son los cuatro casos que
 *  deciden si un setter sirve: el interesado, el que pregunta precio, el que
 *  no quiere reunión, y el que se molesta. */
const ARRANQUES = [
  'Hola, me interesa. ¿Cómo funciona?',
  '¿Cuánto cuesta?',
  'Mándame información por acá, no quiero reunión',
  '¿De dónde sacaste mi número?',
];

export function SetterSandbox({ organizationId }: { organizationId: string }) {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [pensando, setPensando] = useState(false);
  const [cerrada, setCerrada] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turnos, pensando]);

  async function enviar(mensaje: string) {
    if (!mensaje.trim() || pensando) return;

    setTurnos((previos) => [...previos, { quien: 'contacto', texto: mensaje }]);
    setTexto('');
    setPensando(true);
    setError(null);

    try {
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, conversationId, mensaje }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? 'El agente no pudo contestar.');
        return;
      }

      setConversationId(data.conversationId);
      setTurnos((previos) => [
        ...previos,
        {
          quien: 'agente',
          texto: data.mensaje,
          herramientas: data.herramientas ?? [],
          stage: data.stage,
        },
      ]);

      if (data.cerrada || ['booked', 'escalated', 'opted_out'].includes(data.status)) {
        setCerrada(data.status);
      }
    } catch {
      setError('Se cayó la conexión. Inténtalo otra vez.');
    } finally {
      setPensando(false);
    }
  }

  function reiniciar() {
    setTurnos([]);
    setConversationId(null);
    setCerrada(null);
    setError(null);
  }

  return (
    <Card className="flex h-[560px] flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-money-bright" />
          <span className="text-[13.5px] font-semibold text-ink">Tu agente de agendamiento</span>
        </div>
        <div className="flex items-center gap-3">
          {turnos.at(-1)?.stage ? (
            <span className="text-[11.5px] text-ink-faint">
              {ETIQUETA_DE_ESCALON[turnos.at(-1)!.stage!] ?? turnos.at(-1)!.stage}
            </span>
          ) : null}
          {turnos.length > 0 ? (
            <button
              type="button"
              onClick={reiniciar}
              className="text-[12px] text-ink-faint underline underline-offset-4 hover:text-ink"
            >
              Empezar de nuevo
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {turnos.length === 0 ? (
          <div className="space-y-4 py-6">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              Escríbele como si fueras uno de tus contactos. El agente consulta tu agenda de
              verdad; lo único que no hace es reservar el cupo.
            </p>
            <div className="flex flex-wrap gap-2">
              {ARRANQUES.map((arranque) => (
                <button
                  key={arranque}
                  type="button"
                  onClick={() => enviar(arranque)}
                  className="rounded-full border border-line-strong px-3.5 py-2 text-[13px] text-ink-soft transition hover:border-ink hover:text-ink"
                >
                  {arranque}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turnos.map((turno, i) => (
          <div
            key={`${i}-${turno.texto.slice(0, 12)}`}
            className={turno.quien === 'contacto' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div className="max-w-[82%] space-y-1.5">
              <div
                className={[
                  'rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed',
                  turno.quien === 'contacto'
                    ? 'rounded-br-sm bg-ink text-paper'
                    : 'rounded-bl-sm bg-paper-sunken text-ink',
                ].join(' ')}
              >
                {turno.texto}
              </div>

              {turno.herramientas && turno.herramientas.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pl-1">
                  {turno.herramientas.map((h, j) => (
                    <span
                      key={`${h.name}-${j}`}
                      className={[
                        'rounded-full px-2 py-0.5 text-[11px]',
                        h.ok ? 'bg-money-soft text-money' : 'bg-leak-soft text-leak',
                      ].join(' ')}
                    >
                      {ETIQUETA_DE_HERRAMIENTA[h.name] ?? h.name}
                      {h.ok ? '' : ' · falló'}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {pensando ? (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-paper-sunken px-4 py-3">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
            </div>
          </div>
        ) : null}

        {cerrada ? (
          <div className="rounded-xl bg-paper-sunken px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
            {cerrada === 'booked'
              ? 'La conversación cerró agendando. En producción, la cita ya estaría en tu calendario y el contacto tendría su confirmación.'
              : cerrada === 'escalated'
                ? 'El agente escaló a un humano. En producción, esto aparece en tu cola de decisiones.'
                : 'El contacto pidió no ser contactado y el agente obedeció sin insistir.'}
          </div>
        ) : null}

        {error ? (
          <p className="rounded-xl bg-leak-soft px-4 py-3 text-[13px] text-leak">{error}</p>
        ) : null}

        <div ref={finRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          enviar(texto);
        }}
        className="flex gap-2 border-t border-line px-4 py-3"
      >
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          disabled={pensando || Boolean(cerrada)}
          placeholder={cerrada ? 'Esta conversación cerró' : 'Escribe como tu contacto…'}
          className="flex-1 rounded-xl border border-line bg-paper px-4 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-ink disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pensando || !texto.trim() || Boolean(cerrada)}
          className="rounded-xl bg-ink px-5 py-2.5 text-[14px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
        >
          Enviar
        </button>
      </form>
    </Card>
  );
}
