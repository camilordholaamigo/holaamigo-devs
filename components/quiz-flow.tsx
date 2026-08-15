'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ResearchTicker } from '@/components/research-ticker';
import type { QuizQuestion } from '@/lib/quiz/bank';

/**
 * El quiz (PRD §4.2).
 *
 * Una pregunta a la vez. Barra de progreso. Arriba, el indicador vivo del
 * research.
 *
 * Cada respuesta viaja al servidor apenas se da: nunca acumulamos estado en el
 * cliente para mandarlo al final. Si cierra la pestaña en la pregunta 4,
 * tenemos las 3 primeras y un lead recuperable — que vale más que la elegancia
 * de un submit único.
 */

interface NextResponse {
  question: QuizQuestion | null;
  answeredCount: number;
  total: number;
  done: boolean;
  runId?: string | null;
  organizationId?: string;
}

export function QuizFlow({
  sessionId,
  domain,
  initialRunId,
}: {
  sessionId: string;
  domain: string;
  initialRunId: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<NextResponse | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Borrador local de la respuesta en curso (texto, número, multi).
  const [draft, setDraft] = useState<string | string[]>('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/quiz/next', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await response.json()) as NextResponse & { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'No pudimos cargar el quiz.');
        return;
      }
      setState(data);
      if (data.runId) setRunId(data.runId);
      setDraft(data.question?.input_type === 'multi' ? [] : '');
    } catch {
      setError('Se cayó la conexión. Recarga la página.');
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const response = await fetch('/api/diagnostic/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'No pudimos armar el diagnóstico.');
        setGenerating(false);
        return;
      }
      router.push(data.next);
    } catch {
      setError('Se cayó la conexión mientras armábamos tu diagnóstico.');
      setGenerating(false);
    }
  }, [sessionId, router]);

  useEffect(() => {
    if (state?.done && !generating) void generate();
  }, [state?.done, generating, generate]);

  async function submit(answer: unknown) {
    if (!state?.question || busy) return;
    const key = state.question.slot ?? state.question.id;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/quiz/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, key, answer }),
      });
      const data = (await response.json()) as NextResponse & { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'No pudimos guardar tu respuesta.');
        setBusy(false);
        return;
      }
      setState(data);
      setDraft(data.question?.input_type === 'multi' ? [] : '');
    } catch {
      setError('No pudimos guardar tu respuesta. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !state) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-center">
        <p className="text-[15px] text-leak">{error}</p>
      </div>
    );
  }

  if (generating || state?.done) {
    return <Assembling domain={domain} runId={runId} />;
  }

  if (!state?.question) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <div className="h-2 w-32 animate-pulse rounded-full bg-paper-sunken" />
      </div>
    );
  }

  const question = state.question;
  const progress = Math.min(100, Math.round((state.answeredCount / Math.max(1, state.total)) * 100));

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-10 sm:py-14">
      <ResearchTicker runId={runId} domain={domain} />

      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          <span>
            Pregunta {state.answeredCount + 1} de {state.total}
          </span>
          {question.kind === 'generated' ? <span className="text-money">Basada en tu sitio</span> : null}
        </div>
        <div className="progress-track h-1.5 w-full overflow-hidden rounded-full">
          <div className="progress-fill h-full rounded-full" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div key={question.id} className="slide-in mt-10 space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold leading-snug tracking-tight text-ink sm:text-[1.75rem]">
            {question.prompt}
          </h1>
          {question.help_text ? (
            <p className="text-[14px] leading-relaxed text-ink-faint">{question.help_text}</p>
          ) : null}
        </div>

        {question.input_type === 'single' ? (
          <div className="space-y-2.5">
            {question.options.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={busy}
                onClick={() => submit(option.value)}
                className="group flex w-full items-center justify-between rounded-xl border border-line bg-paper-raised
                           px-5 py-4 text-left text-[15px] font-medium text-ink transition
                           hover:border-ink hover:bg-paper-sunken disabled:opacity-50"
              >
                <span>{option.label}</span>
                <span className="text-ink-faint transition group-hover:translate-x-0.5 group-hover:text-ink">→</span>
              </button>
            ))}
          </div>
        ) : null}

        {question.input_type === 'multi' ? (
          <div className="space-y-4">
            <div className="space-y-2.5">
              {question.options.map((option) => {
                const selected = Array.isArray(draft) && draft.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setDraft((prev) => {
                        const list = Array.isArray(prev) ? prev : [];
                        return selected
                          ? list.filter((v) => v !== option.value)
                          : [...list, option.value];
                      })
                    }
                    className={`flex w-full items-center gap-3 rounded-xl border px-5 py-3.5 text-left text-[15px] font-medium transition
                                ${selected ? 'border-ink bg-ink text-paper' : 'border-line bg-paper-raised text-ink hover:border-ink'}`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border
                                  ${selected ? 'border-paper bg-paper text-ink' : 'border-line-strong'}`}
                    >
                      {selected ? '✓' : ''}
                    </span>
                    {option.label}
                  </button>
                );
              })}
            </div>
            <Continue
              disabled={busy || !Array.isArray(draft) || draft.length === 0}
              onClick={() => submit(draft)}
            />
          </div>
        ) : null}

        {question.input_type === 'text' ? (
          <div className="space-y-4">
            <textarea
              autoFocus
              rows={4}
              value={typeof draft === 'string' ? draft : ''}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Escribe aquí…"
              className="w-full resize-none rounded-xl border border-line bg-paper-raised px-4 py-3.5 text-[15px]
                         text-ink placeholder:text-ink-faint/70 focus:border-money-bright focus:outline-none"
            />
            <div className="flex items-center gap-3">
              <Continue
                disabled={busy || (question.required && !String(draft).trim())}
                onClick={() => submit(String(draft).trim())}
              />
              {!question.required ? (
                <button
                  type="button"
                  onClick={() => submit('')}
                  className="text-[13px] font-medium text-ink-faint underline underline-offset-4 hover:text-ink"
                >
                  Saltar
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {question.input_type === 'number' ? (
          <div className="space-y-4">
            <input
              autoFocus
              type="number"
              inputMode="numeric"
              min={0}
              value={typeof draft === 'string' ? draft : ''}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="0"
              className="tnum w-full rounded-xl border border-line bg-paper-raised px-4 py-3.5 text-2xl
                         font-semibold text-ink placeholder:text-ink-faint/40 focus:border-money-bright focus:outline-none"
            />
            <Continue
              disabled={busy || !String(draft).trim() || Number(draft) < 0}
              onClick={() => submit(Number(draft))}
            />
          </div>
        ) : null}

        {question.input_type === 'scale' ? (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => submit(value)}
                className="tnum flex-1 rounded-xl border border-line bg-paper-raised py-4 text-lg font-semibold
                           text-ink transition hover:border-ink hover:bg-paper-sunken"
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <p className="text-[13px] font-medium text-leak">{error}</p> : null}
      </div>
    </div>
  );
}

function Continue({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-xl bg-ink px-6 py-3 text-[15px] font-semibold text-paper transition
                 hover:bg-money-bright disabled:cursor-not-allowed disabled:opacity-40"
    >
      Continuar
    </button>
  );
}

/** Pantalla de ensamblaje. El President está trabajando y hay que decirlo. */
function Assembling({ domain, runId }: { domain: string; runId: string | null }) {
  const [step, setStep] = useState(0);
  const lines = [
    'Cruzando tus respuestas con lo que leímos de tu sitio',
    'Ubicándote frente a tus competidores',
    'Calculando dónde se te está cayendo la plata',
    'Armando la cuenta al revés desde tu meta',
    'Instanciando President, CMO y Sales',
  ];

  useEffect(() => {
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, lines.length - 1)), 4200);
    return () => clearInterval(timer);
  }, [lines.length]);

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-16">
      <ResearchTicker runId={runId} domain={domain} />
      <div className="mt-12 space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Estamos armando tu diagnóstico.
        </h1>
        <ul className="space-y-3">
          {lines.map((line, index) => (
            <li key={line} className="flex items-start gap-3 text-[15px]">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  index < step ? 'bg-money' : index === step ? 'pulse-dot bg-money-bright' : 'bg-line-strong'
                }`}
                aria-hidden
              />
              <span className={index <= step ? 'text-ink' : 'text-ink-faint'}>{line}</span>
            </li>
          ))}
        </ul>
        <p className="pt-4 text-[13px] text-ink-faint">
          Esto toma entre 30 y 90 segundos. No cierres la pestaña — igual te mandamos el enlace
          por correo apenas esté listo.
        </p>
      </div>
    </div>
  );
}
