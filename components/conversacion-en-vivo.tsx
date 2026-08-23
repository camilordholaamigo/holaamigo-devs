'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Mensaje } from '@/lib/pruebas/types';
import type { PruebaResumida } from '@/lib/pruebas/resumen';

/**
 * La transcripción, creciendo sola.
 *
 * Es lo que hace que la herramienta se vuelva a abrir. La conversación tarda
 * entre dos y veinticinco minutos, y hasta ahora el operador tenía que recargar
 * a mano para saber si había pasado algo — así que no volvía.
 *
 * ── DE DÓNDE SALE EL ESTADO ────────────────────────────────────────────────
 *
 * De `GET /api/pruebas/estado/[runId]`, que es el mismo endpoint que consulta el
 * diagnóstico del cliente. No es reuso por pereza: ese GET **es la red de
 * seguridad real** del motor. Cierra las conversaciones estancadas y despierta
 * las colas cuyo avanzador murió, y corre con la frecuencia del problema porque
 * alguien está mirando. El cron es la red de atrás.
 *
 * O sea: tener esta pantalla abierta no es solo cómodo, es lo que hace que el
 * arnés avance en un plan donde el cron corre una vez al día.
 *
 * ── LO QUE NO HACE ─────────────────────────────────────────────────────────
 *
 * No hay barra que avance sola ni «escribiendo…» inventado. El reloj que corre
 * es real —son segundos desde un timestamp de la base— y los globos aparecen
 * cuando hay un mensaje. Nada finge progreso que no está pasando (ADR 0023).
 */

const CADA_MS = 4_000;

export function ConversacionEnVivo({
  runId,
  pruebaId,
  inicial,
  viva,
}: {
  runId: string;
  pruebaId: string;
  inicial: { conversation: Mensaje[]; turno: number; maxTurnos: number };
  viva: boolean;
}) {
  const router = useRouter();
  const [mensajes, setMensajes] = useState<Mensaje[]>(inicial.conversation ?? []);
  const [turno, setTurno] = useState(inicial.turno);
  const [titular, setTitular] = useState<string | null>(null);
  const [estado, setEstado] = useState<PruebaResumida['estado'] | null>(null);
  const [esperando, setEsperando] = useState<number | null>(null);
  // `terminada` es estado y no un ref a propósito: es lo que decide si el
  // intervalo sigue vivo Y lo que decide qué se pinta. Un ref servía para lo
  // primero y no para lo segundo, y leerlo en el render es justo el error que
  // el compilador de React marca — la pastilla «en vivo» se quedaba encendida.
  const [terminada, setTerminada] = useState(!viva);

  useEffect(() => {
    if (!viva || terminada) return;
    let cancelado = false;

    async function mirar() {
      try {
        const res = await fetch(`/api/pruebas/estado/${runId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { pruebas: PruebaResumida[] };
        const mia = json.pruebas.find((p) => p.id === pruebaId);
        if (!mia || cancelado) return;

        setMensajes(mia.conversation ?? []);
        setTurno(mia.turno);
        setTitular(mia.titular);
        setEstado(mia.estado);
        setEsperando(mia.esperando_hace);

        if (mia.estado === 'cerrada' || mia.estado === 'fallida') {
          setTerminada(true);
          // Un refresh y nada más: los veredictos los pinta el servidor, que es
          // el que tiene la auditoría y la evaluación. Seguir consultando el
          // endpoint después de cerrada sería gastar por gastar.
          router.refresh();
        }
      } catch {
        // Un fallo de red no puede vaciar la pantalla. Se reintenta al tick
        // siguiente con lo último que se supo todavía puesto.
      }
    }

    void mirar();
    const t = setInterval(() => void mirar(), CADA_MS);

    return () => {
      cancelado = true;
      clearInterval(t);
    };
  }, [runId, pruebaId, viva, terminada, router]);

  const enCurso = viva && !terminada;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">La conversación</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="muted">
            turno {turno} de {inicial.maxTurnos}
          </Badge>
          {enCurso ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-paper-sunken px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-money-bright opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-money-bright" />
              </span>
              {/* El estado real y no un «en vivo» genérico: «esperando
                  respuesta» es la información que le falta al operador cuando
                  mira una pantalla que no cambia hace cuatro minutos. */}
              {estado === 'esperando'
                ? 'esperando respuesta'
                : estado === 'escribiendo'
                  ? 'mandando el primero'
                  : estado === 'conversando'
                    ? 'conversando'
                    : 'en vivo'}
            </span>
          ) : null}
        </div>
      </div>

      {titular && enCurso ? (
        <p className="tnum text-[13px] leading-relaxed text-ink-soft">
          {titular}
          {esperando !== null && esperando > 30 ? (
            <span className="text-ink-faint"> · {duracion(esperando)} esperando</span>
          ) : null}
        </p>
      ) : null}

      {mensajes.length === 0 ? (
        <Card>
          <p className="px-5 py-8 text-center text-[13px] text-ink-faint">
            El mensaje todavía no salió. Si en un minuto sigue así, mirá el error de arriba o{' '}
            <code className="rounded bg-paper-sunken px-1 py-0.5">/api/admin/pruebas/diagnose</code>.
          </p>
        </Card>
      ) : (
        <Card>
          <div className="space-y-2.5 p-5">
            {mensajes.map((m, i) => (
              <div
                key={`${m.timestamp}-${i}`}
                className={cn('flex', m.role === 'comprador' ? 'justify-end' : 'justify-start')}
              >
                <div className="max-w-[80%] space-y-1">
                  <p
                    className={cn(
                      'whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed',
                      m.role === 'comprador'
                        ? 'rounded-br-sm bg-ink text-paper'
                        : 'rounded-bl-sm bg-paper-sunken text-ink',
                    )}
                  >
                    {m.text}
                  </p>
                  <p
                    className={cn(
                      'tnum text-[10.5px] text-ink-faint',
                      m.role === 'comprador' ? 'text-right' : 'text-left',
                    )}
                  >
                    {m.role === 'comprador' ? 'nosotros' : 'el negocio'} ·{' '}
                    {m.timestamp.slice(11, 16)}
                  </p>
                </div>
              </div>
            ))}

            {enCurso ? (
              <p className="pt-2 text-center text-[11.5px] text-ink-faint">
                Se puede cerrar esta pestaña: el motor es todo de servidor. Pero mientras esté
                abierta, es lo que empuja la cola.
              </p>
            ) : null}
          </div>
        </Card>
      )}
    </div>
  );
}

function duracion(segundos: number): string {
  if (segundos < 60) return `${segundos} s`;
  const m = Math.round(segundos / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
