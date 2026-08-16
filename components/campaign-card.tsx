'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@/components/ui';
import { formatNumber } from '@/lib/utils';

/**
 * Una campaña, con su plan completo a la vista.
 *
 * Se muestran las cuatro partes juntas —a quién, qué esperamos, cómo lo
 * medimos, qué cambiamos si no funciona— y no detrás de pestañas. Aprobar una
 * campaña sin ver la regla que la va a pausar sola es aprobar a ciegas, y el
 * día que se pause el cliente va a sentir que le apagamos algo sin avisar.
 *
 * El rango de cierres se muestra como rango, nunca como número único. La banda
 * baja es la que prometemos.
 */

export interface CampaignView {
  id: string;
  name: string;
  playbook: string | null;
  status: string;
  objective: string | null;
  hypothesis: string | null;
  segment_name: string | null;
  audience_size: number;
  credits_estimate: number;
  paused_reason: string | null;
  scheduled_for: string | null;
  sequence: { day_offset: number; purpose: string; subject: string; body: string; include_asset: boolean }[];
  expected: {
    delivered?: number;
    replies?: number;
    bookings?: number;
    closes?: number;
    revenue_usd?: number;
    cost_per_booking_credits?: number;
    roi?: number;
    range?: { low: number; high: number };
    steps?: { label: string; value: number; formula: string }[];
  };
  measurement: { points?: { kpi: string; formula: string; date: string }[] };
  iteration: { rules?: { trigger: string; action: string; auto_pause: boolean }[] };
  actual?: { sent: number; delivered: number; replied: number; booked: number } | null;
}

const STATUS: Record<string, { label: string; tone: 'money' | 'muted' | 'leak' | 'neutral' }> = {
  proposed: { label: 'Esperando tu decisión', tone: 'neutral' },
  draft: { label: 'Borrador', tone: 'muted' },
  scheduled: { label: 'Programada', tone: 'muted' },
  active: { label: 'Corriendo', tone: 'money' },
  paused: { label: 'En pausa', tone: 'leak' },
  rejected: { label: 'Archivada', tone: 'muted' },
  done: { label: 'Terminada', tone: 'muted' },
};

