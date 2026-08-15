'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Stat } from '@/components/ui';
import { formatNumber } from '@/lib/utils';

/**
 * §4.6 Carga de leads — "en 1 día empiezas a tener leads nuevos".
 *
 * Flujo: soltar archivo o pegar → vista previa con el mapeo detectado y los
 * conteos reales → corregir columnas si hace falta → declarar base legal →
 * confirmar.
 *
 * El checkbox de base legal NO tiene valor por defecto y NO se puede pasar por
 * alto. No es un tecnicismo: sin consentimiento o interés legítimo, cada
 * mensaje que mandemos es una infracción de Habeas Data en Colombia y de GDPR
 * o TCPA afuera. La declaración queda guardada con timestamp e IP.
 */

interface Preview {
  raw_count: number;
  valid_count: number;
  dup_count: number;
  invalid_count: number;
  phone_count: number;
  mapping: Record<string, string | null>;
  detected_country: string | null;
  segments: Record<string, number>;
  sample: { full_name: string | null; email: string | null; phone_e164: string | null }[];
  notes: string[];
}

const FIELD_LABEL: Record<string, string> = {
  full_name: 'Nombre',
  email: 'Correo',
  phone: 'Teléfono',
  company: 'Empresa',
  title: 'Cargo',
  last_interaction: 'Última interacción',
};

const SEGMENT_LABEL: Record<string, { label: string; hint: string }> = {
  hot: { label: 'Calientes', hint: 'Interactuaron hace menos de 30 días' },
  warm: { label: 'Tibios', hint: 'Entre 1 y 4 meses' },
  cold: { label: 'Fríos', hint: 'Entre 4 meses y año y medio' },
  dead: { label: 'Dormidos', hint: 'Más de año y medio' },
};

