'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@/components/ui';
import type { ReasoningEffort, StepName } from '@/config/models';

/**
 * El formulario de modelos del admin.
 *
 * Muestra el valor VIGENTE de cada paso, no el override: el operador tiene que
 * ver qué está corriendo ahora mismo, no qué escribió alguien alguna vez. La
 * insignia dice de dónde sale ese valor —tabla, variable de entorno o default—
 * porque cuando algo no cambia después de guardar, esa es siempre la pregunta.
 */

export interface StepView {
  step: StepName;
  title: string;
  detail: string;
  models: string[];
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
  webSearch: boolean;
  overridden: boolean;
  /** USD por millón de tokens del primer modelo de la cadena. */
  price: { in: number; out: number };
}

const EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

export function ModelsForm({ steps }: { steps: StepView[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState(steps);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function patch(step: StepName, changes: Partial<StepView>) {
    setDraft((prev) => prev.map((s) => (s.step === step ? { ...s, ...changes } : s)));
    setMessage(null);
  }

  async function save() {
    setBusy(true);
    setMessage(null);

    const overrides = Object.fromEntries(
      draft.map((s) => [
        s.step,
        {
          models: s.models,
          maxOutputTokens: s.maxOutputTokens,
          reasoningEffort: s.reasoningEffort,
          webSearch: s.webSearch,
        },
      ]),
    );

    try {
      const response = await fetch('/api/admin/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overrides }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage({ kind: 'error', text: data.error ?? 'No se pudo guardar.' });
      } else {
        setMessage({
          kind: 'ok',
          text: 'Guardado. Toma efecto en menos de 30 segundos, sin desplegar.',
        });
        router.refresh();
      }
    } catch {
      setMessage({ kind: 'error', text: 'Se cayó la conexión.' });
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/models', { method: 'DELETE' });
      if (!response.ok) {
        setMessage({ kind: 'error', text: 'No se pudo restaurar.' });
      } else {
        setMessage({ kind: 'ok', text: 'Restaurado a los valores del código.' });
        router.refresh();
      }
    } catch {
      setMessage({ kind: 'error', text: 'Se cayó la conexión.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {draft.map((s) => (
        <Card key={s.step} className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <h3 className="text-[15px] font-semibold tracking-tight text-ink">{s.title}</h3>
                <Badge tone={s.overridden ? 'money' : 'muted'}>
                  {s.overridden ? 'configurado aquí' : 'valor por defecto'}
                </Badge>
                {s.webSearch ? <Badge tone="neutral">búsqueda web</Badge> : null}
              </div>
              <p className="max-w-2xl text-[13px] leading-relaxed text-ink-faint">{s.detail}</p>
            </div>
            <p className="tnum shrink-0 text-[12px] text-ink-faint">
              USD {s.price.in}/{s.price.out} por Mtok
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
            <label className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Cadena de modelos
              </span>
              <input
                value={s.models.join(', ')}
                onChange={(e) =>
                  patch(s.step, {
                    models: e.target.value
                      .split(',')
                      .map((m) => m.trim())
                      .filter(Boolean),
                  })
                }
                disabled={busy}
                className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink focus:border-money-bright focus:outline-none"
              />
              <span className="block text-[11.5px] text-ink-faint">
                Se intentan en orden. Si el primero no existe en la cuenta, baja al siguiente.
              </span>
            </label>

            <label className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Tope de tokens
              </span>
              <input
                type="number"
                min={500}
                max={64000}
                step={500}
                value={s.maxOutputTokens}
                onChange={(e) => patch(s.step, { maxOutputTokens: Number(e.target.value) })}
                disabled={busy}
                className="tnum w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-money-bright focus:outline-none"
              />
              <span className="block text-[11.5px] text-ink-faint">
                Incluye el razonamiento invisible. Si sale vacío, súbelo.
              </span>
            </label>

            <label className="space-y-1.5">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Esfuerzo
              </span>
              <select
                value={s.reasoningEffort}
                onChange={(e) =>
                  patch(s.step, { reasoningEffort: e.target.value as ReasoningEffort })
                }
                disabled={busy}
                className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus:border-money-bright focus:outline-none"
              >
                {EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <span className="block text-[11.5px] text-ink-faint">
                Solo aplica a modelos de razonamiento (gpt-5, o*).
              </span>
            </label>
          </div>
        </Card>
      ))}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-xl bg-ink px-5 py-3 text-[14px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-50"
        >
          {busy ? 'Guardando…' : 'Guardar y aplicar'}
        </button>
        <button
          type="button"
          onClick={restore}
          disabled={busy}
          className="rounded-xl border border-line-strong px-5 py-3 text-[14px] font-semibold text-ink transition hover:border-ink disabled:opacity-50"
        >
          Volver a los valores del código
        </button>
        {message ? (
          <p
            className={`text-[13px] font-medium ${
              message.kind === 'ok' ? 'text-money' : 'text-leak'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
