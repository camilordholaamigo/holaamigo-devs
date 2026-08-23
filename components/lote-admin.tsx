'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { PlantillaRow } from '@/lib/pruebas/types';

/**
 * Crear y mirar un lote.
 *
 * Los dos controles que parecen de afinación —cuántas a la vez y cada cuánto—
 * son los que deciden si el número de WhatsApp sobrevive la tanda, así que
 * están arriba y con su explicación al lado, no escondidos en «opciones
 * avanzadas». La primera vez que alguien corre treinta clientes tiene que
 * verlos.
 */

export interface OrgConLinea {
  id: string;
  nombre: string;
  telefono: string;
  ultima_prueba_at: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CREAR
// ═══════════════════════════════════════════════════════════════════════════

export function CrearLote({
  plantillas,
  organizaciones,
}: {
  plantillas: PlantillaRow[];
  organizaciones: OrgConLinea[];
}) {
  const router = useRouter();
  const [nombre, setNombre] = useState('');
  const [proposito, setProposito] = useState<'qa' | 'prospeccion'>('qa');
  const [elegidas, setElegidas] = useState<string[]>(
    plantillas.some((p) => p.id === 'servicio') ? ['servicio'] : [],
  );
  const [orgs, setOrgs] = useState<string[]>([]);
  const [sueltos, setSueltos] = useState('');
  const [maxConcurrentes, setMaxConcurrentes] = useState(4);
  const [ritmo, setRitmo] = useState(45);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [omitidos, setOmitidos] = useState<Array<{ telefono: string; motivo: string }>>([]);

  const telefonosSueltos = sueltos
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const totalLineas = orgs.length + telefonosSueltos.length;
  const totalPruebas = totalLineas * elegidas.length;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOmitidos([]);

    if (elegidas.length === 0) return setError('Elegí al menos un tipo de prueba.');
    if (totalLineas === 0) return setError('Elegí al menos una organización o escribí un número.');

    setEnviando(true);
    try {
      const res = await fetch('/api/admin/pruebas/lotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nombre,
          proposito,
          plantillas: elegidas,
          organizationIds: orgs,
          objetivos: telefonosSueltos.map((telefono) => ({ telefono })),
          maxConcurrentes,
          ritmoSegundos: ritmo,
        }),
      });
      const json = await res.json();
      setOmitidos(json.omitidos ?? []);

      if (!res.ok) {
        setError(json.error ?? 'No se pudo crear el lote.');
        return;
      }
      router.push(`/admin/pruebas/lotes/${json.loteId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card>
      <form onSubmit={enviar} className="space-y-6 p-6">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Nueva tanda</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
            La misma batería contra varias líneas. Los números salen de lo que el
            research ya encontró; no se inventa ninguno.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Nombre de la tanda
            </label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="QA de septiembre"
              required
              className="w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-line-strong"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Para qué
            </label>
            <div className="flex gap-2">
              {(
                [
                  ['qa', 'QA de clientes'],
                  ['prospeccion', 'Prospección'],
                ] as const
              ).map(([valor, texto]) => (
                <button
                  key={valor}
                  type="button"
                  onClick={() => setProposito(valor)}
                  className={cn(
                    'flex-1 rounded-xl border px-3 py-2.5 text-[13px] font-medium transition',
                    proposito === valor
                      ? 'border-ink bg-ink text-paper'
                      : 'border-line text-ink-soft hover:border-line-strong',
                  )}
                >
                  {texto}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Los dos frenos. Arriba y explicados: la primera vez que alguien
            corre treinta clientes tiene que entender qué está apretando. */}
        <div className="space-y-3 rounded-xl bg-paper-sunken p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            El freno
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Deslizador
              etiqueta="Conversaciones a la vez"
              valor={maxConcurrentes}
              min={1}
              max={12}
              onChange={setMaxConcurrentes}
              sufijo={maxConcurrentes === 1 ? 'conversación' : 'conversaciones'}
            />
            <Deslizador
              etiqueta="Entre un arranque y el siguiente"
              valor={ritmo}
              min={0}
              max={300}
              paso={15}
              onChange={setRitmo}
              sufijo="segundos"
            />
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Todas las conversaciones salen del <strong>mismo número</strong> de
            WhatsApp. Abrir muchas a la vez y sin pausa es el patrón que Meta lee
            como spam, y lo que se pierde no es la tanda: es el número.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Qué pruebas · por cada línea
          </p>
          <div className="flex flex-wrap gap-2">
            {plantillas.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  setElegidas((prev) =>
                    prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                  )
                }
                className={cn(
                  'rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition',
                  elegidas.includes(p.id)
                    ? 'border-ink bg-ink text-paper'
                    : 'border-line text-ink-soft hover:border-line-strong',
                )}
              >
                {p.nombre}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              A quién · {orgs.length} de {organizaciones.length}
            </p>
            <button
              type="button"
              onClick={() =>
                setOrgs(orgs.length === organizaciones.length ? [] : organizaciones.map((o) => o.id))
              }
              className="text-[12.5px] text-ink-faint underline underline-offset-2 transition hover:text-ink"
            >
              {orgs.length === organizaciones.length ? 'Ninguna' : 'Todas'}
            </button>
          </div>

          {organizaciones.length === 0 ? (
            <p className="rounded-xl bg-paper-sunken px-4 py-3 text-[13px] text-ink-faint">
              Todavía no hay ninguna línea guardada. Se guardan solas cuando corre el
              research de un diagnóstico, o se pueden escribir a mano acá abajo.
            </p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
              {organizaciones.map((o) => (
                <label
                  key={o.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 transition hover:bg-paper-sunken"
                >
                  <input
                    type="checkbox"
                    checked={orgs.includes(o.id)}
                    onChange={() =>
                      setOrgs((prev) =>
                        prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id],
                      )
                    }
                    className="h-4 w-4 rounded border-line-strong"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{o.nombre}</span>
                  <span className="tnum shrink-0 text-[12px] text-ink-faint">{o.telefono}</span>
                </label>
              ))}
            </div>
          )}

          <textarea
            value={sueltos}
            onChange={(e) => setSueltos(e.target.value)}
            rows={2}
            placeholder="…o pegá números sueltos, uno por línea"
            className="w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition focus:border-line-strong"
          />
        </div>

        {error ? (
          <p className="rounded-xl bg-leak-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-leak">
            {error}
          </p>
        ) : null}

        {omitidos.length > 0 ? (
          <div className="space-y-1 rounded-xl bg-paper-sunken px-3.5 py-3">
            <p className="text-[12px] font-semibold text-ink-soft">
              {omitidos.length} línea{omitidos.length === 1 ? '' : 's'} quedaron afuera:
            </p>
            {omitidos.slice(0, 8).map((o) => (
              <p key={o.telefono} className="tnum text-[12.5px] text-ink-faint">
                {o.telefono} — {o.motivo}
              </p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={enviando || totalPruebas === 0}
            className="rounded-xl bg-ink px-5 py-2.5 text-[14px] font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
          >
            {enviando ? 'Armando la tanda…' : 'Arrancar'}
          </button>
          {totalPruebas > 0 ? (
            <p className="tnum text-[13px] text-ink-faint">
              {totalPruebas} conversaciones · aproximadamente{' '}
              {estimarMinutos(totalPruebas, maxConcurrentes, ritmo)}
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

/**
 * Cuánto va a durar la tanda.
 *
 * Es una estimación y se dice «aproximadamente» porque el que manda es el otro
 * lado: una conversación dura lo que el negocio tarde en contestar. Se asume
 * 12 minutos por conversación, que es la mediana observada. Sin esta cifra
 * alguien lanza treinta clientes creyendo que termina en cinco minutos y
 * cierra la pestaña.
 */
function estimarMinutos(pruebas: number, concurrentes: number, ritmo: number): string {
  const MINUTOS_POR_CONVERSACION = 12;
  const tandas = Math.ceil(pruebas / Math.max(1, concurrentes));
  const minutos = tandas * MINUTOS_POR_CONVERSACION + (pruebas * ritmo) / 60;
  if (minutos < 60) return `${Math.round(minutos)} minutos`;
  const horas = minutos / 60;
  return `${horas.toFixed(1)} horas`;
}

function Deslizador({
  etiqueta,
  valor,
  min,
  max,
  paso = 1,
  sufijo,
  onChange,
}: {
  etiqueta: string;
  valor: number;
  min: number;
  max: number;
  paso?: number;
  sufijo: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12px] text-ink-soft">{etiqueta}</label>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={paso}
          value={valor}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1"
        />
        <span className="tnum w-28 shrink-0 text-[13px] font-medium text-ink">
          {valor} {sufijo}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MIRAR
// ═══════════════════════════════════════════════════════════════════════════

interface EstadoLote {
  total: number;
  pendientes: number;
  corriendo: number;
  cerradas: number;
  sin_respuesta: number;
  fallidas: number;
  organizaciones: number;
}

interface PruebaDeLote {
  id: string;
  template_id: string;
  target_phone: string;
  estado: string;
  cerro_con: string | null;
  turno: number;
  max_turnos: number;
  segundos_primera_respuesta: number | null;
  auditoria_score: number | null;
  error: string | null;
  smoke_targets: { nombre: string | null } | null;
}

const POLL_MS = 5_000;

/**
 * La pantalla del lote, y **el motor del lote**.
 *
 * Cada refresco llama al GET, y ese GET arranca lo que quepa. En un plan donde
 * el cron corre una vez al día, la pantalla abierta es lo único que corre con
 * la frecuencia del problema. Está dicho en la pantalla para que nadie la
 * cierre creyendo que sigue sola — sigue, pero mucho más lento.
 */
export function LoteEnVivo({
  loteId,
  inicial,
}: {
  loteId: string;
  inicial: { estado: EstadoLote; pruebas: PruebaDeLote[]; corriendo: boolean };
}) {
  const [estado, setEstado] = useState(inicial.estado);
  const [pruebas, setPruebas] = useState(inicial.pruebas);
  const [vivo, setVivo] = useState(inicial.corriendo);
  const [ocupado, setOcupado] = useState(false);

  const traer = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/pruebas/lotes/${loteId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setEstado(json.estado);
      setPruebas(json.pruebas ?? []);
      setVivo(json.lote?.estado === 'running');
    } catch {
      /* el ciclo siguiente reintenta */
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

  const avance = estado.total > 0 ? Math.round(((estado.cerradas + estado.fallidas) / estado.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="tnum text-[13px] text-ink-soft">
              {estado.cerradas + estado.fallidas} de {estado.total} · {estado.corriendo} conversando
              {estado.pendientes > 0 ? ` · ${estado.pendientes} en cola` : ''}
            </div>
            <div className="flex gap-2">
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
              Esta pantalla es la que empuja la cola: mientras esté abierta, la tanda
              avanza cada pocos segundos. Si la cerrás sigue avanzando —cada
              conversación que termina arranca la siguiente— pero lo que se quede
              trabado espera al barrido diario.
            </p>
          ) : null}
        </div>
      </Card>

      <div className="space-y-2">
        {pruebas.map((p) => (
          <Card key={p.id}>
            <Link
              href={`/admin/pruebas/${p.id}`}
              className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5 transition hover:bg-paper-sunken"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-ink">
                  {p.smoke_targets?.nombre ?? p.target_phone}
                </p>
                <p className="tnum text-[12px] text-ink-faint">
                  {p.template_id} · {p.target_phone}
                  {p.estado === 'running' ? ` · turno ${p.turno} de ${p.max_turnos}` : ''}
                </p>
              </div>
              <Pastilla estado={p.estado} cerroCon={p.cerro_con} />
              <p className="tnum w-24 shrink-0 text-right text-[13px] text-ink-soft">
                {p.segundos_primera_respuesta !== null
                  ? `${Math.round(p.segundos_primera_respuesta / 60)} min`
                  : '—'}
              </p>
              <p className="tnum w-12 shrink-0 text-right text-[13px] text-ink-faint">
                {p.auditoria_score ?? '—'}
              </p>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Pastilla({ estado, cerroCon }: { estado: string; cerroCon: string | null }) {
  if (estado === 'pending') return <Badge tone="muted">en cola</Badge>;
  if (estado === 'running') return <Badge tone="neutral">conversando</Badge>;
  if (estado === 'failed' || estado === 'cancelled') return <Badge tone="muted">{estado === 'failed' ? 'falló' : 'cancelada'}</Badge>;
  if (cerroCon === 'sin_respuesta') return <Badge tone="leak">sin respuesta</Badge>;
  if (cerroCon === 'agendado' || cerroCon === 'cotizacion') return <Badge tone="money">{cerroCon}</Badge>;
  return <Badge tone="muted">{cerroCon ?? 'cerrada'}</Badge>;
}