export function LeadsUpload({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const fileRef = useRef<File | null>(null);
  const pastedRef = useRef<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<'pick' | 'preview' | 'saving'>('pick');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [consent, setConsent] = useState(false);
  const [consentBasis, setConsentBasis] = useState('consentimiento_expreso');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  async function send(mode: 'preview' | 'commit', overrideMapping?: Record<string, string | null>) {
    setBusy(true);
    setError(null);

    const form = new FormData();
    form.set('mode', mode);
    form.set('organizationId', organizationId);
    if (fileRef.current) form.set('file', fileRef.current);
    else if (pastedRef.current) form.set('pasted', pastedRef.current);

    if (overrideMapping) form.set('mapping', JSON.stringify(overrideMapping));
    if (preview?.detected_country) form.set('country', preview.detected_country);
    if (mode === 'commit') form.set('consentBasis', consentBasis);

    try {
      const response = await fetch('/api/leads/upload', { method: 'POST', body: form });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? 'No pudimos procesar el archivo.');
        if (data.headers) setHeaders(data.headers);
        if (data.mapping) setMapping(data.mapping);
        setBusy(false);
        return;
      }

      if (mode === 'preview') {
        setPreview(data.preview);
        setMapping(data.preview.mapping);
        setHeaders(data.headers ?? []);
        setStage('preview');
      } else {
        router.push(data.next);
        return;
      }
    } catch {
      setError('Se cayó la conexión mientras subíamos el archivo.');
    }
    setBusy(false);
  }

  function pickFile(file: File) {
    fileRef.current = file;
    pastedRef.current = '';
    void send('preview');
  }

  if (stage === 'pick') {
    return (
      <div className="space-y-5">
        <Card
          className={`border-dashed p-10 text-center transition ${dragging ? 'border-money-bright bg-money-soft' : 'border-line-strong'}`}
          {...({
            onDragOver: (e: React.DragEvent) => {
              e.preventDefault();
              setDragging(true);
            },
            onDragLeave: () => setDragging(false),
            onDrop: (e: React.DragEvent) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) pickFile(file);
            },
          } as React.HTMLAttributes<HTMLDivElement>)}
        >
          <p className="text-[16px] font-semibold tracking-tight text-ink">
            Suelta aquí tu CSV o Excel
          </p>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-soft">
            Lo que tengas sirve: la exportación del CRM, el Excel de la secretaria, la lista de
            WhatsApp. Nosotros detectamos las columnas.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="rounded-xl bg-ink px-6 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-60"
            >
              {busy ? 'Leyendo…' : 'Elegir archivo'}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) pickFile(file);
              }}
            />
          </div>
        </Card>

        <Card className="space-y-3 p-5">
          <p className="text-[13.5px] font-medium text-ink">O pega los contactos directamente</p>
          <textarea
            rows={5}
            placeholder={'nombre,correo,telefono\nAna Pérez,ana@acme.com,3001234567'}
            onChange={(e) => {
              pastedRef.current = e.target.value;
              fileRef.current = null;
            }}
            className="w-full resize-none rounded-xl border border-line bg-paper px-4 py-3 font-mono text-[13px] text-ink placeholder:text-ink-faint/60 focus:border-money-bright focus:outline-none"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!pastedRef.current.trim()) {
                setError('Pega al menos una fila.');
                return;
              }
              void send('preview');
            }}
            className="rounded-xl border border-line-strong px-5 py-2.5 text-[14px] font-semibold text-ink transition hover:border-ink disabled:opacity-60"
          >
            Analizar lo pegado
          </button>
        </Card>

        {error ? <p className="text-[13px] font-medium text-leak">{error}</p> : null}
      </div>
    );
  }

  if (!preview) return null;

  const usable = preview.valid_count;

  return (
    <div className="space-y-6">
      {/* Vista previa (§4.6) */}
      <Card className="overflow-hidden">
        <div className="grid gap-6 border-b border-line px-6 py-6 sm:grid-cols-4 sm:px-8">
          <Stat label="Contactos válidos" value={formatNumber(usable)} tone="money" />
          <Stat label="Con teléfono usable" value={formatNumber(preview.phone_count)} />
          <Stat label="Duplicados" value={formatNumber(preview.dup_count)} />
          <Stat
            label="Inválidos"
            value={formatNumber(preview.invalid_count)}
            hint="Sin correo ni teléfono utilizable"
          />
        </div>

        <div className="grid gap-4 px-6 py-6 sm:grid-cols-4 sm:px-8">
          {Object.entries(preview.segments).map(([key, count]) => (
            <div key={key} className="rounded-xl bg-paper-sunken px-4 py-3">
              <p className="tnum text-lg font-semibold text-ink">{formatNumber(count)}</p>
              <p className="text-[12.5px] font-medium text-ink-soft">
                {SEGMENT_LABEL[key]?.label ?? key}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">
                {SEGMENT_LABEL[key]?.hint ?? ''}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* Mapeo, corregible */}
      <Card className="space-y-4 p-6">
        <div>
          <p className="text-[14.5px] font-semibold tracking-tight text-ink">
            Así entendimos tus columnas
          </p>
          <p className="mt-1 text-[13px] text-ink-faint">
            {preview.notes[0] ?? 'Corrige cualquiera que esté mal antes de continuar.'}
            {preview.detected_country
              ? ` País detectado para normalizar teléfonos: ${preview.detected_country}.`
              : ''}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {Object.keys(FIELD_LABEL).map((field) => (
            <label key={field} className="space-y-1.5">
              <span className="block text-[12.5px] font-medium text-ink-soft">
                {FIELD_LABEL[field]}
              </span>
              <select
                value={mapping[field] ?? ''}
                onChange={(e) =>
                  setMapping((prev) => ({ ...prev, [field]: e.target.value || null }))
                }
                className="w-full rounded-lg border border-line bg-paper-raised px-3 py-2.5 text-[13.5px] text-ink focus:border-money-bright focus:outline-none"
              >
                <option value="">— ninguna —</option>
                {headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void send('preview', mapping)}
          className="rounded-xl border border-line-strong px-5 py-2.5 text-[14px] font-semibold text-ink transition hover:border-ink disabled:opacity-60"
        >
          {busy ? 'Recalculando…' : 'Recalcular con este mapeo'}
        </button>
      </Card>

      {/* Base legal — obligatoria */}
      <Card className="space-y-4 p-6">
        <p className="text-[14.5px] font-semibold tracking-tight text-ink">
          Base legal para contactar a esta gente
        </p>

        <div className="space-y-2">
          {[
            {
              value: 'consentimiento_expreso',
              label: 'Me dieron su autorización expresa',
              hint: 'Llenaron un formulario, aceptaron términos, o dijeron que sí por escrito.',
            },
            {
              value: 'interes_legitimo',
              label: 'Son clientes o prospectos con relación comercial previa',
              hint: 'Compraron, cotizaron, o iniciaron una conversación conmigo.',
            },
          ].map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition ${
                consentBasis === option.value ? 'border-ink bg-paper-sunken' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="consentBasis"
                value={option.value}
                checked={consentBasis === option.value}
                onChange={() => setConsentBasis(option.value)}
                className="mt-1"
              />
              <span>
                <span className="block text-[14px] font-medium text-ink">{option.label}</span>
                <span className="block text-[12.5px] leading-snug text-ink-faint">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-paper-sunken px-4 py-3.5">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[13.5px] leading-relaxed text-ink">
            Declaro que tengo la base legal indicada sobre estos contactos y que asumo la
            responsabilidad de esa declaración. Entiendo que queda registrada con fecha y mi
            dirección IP.
          </span>
        </label>
      </Card>

      {error ? <p className="text-[13px] font-medium text-leak">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={!consent || busy || usable === 0}
          onClick={() => {
            setStage('saving');
            void send('commit', mapping);
          }}
          className="rounded-xl bg-ink px-7 py-3.5 text-[15px] font-semibold text-paper transition hover:bg-money-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Guardando…' : `Cargar ${formatNumber(usable)} contactos`}
        </button>
        <button
          type="button"
          onClick={() => {
            setStage('pick');
            setPreview(null);
            fileRef.current = null;
          }}
          className="text-[13.5px] font-medium text-ink-faint underline underline-offset-4 hover:text-ink"
        >
          Cambiar de archivo
        </button>
      </div>

      {!consent ? (
        <p className="text-[12.5px] text-ink-faint">
          Sin esa declaración no procesamos el archivo. No es un formalismo: es lo que nos permite
          escribirle a esta gente sin quemarte a ti.
        </p>
      ) : null}
    </div>
  );
}
