'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ResearchTicker } from '@/components/research-ticker';
import type { QuizQuestion } from '@/lib/quiz/bank';
import type { QuizPreview } from '@/lib/quiz/preview';
import { toCurrency } from '@/config/assumptions';
import { formatMoney, formatNumber } from '@/lib/utils';

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
  /** Llega una sola vez, en la respuesta que la desbloquea. */
  preview?: QuizPreview | null;
}

export function QuizFlow({
  sessionId,
  domain,
  currency,
  initialRunId,
}: {
  sessionId: string;
  domain: string;
  currency: string;
  initialRunId: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<NextResponse | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Guarda contra el doble disparo del efecto.
   *
   * `setGenerating(true)` no se ve dentro del mismo ciclo, así que en el modo
   * estricto de React —y en cualquier re-render que llegue antes del repintado—
   * el efecto de abajo llamaba dos veces a `/api/diagnostic/generate`. Con la
   * idempotencia respaldada en la base eso ya no duplica diagnósticos, pero sí
   * dispara dos corridas del modelo y cobra dos veces. Un ref se lee y se
   * escribe en el mismo tick; el estado no.
   */
  const generateStarted = useRef(false);

  /**
   * El progreso nunca retrocede.
   *
   * El total del quiz crece cuando aparecen las adaptativas (11 → 12), así que
   * el porcentaje crudo puede bajar de una pregunta a la siguiente. Se guarda
   * el máximo en estado y no en un ref: un ref escrito durante el render es
   * justo el patrón que rompe cuando React reintenta un render.
   */
  const [progress, setProgress] = useState(0);

  // Borrador local de la respuesta en curso (texto, número, multi).
  const [draft, setDraft] = useState<string | string[]>('');

  /**
   * La primera cifra, apenas el servidor la puede calcular (§4.2).
   *
   * Se queda en pantalla el resto del quiz y no se limpia nunca. Aparecer una
   * vez y desaparecer la convertiría en una notificación; quedarse la convierte
   * en un marcador: el cliente responde las seis preguntas que faltan con su
   * propio número mirándolo. Ese es todo el punto.
   */
  const [preview, setPreview] = useState<QuizPreview | null>(null);

  /** Punto único donde entra una respuesta del servidor. */
  const applyState = useCallback((data: NextResponse) => {
    setState(data);
    if (data.runId) setRunId(data.runId);
    if (data.preview) setPreview(data.preview);
    setDraft(data.question?.input_type === 'multi' ? [] : '');
    const pct = Math.min(100, Math.round((data.answeredCount / Math.max(1, data.total)) * 100));
    setProgress((previous) => Math.max(previous, pct));
  }, []);

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
      applyState(data);
    } catch {
      setError('Se cayó la conexión. Recarga la página.');
    }
  }, [sessionId, applyState]);

  // Carga inicial. La regla del compilador desaconseja `setState` dentro de un
  // efecto, y tiene razón como norma general — pero esto es exactamente el caso
  // que la excepción cubre: sincronizar con un sistema externo (el servidor) al
  // montar. La alternativa, pasar el estado inicial desde el Server Component,
  // haría que la generación de las preguntas adaptativas —una llamada de IA—
  // bloquee el primer byte de la página.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    if (generateStarted.current) return;
    generateStarted.current = true;
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
        // Se libera la guarda para que el botón de reintentar sirva de verdad.
        generateStarted.current = false;
        return;
      }
      router.push(data.next);
    } catch {
      setError('Se cayó la conexión mientras armábamos tu diagnóstico.');
      setGenerating(false);
      generateStarted.current = false;
    }
  }, [sessionId, router]);

  // El quiz terminó → se arma el diagnóstico. Va en un efecto y no solo en el
  // manejador de `submit` porque también hay que cubrir al que recarga la
  // página con el quiz ya completo. La guarda de `generateStarted` es la que
  // impide que ambos caminos disparen dos corridas del modelo.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state?.done) void generate();
  }, [state?.done, generate]);

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
      applyState(data);
    } catch {
      setError('No pudimos guardar tu respuesta. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  // El error del ensamblaje tiene que ganarle a la pantalla de carga: si no,
  // el cliente se queda mirando "estamos armando tu diagnóstico" para siempre
  // mientras el servidor ya contestó que no pudo.
  if (error && (!state || (state.done && !generating))) {
    return (
      <div className="mx-auto max-w-xl space-y-5 px-6 py-24 text-center">
        <p className="text-[15px] text-leak">{error}</p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            void (state?.done ? generate() : load());
          }}
          className="rounded-xl bg-ink px-5 py-3 text-[14px] font-semibold text-paper transition hover:bg-money-bright"
        >
          Intentar de nuevo
        </button>
      </div>
    );
  }

  if (generating || state?.done) {
    return <Assembling domain={domain} runId={runId} currency={currency} preview={preview} />;
  }

  if (!state?.question) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <div className="h-2 w-32 animate-pulse rounded-full bg-paper-sunken" />
      </div>
    );
  }

  const question = state.question;

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

      {preview ? <PreviewCard preview={preview} currency={currency} /> : null}

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

