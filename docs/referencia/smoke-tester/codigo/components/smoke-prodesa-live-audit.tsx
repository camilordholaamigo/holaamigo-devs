'use client'

import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  Circle,
  AlertTriangle,
  Clock,
  Sparkles,
} from 'lucide-react'
import type { ProdesaAuditResult, StepAudit } from '@/lib/smoke-tester/types'

interface RunSnapshot {
  id: string
  status: string
  closed_with: string | null
  trigger_type: string
  waiting_for_template: boolean
  template_received_at: string | null
  audit_result: ProdesaAuditResult | Record<string, never>
  overall_score: number | null
  started_at: string | null
  completed_at: string | null
  bubble_response: Record<string, unknown> | null
}

interface ResultSnapshot {
  id: string
  status: string
  audit_steps: StepAudit[]
  conversation: Array<{
    role: 'agent' | 'buyer'
    text: string
    timestamp: string
  }>
}

interface Props {
  runId: string
  pollIntervalMs?: number
  onTerminal?: (run: RunSnapshot) => void
}

const STEP_TITLES: Record<number, string> = {
  1: 'Bienvenida + Ciudadela + #ID',
  2: 'Info proyecto + presupuesto',
  3: 'Subtipos con BREAK',
  4: 'Respuesta empática',
  5: 'Subsidio (solo VIS)',
  6: 'Centrales de riesgo',
  7: 'Ingreso mensual',
  8: 'Ahorros / cesantías',
  9: 'Ofrece cotización',
  10: 'Cierre #agendado / #cotizacion',
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function SmokeProdesaLiveAudit({
  runId,
  pollIntervalMs = 5000,
  onTerminal,
}: Props) {
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [result, setResult] = useState<ResultSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function tick() {
      try {
        const res = await fetch(`/api/smoke-test/runs/${runId}`, {
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`run ${res.status}`)
        const json = await res.json()
        if (cancelled) return

        // Endpoint wraps in { data: { run, results, sequences } }
        const payload = (json.data ?? json) as {
          run: RunSnapshot
          results: ResultSnapshot[]
        }
        const r = payload.run as RunSnapshot
        const firstResult = (payload.results?.[0] || null) as ResultSnapshot | null
        setRun(r)
        setResult(firstResult)
        setError(null)

        if (TERMINAL_STATUSES.has(r.status)) {
          if (onTerminal) onTerminal(r)
          return
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
      if (!cancelled) timer = setTimeout(tick, pollIntervalMs)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, pollIntervalMs, onTerminal])

  if (error && !run) {
    return (
      <div
        className="rm-bento"
        style={{ borderLeft: '3px solid var(--rm-red)' }}
      >
        <p className="text-sm" style={{ color: 'var(--rm-red)' }}>
          No se pudo cargar el run: {error}
        </p>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="rm-bento">
        <p className="text-sm" style={{ color: 'var(--rm-muted)' }}>
          Cargando run…
        </p>
      </div>
    )
  }

  const audit = (run.audit_result as ProdesaAuditResult) || null
  const steps = result?.audit_steps && result.audit_steps.length > 0
    ? result.audit_steps
    : audit?.steps || []

  const isWaitingForTemplate = run.waiting_for_template
  const isRunning = run.status === 'running'

  return (
    <div className="rm-bento">
      {/* Status header */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div>
          <span className="rm-page-eyebrow" style={{ marginBottom: 0 }}>
            <Sparkles size={11} strokeWidth={1.8} />
            Live audit
          </span>
          <h3 className="rm-display-h2" style={{ marginTop: 4 }}>
            {isWaitingForTemplate ? (
              <>Esperando <span className="rm-italic-accent">plantilla</span></>
            ) : isRunning ? (
              <>Conversación <span className="rm-italic-accent">en curso</span></>
            ) : run.status === 'completed' ? (
              <>Run <span className="rm-italic-accent">completado</span></>
            ) : (
              <>Run terminado: {run.status}</>
            )}
          </h3>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={run.status} closedWith={run.closed_with} />
          {run.overall_score != null ? (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 6,
                padding: '6px 12px',
                background: 'var(--rm-surface-2)',
                borderRadius: 999,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--rm-muted)',
                }}
              >
                Score
              </span>
              <span
                style={{
                  fontFamily: 'var(--rm-font-display)',
                  fontSize: 18,
                  fontWeight: 700,
                  color: scoreColor(run.overall_score),
                  letterSpacing: '-0.02em',
                }}
              >
                {run.overall_score}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {isWaitingForTemplate ? (
        <div
          className="p-4 rounded-xl flex items-start gap-3 mb-4"
          style={{
            background: 'rgba(64, 217, 157, 0.08)',
            border: '1px solid rgba(64, 217, 157, 0.2)',
          }}
        >
          <Clock
            size={16}
            strokeWidth={1.8}
            style={{ color: 'var(--rm-green)', marginTop: 2 }}
          />
          <div>
            <p
              className="text-sm font-semibold"
              style={{ color: 'var(--rm-ink)' }}
            >
              Bubble disparado, esperando plantilla
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--rm-ink-2)' }}>
              Cuando Meta WhatsApp envíe el mensaje plantilla a tu canal de
              testing (1-2 min), el flujo del buyer arranca automáticamente.
            </p>
          </div>
        </div>
      ) : null}

      {/* 10-step timeline */}
      <div className="flex flex-col gap-2">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((stepNum) => {
          const step = steps.find((s) => s.step === stepNum) || null
          return <StepRow key={stepNum} stepNum={stepNum} step={step} />
        })}
      </div>

      {/* Audit summary footer */}
      {audit ? (
        <div
          className="grid grid-cols-3 gap-3 mt-5 p-4 rounded-xl"
          style={{ background: 'var(--rm-surface-2)' }}
        >
          <SummaryStat
            label="Critical"
            value={audit.critical_count}
            color="var(--rm-red)"
          />
          <SummaryStat
            label="Warnings"
            value={audit.warning_count}
            color="var(--rm-amber)"
          />
          <SummaryStat
            label="Cierre"
            value={audit.closed_with}
            color="var(--rm-green)"
          />
        </div>
      ) : null}

      {error ? (
        <p
          className="text-xs mt-3"
          style={{ color: 'var(--rm-muted)', fontStyle: 'italic' }}
        >
          (auto-refresh: {error})
        </p>
      ) : null}
    </div>
  )
}

function StepRow({
  stepNum,
  step,
}: {
  stepNum: number
  step: StepAudit | null
}) {
  const detected = step?.detected ?? false
  const passed = step?.passed ?? false
  const stateClass = detected
    ? passed
      ? 'pass'
      : 'fail'
    : 'pending'

  const borderColor =
    stateClass === 'pass'
      ? 'var(--rm-green)'
      : stateClass === 'fail'
        ? 'var(--rm-red)'
        : 'rgba(187, 202, 191, 0.4)'

  const Icon =
    stateClass === 'pass'
      ? CheckCircle2
      : stateClass === 'fail'
        ? XCircle
        : Circle

  const iconColor =
    stateClass === 'pass'
      ? 'var(--rm-green)'
      : stateClass === 'fail'
        ? 'var(--rm-red)'
        : 'var(--rm-muted)'

  return (
    <div
      className="rounded-lg pl-4 pr-3 py-3"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background:
          stateClass === 'pass'
            ? 'rgba(64, 217, 157, 0.06)'
            : stateClass === 'fail'
              ? 'rgba(193, 79, 58, 0.06)'
              : 'transparent',
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon
            size={14}
            strokeWidth={2}
            style={{ color: iconColor, flexShrink: 0 }}
          />
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--rm-muted)',
            }}
          >
            Paso {stepNum}
          </span>
          <span
            className="text-sm font-medium truncate"
            style={{ color: 'var(--rm-ink)' }}
          >
            {STEP_TITLES[stepNum]}
          </span>
        </div>
        {step ? (
          <span
            className="rm-status-chip"
            style={{
              flexShrink: 0,
              ...(stateClass === 'pass'
                ? { background: 'rgba(64, 217, 157, 0.15)', color: 'var(--rm-green)' }
                : stateClass === 'fail'
                  ? { background: '#ffdad6', color: '#93000a' }
                  : { background: 'var(--rm-surface-3)', color: 'var(--rm-muted)' }),
            }}
          >
            {stateClass === 'pass' ? 'OK' : stateClass === 'fail' ? 'Fail' : 'Pending'}
          </span>
        ) : null}
      </div>

      {step?.agent_message_text ? (
        <p
          className="text-xs mt-2"
          style={{
            color: 'var(--rm-ink-2)',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {step.agent_message_text}
        </p>
      ) : null}

      {step && step.critical_errors.length > 0 ? (
        <ul className="mt-2 text-xs space-y-1">
          {step.critical_errors.map((e, i) => (
            <li
              key={i}
              style={{
                color: 'var(--rm-red)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
              }}
            >
              <XCircle size={11} strokeWidth={2} style={{ flexShrink: 0, marginTop: 2 }} />
              {e}
            </li>
          ))}
        </ul>
      ) : null}
      {step && step.warning_errors.length > 0 ? (
        <ul className="mt-1 text-xs space-y-1">
          {step.warning_errors.map((e, i) => (
            <li
              key={i}
              style={{
                color: 'var(--rm-amber)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
              }}
            >
              <AlertTriangle
                size={11}
                strokeWidth={2}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              {e}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function StatusBadge({
  status,
  closedWith,
}: {
  status: string
  closedWith: string | null
}) {
  if (status === 'completed' && closedWith === 'agendado') {
    return (
      <span className="rm-status-chip rm-status-chip-active">
        #agendado ✓
      </span>
    )
  }
  if (status === 'completed' && closedWith === 'cotizacion') {
    return (
      <span className="rm-status-chip rm-status-chip-connected">
        #cotizacion ✓
      </span>
    )
  }
  if (status === 'completed' && closedWith === 'timeout') {
    return <span className="rm-status-chip rm-status-chip-pending">Timeout</span>
  }
  if (status === 'running') {
    return <span className="rm-status-chip rm-status-chip-live">Running</span>
  }
  if (status === 'failed') {
    return <span className="rm-status-chip rm-status-chip-error">Failed</span>
  }
  return (
    <span className="rm-status-chip rm-status-chip-stable">{status}</span>
  )
}

function SummaryStat({
  label,
  value,
  color,
}: {
  label: string
  value: number | string | null
  color: string
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--rm-muted)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--rm-font-display)',
          fontSize: 22,
          fontWeight: 700,
          color,
          letterSpacing: '-0.02em',
          marginTop: 2,
        }}
      >
        {value ?? '—'}
      </div>
    </div>
  )
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--rm-green)'
  if (score >= 60) return 'var(--rm-amber)'
  return 'var(--rm-red)'
}
