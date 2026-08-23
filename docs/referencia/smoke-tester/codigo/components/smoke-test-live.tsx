'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Square,
} from 'lucide-react'

interface ConvEntry {
  role: 'buyer' | 'agent'
  text: string
  timestamp: string
}

interface ResultRow {
  id: string
  sequence_id: string
  sequence_nombre: string | null
  sequence_orden: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout'
  conversation: ConvEntry[]
  error_message: string | null
  started_at: string | null
  completed_at: string | null
}

interface RunRow {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  total_sequences: number
  completed_sequences: number
  overall_score: number | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  summary: Record<string, unknown>
  suite_id: string
  /** Runs autónomos (PRD 52) guardan aquí objetivo, persona y turno. */
  form_data?: Record<string, unknown> | null
}

interface AutonomousInfo {
  turno: number
  maxTurnos: number
  objetivo: string
  fuente: string | null
}

function readAutonomous(run: RunRow | null): AutonomousInfo | null {
  const fd = run?.form_data as Record<string, unknown> | null | undefined
  if (!fd || fd.modo !== 'autonomo') return null
  return {
    turno: Number(fd.turno) || 0,
    maxTurnos: Number(fd.max_turnos) || 0,
    objetivo: typeof fd.objetivo === 'string' ? fd.objetivo : '',
    fuente: typeof fd.fuente_comprador === 'string' ? fd.fuente_comprador : null,
  }
}

interface Props {
  runId: string
  onFinished: (run: RunRow) => void
}

const POLL_INTERVAL_MS = 2500

