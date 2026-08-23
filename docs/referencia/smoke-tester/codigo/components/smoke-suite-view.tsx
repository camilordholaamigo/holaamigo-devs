'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus,
  Play,
  Trash2,
  Bot,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  ChevronLeft,
  Sparkles,
  ListPlus,
} from 'lucide-react'
import { useTerminalPage } from './use-terminal-page'
import { useMounted } from '@/lib/hooks/use-mounted'
import { SmokeSequenceCreateModal } from './smoke-sequence-create-modal'
import { SmokeAutonomousRunModal } from './smoke-autonomous-run-modal'
import { SmokeTestLive } from './smoke-test-live'
import { SmokeTestReport } from './smoke-test-report'

interface SuiteRow {
  id: string
  nombre: string
  descripcion: string | null
  test_phone: string
  agente_ia_id: string
}

interface AgentRow {
  id: string
  nombre: string
  canal: string
  numero_whatsapp: string | null
  assistant_id: string | null
  instrucciones: string | null
}

interface SequenceRow {
  id: string
  nombre: string
  proyecto_ref: string | null
  ficha_tecnica: string | null
  messages: { text: string; delay?: number }[]
  orden: number
}

interface RunRow {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: string | null
  completed_at: string | null
  total_sequences: number
  completed_sequences: number
  overall_score: number | null
  created_at: string
  summary: Record<string, unknown>
}