/**
 * El adelanto de la primera fuga, a mitad del quiz.
 *
 * El monto lo calculó el servidor con `computeLeaks` — el mismo que va a
 * producir el diagnóstico. Acá solo se convierte a la moneda local y se pinta.
 * La fórmula va visible desde el primer momento por la misma razón que en el
 * diagnóstico: una cifra sin su aritmética al lado se lee como una promesa de
 * vendedor, y esta llega demasiado temprano en la relación para gastarse la
 * confianza.
 */
function PreviewCard({ preview, currency }: { preview: QuizPreview; currency: string }) {
  return (
    <div className="slide-in mt-8 rounded-xl border border-leak/25 bg-leak-soft px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-leak">
        Con lo que llevas ya podemos calcular esto
      </p>
      <p className="tnum mt-1 text-3xl font-semibold tracking-tight text-leak">
        {formatMoney(toCurrency(preview.leak_usd, currency), currency)}
        <span className="ml-2 align-middle text-[13px] font-normal text-leak/80">al mes</span>
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
        Es lo que vale tu base dormida: {formatNumber(preview.contacts)} contactos que ya
        levantaron la mano. Faltan las otras fugas.
      </p>
      <p className="tnum mt-2 font-mono text-[11.5px] leading-relaxed text-ink-faint">
        {preview.formula}
      </p>
    </div>
  );
}

/**
 * Pantalla de ensamblaje.
 *
 * Antes rotaba cinco frases con un `setInterval` de 4,2 s: los puntos marchaban
 * solos, sin relación con nada que estuviera pasando en el servidor. Es la
 * pantalla más larga del flujo —`/api/diagnostic/generate` puede esperar 45 s
 * al research y después llamar al modelo— y era la única que mentía, justo
 * debajo de un ticker que sí dice la verdad.
 *
 * Ahora hay exactamente dos cosas vivas, y las dos son reales: el estado del
 * research (que sí sabemos) y el cronómetro. Los cinco pasos siguen listados
 * porque el cliente merece saber qué está corriendo, pero en presente y sin
 * marcadores de progreso falsos: se dice qué hace el President, no se finge
 * saber en cuál va.
 */
function Assembling({
  domain,
  runId,
  currency,
  preview,
}: {
  domain: string;
  runId: string | null;
  currency: string;
  preview: QuizPreview | null;
}) {
  const [researchDone, setResearchDone] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // `useCallback` y no una función inline: el efecto del ticker tiene
  // `onFinished` en sus dependencias, y una identidad nueva en cada render
  // reabriría el EventSource en bucle.
  const onFinished = useCallback(() => setResearchDone(true), []);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const lines = [
    'Cruza tus respuestas con lo que leímos de tu sitio',
    'Te ubica frente a tus competidores',
    'Calcula dónde se te está cayendo la plata',
    'Arma la cuenta al revés desde tu meta',
    'Instancia President, CMO y Sales',
  ];

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-16">
      <ResearchTicker runId={runId} domain={domain} onFinished={onFinished} />

      <div className="mt-10 space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          El President está armando tu diagnóstico.
        </h1>

        <div className="flex items-center gap-3 rounded-xl border border-line bg-paper-sunken px-4 py-3">
          <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-money-bright" aria-hidden />
          <p className="text-[13.5px] text-ink-soft">
            {researchDone ? 'Análisis del sitio listo. Razonando' : 'Esperando el análisis de tu sitio'}
          </p>
          <span className="tnum ml-auto text-[12.5px] text-ink-faint" aria-live="off">
            {elapsed}s
          </span>
        </div>

        {preview ? (
          <p className="text-[13.5px] leading-relaxed text-ink-soft">
            Ya tienes{' '}
            <span className="tnum font-semibold text-leak">
              {formatMoney(toCurrency(preview.leak_usd, currency), currency)}
            </span>{' '}
            al mes en la base dormida. Faltan las otras fugas y la cuenta al revés.
          </p>
        ) : null}

        <div className="space-y-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Qué está corriendo
          </p>
          <ul className="space-y-2">
            {lines.map((line) => (
              <li key={line} className="flex items-start gap-3 text-[14px] text-ink-soft">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="pt-2 text-[13px] text-ink-faint">
          {elapsed > 90
            ? 'Está tardando más de lo normal. No cierres la pestaña — y si la cierras, el enlace te llega por correo igual.'
            : 'Esto toma entre 30 y 90 segundos. No cierres la pestaña — igual te mandamos el enlace por correo apenas esté listo.'}
        </p>
      </div>
    </div>
  );
}
