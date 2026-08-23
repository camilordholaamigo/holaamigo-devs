'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Loader2,
  Sparkles,
  Play,
  Square,
  AlertCircle,
} from 'lucide-react'
import type { ProdesaProjectLite } from './smoke-prodesa-trigger-form'

interface QueueSnapshot {
  id: string
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed'
  project_ids: string[]
  current_index: number
  current_run_id: string | null
  total_projects: number
  completed_projects: number
  failed_projects: number
  inter_run_delay_seconds: number
  started_at: string | null
  completed_at: string | null
}

interface Props {
  suiteId: string
  projects: ProdesaProjectLite[]
  initialQueue?: QueueSnapshot | null
}

const POLL_MS = 6000
const TERMINAL = new Set(['completed', 'cancelled', 'failed'])

export function SmokeProdesaCampaignRunner({
  suiteId,
  projects,
  initialQueue = null,
}: Props) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [delaySeconds, setDelaySeconds] = useState<number>(60)
  const [submitting, setSubmitting] = useState(false)
  const [queue, setQueue] = useState<QueueSnapshot | null>(initialQueue)
  const [error, setError] = useState<string | null>(null)

  const projectsById = useMemo(() => {
    const map = new Map<string, ProdesaProjectLite>()
    for (const p of projects) map.set(p.id, p)
    return map
  }, [projects])

  // Poll queue status while running.
  useEffect(() => {
    if (!queue?.id) return
    if (TERMINAL.has(queue.status)) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function tick() {
      try {
        const res = await fetch(
          `/api/smoke-test/${suiteId}/campaign/${queue!.id}`,
          { cache: 'no-store' }
        )
        if (!res.ok) throw new Error(`queue ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setQueue(data.queue as QueueSnapshot)
        if (TERMINAL.has((data.queue as QueueSnapshot).status)) {
          router.refresh()
          return
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [queue?.id, queue?.status, suiteId, router])

  function toggleProject(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  async function handleLaunch() {
    if (selectedIds.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/smoke-test/${suiteId}/campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_ids: selectedIds,
          inter_run_delay_seconds: delaySeconds,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `Error ${res.status}`)
        return
      }
      setQueue({
        id: data.queue_id,
        status: 'running',
        project_ids: selectedIds,
        current_index: 0,
        current_run_id: null,
        total_projects: selectedIds.length,
        completed_projects: 0,
        failed_projects: 0,
        inter_run_delay_seconds: delaySeconds,
        started_at: new Date().toISOString(),
        completed_at: null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel() {
    if (!queue?.id) return
    if (!confirm('¿Cancelar la campaña? La conversación actual termina y no se inicia la siguiente.')) return
    try {
      await fetch(`/api/smoke-test/${suiteId}/campaign/${queue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      })
      setQueue((prev) =>
        prev ? { ...prev, status: 'cancelled' } : prev
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const isActive = queue && !TERMINAL.has(queue.status)

  // ─── Active queue view ────────────────────────────────────────────────
  if (isActive && queue) {
    const totalDone = queue.completed_projects + queue.failed_projects
    const progress = (totalDone / queue.total_projects) * 100
    const currentProject = queue.current_run_id
      ? projectsById.get(queue.project_ids[queue.current_index] || '')
      : null
    const remaining = queue.total_projects - totalDone
    const estTotalMin = Math.round((queue.total_projects * 14 + queue.inter_run_delay_seconds * (queue.total_projects - 1) / 60))

    return (
      <div className="rm-bento-dark">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
          <div>
            <span
              className="rm-page-eyebrow"
              style={{ color: 'var(--rm-mint)' }}
            >
              <Sparkles size={11} strokeWidth={1.8} />
              Campaña en curso
            </span>
            <h3
              style={{
                fontFamily: 'var(--rm-font-display)',
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: '#fff',
                lineHeight: 1.2,
                marginTop: 6,
              }}
            >
              Proyecto {Math.min(queue.current_index + 1, queue.total_projects)} de{' '}
              {queue.total_projects}
            </h3>
            {currentProject ? (
              <p
                style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.85)',
                  marginTop: 4,
                  fontStyle: 'italic',
                }}
              >
                {currentProject.nombre_proyecto}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleCancel}
            style={{
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              padding: '8px 16px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              border: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Square size={11} strokeWidth={2} />
            Cancelar
          </button>
        </div>

        {/* Progress bar */}
        <div
          style={{
            height: 6,
            background: 'rgba(255,255,255,0.1)',
            borderRadius: 999,
            overflow: 'hidden',
            marginBottom: 18,
          }}
        >
          <div
            style={{
              width: `${Math.max(0, Math.min(100, progress))}%`,
              height: '100%',
              background: 'var(--rm-mint)',
              transition: 'width 0.5s ease',
            }}
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.65)',
              }}
            >
              Completados
            </div>
            <div
              style={{
                fontFamily: 'var(--rm-font-display)',
                fontSize: 30,
                fontWeight: 700,
                color: 'var(--rm-mint)',
                letterSpacing: '-0.02em',
                lineHeight: 1,
                marginTop: 4,
              }}
            >
              {queue.completed_projects}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.65)',
              }}
            >
              Fallidos
            </div>
            <div
              style={{
                fontFamily: 'var(--rm-font-display)',
                fontSize: 30,
                fontWeight: 700,
                color: '#ffa68a',
                letterSpacing: '-0.02em',
                lineHeight: 1,
                marginTop: 4,
              }}
            >
              {queue.failed_projects}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.65)',
              }}
            >
              Restantes
            </div>
            <div
              style={{
                fontFamily: 'var(--rm-font-display)',
                fontSize: 30,
                fontWeight: 700,
                color: '#fff',
                letterSpacing: '-0.02em',
                lineHeight: 1,
                marginTop: 4,
              }}
            >
              {remaining}
            </div>
          </div>
        </div>

        <p
          className="text-xs mt-4"
          style={{ color: 'rgba(255,255,255,0.65)' }}
        >
          Cada conversación toma ~12-15 min · {queue.inter_run_delay_seconds}s entre runs · ETA total
          ~{Math.round(estTotalMin / 60)}h
        </p>

        {queue.current_run_id ? (
          <a
            href="#current-run"
            className="block text-xs mt-3"
            style={{ color: 'var(--rm-mint)', textDecoration: 'underline' }}
          >
            Ver auditoría del run actual ↓
          </a>
        ) : null}

        {error ? (
          <p
            className="text-xs mt-2"
            style={{ color: 'rgba(255,180,170,0.9)' }}
          >
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  // ─── Selector view ────────────────────────────────────────────────────
  return (
    <div className="rm-bento">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <span className="rm-page-eyebrow" style={{ marginBottom: 0 }}>
          <Sparkles size={11} strokeWidth={1.8} />
          Batch campaign
        </span>
        <span className="rm-status-chip rm-status-chip-stable">
          Serial · 1 número
        </span>
      </div>
      <h3 className="rm-display-h2" style={{ marginBottom: 8 }}>
        Test <span className="rm-italic-accent">en serie</span>
      </h3>
      <p
        className="text-sm"
        style={{ color: 'var(--rm-muted)', maxWidth: 600, marginBottom: 16 }}
      >
        Selecciona varios proyectos. Cada conversación arranca solo cuando la
        anterior cierra (#agendado, #cotizacion o timeout).
      </p>

      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <button
          type="button"
          onClick={() => setSelectedIds(projects.map((p) => p.id))}
          className="text-xs"
          style={{
            color: 'var(--rm-green)',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
          }}
        >
          Seleccionar todos ({projects.length})
        </button>
        <span style={{ color: 'var(--rm-border)' }}>·</span>
        <button
          type="button"
          onClick={() => setSelectedIds([])}
          className="text-xs"
          style={{
            color: 'var(--rm-muted)',
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
          }}
        >
          Limpiar
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--rm-muted)' }}>
          <strong style={{ color: 'var(--rm-ink)' }}>
            {selectedIds.length}
          </strong>{' '}
          seleccionados
        </span>
      </div>

      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4"
        style={{ maxHeight: 280, overflowY: 'auto' }}
      >
        {projects.map((p) => {
          const checked = selectedIds.includes(p.id)
          return (
            <label
              key={p.id}
              className="flex items-center gap-3 p-3 rounded-lg cursor-pointer"
              style={{
                background: checked
                  ? 'rgba(64, 217, 157, 0.08)'
                  : 'var(--rm-surface-2)',
                outline: checked ? '1.5px solid var(--rm-teal)' : '0',
                outlineOffset: -1.5,
                transition: 'background 0.15s ease',
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleProject(p.id)}
                style={{ accentColor: 'var(--rm-green)' }}
              />
              <div className="flex-1 min-w-0">
                <div
                  className="text-sm font-medium truncate"
                  style={{ color: 'var(--rm-ink)' }}
                >
                  {p.nombre_proyecto}
                </div>
                <div
                  className="text-xs"
                  style={{ color: 'var(--rm-muted)' }}
                >
                  {p.categoria || '—'}
                </div>
              </div>
            </label>
          )
        })}
      </div>

      <label
        className="block mb-2"
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--rm-muted)',
        }}
      >
        Delay entre conversaciones
      </label>
      <select
        value={delaySeconds}
        onChange={(e) => setDelaySeconds(Number(e.target.value))}
        className="rm-input rm-select"
        style={{ width: '100%', marginBottom: 14 }}
      >
        <option value={30}>30 s — agresivo</option>
        <option value={60}>1 min — recomendado</option>
        <option value={180}>3 min — seguro</option>
        <option value={300}>5 min — muy seguro</option>
      </select>

      <button
        type="button"
        onClick={handleLaunch}
        disabled={selectedIds.length === 0 || submitting}
        className="rm-btn-primary"
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '12px 20px',
          opacity: selectedIds.length === 0 || submitting ? 0.55 : 1,
        }}
      >
        {submitting ? (
          <>
            <Loader2 size={14} className="animate-spin" /> Lanzando…
          </>
        ) : (
          <>
            <Play size={14} strokeWidth={2} /> Lanzar campaña ({selectedIds.length} proyectos · ETA ~
            {Math.round((selectedIds.length * 14) / 60)}h)
          </>
        )}
      </button>

      {error ? (
        <div
          className="mt-3 p-3 rounded-lg flex items-start gap-2"
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
          <p className="text-xs flex-1" style={{ color: 'var(--rm-red)' }}>
            {error}
          </p>
        </div>
      ) : null}
    </div>
  )
}
