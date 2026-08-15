'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Badge } from '@/components/ui';

/**
 * §9.3 — un ítem de la cola de decisiones.
 *
 * Cada ítem dice cuatro cosas: qué propone el agente, por qué, qué pasa si se
 * aprueba, y qué pasa si no. Sin esas cuatro, no se puede decidir en 5
 * segundos, y una cola que no se puede vaciar en 5 segundos por ítem no se
 * vacía nunca.
 *
 * Aprobar: un clic. Rechazar: abre el campo de nota y no deja seguir sin ella.
 */

export interface ApprovalItem {
  id: string;
  organization_id: string;
  kind: string;
  title: string;
  rationale: string | null;
  if_approved: string | null;
  if_rejected: string | null;
  severity: string;
  created_at: string;
  org_label?: string;
}

export function ApprovalCard({ approval }: { approval: ApprovalItem }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<string | null>(null);

  async function decide(decision: 'approved' | 'rejected') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/approvals/${approval.id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note: note || null }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'No se pudo registrar la decisión.');
        setBusy(false);
        return;
      }
      setDecided(decision);
      router.refresh();
    } catch {
      setError('Sin conexión.');
      setBusy(false);
    }
  }

  if (decided) {
    return (
      <Card className="slide-in px-5 py-4">
        <p className="text-[13.5px] text-ink-faint">
          {decided === 'approved' ? 'Aprobado' : 'Rechazado'} · {approval.title}
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">{approval.title}</h3>
            {approval.severity === 'high' ? <Badge tone="leak">Alta</Badge> : null}
            <Badge tone="muted">{approval.kind.replace(/_/g, ' ')}</Badge>
          </div>
          {approval.org_label ? (
            <Link
              href={`/admin/prospects/${approval.organization_id}`}
              className="text-[12.5px] text-ink-faint underline underline-offset-2 hover:text-ink"
            >
              {approval.org_label}
            </Link>
          ) : null}
        </div>
        <p className="tnum shrink-0 text-[12px] text-ink-faint">
          {new Date(approval.created_at).toLocaleString('es-CO', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      </div>

      {approval.rationale ? (
        <p className="text-[13.5px] leading-relaxed text-ink-soft">{approval.rationale}</p>
      ) : null}

      <dl className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
        {approval.if_approved ? (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-money">
              Si se aprueba
            </dt>
            <dd className="mt-0.5 text-[13px] leading-snug text-ink-soft">{approval.if_approved}</dd>
          </div>
        ) : null}
        {approval.if_rejected ? (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-leak">
              Si se rechaza
            </dt>
            <dd className="mt-0.5 text-[13px] leading-snug text-ink-soft">{approval.if_rejected}</dd>
          </div>
        ) : null}
      </dl>

      {rejecting ? (
        <div className="slide-in space-y-2.5">
          <textarea
            autoFocus
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Por qué no sirve. Obligatorio — es la única señal de aprendizaje que tenemos."
            className="w-full resize-none rounded-lg border border-line bg-paper px-3.5 py-2.5 text-[13.5px] text-ink placeholder:text-ink-faint/70 focus:border-leak focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() => decide('rejected')}
              className="rounded-lg bg-leak px-4 py-2.5 text-[13px] font-semibold text-paper transition disabled:opacity-40"
            >
              Confirmar rechazo
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              className="text-[13px] text-ink-faint underline underline-offset-4 hover:text-ink"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => decide('approved')}
            className="rounded-lg bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-50"
          >
            Aprobar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="rounded-lg border border-line-strong px-5 py-2.5 text-[13.5px] font-semibold text-ink transition hover:border-leak hover:text-leak disabled:opacity-50"
          >
            Rechazar
          </button>
        </div>
      )}

      {error ? <p className="text-[12.5px] text-leak">{error}</p> : null}
    </Card>
  );
}