interface Props {
  suite: SuiteRow
  agent: AgentRow | null
  sequences: SequenceRow[]
  runs: RunRow[]
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return '—'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'hace instantes'
  if (min < 60) return `hace ${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `hace ${hr}h`
  const d = Math.floor(hr / 24)
  return `hace ${d}d`
}

function statusPill(status: RunRow['status']): { cls: string; label: string; icon: any } {
  switch (status) {
    case 'running':
      return { cls: 'rm-pill-teal', label: 'Ejecutando', icon: Loader2 }
    case 'completed':
      return { cls: 'rm-pill-teal', label: 'Completo', icon: CheckCircle2 }
    case 'failed':
      return { cls: 'rm-pill-red', label: 'Falló', icon: XCircle }
    case 'cancelled':
      return { cls: 'rm-pill-muted', label: 'Cancelado', icon: AlertCircle }
    default:
      return { cls: 'rm-pill-muted', label: 'Pendiente', icon: Clock }
  }
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--rm-muted)'
  if (score >= 80) return 'var(--rm-green)'
  if (score >= 60) return 'var(--rm-amber)'
  return 'var(--rm-red)'
}

export function SmokeSuiteView({ suite, agent, sequences: initialSequences, runs: initialRuns }: Props) {
  const router = useRouter()
  const mounted = useMounted()
  const [sequences, setSequences] = useState<SequenceRow[]>(initialSequences)
  const [runs, setRuns] = useState<RunRow[]>(initialRuns)
  const [showCreateSeq, setShowCreateSeq] = useState(false)
  const [showAutoRun, setShowAutoRun] = useState(false)
  // Auto-pick up any in-flight run on first render so the user lands on the
  // live transcript even when the run was kicked off elsewhere (e.g. the
  // create-conversation modal that auto-runs).
  const initialActiveRun =
    initialRuns.find((r) => r.status === 'running' || r.status === 'pending') ?? null
  const [activeRunId, setActiveRunId] = useState<string | null>(
    initialActiveRun?.id ?? null
  )
  const [viewingRunId, setViewingRunId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useTerminalPage({
    title: suite.nombre,
    crumb: `${sequences.length} secuencia${sequences.length === 1 ? '' : 's'} · ${suite.test_phone}`,
    nav: 'smoke-tester',
    contextLabel: agent ? `Agente · ${agent.nombre}` : 'Sin agente vinculado',
    insights: [
      {
        id: 'how',
        kind: 'ai',
        title: 'Cómo funciona',
        body:
          'Cada secuencia simula una conversación. Al ejecutar, el agente responde realmente a través del orchestrator y todo queda grabado para evaluar después.',
      },
      {
        id: 'tip',
        kind: 'opportunity',
        title: 'Pega la ficha técnica real',
        body:
          'El evaluador IA compara las respuestas contra la ficha que pegues. Si está vacía, solo se podrán medir tono y completitud.',
      },
    ],
  })

  const liveRunId = useMemo(() => activeRunId ?? viewingRunId, [activeRunId, viewingRunId])

  const handleStartRun = useCallback(async () => {
    if (sequences.length === 0) {
      setError('Agrega al menos una secuencia antes de ejecutar')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const res = await fetch(`/api/smoke-test/${suite.id}/run`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Error al iniciar el run')
        setRunning(false)
        return
      }
      setActiveRunId(data.run_id)
      setRunning(false)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
      setRunning(false)
    }
  }, [sequences.length, suite.id, router])

  const handleAutonomousStarted = useCallback(
    (runId: string) => {
      setActiveRunId(runId)
      setViewingRunId(null)
      router.refresh()
    },
    [router]
  )

  const handleDeleteSequence = useCallback(
    async (seqId: string) => {
      if (!confirm('¿Eliminar esta secuencia?')) return
      const res = await fetch(`/api/smoke-test/${suite.id}/sequences/${seqId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setSequences((prev) => prev.filter((s) => s.id !== seqId))
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'No se pudo eliminar la secuencia')
      }
    },
    [suite.id]
  )

  const handleSequenceCreated = useCallback((row: SequenceRow) => {
    setSequences((prev) => [...prev, row].sort((a, b) => a.orden - b.orden))
  }, [])

  const handleRunFinished = useCallback(
    (run: RunRow) => {
      setActiveRunId(null)
      setRuns((prev) => {
        const exists = prev.some((r) => r.id === run.id)
        if (exists) return prev.map((r) => (r.id === run.id ? run : r))
        return [run, ...prev]
      })
      setViewingRunId(run.id)
      router.refresh()
    },
    [router]
  )

  // If we are viewing a run report
  if (viewingRunId && !activeRunId) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setViewingRunId(null)}
          className="rm-btn-ghost"
        >
          <ChevronLeft size={13} strokeWidth={1.8} /> Volver a la suite
        </button>
        <SmokeTestReport runId={viewingRunId} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
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
          <p className="text-xs flex-1" style={{ color: 'var(--rm-red)' }}>{error}</p>
          <button
            type="button"
            className="text-xs"
            style={{ color: 'var(--rm-red)' }}
            onClick={() => setError(null)}
          >
            Cerrar
          </button>
        </div>
      ) : null}

      <div className="rm-card" style={{ padding: 16 }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <span className="rm-eyebrow">Configuración</span>
            <div className="flex items-center gap-3 mt-1">
              <span
                className="text-sm font-semibold"
                style={{ color: 'var(--rm-ink)' }}
              >
                {suite.nombre}
              </span>
              {agent ? (
                <span
                  className="rm-pill rm-pill-teal"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Bot size={10} strokeWidth={1.8} /> {agent.nombre}
                </span>
              ) : null}
              <span
                className="text-[11px] font-mono"
                style={{ color: 'var(--rm-muted)' }}
              >
                Test → {suite.test_phone}
              </span>
            </div>
            {suite.descripcion ? (
              <p className="text-xs mt-2" style={{ color: 'var(--rm-ink-2)' }}>
                {suite.descripcion}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rm-btn-ghost"
              onClick={() => setShowCreateSeq(true)}
            >
              <ListPlus size={13} strokeWidth={1.8} /> Agregar secuencia
            </button>
            <button
              type="button"
              className="rm-btn-ghost"
              onClick={() => setShowAutoRun(true)}
              disabled={running || sequences.length === 0}
              title="El comprador IA conversa hasta cerrar: contesta lo que le pregunten y empuja al agendamiento"
            >
              <Sparkles size={13} strokeWidth={1.8} /> Flujo completo
            </button>
            <button
              type="button"
              className="rm-btn-primary"
              onClick={handleStartRun}
              disabled={running || sequences.length === 0}
              title={
                activeRunId
                  ? 'Ya hay un run activo — al ejecutar se cancelará automáticamente y arrancará uno nuevo'
                  : ''
              }
            >
              {running ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Iniciando…
                </>
              ) : (
                <>
                  <Play size={13} strokeWidth={2} /> {activeRunId ? 'Reiniciar prueba' : 'Ejecutar prueba'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {liveRunId && activeRunId ? (
        <SmokeTestLive
          runId={activeRunId}
          onFinished={handleRunFinished}
        />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="rm-eyebrow">Secuencias</span>
            <span className="text-[11px]" style={{ color: 'var(--rm-muted)' }}>
              {sequences.length} total
            </span>
          </div>

          <div className="rm-row-list">
            {sequences.length === 0 ? (
              <div className="rm-card text-center py-10">
                <div
                  className="inline-flex items-center justify-center rounded-full mx-auto"
                  style={{
                    width: 40,
                    height: 40,
                    background: 'var(--rm-surface-2)',
                    color: 'var(--rm-muted)',
                  }}
                >
                  <Sparkles size={16} strokeWidth={1.6} />
                </div>
                <p className="text-sm font-semibold mt-3" style={{ color: 'var(--rm-ink)' }}>
                  Sin secuencias aún
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--rm-muted)' }}>
                  Crea una secuencia por proyecto o por flujo de comprador.
                </p>
                <button
                  type="button"
                  className="rm-btn-primary mt-4"
                  onClick={() => setShowCreateSeq(true)}
                >
                  <Plus size={13} strokeWidth={2} /> Agregar secuencia
                </button>
              </div>
            ) : (
              sequences.map((s) => (
                <div
                  key={s.id}
                  className="rm-row"
                  style={{
                    gridTemplateColumns: '1fr auto auto',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="text-sm font-semibold truncate"
                        style={{ color: 'var(--rm-ink)' }}
                      >
                        {s.nombre}
                      </span>
                      {s.proyecto_ref ? (
                        <span className="rm-pill rm-pill-blue">{s.proyecto_ref}</span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[11px]" style={{ color: 'var(--rm-muted)' }}>
                        {s.messages.length} mensajes
                      </span>
                      {s.ficha_tecnica ? (
                        <span className="text-[11px]" style={{ color: 'var(--rm-green)' }}>
                          ✓ ficha cargada
                        </span>
                      ) : (
                        <span className="text-[11px]" style={{ color: 'var(--rm-amber)' }}>
                          sin ficha — solo medirá tono
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="rm-icon-btn"
                    style={{ color: 'var(--rm-muted)' }}
                    onClick={() => handleDeleteSequence(s.id)}
                    aria-label="Eliminar secuencia"
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>

                  <span
                    className="rm-icon-btn"
                    style={{ width: 28, height: 28, color: 'var(--rm-muted)' }}
                    aria-hidden
                  >
                    <ChevronRight size={14} strokeWidth={1.8} />
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="rm-eyebrow">Historial de pruebas</span>
            <span className="text-[11px]" style={{ color: 'var(--rm-muted)' }}>
              {runs.length} runs
            </span>
          </div>

          <div className="rm-row-list">
            {runs.length === 0 ? (
              <div className="rm-card text-center py-10">
                <div
                  className="inline-flex items-center justify-center rounded-full mx-auto"
                  style={{
                    width: 40,
                    height: 40,
                    background: 'var(--rm-surface-2)',
                    color: 'var(--rm-muted)',
                  }}
                >
                  <Play size={14} strokeWidth={1.6} />
                </div>
                <p className="text-sm font-semibold mt-3" style={{ color: 'var(--rm-ink)' }}>
                  Aún no has ejecutado pruebas
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--rm-muted)' }}>
                  Cuando ejecutes una prueba aparecerá aquí con la transcripción y la calificación.
                </p>
              </div>
            ) : (
              runs.map((r) => {
                const meta = statusPill(r.status)
                const Icon = meta.icon
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setViewingRunId(r.id)}
                    className="rm-row text-left w-full"
                    data-clickable="true"
                    style={{
                      gridTemplateColumns: '1fr auto auto auto',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className="text-sm font-semibold"
                          style={{ color: 'var(--rm-ink)' }}
                        >
                          Run #{r.id.slice(0, 8)}
                        </span>
                        <span className="rm-pill rm-pill-muted text-[10px]">
                          {r.completed_sequences}/{r.total_sequences}
                        </span>
                      </div>
                      <p
                        className="text-[11px] mt-0.5"
                        style={{ color: 'var(--rm-muted)' }}
                        suppressHydrationWarning
                      >
                        {mounted ? timeAgo(r.created_at) : '—'}
                      </p>
                    </div>

                    <span className={`rm-pill ${meta.cls}`}>
                      <Icon
                        size={10}
                        strokeWidth={2}
                        className={r.status === 'running' ? 'animate-spin' : ''}
                      />
                      <span style={{ marginLeft: 4 }}>{meta.label}</span>
                    </span>

                    <span
                      className="text-sm font-semibold"
                      style={{
                        color: scoreColor(r.overall_score),
                        fontFamily: 'var(--rm-font-mono)',
                        minWidth: 60,
                        textAlign: 'right',
                      }}
                    >
                      {r.overall_score != null ? `${Math.round(r.overall_score)}/100` : '—'}
                    </span>

                    <span
                      className="rm-icon-btn"
                      style={{ width: 28, height: 28, color: 'var(--rm-muted)' }}
                      aria-hidden
                    >
                      <ChevronRight size={14} strokeWidth={1.8} />
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>

      <SmokeSequenceCreateModal
        open={showCreateSeq}
        onClose={() => setShowCreateSeq(false)}
        suiteId={suite.id}
        onCreated={handleSequenceCreated}
      />

      <SmokeAutonomousRunModal
        open={showAutoRun}
        onClose={() => setShowAutoRun(false)}
        suiteId={suite.id}
        defaultMensajeInicial={sequences[0]?.messages?.[0]?.text || ''}
        onStarted={handleAutonomousStarted}
      />
    </div>
  )
}
