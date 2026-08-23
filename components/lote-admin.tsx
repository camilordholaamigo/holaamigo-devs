'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Mensaje } from '@/lib/pruebas/types';

/**
 * La pantalla de una prueba mientras corre.
 *
 * ── POR QUÉ HAY DOS VISTAS Y NO UNA ────────────────────────────────────────
 *
 * Una prueba puede ser dos cosas muy distintas y no se leen igual:
 *
 *   COMPARAR   pocas conversaciones contra el mismo negocio, desde líneas
 *              distintas. La pregunta es «¿les contestó igual a los tres?», y se
 *              contesta poniendo las transcripciones una al lado de la otra. Si
 *              hay que abrir tres pestañas para comparar, nadie compara.
 *   LISTA      treinta conversaciones de un barrido. La pregunta es «¿a quién
 *              llamo?», y se contesta con una fila por línea, ordenada, con el
 *              último mensaje a la vista.
 *
 * Arranca en la vista que corresponde al tamaño y se puede cambiar. Es la misma
 * lógica de wiki/14: la pantalla la manda la decisión que hay que tomar.
 *
 * ── Y POR QUÉ ESTA PANTALLA ES PARTE DEL MOTOR ─────────────────────────────
 *
 * El GET que consulta acá **empuja la cola**. Mientras alguien la mira, la
 * prueba avanza cada pocos segundos; si nadie la mira, avanza cuando cada
 * conversación cierra y, lo que se trabe, espera el barrido diario. En un plan
 * donde el cron corre una vez al día, la pantalla abierta es la única cosa que
 * corre con la frecuencia del problema.
 */

const POLL_MS = 6_000;

interface EstadoLote {
  total: number;
  pendientes: number;
  corriendo: number;
  cerradas: number;
  sin_respuesta: number;
  fallidas: number;
  organizaciones: number;
  ultimo_arranque: string | null;
}

interface Conversacion {
  id: string;
  template_id: string;
  target_phone: string;
  estado: string;
  cerro_con: string | null;
  turno: number;
  max_turnos: number;
  segundos_primera_respuesta: number | null;
  auditoria_score: number | null;
  evaluacion_score: number | null;
  error: string | null;
  conversation: Mensaje[] | null;
  smoke_targets: { nombre: string | null } | null;
  smoke_channels: { label: string; phone_e164: string } | null;
}

