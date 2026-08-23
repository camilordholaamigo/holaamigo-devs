'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Sparkles,
  Lightbulb,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
} from 'lucide-react'
import type {
  ConversationEntry,
  EvaluationResult,
} from '@/lib/smoke-tester/types'

interface ResultRow {
  id: string
  sequence_id: string
  sequence_nombre: string | null
  sequence_proyecto_ref: string | null
  sequence_orden: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout'
  conversation: ConversationEntry[]
  score: number | null
  evaluation: Partial<EvaluationResult> & { error?: string }
  error_message: string | null
}

interface RunRow {
  id: string
  status: string
  total_sequences: number
  completed_sequences: number
  overall_score: number | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  summary: {
    average_score?: number
    common_errors?: string[]
    common_suggestions?: string[]
    top_hallucinations?: string[]
  }
  suite_id: string
}

interface Props {
  runId: string
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--rm-muted)'
  if (score >= 80) return 'var(--rm-green)'
  if (score >= 60) return 'var(--rm-amber)'
  return 'var(--rm-red)'
}

export function SmokeTestReport({ runId }: Props) {
  const [run, setRun] = useState<RunRow | null>(null)
  const [results, setResults] = useState<ResultRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [evaluating, setEvaluating] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/smoke-test/runs/${runId}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Error al cargar el reporte')
        return
      }
      setRun(data.data.run as RunRow)
      setResults((data.data.results || []) as ResultRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    load()
  }, [load])

  const handleEvaluate = useCallback(async () => {
    setEvaluating(true)
    setError(null)
    try {
      const res = await fetch(`/api/smoke-test/runs/${runId}/evaluate`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Error al evaluar')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
    } finally {
      setEvaluating(false)
    }
  }, [runId, load])

  const handleExport = useCallback(() => {
    if (!run) return
    const lines: string[] = []
    lines.push(`Smoke Test Run · ${run.id}`)
    lines.push(`Score promedio: ${run.overall_score ?? 'sin evaluar'}`)
    lines.push('')
    for (const r of results) {
      lines.push('─'.repeat(60))
      lines.push(`SECUENCIA: ${r.sequence_nombre || r.sequence_id}`)
      lines.push(`Estado: ${r.status} · Score: ${r.score ?? '—'}`)
      lines.push('')
      for (const m of r.conversation) {
        lines.push(`${m.role === 'buyer' ? 'COMPRADOR' : 'AGENTE'}: ${m.text}`)
      }
      if (r.evaluation && !('error' in r.evaluation)) {
        const e = r.evaluation
        lines.push('')
        lines.push(`Resumen: ${e.summary || ''}`)
        if (e.errors?.length) lines.push(`Errores: ${e.errors.join(' · ')}`)
        if (e.hallucinations?.length) lines.push(`Inventos: ${e.hallucinations.join(' · ')}`)
        if (e.suggestions?.length) lines.push(`Sugerencias: ${e.suggestions.join(' · ')}`)
      }
      lines.push('')
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `smoke-run-${runId.slice(0, 8)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [run, results, runId])

  if (loading) {
    return (
      <div className="rm-card text-center py-12">
        <Loader2
          size={20}
          strokeWidth={1.6}
          className="animate-spin mx-auto"
          style={{ color: 'var(--rm-teal)' }}
        />
        <p className="text-xs mt-3" style={{ color: 'var(--rm-muted)' }}>
          Cargando reporte…
        </p>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="rm-card text-center py-12">
        <p className="text-sm" style={{ color: 'var(--rm-red)' }}>
          {error || 'Run no encontrado'}
        </p>
      </div>
    )
  }

  const evaluatedCount = results.filter(
    (r) => r.evaluation && typeof (r.evaluation as { overall_score?: number }).overall_score === 'number'
  ).length
  const allEvaluated = evaluatedCount === results.filter((r) => r.status === 'completed').length

  return (
    <div className="space-y-4">
      {error ? (
        <div
          className="flex items-start gap-2 p-3 rounded-lg"
          style={{
            background: 'rgba(193, 79, 58, 0.08)',
            border: '1px solid rgba(193, 79, 58, 0.2)',
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
        className="rm-card"
        style={{
          padding: 20,
          background: 'linear-gradient(180deg, #0f1410 0%, #141a14 100%)',
          color: 'white',
          border: 0,
        }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <span className="rm-eyebrow" style={{ color: 'var(--rm-teal)' }}>
              Reporte de prueba
            </span>
            <h2
              className="rm-h1 mt-1"
              style={{ color: 'white' }}
            >
              Run #{run.id.slice(0, 8)}
            </h2>
            <p className="text-xs mt-1" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
              {run.completed_sequences}/{run.total_sequences} secuencias · {run.status}
            </p>
          </div>
          <div className="text-right">
            <p
              className="text-[10px] font-mono uppercase"
              style={{ color: 'rgba(255, 255, 255, 0.5)', letterSpacing: '0.18em' }}
            >
              Score promedio
            </p>
            <p
              className="text-4xl font-bold"
              style={{
                color: run.overall_score == null ? 'rgba(255,255,255,0.5)' : scoreColor(run.overall_score),
                fontFamily: 'var(--rm-font-mono)',
              }}
            >
              {run.overall_score != null ? Math.round(run.overall_score) : '—'}
              {run.overall_score != null ? (
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginLeft: 4 }}>
                  /100
                </span>
              ) : null}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4">
          {allEvaluated && evaluatedCount > 0 ? (
            <span
              className="rm-pill rm-pill-teal"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <CheckCircle2 size={11} strokeWidth={1.8} /> Evaluado por Claude
            </span>
          ) : null}
          <button
            type="button"
            className="rm-btn-primary"
            onClick={handleEvaluate}
            disabled={evaluating || results.filter((r) => r.status === 'completed').length === 0}
          >
            {evaluating ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Evaluando…
              </>
            ) : (
              <>
                <Sparkles size={13} strokeWidth={1.8} />
                {evaluatedCount > 0 ? 'Re-evaluar' : 'Evaluar con IA'}
              </>
            )}
          </button>
          <button
            type="button"
            className="rm-btn-ghost"
            onClick={handleExport}
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'white' }}
          >
            <Download size={13} strokeWidth={1.8} /> Exportar
          </button>
        </div>
      </div>

      {run.summary?.common_errors?.length || run.summary?.common_suggestions?.length || run.summary?.top_hallucinations?.length ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {run.summary.common_errors?.length ? (
            <div className="rm-card" style={{ padding: 14 }}>
              <span
                className="rm-eyebrow"
                style={{ color: 'var(--rm-amber)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <AlertTriangle size={11} strokeWidth={2} /> Errores comunes
              </span>
              <ul className="mt-2 space-y-1">
                {run.summary.common_errors.slice(0, 5).map((e, i) => (
                  <li key={i} className="text-xs" style={{ color: 'var(--rm-ink-2)' }}>
                    • {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.summary.top_hallucinations?.length ? (
            <div className="rm-card" style={{ padding: 14 }}>
              <span
                className="rm-eyebrow"
                style={{ color: 'var(--rm-red)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <XCircle size={11} strokeWidth={2} /> Datos inventados
              </span>
              <ul className="mt-2 space-y-1">
                {run.summary.top_hallucinations.slice(0, 5).map((e, i) => (
                  <li key={i} className="text-xs" style={{ color: 'var(--rm-ink-2)' }}>
                    • {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.summary.common_suggestions?.length ? (
            <div className="rm-card" style={{ padding: 14 }}>
              <span
                className="rm-eyebrow"
                style={{ color: 'var(--rm-green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Lightbulb size={11} strokeWidth={2} /> Sugerencias
              </span>
              <ul className="mt-2 space-y-1">
                {run.summary.common_suggestions.slice(0, 5).map((e, i) => (
                  <li key={i} className="text-xs" style={{ color: 'var(--rm-ink-2)' }}>
                    • {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        {results.map((r) => {
          const isOpen = expanded[r.id] ?? false
          const evalRes = (r.evaluation || {}) as Partial<EvaluationResult> & { error?: string }
          const hasEval = typeof evalRes.overall_score === 'number'
          return (
            <div key={r.id} className="rm-card" style={{ padding: 0, overflow: 'hidden' }}>
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setExpanded((prev) => ({ ...prev, [r.id]: !isOpen }))}
                style={{
                  padding: 16,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: 'var(--rm-surface)',
                  borderBottom: isOpen ? '1px solid var(--rm-border)' : '0',
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-sm font-semibold"
                      style={{ color: 'var(--rm-ink)' }}
                    >
                      {r.sequence_nombre || `Secuencia ${r.sequence_orden + 1}`}
                    </span>
                    {r.sequence_proyecto_ref ? (
                      <span className="rm-pill rm-pill-blue">{r.sequence_proyecto_ref}</span>
                    ) : null}
                    {r.status === 'completed' ? (
                      <span className="rm-pill rm-pill-teal">Completo</span>
                    ) : r.status === 'failed' ? (
                      <span className="rm-pill rm-pill-red">Falló</span>
                    ) : r.status === 'timeout' ? (
                      <span className="rm-pill rm-pill-amber">Timeout</span>
                    ) : (
                      <span className="rm-pill rm-pill-muted">{r.status}</span>
                    )}
                  </div>
                  <p
                    className="text-[11px] mt-0.5"
                    style={{ color: 'var(--rm-muted)' }}
                  >
                    {r.conversation.length} mensajes
                    {hasEval ? ` · Resumen: ${evalRes.summary?.slice(0, 80)}…` : ''}
                  </p>
                </div>
                <span
                  className="text-lg font-bold"
                  style={{
                    color: scoreColor(r.score),
                    fontFamily: 'var(--rm-font-mono)',
                    minWidth: 70,
                    textAlign: 'right',
                  }}
                >
                  {r.score != null ? `${Math.round(r.score)}/100` : '—'}
                </span>
                {isOpen ? (
                  <ChevronUp size={14} strokeWidth={1.8} style={{ color: 'var(--rm-muted)' }} />
                ) : (
                  <ChevronDown size={14} strokeWidth={1.8} style={{ color: 'var(--rm-muted)' }} />
                )}
              </button>

              {isOpen ? (
                <div style={{ background: 'var(--rm-surface-2)' }}>
                  {hasEval ? (
                    <div
                      className="px-4 py-3"
                      style={{ borderBottom: '1px solid var(--rm-border)' }}
                    >
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {(['accuracy', 'tone', 'completeness', 'proactivity', 'hallucination_risk'] as const).map(
                          (k) => {
                            const v = (evalRes as Record<string, number | undefined>)[k]
                            return (
                              <div key={k} className="rm-mini-stat">
                                <span className="rm-mini-stat-label">
                                  {k === 'accuracy' && 'Precisión'}
                                  {k === 'tone' && 'Tono'}
                                  {k === 'completeness' && 'Completitud'}
                                  {k === 'proactivity' && 'Proactividad'}
                                  {k === 'hallucination_risk' && 'Sin inventos'}
                                </span>
                                <span
                                  className="rm-mini-stat-value"
                                  style={{ color: scoreColor(v ?? null) }}
                                >
                                  {v != null ? `${Math.round(v)}` : '—'}
                                </span>
                              </div>
                            )
                          }
                        )}
                      </div>

                      {evalRes.summary ? (
                        <p
                          className="text-xs mt-3"
                          style={{ color: 'var(--rm-ink-2)' }}
                        >
                          {evalRes.summary}
                        </p>
                      ) : null}

                      {evalRes.hallucinations?.length ? (
                        <div className="mt-3">
                          <span
                            className="rm-eyebrow"
                            style={{ color: 'var(--rm-red)' }}
                          >
                            Datos inventados
                          </span>
                          <ul className="mt-1 space-y-0.5">
                            {evalRes.hallucinations.map((h, i) => (
                              <li
                                key={i}
                                className="text-xs"
                                style={{ color: 'var(--rm-ink-2)' }}
                              >
                                • {h}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {evalRes.errors?.length ? (
                        <div className="mt-3">
                          <span
                            className="rm-eyebrow"
                            style={{ color: 'var(--rm-amber)' }}
                          >
                            Errores
                          </span>
                          <ul className="mt-1 space-y-0.5">
                            {evalRes.errors.map((e, i) => (
                              <li
                                key={i}
                                className="text-xs"
                                style={{ color: 'var(--rm-ink-2)' }}
                              >
                                • {e}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {evalRes.suggestions?.length ? (
                        <div className="mt-3">
                          <span
                            className="rm-eyebrow"
                            style={{ color: 'var(--rm-green)' }}
                          >
                            Sugerencias
                          </span>
                          <ul className="mt-1 space-y-0.5">
                            {evalRes.suggestions.map((s, i) => (
                              <li
                                key={i}
                                className="text-xs"
                                style={{ color: 'var(--rm-ink-2)' }}
                              >
                                • {s}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : evalRes?.error ? (
                    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--rm-border)' }}>
                      <p className="text-xs" style={{ color: 'var(--rm-red)' }}>
                        Error de evaluación: {evalRes.error}
                      </p>
                    </div>
                  ) : null}

                  <div className="p-4 space-y-2">
                    {r.conversation.map((m, i) => (
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
                    {r.error_message ? (
                      <div
                        className="text-xs"
                        style={{
                          color: 'var(--rm-red)',
                          padding: '6px 12px',
                          background: 'rgba(193, 79, 58, 0.06)',
                          borderRadius: 8,
                        }}
                      >
                        {r.error_message}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
