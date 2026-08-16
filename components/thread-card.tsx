'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@/components/ui';

/**
 * Una conversación en la bandeja.
 *
 * El borrador que sugirió el agente se muestra ya escrito en la caja de
 * respuesta, editable. Es la diferencia entre "el agente te ayuda" y "el
 * agente te deja tarea": con el borrador puesto, contestar cuesta leer y
 * ajustar una palabra; con la caja vacía, cuesta escribir un correo.
 */

export interface ThreadView {
  id: string;
  contact_email: string | null;
  subject: string | null;
  snippet: string | null;
  status: string;
  intent: string | null;
  needs_human: boolean;
  human_reason: string | null;
  last_direction: string | null;
  last_message_at: string | null;
  campaign_name: string | null;
  suggested_reply: string | null;
  last_inbound: string | null;
}

const INTENT_LABEL: Record<string, string> = {
  interested: 'Interesado',
  wants_meeting: 'Quiere reunirse',
  ask_price: 'Pregunta precio',
  ask_info: 'Pide información',
  not_interested: 'No le interesa',
  wrong_person: 'No es la persona',
  out_of_office: 'Fuera de oficina',
  opt_out: 'Pidió salir',
  complaint: 'Queja',
  legal: 'Legal',
  other: 'Otro',
};

export function ThreadCard({ thread, orgId }: { thread: ThreadView; orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(thread.needs_human);
  const [body, setBody] = useState(thread.suggested_reply ?? '');
  const [error, setError] = useState<string | null>(null);

  function act(action: 'reply' | 'handled', status?: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${thread.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, action, body, status }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos enviar.');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Card as="li" className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[14px] font-semibold tracking-tight text-ink">
          {thread.contact_email}
        </span>
        {thread.needs_human ? <Badge tone="leak">Te espera</Badge> : null}
        {thread.intent ? (
          <Badge tone="muted">{INTENT_LABEL[thread.intent] ?? thread.intent}</Badge>
        ) : null}
        <span className="ml-auto text-[12px] text-ink-faint">
          {thread.last_message_at
            ? new Date(thread.last_message_at).toLocaleString('es-CO', {
                day: 'numeric',
                month: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })
            : ''}
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-[13.5px] font-medium text-ink-soft">{thread.subject}</p>
        {thread.campaign_name ? (
          <p className="text-[12px] text-ink-faint">De la campaña «{thread.campaign_name}»</p>
        ) : null}
        <p className="line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-ink-faint">
          {thread.last_inbound ?? thread.snippet}
        </p>
      </div>

      {thread.human_reason ? (
        <p className="rounded-xl bg-leak-soft px-3.5 py-2 text-[12.5px] text-leak">
          {thread.human_reason}
        </p>
      ) : null}

      {open ? (
        <div className="space-y-2 border-t border-line pt-3">
          {error ? <p className="text-[13px] text-leak">{error}</p> : null}
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            placeholder="Tu respuesta. Sale desde la misma dirección que envió el original."
            className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-ink"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending || body.trim().length === 0}
              onClick={() => act('reply')}
              className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
            >
              {pending ? 'Enviando…' : 'Responder'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => act('handled', 'won')}
              className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft transition hover:border-ink"
            >
              Ya lo resolví
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => act('handled', 'lost')}
              className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft transition hover:border-ink"
            >
              No va a pasar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12.5px] text-ink-faint underline decoration-line-strong"
        >
          Responder
        </button>
      )}
    </Card>
  );
}