export function CampaignCard({ campaign, orgId }: { campaign: CampaignView; orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCopy, setShowCopy] = useState(false);

  function act(action: 'approve' | 'reject' | 'pause' | 'resume') {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, action, note: action === 'reject' ? note : null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; summary?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos aplicar el cambio.');
        return;
      }
      setMessage(data.summary ?? null);
      setRejecting(false);
      router.refresh();
    });
  }

  const status = STATUS[campaign.status] ?? STATUS.draft;
  const expected = campaign.expected ?? {};

  return (
    <Card as="li" className="space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-[16px] font-semibold tracking-tight text-ink">{campaign.name}</h3>
          {campaign.objective ? (
            <p className="max-w-xl text-[13.5px] leading-snug text-ink-soft">{campaign.objective}</p>
          ) : null}
        </div>
        <Badge tone={status.tone === 'neutral' ? 'neutral' : status.tone}>{status.label}</Badge>
      </div>

      {campaign.paused_reason ? (
        <p className="rounded-xl bg-leak-soft px-3.5 py-2.5 text-[13px] text-leak">
          {campaign.paused_reason}
        </p>
      ) : null}

      {/* ── A quién le pega ─────────────────────────────────────────────── */}
      <div className="space-y-1.5 border-t border-line pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          A quién le pegamos
        </p>
        <p className="text-[13.5px] text-ink">
          <span className="tnum font-semibold">{formatNumber(campaign.audience_size)}</span> contactos
          {campaign.segment_name ? ` · ${campaign.segment_name}` : ''}
        </p>
        {campaign.hypothesis ? (
          <p className="text-[12.5px] leading-snug text-ink-faint">{campaign.hypothesis}</p>
        ) : null}
      </div>

      {/* ── Qué esperamos ───────────────────────────────────────────────── */}
      <div className="space-y-2 border-t border-line pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Qué esperamos
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
          <Metric label="Respuestas" value={expected.replies ?? 0} />
          <Metric label="Citas" value={expected.bookings ?? 0} />
          <Metric
            label="Cierres"
            text={`${expected.range?.low ?? 0} a ${expected.range?.high ?? 0}`}
          />
          <Metric label="Créditos" value={campaign.credits_estimate} />
        </div>
        {expected.steps ? (
          <details className="pt-1">
            <summary className="cursor-pointer text-[12.5px] text-ink-faint underline decoration-line-strong">
              De dónde salen estos números
            </summary>
            <ul className="mt-2 space-y-1">
              {expected.steps.map((step) => (
                <li key={step.label} className="text-[12.5px] text-ink-faint">
                  <span className="tnum font-medium text-ink">{formatNumber(step.value)}</span>{' '}
                  {step.label.toLowerCase()} — {step.formula}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {/* ── Lo que va pasando ───────────────────────────────────────────── */}
      {campaign.actual && campaign.actual.sent > 0 ? (
        <div className="space-y-1.5 border-t border-line pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-money">
            Lo que va pasando
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
            <Metric label="Enviados" value={campaign.actual.sent} />
            <Metric label="Entregados" value={campaign.actual.delivered} />
            <Metric label="Respuestas" value={campaign.actual.replied} />
            <Metric label="Citas" value={campaign.actual.booked} />
          </div>
        </div>
      ) : null}

      {/* ── Cómo se mide ────────────────────────────────────────────────── */}
      {(campaign.measurement?.points ?? []).length > 0 ? (
        <div className="space-y-1.5 border-t border-line pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Cómo lo medimos
          </p>
          <ul className="space-y-1">
            {campaign.measurement.points!.map((point) => (
              <li key={point.kpi} className="text-[12.5px] text-ink-soft">
                <span className="font-medium text-ink">{point.kpi}</span> · {point.formula} ·{' '}
                <span className="text-ink-faint">se revisa el {point.date}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Qué cambiamos si no funciona ────────────────────────────────── */}
      {(campaign.iteration?.rules ?? []).length > 0 ? (
        <div className="space-y-1.5 border-t border-line pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Qué cambiamos si no funciona
          </p>
          <ul className="space-y-1.5">
            {campaign.iteration.rules!.map((rule) => (
              <li key={rule.trigger} className="text-[12.5px] leading-snug text-ink-soft">
                <span className="text-ink">Si {rule.trigger}</span> → {rule.action}
                {rule.auto_pause ? (
                  <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-wide text-leak">
                    pausa sola
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── La secuencia ────────────────────────────────────────────────── */}
      <div className="space-y-2 border-t border-line pt-4">
        <button
          type="button"
          onClick={() => setShowCopy((value) => !value)}
          className="text-[12.5px] text-ink-faint underline decoration-line-strong"
        >
          {showCopy ? 'Ocultar' : 'Ver'} los {campaign.sequence.length} correos
        </button>
        {showCopy ? (
          <ol className="space-y-3">
            {campaign.sequence.map((step, index) => (
              <li key={index} className="rounded-xl bg-paper-sunken p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  Día {step.day_offset} · {step.purpose}
                </p>
                <p className="mt-1.5 text-[13.5px] font-medium text-ink">{step.subject}</p>
                <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-ink-soft">
                  {step.body}
                </p>
                {step.include_asset ? (
                  <p className="mt-1.5 text-[12px] text-money">+ link de agenda de Hola Amigo</p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {/* ── Decisión ────────────────────────────────────────────────────── */}
      <div className="space-y-3 border-t border-line pt-4">
        {error ? <p className="text-[13px] text-leak">{error}</p> : null}
        {message ? <p className="text-[13px] text-money">{message}</p> : null}

        {['proposed', 'draft'].includes(campaign.status) ? (
          rejecting ? (
            <div className="space-y-2">
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                autoFocus
                placeholder="¿Por qué no va? Con una línea basta."
                className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending || note.trim().length === 0}
                  onClick={() => act('reject')}
                  className="rounded-xl bg-leak px-4 py-2.5 text-[13.5px] font-semibold text-paper disabled:opacity-40"
                >
                  Archivar
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
                onClick={() => act('approve')}
                className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
              >
                {pending ? 'Programando…' : 'Lanzar esta campaña'}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setRejecting(true)}
                className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft transition hover:border-ink"
              >
                No va
              </button>
            </div>
          )
        ) : null}

        {campaign.status === 'active' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('pause')}
            className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-medium text-ink-soft transition hover:border-ink"
          >
            Pausar
          </button>
        ) : null}

        {campaign.status === 'paused' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('resume')}
            className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright"
          >
            Reanudar
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function Metric({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum text-[15px] font-semibold text-ink">
        {text ?? formatNumber(value ?? 0)}
      </p>
    </div>
  );
}
