'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

/**
 * La construcción del agente, mostrada mientras pasa.
 *
 * Cada línea que aparece acá viene del servidor y significa que una fase
 * TERMINÓ. No hay temporizadores, no hay pasos que avanzan solos, no hay barra
 * que llega al 90% y se queda. Es ADR 0023 aplicado a la pantalla más tentadora
 * para hacer lo contrario: cuarenta segundos de espera son cuarenta segundos
 * pidiendo una animación falsa.
 *
 * El costo de la honestidad es que a veces una fase tarda quince segundos y no
 * pasa nada en pantalla. Se acepta: un usuario que ve "Escribiendo el guion,
 * las objeciones y las preguntas" quieto durante quince segundos entiende que
 * eso es lo que está pasando. Uno que ve una barra que se mueve sola y termina
 * en un error aprende a no creerle a la pantalla.
 */

interface Fase {
  fase: string;
  estado: 'corriendo' | 'listo' | 'falló';
  detalle: string;
  datos?: Record<string, unknown>;
}

const ORDEN_ESPERADO = [
  { clave: 'contexto', titulo: 'Leemos tu diagnóstico' },
  { clave: 'agenda', titulo: 'Preparamos tu agenda' },
  { clave: 'lenguaje', titulo: 'Escribimos el guion' },
  { clave: 'ensamblado', titulo: 'Ponemos tus números y tus límites' },
  { clave: 'guardado', titulo: 'Guardamos el guion' },
  { clave: 'redactando', titulo: 'Reunimos lo que dice tu sitio' },
  { clave: 'subiendo', titulo: 'Subimos tus documentos' },
  { clave: 'indexando', titulo: 'Indexamos para que pueda buscar' },
];

export function AgentBuilder({
  organizationId,
  sessionId,
  yaExiste,
}: {
  organizationId: string;
  sessionId?: string | null;
  yaExiste: boolean;
}) {
  const router = useRouter();
  const [corriendo, setCorriendo] = useState(false);
  const [fases, setFases] = useState<Fase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  async function construir() {
    setCorriendo(true);
    setError(null);
    setFases([]);

    try {
      const response = await fetch('/api/agent/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, sessionId, force: yaExiste }),
      });

      // Camino corto: ya había un agente y el servidor devolvió JSON en vez de
      // un stream. Pasa cuando el cliente vuelve a esta pantalla.
      const tipo = response.headers.get('content-type') ?? '';
      if (tipo.includes('application/json')) {
        const data = await response.json();
        if (data.ok) {
          router.push(`/agente/${organizationId}`);
          return;
        }
        setError(data.error ?? 'No pudimos armar el agente.');
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('sin respuesta del servidor');

      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON: una fase por línea. La última puede venir partida, así que
        // se deja en el buffer hasta que llegue su salto de línea.
        const lineas = buffer.split('\n');
        buffer = lineas.pop() ?? '';

        for (const linea of lineas) {
          if (!linea.trim()) continue;
          let evento: Fase;
          try {
            evento = JSON.parse(linea) as Fase;
          } catch {
            continue;
          }

          if (evento.fase === 'fin') {
            if (evento.estado === 'falló') setError(evento.detalle);
            else {
              setListo(true);
              // Un segundo para que se lea "Tu agente está listo" antes de
              // saltar. Menos que eso y el cambio de pantalla se siente como
              // un error.
              setTimeout(() => router.push(`/agente/${organizationId}`), 900);
            }
            continue;
          }

          setFases((previas) => fundir(previas, evento));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos armar el agente.');
    } finally {
      setCorriendo(false);
    }
  }

  if (!corriendo && fases.length === 0 && !error) {
    return (
      <button
        type="button"
        onClick={construir}
        className="w-full rounded-xl bg-ink px-5 py-3.5 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright"
      >
        {yaExiste ? 'Volver a armar mi agente' : 'Crear mi agente de agendamiento'}
      </button>
    );
  }

  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-1">
        <p className="text-[15px] font-semibold tracking-tight text-ink">
          {listo ? 'Tu agente está listo.' : 'Armando tu agente'}
        </p>
        <p className="text-[13px] leading-relaxed text-ink-faint">
          {listo
            ? 'Te llevamos a probarlo.'
            : 'Cada línea aparece cuando ese paso terminó de verdad. No hay barra de progreso porque no sabríamos qué porcentaje inventarle.'}
        </p>
      </div>

      <ol className="space-y-2.5">
        {ORDEN_ESPERADO.map((paso) => {
          const fase = fases.find((f) => f.fase === paso.clave);
          const activa = fase?.estado === 'corriendo';
          const hecha = Boolean(fase) && !activa;

          return (
            <li key={paso.clave} className="flex items-start gap-3">
              <span
                className={[
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                  fase?.estado === 'falló'
                    ? 'bg-leak-soft text-leak'
                    : hecha
                      ? 'bg-money-soft text-money'
                      : activa
                        ? 'bg-ink text-paper'
                        : 'bg-paper-sunken text-ink-faint',
                ].join(' ')}
              >
                {fase?.estado === 'falló' ? '!' : hecha ? '✓' : activa ? '·' : ''}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-[13.5px] ${fase ? 'text-ink' : 'text-ink-faint'}`}
                >
                  {paso.titulo}
                </span>
                {fase ? (
                  <span className="block text-[12.5px] leading-relaxed text-ink-faint">
                    {fase.detalle}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      {error ? (
        <div className="space-y-3 rounded-xl bg-leak-soft p-4">
          <p className="text-[13.5px] leading-relaxed text-leak">{error}</p>
          <button
            type="button"
            onClick={construir}
            className="rounded-lg border border-leak/30 px-4 py-2 text-[13px] font-semibold text-leak"
          >
            Intentar otra vez
          </button>
        </div>
      ) : null}
    </Card>
  );
}

/** Una fase se reemplaza a sí misma; el resto conserva su orden de llegada. */
function fundir(previas: Fase[], evento: Fase): Fase[] {
  const sinLaMisma = previas.filter((f) => f.fase !== evento.fase);
  return [...sinLaMisma, evento];
}
