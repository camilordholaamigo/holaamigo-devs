'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Un hilo de La Sala, en modo novela.
 *
 * El cliente no está mirando un dashboard: está leyendo cómo su organización
 * pensó. Por eso el ancho de columna es de lectura y no de tabla, la tipografía
 * es más grande de lo que sería en un panel, y los turnos se atribuyen como
 * diálogo.
 *
 * Y por eso se puede entrar. La caja del final no es un comentario: lo que se
 * escribe ahí pesa 2.0 —más que la evidencia del sistema— y **reabre la
 * deliberación aunque ya estuviera resuelta**. La próxima recomendación está
 * obligada a citarlo; eso lo garantiza `holaamigo.resolver_deliberacion`, no
 * esta pantalla.
 */

export interface ThreadTurn {
  id: number;
  speaker: string;
  speaker_type: 'agent' | 'human';
  body: string;
  stance: string;
  created_at: string;
}

export interface ThreadDeliberation {
  id: string;
  question: string;
  status: string;
  recommendation: { option: string; summary: string } | null;
  confidence: number | null;
  what_would_change_my_mind: string | null;
  dissent: Array<{ agent: string; position: string; argument: string }>;
  opened_at: string;
  reopened_count: number;
  turns: ThreadTurn[];
}

const HABLANTE: Record<string, string> = {
  president: 'El President',
  cmo: 'La CMO',
  sales: 'SALES',
  cliente: 'Vos',
  system: 'El sistema',
};

const POSTURA: Record<string, string> = {
  propose: 'propone',
  support: 'apoya',
  object: 'objeta',
  question: 'pregunta',
  concede: 'concede',
  decide: 'decide',
};

export function DeliberationThread({
  deliberation,
  orgId,
}: {
  deliberation: ThreadDeliberation;
  orgId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [texto, setTexto] = useState('');
  const [abierto, setAbierto] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  function interponer() {
    startTransition(async () => {
      const res = await fetch(`/api/deliberations/${deliberation.id}/interject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, body: texto }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; efecto?: string };
      setAviso(res.ok ? (data.efecto ?? 'Listo.') : (data.error ?? 'No pudimos guardarlo.'));
      if (res.ok) {
        setTexto('');
        setAbierto(false);
        router.refresh();
      }
    });
  }

  return (
    <article id={`d-${deliberation.id}`} className="scroll-mt-24 space-y-5 border-b border-line pb-10">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              deliberation.status === 'open' ? 'bg-money-bright' : 'bg-line-strong',
            )}
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            {deliberation.status === 'open' ? 'En discusión' : 'Resuelta'}
            {deliberation.reopened_count > 0
              ? ` · reabierta ${deliberation.reopened_count} ${deliberation.reopened_count === 1 ? 'vez' : 'veces'}`
              : ''}
          </span>
          <span className="ml-auto text-[12px] text-ink-faint">
            {new Date(deliberation.opened_at).toLocaleDateString('es-CO', {
              day: 'numeric',
              month: 'long',
            })}
          </span>
        </div>
        <h2 className="prosa text-[21px] font-semibold leading-snug tracking-tight text-ink">
          {deliberation.question}
        </h2>
      </header>

      {deliberation.dissent.length > 1 ? (
        <div className="rounded-xl border border-line bg-paper-sunken px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            No estaban de acuerdo
          </p>
          <ul className="mt-2 space-y-1.5">
            {deliberation.dissent.map((posicion) => (
              <li key={posicion.agent} className="text-[13.5px] leading-snug text-ink-soft">
                <span className="font-semibold text-ink">
                  {HABLANTE[posicion.agent] ?? posicion.agent}
                </span>{' '}
                quería {posicion.position} — {posicion.argument}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ol className="space-y-5">
        {deliberation.turns.map((turn) => (
          <li key={turn.id} className="space-y-1">
            <p className="text-[12.5px] text-ink-faint">
              <span
                className={cn(
                  'font-semibold',
                  turn.speaker_type === 'human' ? 'text-money' : 'text-ink',
                )}
              >
                {HABLANTE[turn.speaker] ?? turn.speaker}
              </span>{' '}
              {POSTURA[turn.stance] ?? turn.stance}
            </p>
            <p
              className={cn(
                'prosa text-[15px] leading-[1.7] text-ink-soft',
                turn.speaker_type === 'human' ? 'border-l-2 border-money pl-4' : '',
              )}
            >
              {turn.body}
            </p>
          </li>
        ))}
      </ol>

      {deliberation.recommendation ? (
        <div className="space-y-2 rounded-xl border border-line bg-paper-raised px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            La recomendación
            {deliberation.confidence !== null
              ? ` · confianza ${deliberation.confidence.toFixed(2)}`
              : ''}
          </p>
          <p className="prosa text-[15px] leading-relaxed text-ink">
            {deliberation.recommendation.summary}
          </p>
          {deliberation.what_would_change_my_mind ? (
            <p className="border-t border-line pt-3 text-[13.5px] leading-relaxed text-ink-soft">
              <span className="font-semibold text-ink">Qué me haría cambiar de opinión: </span>
              {deliberation.what_would_change_my_mind}
            </p>
          ) : null}
        </div>
      ) : null}

      {aviso ? <p className="text-[13px] text-money">{aviso}</p> : null}

      {abierto ? (
        <div className="space-y-2">
          <textarea
            value={texto}
            onChange={(event) => setTexto(event.target.value)}
            rows={3}
            autoFocus
            placeholder="Lo que sepas y el sistema no pueda ver: que un competidor bajó precios, que ese cliente es intocable, que no querés que los vean como los baratos."
            className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-ink"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending || texto.trim().length < 3}
              onClick={interponer}
              className="rounded-xl bg-ink px-4 py-2 text-[13px] font-semibold text-paper disabled:opacity-40"
            >
              {pending ? 'Un momento…' : 'Meterme en la conversación'}
            </button>
            <button
              type="button"
              onClick={() => setAbierto(false)}
              className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-soft"
            >
              Cancelar
            </button>
            <span className="text-[12px] text-ink-faint">
              Lo que escribas pesa más que los datos y reabre la discusión.
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className="text-[13px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 transition hover:text-ink"
        >
          Meterme en la conversación
        </button>
      )}
    </article>
  );
}