export function LoteEnVivo({
  loteId,
  inicial,
}: {
  loteId: string;
  inicial: { estado: EstadoLote; pruebas: Conversacion[]; corriendo: boolean };
}) {
  const [estado, setEstado] = useState(inicial.estado);
  const [conversaciones, setConversaciones] = useState(inicial.pruebas);
  const [vivo, setVivo] = useState(inicial.corriendo);
  const [ocupado, setOcupado] = useState(false);
  const [comparar, setComparar] = useState(inicial.pruebas.length <= 3);

  const traer = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/pruebas/lotes/${loteId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setEstado(json.estado);
      setConversaciones(json.pruebas ?? []);
      setVivo(json.lote?.estado === 'running');
    } catch {
      /* el ciclo siguiente reintenta con lo último que se supo todavía puesto */
    }
  }, [loteId]);

  useEffect(() => {
    if (!vivo) return;
    const t = setInterval(() => void traer(), POLL_MS);
    return () => clearInterval(t);
  }, [vivo, traer]);

  async function accionar(accion: 'pausar' | 'reanudar' | 'cancelar') {
    setOcupado(true);
    try {
      await fetch(`/api/admin/pruebas/lotes/${loteId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accion }),
      });
      await traer();
    } finally {
      setOcupado(false);
    }
  }

  // El avance cuenta hechos con hora en la base: conversaciones que llegaron a
  // un estado terminal. No se mueve solo entre dos hechos, y eso es a propósito
  // (ADR 0023).
  const terminadas = estado.cerradas + estado.fallidas;
  const avance = estado.total > 0 ? Math.round((terminadas / estado.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="tnum text-[13px] text-ink-soft">
              {terminadas} de {estado.total} · {estado.corriendo} conversando
              {estado.pendientes > 0 ? ` · ${estado.pendientes} en cola` : ''}
              {estado.sin_respuesta > 0 ? (
                <span className="text-leak"> · {estado.sin_respuesta} sin respuesta</span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {conversaciones.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setComparar((v) => !v)}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-paper-sunken"
                >
                  {comparar ? 'Ver como lista' : 'Comparar lado a lado'}
                </button>
              ) : null}
              {vivo ? (
                <button
                  type="button"
                  onClick={() => accionar('pausar')}
                  disabled={ocupado}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-paper-sunken disabled:opacity-40"
                >
                  Pausar
                </button>
              ) : estado.pendientes > 0 ? (
                <button
                  type="button"
                  onClick={() => accionar('reanudar')}
                  disabled={ocupado}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-paper-sunken disabled:opacity-40"
                >
                  Reanudar
                </button>
              ) : null}
              {estado.pendientes > 0 ? (
                <button
                  type="button"
                  onClick={() => accionar('cancelar')}
                  disabled={ocupado}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-[13px] font-medium text-leak transition hover:bg-leak-soft disabled:opacity-40"
                >
                  Cancelar lo que falta
                </button>
              ) : null}
            </div>
          </div>

          <div className="progress-track h-2 w-full overflow-hidden rounded-full">
            <div className="progress-fill h-full rounded-full" style={{ width: `${avance}%` }} />
          </div>

          {vivo ? (
            <p className="text-[12.5px] leading-relaxed text-ink-faint">
              Esta pantalla es la que empuja la cola: mientras esté abierta, la prueba avanza cada
              pocos segundos. Si la cerrás sigue avanzando —cada conversación que termina arranca la
              siguiente— pero lo que se quede trabado espera al barrido diario.
            </p>
          ) : null}
        </div>
      </Card>

      {comparar ? (
        <Comparador conversaciones={conversaciones} />
      ) : (
        <div className="space-y-2">
          {conversaciones.map((c) => (
            <Fila key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Las transcripciones, una al lado de la otra.
 *
 * Es la vista que justifica que existan varias líneas. Con tres columnas se ve
 * de un vistazo lo que en tres pestañas no se ve nunca: que al primero le
 * contestaron en dos minutos y al tercero no le contestaron, o que a los tres
 * les dijeron un precio distinto.
 *
 * Se limita a seis. Más columnas no se comparan: se hojean, y para hojear está
 * la lista.
 */
function Comparador({ conversaciones }: { conversaciones: Conversacion[] }) {
  const visibles = conversaciones.slice(0, 6);

  return (
    <div className="space-y-2">
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {visibles.map((c) => (
          <Columna key={c.id} c={c} />
        ))}
      </div>
      {conversaciones.length > visibles.length ? (
        <p className="text-[12.5px] text-ink-faint">
          Se comparan las primeras {visibles.length} de {conversaciones.length}. Para ver el resto,
          pasá a la lista.
        </p>
      ) : null}
    </div>
  );
}

function Columna({ c }: { c: Conversacion }) {
  const mensajes = c.conversation ?? [];

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="space-y-1.5 border-b border-line bg-paper-sunken px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <Link
            href={`/admin/pruebas/${c.id}`}
            className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink underline decoration-transparent underline-offset-2 transition hover:decoration-line-strong"
          >
            {c.smoke_targets?.nombre ?? c.target_phone}
          </Link>
          <Pastilla estado={c.estado} cerroCon={c.cerro_con} />
        </div>
        <p className="tnum text-[11.5px] text-ink-faint">
          desde {c.smoke_channels?.phone_e164 ?? 'nuestra línea'}
          {c.segundos_primera_respuesta !== null
            ? ` · contestaron en ${minutos(c.segundos_primera_respuesta)}`
            : c.estado === 'running'
              ? ' · esperando'
              : ''}
        </p>
      </div>

      <div className="max-h-[26rem] space-y-2 overflow-y-auto p-3.5">
        {mensajes.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-ink-faint">
            {c.estado === 'pending' ? 'En cola.' : 'Sin mensajes todavía.'}
          </p>
        ) : (
          mensajes.map((m, i) => (
            <div
              key={`${m.timestamp}-${i}`}
              className={cn('flex', m.role === 'comprador' ? 'justify-end' : 'justify-start')}
            >
              <p
                className={cn(
                  'max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-[12.5px] leading-relaxed',
                  m.role === 'comprador'
                    ? 'rounded-br-sm bg-ink text-paper'
                    : 'rounded-bl-sm bg-paper-sunken text-ink',
                )}
              >
                {m.text}
              </p>
            </div>
          ))
        )}
      </div>

      {c.error ? (
        <p className="border-t border-line bg-leak-soft px-4 py-2 text-[12px] leading-snug text-leak">
          {c.error}
        </p>
      ) : null}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTA
// ═══════════════════════════════════════════════════════════════════════════

function Fila({ c }: { c: Conversacion }) {
  const ultimo = [...(c.conversation ?? [])].reverse().find((m) => m.role === 'negocio');

  return (
    <Card>
      <Link
        href={`/admin/pruebas/${c.id}`}
        className="block px-5 py-3.5 transition hover:bg-paper-sunken"
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-ink">
              {c.smoke_targets?.nombre ?? c.target_phone}
            </p>
            <p className="tnum text-[12px] text-ink-faint">
              {c.target_phone}
              {c.smoke_channels ? ` · desde ${c.smoke_channels.phone_e164}` : ''}
              {c.estado === 'running' ? ` · turno ${c.turno} de ${c.max_turnos}` : ''}
            </p>
          </div>
          <Pastilla estado={c.estado} cerroCon={c.cerro_con} />
          <p className="tnum w-20 shrink-0 text-right text-[13px] text-ink-soft">
            {c.segundos_primera_respuesta !== null
              ? minutos(c.segundos_primera_respuesta)
              : '—'}
          </p>
          <p className="tnum w-12 shrink-0 text-right text-[13px] text-ink-faint">
            {c.auditoria_score ?? '—'}
          </p>
        </div>

        {/* El último mensaje del negocio, en la fila. Es lo que decide si vale
            la pena abrir la conversación, y sin esto hay que abrir treinta. */}
        {ultimo ? (
          <p className="mt-2 line-clamp-2 border-l-2 border-line pl-2.5 text-[12.5px] leading-relaxed text-ink-faint">
            {ultimo.text}
          </p>
        ) : null}
      </Link>
    </Card>
  );
}

function Pastilla({ estado, cerroCon }: { estado: string; cerroCon: string | null }) {
  if (estado === 'pending') return <Badge tone="muted">en cola</Badge>;
  if (estado === 'running') return <Badge tone="neutral">conversando</Badge>;
  if (estado === 'failed' || estado === 'cancelled') {
    return <Badge tone="muted">{estado === 'failed' ? 'falló' : 'cancelada'}</Badge>;
  }
  if (cerroCon === 'sin_respuesta') return <Badge tone="leak">sin respuesta</Badge>;
  if (cerroCon === 'bloqueado') return <Badge tone="leak">pidió parar</Badge>;
  if (cerroCon === 'agendado' || cerroCon === 'cotizacion') {
    return <Badge tone="money">{cerroCon}</Badge>;
  }
  return <Badge tone="muted">{cerroCon ?? 'cerrada'}</Badge>;
}

function minutos(segundos: number): string {
  if (segundos < 60) return `${segundos} s`;
  return `${Math.round(segundos / 60)} min`;
}
