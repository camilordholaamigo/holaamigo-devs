'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Un item del feed del President.
 *
 * Decisión de interacción que importa: aprobar es UN clic, sin diálogo de
 * confirmación. Rechazar abre el campo de nota y exige escribir algo. La
 * fricción está puesta a propósito del lado del rechazo, porque es el único
 * lado que produce aprendizaje — un "no" sin razón se repite la semana
 * siguiente igual de mal.
 *
 * La evidencia va SIEMPRE visible, no detrás de un "ver detalles". El President
 * dice "cuesta 1.240 créditos" y justo debajo está la tabla de dónde sale ese
 * número. Pedir permiso con la cifra escondida es pedir un cheque en blanco.
 */

export interface FeedCardItem {
  id: string;
  kind: 'proposal' | 'ask' | 'digest' | 'alert' | 'win';
  role: string;
  title: string;
  body: string;
  rationale: string | null;
  evidence: Record<string, unknown>;
  requires: 'approval' | 'input' | 'nothing';
  input_kind: string | null;
  status: string;
  severity: 'low' | 'normal' | 'high';
  created_at: string;
  response: Record<string, unknown> | null;
}

const ROLE_LABEL: Record<string, string> = {
  president: 'PRESIDENT',
  cmo: 'CMO',
  sales: 'SALES',
  system: 'SISTEMA',
};

const KIND_LABEL: Record<FeedCardItem['kind'], string> = {
  proposal: 'Propuesta',
  ask: 'Te necesita',
  digest: 'Resumen',
  alert: 'Atención',
  win: 'Buena noticia',
};

const EVIDENCE_LABEL: Record<string, string> = {
  campana: 'Campaña',
  segmento: 'Segmento',
  contactos_disponibles: 'Contactos en el segmento',
  envios_que_caben_hoy: 'Envíos que caben hoy',
  bandejas_con_cupo: 'Bandejas con cupo',
  creditos_estimados: 'Créditos',
  saldo_actual: 'Saldo actual',
  saldo_despues: 'Saldo después',
  respuestas_esperadas: 'Respuestas esperadas',
  citas_esperadas: 'Citas esperadas',
  ayer_enviamos: 'Ayer enviamos',
  ayer_contestaron: 'Ayer contestaron',
};

export function FeedCard({ item, orgId }: { item: FeedCardItem; orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [effect, setEffect] = useState<string | null>(null);

  const decided = item.status !== 'open';

  function respond(decision: 'approved' | 'rejected' | 'answered' | 'dismissed') {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/feed/${item.id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: orgId,
          decision,
          note: decision === 'rejected' ? note : (answer || null),
          payload: decision === 'answered' ? { respuesta: answer } : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; effect?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos registrar tu respuesta.');
        return;
      }
      setEffect(data.effect ?? null);
      router.refresh();
    });
  }

  const evidence = Object.entries(item.evidence ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && typeof value !== 'object',
  );

  return (
    <Card
      as="li"
      className={cn(
        'space-y-4 p-6',
        item.severity === 'high' && !decided ? 'border-leak/40' : '',
        decided ? 'opacity-60' : '',
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge tone={item.kind === 'win' ? 'money' : item.severity === 'high' ? 'leak' : 'muted'}>
          {KIND_LABEL[item.kind]}
        </Badge>
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          {ROLE_LABEL[item.role] ?? item.role}
        </span>
        <span className="ml-auto text-[12px] text-ink-faint">
          {new Date(item.created_at).toLocaleString('es-CO', {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
      </div>

      <div className="space-y-2">
        <h3 className="text-[16px] font-semibold tracking-tight text-ink">{item.title}</h3>
        <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink-soft">{item.body}</p>
        {item.rationale ? (
          <p className="text-[12.5px] leading-snug text-ink-faint">{item.rationale}</p>
        ) : null}
      </div>

      {evidence.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-1.5 border-t border-line pt-4 sm:grid-cols-2">
          {evidence.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-3">
              <dt className="text-[12.5px] text-ink-faint">{EVIDENCE_LABEL[key] ?? key.replace(/_/g, ' ')}</dt>
              <dd className="tnum text-[13px] font-medium text-ink">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {decided ? (
        <p className="border-t border-line pt-3 text-[12.5px] text-ink-faint">
          {item.status === 'approved'
            ? 'Aprobado.'
            : item.status === 'rejected'
              ? 'Rechazado.'
              : item.status === 'answered'
                ? 'Respondido.'
                : 'Descartado.'}
          {effect ? ` ${effect}` : ''}
        </p>
      ) : (
        <div className="space-y-3 border-t border-line pt-4">
          {error ? <p className="text-[13px] text-leak">{error}</p> : null}

          {item.requires === 'approval' ? (
            rejecting ? (
              <div className="space-y-2">
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  autoFocus
                  placeholder="¿Por qué no? Con una línea basta, y es lo que evita que te lo vuelva a proponer."
                  className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending || note.trim().length === 0}
                    onClick={() => respond('rejected')}
                    className="rounded-xl bg-leak px-4 py-2.5 text-[13.5px] font-semibold text-paper transition disabled:opacity-40"
                  >
                    Rechazar
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(false)}
                    className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => respond('approved')}
                  className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
                >
                  {pending ? 'Un momento…' : 'Apruebo'}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setRejecting(true)}
                  className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft transition hover:border-ink"
                >
                  Ahora no
                </button>
              </div>
            )
          ) : null}

          {item.requires === 'input' ? (
            <div className="space-y-2">
              <textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                rows={2}
                placeholder={
                  item.input_kind === 'video'
                    ? 'Pega el link del video (Drive, WeTransfer, lo que sea)'
                    : 'Escribe tu respuesta'
                }
                className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending || answer.trim().length === 0}
                  onClick={() => respond('answered')}
                  className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
                >
                  Enviar
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => respond('dismissed')}
                  className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft"
                >
                  No va
                </button>
              </div>
            </div>
          ) : null}

          {item.requires === 'nothing' && item.kind === 'alert' ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => respond('dismissed')}
              className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft transition hover:border-ink"
            >
              Entendido
            </button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
