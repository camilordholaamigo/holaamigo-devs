'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { CanalRow } from '@/lib/pruebas/types';

/**
 * Las piezas con estado de /admin/pruebas.
 *
 * Comparten una regla que se ganó a los golpes en el paquete que portamos:
 * **si algo falla, el formulario se queda abierto con el error a la vista.**
 * Solo se limpia en el camino feliz. En una herramienta de diagnóstico el error
 * ES el producto; cerrar el formulario cuando algo sale mal convierte un fallo
 * de dos segundos —«la llave venció»— en una investigación de veinte minutos.
 *
 * El formulario de crear una prueba ya no vive acá: se fue a
 * `components/prueba-nueva.tsx` y a su propia pantalla. Tenía tres pasos y una
 * vista previa, y no cabía al lado de la configuración sin que las dos cosas
 * parecieran del mismo peso — que era justamente el problema.
 */

// ═══════════════════════════════════════════════════════════════════════════
// NUESTRAS LÍNEAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Varias líneas, no una.
 *
 * Hasta ADR 0027 esta pantalla editaba «nuestra línea», en singular, porque el
 * motor solo sabía usar una. Ahora cada línea es un hilo de WhatsApp propio y
 * tener tres es la unidad de escala: es lo que permite ver si el agente de un
 * negocio les contesta igual a tres clientes a la vez, y es lo que sube el techo
 * de conversaciones diarias sin acercarse al umbral de spam de Meta.
 *
 * Una línea no se borra: se apaga. Las conversaciones viejas apuntan a ella con
 * una clave foránea y borrarla se llevaría el historial que sirve justamente
 * para comparar contra las nuevas.
 */