export function SmokeTestLive({ runId, onFinished }: Props) {
  const [run, setRun] = useState<RunRow | null>(null)
  const [results, setResults] = useState<ResultRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const finishedRef = useRef(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const handleCancel = useCallback(async () => {
    if (!confirm('¿Cancelar este run? Los mensajes ya enviados quedan en WhatsApp.')) return
    setCancelling(true)
    try {
      const res = await fetch(`/api/smoke-test/runs/${runId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'No se pudo cancelar el run')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
    } finally {
      setCancelling(false)
    }
  }, [runId])

  useEffect(() => {
    finishedRef.current = false
    let cancelled = false

    async function tick() {
      try {
        const res = await fetch(`/api/smoke-test/runs/${runId}`, {
          cache: 'no-store',
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error || 'Error al consultar el run')
          return
        }
        if (cancelled) return
        const r = data.data.run as RunRow
        const rs = (data.data.results || []) as ResultRow[]
        setRun(r)
        setResults(rs)
        if (
          ['completed', 'failed', 'cancelled'].includes(r.status) &&
          !finishedRef.current
        ) {
          finishedRef.current = true
          onFinished(r)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error de red')
      }
    }

    tick()
    const t = setInterval(() => {
      if (finishedRef.current) return
      tick()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [runId, onFinished])

  useEffect(() => {
    if (!scrollerRef.current) return
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
  }, [results])

  const activeResult =
    results.find((r) => r.status === 'running') ||
    results.find((r) => r.status === 'pending') ||
    results[results.length - 1] ||
    null

  const autonomous = readAutonomous(run)

  const progressPct = autonomous
    ? Math.min(
        100,
        Math.round((autonomous.turno / Math.max(autonomous.maxTurnos, 1)) * 100)
      )
    : run?.total_sequences
      ? Math.round(((run.completed_sequences ?? 0) / run.total_sequences) * 100)
      : 0

  return (
    <div className="rm-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="px-4 py-3"
        style={{
          background: 'linear-gradient(180deg, #0f1410 0%, #141a14 100%)',
          color: 'white',
        }}
      >
        <div className="flex items-center justify-between">
          <div>
            <span className="rm-eyebrow" style={{ color: 'var(--rm-teal)' }}>
              {autonomous ? 'Flujo completo · comprador IA' : 'Ejecución en vivo'}
            </span>
            <p className="text-sm font-semibold mt-1">
              {autonomous
                ? `Turno ${autonomous.turno} de ${autonomous.maxTurnos}`
                : activeResult?.sequence_nombre || 'Iniciando…'}
            </p>
            {autonomous?.objetivo ? (
              <p
                className="text-[11px] mt-0.5"
                style={{ color: 'rgba(255, 255, 255, 0.55)', maxWidth: 460 }}
              >
                {autonomous.objetivo}
              </p>
            ) : null}
          </div>
          <div
            className="flex items-center gap-3 text-xs"
            style={{ color: 'rgba(255, 255, 255, 0.7)' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={13} className="animate-spin" />
              {autonomous
                ? `${autonomous.turno}/${autonomous.maxTurnos}`
                : `${run?.completed_sequences ?? 0} / ${run?.total_sequences ?? 0}`}
            </span>
            {run && ['running', 'pending'].includes(run.status) ? (
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'white',
                  fontSize: 11,
                  cursor: cancelling ? 'wait' : 'pointer',
                }}
              >
                <Square size={10} strokeWidth={2} />
                {cancelling ? 'Cancelando…' : 'Cancelar'}
              </button>
            ) : null}
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            height: 4,
            background: 'rgba(255, 255, 255, 0.08)',
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'var(--rm-teal)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      {error ? (
        <div
          className="flex items-start gap-2 p-3"
          style={{
            background: 'rgba(193, 79, 58, 0.06)',
            borderBottom: '1px solid var(--rm-border)',
          }}
        >
          <AlertCircle
            size={14}
            strokeWidth={1.8}
            style={{ color: 'var(--rm-red)', marginTop: 2 }}
          />
          <p className="text-xs" style={{ color: 'var(--rm-red)' }}>{error}</p>
        </div>
      ) : null}

      <div
        ref={scrollerRef}
        className="terminal-scroll"
        style={{
          maxHeight: 360,
          overflowY: 'auto',
          padding: 16,
          background: 'var(--rm-surface-2)',
        }}
      >
        {activeResult && activeResult.conversation.length > 0 ? (
          <div className="space-y-2">
            {activeResult.conversation.map((m, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: m.role === 'buyer' ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  style={{
                    maxWidth: '78%',
                    padding: '8px 12px',
                    borderRadius: 12,
                    background:
                      m.role === 'buyer'
                        ? 'var(--rm-surface)'
                        : 'rgba(64, 217, 157, 0.12)',
                    color: 'var(--rm-ink)',
                    fontSize: 13,
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    border:
                      m.role === 'buyer'
                        ? '1px solid var(--rm-border)'
                        : '1px solid rgba(64, 217, 157, 0.25)',
                  }}
                >
                  <p
                    className="text-[10px] font-mono"
                    style={{
                      color: 'var(--rm-muted)',
                      marginBottom: 2,
                      textTransform: 'uppercase',
                    }}
                  >
                    {m.role === 'buyer' ? 'Comprador' : 'Agente IA'}
                  </p>
                  {m.text}
                </div>
              </div>
            ))}
            {activeResult.status === 'running' &&
            (activeResult.conversation.length === 0 ||
              activeResult.conversation[activeResult.conversation.length - 1]?.role ===
                'buyer') ? (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-start',
                  marginTop: 4,
                }}
              >
                <div
                  className="text-xs"
                  style={{
                    color: 'var(--rm-muted)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                  }}
                >
                  <Loader2 size={12} className="animate-spin" />
                  Esperando respuesta del agente…
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="py-8 text-center">
            <Loader2
              size={20}
              strokeWidth={1.6}
              className="animate-spin mx-auto"
              style={{ color: 'var(--rm-teal)' }}
            />
            <p className="text-xs mt-3" style={{ color: 'var(--rm-muted)' }}>
              Iniciando primera secuencia…
            </p>
          </div>
        )}
      </div>

      <div
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--rm-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        {results.map((r) => {
          let icon = <Clock size={11} strokeWidth={1.8} />
          let color = 'var(--rm-muted)'
          if (r.status === 'running') {
            icon = <Loader2 size={11} className="animate-spin" />
            color = 'var(--rm-teal)'
          } else if (r.status === 'completed') {
            icon = <CheckCircle2 size={11} strokeWidth={1.8} />
            color = 'var(--rm-green)'
          } else if (r.status === 'failed' || r.status === 'timeout') {
            icon = <XCircle size={11} strokeWidth={1.8} />
            color = 'var(--rm-red)'
          }
          return (
            <span
              key={r.id}
              className="text-[11px]"
              style={{
                color,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {icon}
              {r.sequence_nombre || `Sec. ${r.sequence_orden + 1}`}
            </span>
          )
        })}
      </div>
    </div>
  )
}
