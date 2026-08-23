'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { CanalRow, PlantillaRow } from '@/lib/pruebas/types';

/**
 * Los tres formularios de /admin/pruebas.
 *
 * Comparten una regla que se ganó a los golpes en el paquete que portamos:
 * **si algo falla, el formulario se queda abierto con el error a la vista.**
 * Solo se limpia en el camino feliz. En una herramienta de diagnóstico el
 * error ES el producto; cerrar el formulario cuando algo sale mal convierte un
 * fallo de dos segundos —«la llave venció»— en una investigación de veinte
 * minutos.
 */

// ═══════════════════════════════════════════════════════════════════════════
// CREAR UNA PRUEBA
// ═══════════════════════════════════════════════════════════════════════════

export function CrearPrueba({
  plantillas,
  canales,
}: {
  plantillas: PlantillaRow[];
  canales: CanalRow[];
}) {
  const router = useRouter();
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [orgId, setOrgId] = useState('');
  const [canalId, setCanalId] = useState(canales[0]?.id ?? '');
  const [contexto, setContexto] = useState('');
  const [elegidas, setElegidas] = useState<string[]>(
    plantillas.some((p) => p.id === 'servicio') ? ['servicio'] : plantillas.slice(0, 1).map((p) => p.id),
  );
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const alternar = (id: string) =>
    setElegidas((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);

    if (elegidas.length === 0) {
      setError('Elegí al menos un tipo de prueba.');
      return;
    }

    setEnviando(true);
    try {
      const res = await fetch('/api/admin/pruebas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          telefono,
          nombre: nombre.trim() || null,
          plantillas: elegidas,
          organizationId: orgId.trim() || null,
          canalId: canalId || null,
          contexto: contexto.trim() || null,
        }),
      });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? 'No se pudo crear la prueba.');
        return;
      }

      setOk(
        `${json.pruebas} prueba${json.pruebas === 1 ? '' : 's'} en marcha. El primer mensaje ya salió.`,
      );
      setTelefono('');
      setNombre('');
      setContexto('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card>
      <form onSubmit={enviar} className="space-y-5 p-6">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Probar una línea</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
            No hace falta diagnóstico. Con el id de una organización, la prueba se
            compila con su research y además mide exactitud contra su sitio; sin
            él, mide atención: si contestan, en cuánto y si proponen algo.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Campo
            etiqueta="Número al que le escribimos"
            valor={telefono}
            onChange={setTelefono}
            placeholder="+57 300 123 4567"
            requerido
          />
          <Campo
            etiqueta="A nombre de quién"
            valor={nombre}
            onChange={setNombre}
            placeholder="Ferretería El Tornillo"
          />
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Qué pruebas
          </p>
          <div className="flex flex-wrap gap-2">
            {plantillas.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => alternar(p.id)}
                title={p.descripcion}
                className={cn(
                  'rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition',
                  elegidas.includes(p.id)
                    ? 'border-ink bg-ink text-paper'
                    : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
                )}
              >
                {p.nombre}
              </button>
            ))}
          </div>
          {elegidas.length > 1 ? (
            <p className="text-[12px] text-ink-faint">
              Van una detrás de otra contra el mismo número: dos conversaciones a la
              vez caen en el mismo hilo de WhatsApp y ninguna mide nada.
            </p>
          ) : null}
        </div>

        <details className="group">
          <summary className="cursor-pointer text-[13px] font-medium text-ink-faint transition hover:text-ink">
            Opciones
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Campo
              etiqueta="ID de organización (opcional)"
              valor={orgId}
              onChange={setOrgId}
              placeholder="uuid"
            />
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Desde qué línea
              </label>
              <select
                value={canalId}
                onChange={(e) => setCanalId(e.target.value)}
                className="w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-line-strong"
              >
                {canales.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · {c.phone_e164}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2 space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Contexto para el compilador
              </label>
              <textarea
                value={contexto}
                onChange={(e) => setContexto(e.target.value)}
                rows={3}
                placeholder="Lo que sepas del negocio y quieras que la prueba tenga en cuenta."
                className="w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] leading-relaxed text-ink outline-none transition focus:border-line-strong"
              />
            </div>
          </div>
        </details>

        {error ? <Aviso tono="error">{error}</Aviso> : null}
        {ok ? <Aviso tono="ok">{ok}</Aviso> : null}

        <button
          type="submit"
          disabled={enviando || !telefono.trim() || canales.length === 0}
          className="rounded-xl bg-ink px-5 py-2.5 text-[14px] font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
        >
          {enviando ? 'Escribiendo…' : 'Escribir ahora'}
        </button>

        {canales.length === 0 ? (
          <p className="text-[12.5px] text-leak">
            No hay ninguna línea activa. Configurá una abajo antes de probar.
          </p>
        ) : null}
      </form>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// NUESTRA LÍNEA
// ═══════════════════════════════════════════════════════════════════════════

export function EditarCanal({ canal }: { canal: CanalRow | null }) {
  const router = useRouter();
  const [label, setLabel] = useState(canal?.label ?? 'Callbell · línea de pruebas');
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

  return (
    <Card>
      <form onSubmit={guardar} className="space-y-5 p-6">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Nuestra línea</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
            El número desde el que escribimos y su identificador en Callbell. Se
            cambian acá y toman efecto sin desplegar. La llave de la API va en
            Vercel: eso es un secreto, esto es un dato de operación.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Campo etiqueta="Nombre interno" valor={label} onChange={setLabel} requerido />
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
          Activa
        </label>

        {error ? <Aviso tono="error">{error}</Aviso> : null}
        {ok ? <Aviso tono="ok">{ok}</Aviso> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={guardando}
            className="rounded-xl bg-ink px-5 py-2.5 text-[14px] font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>

        {/* El único chequeo que vale es mandar un mensaje. Validar el formato
            del uuid daría una falsa sensación de que está bien configurado. */}
        <div className="space-y-2 border-t border-line pt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Probar el envío
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={prueba}
              onChange={(e) => setPrueba(e.target.value)}
              placeholder="Tu propio celular"
              className="flex-1 rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-line-strong"
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
      </form>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCIONES SOBRE UNA PRUEBA
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
