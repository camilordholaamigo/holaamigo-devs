'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Generar los informes de una prueba, y mandarlos.
 *
 * Dos botones separados a propósito. Generar es barato y reversible: arma el
 * objeto y publica un enlace que nadie conoce todavía. Enviar sale del
 * edificio y llega a la bandeja de alguien.
 *
 * Es la misma disciplina de `/admin/senales` (ADR 0021): el sistema detecta y
 * redacta, una persona decide qué sale. Un correo automático diciéndole a un
 * prospecto que su equipo contesta mal es exactamente el mensaje que hay que
 * leer antes de mandar.
 */

export function GenerarInformes({ loteId, listos }: { loteId: string; listos: number }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generar() {
    setOcupado(true);
    setError(null);
    setMensaje(null);
    try {
      const res = await fetch('/api/admin/pruebas/informes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loteId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo generar.');
        return;
      }
      const vacios = json.vacios?.length ?? 0;
      setMensaje(
        `${json.generados} informe${json.generados === 1 ? '' : 's'} listo${json.generados === 1 ? '' : 's'}` +
          (vacios > 0
            ? ` · ${vacios} sin conversaciones todavía, se pueden generar después`
            : ''),
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={generar}
        disabled={ocupado}
        className="rounded-xl bg-ink px-4 py-2 text-[13.5px] font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
      >
        {ocupado
          ? 'Armando…'
          : listos > 0
            ? 'Volver a generar'
            : 'Generar los informes'}
      </button>
      {mensaje ? <span className="text-[13px] text-money">{mensaje}</span> : null}
      {error ? <span className="text-[13px] text-leak">{error}</span> : null}
    </div>
  );
}

/**
 * Mandar un informe por correo.
 *
 * El campo del destinatario viene con el correo que la organización dejó en la
 * landing y se puede cambiar. Que sea editable no es comodidad: el que llenó
 * el formulario casi nunca es el que decide, y mandarle el informe al gerente
 * en vez de al pasante es la diferencia entre que se lea y que no.
 */
export function EnviarInforme({
  informeId,
  correoPorDefecto,
  asunto,
  cuerpo,
  url,
}: {
  informeId: string;
  correoPorDefecto: string | null;
  asunto: string | null;
  cuerpo: string | null;
  url: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [para, setPara] = useState(correoPorDefecto ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!asunto || !cuerpo) {
    return (
      <p className="text-[12.5px] text-ink-faint">
        Sin borrador de correo. Se genera con la llave de OpenAI cargada; el enlace
        del informe funciona igual.
      </p>
    );
  }

  async function enviar() {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/pruebas/informes', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ informeId, accion: 'enviar', para }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo enviar.');
        return;
      }
      setResultado(`Enviado a ${json.enviado_a}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className="text-[13px] font-medium text-ink-faint underline underline-offset-2 transition hover:text-ink"
      >
        {abierto ? 'Ocultar el borrador' : 'Ver y mandar el correo'}
      </button>

      {abierto ? (
        <div className="space-y-3 rounded-xl border border-line bg-paper-sunken p-4">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Asunto
            </p>
            <p className="text-[14px] font-medium text-ink">{asunto}</p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Cuerpo
            </p>
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-soft">
              {cuerpo.replaceAll('{{link}}', '')}
            </p>
            <p className="tnum break-all text-[12px] text-ink-faint">{url}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              value={para}
              onChange={(e) => setPara(e.target.value)}
              placeholder="a quién"
              className="flex-1 rounded-xl border border-line bg-paper-raised px-3.5 py-2 text-[13.5px] text-ink outline-none transition focus:border-line-strong"
            />
            <button
              type="button"
              onClick={enviar}
              disabled={ocupado || !para.trim()}
              className={cn(
                'rounded-xl px-4 py-2 text-[13.5px] font-semibold transition disabled:opacity-40',
                'bg-ink text-paper hover:bg-ink/90',
              )}
            >
              {ocupado ? 'Enviando…' : 'Enviar'}
            </button>
          </div>

          {resultado ? <p className="text-[13px] text-money">{resultado}</p> : null}
          {error ? <p className="text-[13px] text-leak">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