export function LineasDeCallbell({ canales }: { canales: CanalRow[] }) {
  const [agregando, setAgregando] = useState(canales.length === 0);

  return (
    <div className="space-y-3">
      {canales.map((c) => (
        <LineaEditable key={c.id} canal={c} />
      ))}

      {agregando ? (
        <LineaEditable canal={null} onCerrar={() => setAgregando(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAgregando(true)}
          className="w-full rounded-[14px] border border-dashed border-line-strong px-5 py-4 text-[13.5px] font-medium text-ink-soft transition hover:border-ink hover:text-ink"
        >
          + Agregar otra línea
        </button>
      )}
    </div>
  );
}

function LineaEditable({
  canal,
  onCerrar,
}: {
  canal: CanalRow | null;
  onCerrar?: () => void;
}) {
  const router = useRouter();
  const nueva = canal === null;

  const [abierta, setAbierta] = useState(nueva);
  const [label, setLabel] = useState(canal?.label ?? '');
  const [phone, setPhone] = useState(canal?.phone_e164 ?? '');
  const [channelUuid, setChannelUuid] = useState(canal?.channel_uuid ?? '');
  const [templateUuid, setTemplateUuid] = useState(canal?.template_uuid ?? '');
  const [activo, setActivo] = useState(canal?.activo ?? true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [prueba, setPrueba] = useState('');
  const [resultado, setResultado] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    setGuardando(true);
    try {
      const res = await fetch('/api/admin/pruebas/canales', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: canal?.id ?? null,
          label,
          phone,
          channelUuid,
          templateUuid: templateUuid.trim() || null,
          activo,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo guardar.');
        return;
      }
      setOk('Guardado. Toma efecto en menos de 30 segundos.');
      if (nueva) onCerrar?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setGuardando(false);
    }
  }

  async function mandarPrueba() {
    setResultado(null);
    try {
      const res = await fetch('/api/admin/pruebas/diagnose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telefono: prueba, canalId: canal?.id }),
      });
      const json = await res.json();
      setResultado(
        json.ok
          ? `Salió. Id del mensaje: ${json.messageId ?? '(sin id)'}`
          : `Falló: ${json.error}${json.pista ? ` — ${json.pista}` : ''}`,
      );
    } catch (err) {
      setResultado(err instanceof Error ? err.message : 'Falló la petición.');
    }
  }

  if (!abierta && canal) {
    return (
      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-ink">{canal.label}</p>
            <p className="tnum text-[12.5px] text-ink-faint">
              {canal.phone_e164} · {canal.channel_uuid.slice(0, 8)}…
            </p>
          </div>
          <Badge tone={canal.activo ? 'money' : 'muted'}>
            {canal.activo ? 'activa' : 'apagada'}
          </Badge>
          <button
            type="button"
            onClick={() => setAbierta(true)}
            className="shrink-0 text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-2 transition hover:decoration-ink"
          >
            Editar
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className={nueva ? 'border-ink/30' : undefined}>
      <form onSubmit={guardar} className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            etiqueta="Nombre interno"
            valor={label}
            onChange={setLabel}
            placeholder="Callbell · línea 2"
            requerido
          />
          <Campo
            etiqueta="Nuestro número"
            valor={phone}
            onChange={setPhone}
            placeholder="+573054182637"
            requerido
          />
          <Campo
            etiqueta="channel_uuid de Callbell"
            valor={channelUuid}
            onChange={setChannelUuid}
            placeholder="124902a5f0fa43289fe1fa7a4c23fe0d"
            requerido
          />
          <Campo
            etiqueta="template_uuid (solo API oficial)"
            valor={templateUuid}
            onChange={setTemplateUuid}
            placeholder="vacío si la línea es por QR"
          />
        </div>

        <label className="flex items-center gap-2.5 text-[13.5px] text-ink-soft">
          <input
            type="checkbox"
            checked={activo}
            onChange={(e) => setActivo(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong"
          />
          Activa · se puede elegir al crear una prueba
        </label>

        {error ? <Aviso tono="error">{error}</Aviso> : null}
        {ok ? <Aviso tono="ok">{ok}</Aviso> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={guardando}
            className="rounded-xl bg-ink px-4 py-2.5 text-[14px] font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
          >
            {guardando ? 'Guardando…' : nueva ? 'Agregar línea' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={() => (nueva ? onCerrar?.() : setAbierta(false))}
            className="text-[13px] font-medium text-ink-faint transition hover:text-ink"
          >
            Cancelar
          </button>
        </div>

        {/* El único chequeo que vale es mandar un mensaje. Validar el formato
            del uuid daría una falsa sensación de que está bien configurado, y
            acá vive la mitad de los problemas de puesta en marcha. */}
        {canal ? (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Probar el envío desde esta línea
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                value={prueba}
                onChange={(e) => setPrueba(e.target.value)}
                placeholder="Tu propio celular"
                className="min-w-0 flex-1 rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-line-strong"
              />
              <button
                type="button"
                onClick={mandarPrueba}
                disabled={!prueba.trim()}
                className="rounded-xl border border-line-strong px-4 py-2.5 text-[14px] font-medium text-ink transition hover:bg-paper-sunken disabled:opacity-40"
              >
                Mandar
              </button>
            </div>
            {resultado ? (
              <p className="text-[13px] leading-relaxed text-ink-soft">{resultado}</p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCIONES SOBRE UNA CONVERSACIÓN
// ═══════════════════════════════════════════════════════════════════════════

export function AccionesDePrueba({
  pruebaId,
  viva,
  yaEvaluada,
}: {
  pruebaId: string;
  viva: boolean;
  yaEvaluada: boolean;
}) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accionar(accion: 'cancelar' | 'reevaluar') {
    setOcupado(accion);
    setError(null);
    try {
      const res = await fetch('/api/admin/pruebas', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accion, pruebaId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? 'No se pudo.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {viva ? (
        <button
          type="button"
          onClick={() => accionar('cancelar')}
          disabled={ocupado !== null}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-paper-sunken disabled:opacity-40"
        >
          {ocupado === 'cancelar' ? 'Cancelando…' : 'Cancelar'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => accionar('reevaluar')}
          disabled={ocupado !== null}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-paper-sunken disabled:opacity-40"
        >
          {ocupado === 'reevaluar'
            ? 'Encolando…'
            : yaEvaluada
              ? 'Volver a calificar'
              : 'Calificar'}
        </button>
      )}
      {error ? <span className="text-[12.5px] text-leak">{error}</span> : null}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

function Campo({
  etiqueta,
  valor,
  onChange,
  placeholder,
  requerido,
}: {
  etiqueta: string;
  valor: string;
  onChange: (v: string) => void;
  placeholder?: string;
  requerido?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {etiqueta}
      </label>
      <input
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={requerido}
        className="w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-line-strong"
      />
    </div>
  );
}

function Aviso({ tono, children }: { tono: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed',
        tono === 'error' ? 'bg-leak-soft text-leak' : 'bg-money-soft text-money',
      )}
    >
      {children}
    </p>
  );
}
