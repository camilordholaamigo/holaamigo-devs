'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  FlaskConical,
  Plus,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Bot,
  Sparkles,
} from 'lucide-react'
import { useTerminalPage } from './use-terminal-page'
import { useRoutePrefix } from '@/lib/hooks/use-route-prefix'
import { useMounted } from '@/lib/hooks/use-mounted'
import { SmokeSuiteCreateModal } from './smoke-suite-create-modal'

interface SuiteRow {
  id: string
  nombre: string
  descripcion: string | null
  test_phone: string
  agente_ia_id: string
  created_at: string
  updated_at: string
}

interface AgentRow {
  id: string
  nombre: string
  canal: string
  numero_whatsapp: string | null
  assistant_id: string | null
  activo: boolean
}

interface RunRow {
  id: string
  suite_id: string
  status: string
  overall_score: number | null
  completed_at: string | null
  created_at: string
}

interface SeqRow {
  suite_id: string
}

interface Props {
  suites: SuiteRow[]
  agents: AgentRow[]
  lastRuns: RunRow[]
  sequences: SeqRow[]
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'sin runs'
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return 'sin runs'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'hace instantes'
  if (min < 60) return `hace ${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `hace ${hr}h`
  const d = Math.floor(hr / 24)
  return `hace ${d}d`
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--rm-muted)'
  if (score >= 80) return 'var(--rm-green)'
  if (score >= 60) return 'var(--rm-amber)'
  return 'var(--rm-red)'
}

function scorePill(score: number | null | undefined): { cls: string; text: string } {
  if (score == null) return { cls: 'rm-pill-muted', text: 'Sin evaluar' }
  if (score >= 80) return { cls: 'rm-pill-teal', text: `${Math.round(score)}/100` }
  if (score >= 60) return { cls: 'rm-pill-amber', text: `${Math.round(score)}/100` }
  return { cls: 'rm-pill-red', text: `${Math.round(score)}/100` }
}

export function SmokeTesterView({ suites, agents, lastRuns, sequences }: Props) {
  const router = useRouter()
  const prefix = useRoutePrefix()
  const mounted = useMounted()
  const [showCreate, setShowCreate] = useState(false)

  const agentMap = useMemo(() => {
    const m = new Map<string, AgentRow>()
    for (const a of agents) m.set(a.id, a)
    return m
  }, [agents])

  const lastRunBySuite = useMemo(() => {
    const m = new Map<string, RunRow>()
    for (const r of lastRuns) {
      if (!m.has(r.suite_id)) m.set(r.suite_id, r)
    }
    return m
  }, [lastRuns])

  const seqCountBySuite = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of sequences) {
      counts[s.suite_id] = (counts[s.suite_id] || 0) + 1
    }
    return counts
  }, [sequences])

  // Date.now() inside useMemo runs during render — that's fine on the
  // client, but on SSR it produces a different value than the client first
  // render, so any time-relative output must be gated by `mounted` to avoid
  // React #418 hydration errors. We compute stats unconditionally (no time
  // dep) and time-relative buckets (thisWeek) separately when mounted.
  const stats = useMemo(() => {
    const total = suites.length
    const totalRuns = lastRuns.length
    const completed = lastRuns.filter((r) => r.status === 'completed')
    const scored = completed.filter((r) => typeof r.overall_score === 'number')
    const avgScore =
      scored.length > 0
        ? Math.round(
            scored.reduce((acc, r) => acc + (r.overall_score ?? 0), 0) / scored.length
          )
        : null
    const lastRunIso = lastRuns[0]?.created_at ?? null
    return { total, totalRuns, avgScore, lastRunIso }
  }, [suites.length, lastRuns])

  const thisWeek = useMemo(() => {
    if (!mounted) return null
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    return lastRuns.filter((r) => new Date(r.created_at).getTime() > sevenDaysAgo).length
  }, [mounted, lastRuns])

  useTerminalPage({
    title: 'Smoke Tester',
    crumb: `${stats.total} suite${stats.total === 1 ? '' : 's'} · ${stats.totalRuns} runs`,
    nav: 'smoke-tester',
    contextLabel:
      stats.avgScore != null
        ? `Calidad promedio · ${stats.avgScore}/100`
        : 'Aún sin evaluaciones',
    insights: [
      {
        id: 'why',
        kind: 'ai',
        title: '¿Para qué sirve?',
        body:
          'Lanza conversaciones simuladas a tu agente, captura sus respuestas y un evaluador IA las compara contra la ficha real del proyecto.',
      },
      {
        id: 'tip',
        kind: 'opportunity',
        title: 'Recomendación',
        body:
          'Crea una suite por inmobiliaria con una secuencia por proyecto. Vuelve a correr la suite cada vez que cambies las instrucciones del agente.',
      },
    ],
  })

  const miniStats = [
    { label: 'Suites', value: stats.total.toLocaleString('es-CO') },
    {
      label: 'Score promedio',
      value: stats.avgScore != null ? `${stats.avgScore}/100` : '—',
      color: scoreColor(stats.avgScore ?? null),
    },
    {
      label: 'Runs · 7 días',
      value: thisWeek != null ? thisWeek.toLocaleString('es-CO') : '—',
    },
    {
      label: 'Último run',
      value: mounted ? timeAgo(stats.lastRunIso) : '—',
    },
  ]

  // Smoke tester sends via wzap.chat, not via internal orchestrator —
  // assistant_id is no longer required. Any active agent (or none) is fine.
  const eligibleAgents = agents.filter((a) => a.activo)

  return (
    <div className="space-y-6 px-2">
      <header className="rm-page-header">
        <div className="rm-page-header-block">
          <span className="rm-page-eyebrow">
            <Sparkles size={11} strokeWidth={1.8} />
            Calidad &amp; QA
          </span>
          <h1 className="rm-display-h1">
            Smoke <span className="rm-italic-accent">Tester</span>
          </h1>
          <p className="rm-page-lede">
            Conversaciones simuladas evaluadas por Claude para validar que tus agentes
            IA responden con el tono, conocimiento y flujo correctos.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {miniStats.map((s) => (
          <div key={s.label} className="rm-mini-stat">
            <span className="rm-mini-stat-label">{s.label}</span>
            <span className="rm-mini-stat-value" style={s.color ? { color: s.color } : undefined}>
              {s.value}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div
          className="rm-pill rm-pill-violet"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Sparkles size={11} strokeWidth={2} /> Evaluador con Claude
        </div>
        <div className="ml-auto">
          <button
            type="button"
            className="rm-btn-primary"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={13} strokeWidth={2} /> Iniciar conversación
          </button>
        </div>
      </div>

      {agents.length === 0 ? (
        <div
          className="flex items-start gap-2 p-3 rounded-lg"
          style={{
            background: 'rgba(210, 152, 54, 0.08)',
            border: '1px solid rgba(210, 152, 54, 0.2)',
          }}
        >
          <AlertTriangle
            size={14}
            strokeWidth={1.8}
            style={{ color: 'var(--rm-amber)', marginTop: 2 }}
          />
          <p className="text-xs" style={{ color: 'var(--rm-ink-2)' }}>
            Aún no tienes agentes IA. Conecta uno antes de crear una suite de pruebas.
          </p>
        </div>
      ) : null}

      <div className="rm-row-list">
        {suites.length === 0 ? (
          <div className="rm-card text-center py-12">
            <div
              className="inline-flex items-center justify-center rounded-full mx-auto"
              style={{
                width: 48,
                height: 48,
                background: 'var(--rm-surface-2)',
                color: 'var(--rm-muted)',
              }}
            >
              <FlaskConical size={20} strokeWidth={1.6} />
            </div>
            <p className="text-sm font-semibold mt-3" style={{ color: 'var(--rm-ink)' }}>
              Aún no tienes suites de prueba
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--rm-muted)' }}>
              Crea una suite y agrega secuencias para validar tu agente IA contra fichas reales.
            </p>
            <button
              type="button"
              className="rm-btn-primary mt-4"
              onClick={() => setShowCreate(true)}
            >
              <Plus size={13} strokeWidth={2} /> Iniciar primera conversación
            </button>
          </div>
        ) : (
          suites.map((s) => {
            const agent = agentMap.get(s.agente_ia_id)
            const lastRun = lastRunBySuite.get(s.id) ?? null
            const seqCount = seqCountBySuite[s.id] || 0
            const pill = scorePill(lastRun?.overall_score ?? null)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => router.push(`${prefix}/smoke-tester/${s.id}`)}
                className="rm-row text-left w-full"
                data-clickable="true"
                style={{
                  gridTemplateColumns: '40px 1fr auto auto auto',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: 36,
                    height: 36,
                    background: 'var(--rm-surface-3)',
                    color: 'var(--rm-ink-2)',
                  }}
                >
                  <FlaskConical size={15} strokeWidth={1.8} />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="text-sm font-semibold truncate"
                      style={{ color: 'var(--rm-ink)' }}
                    >
                      {s.nombre}
                    </span>
                    <span className="rm-pill rm-pill-muted">
                      {seqCount} secuencia{seqCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span
                      className="text-[11px]"
                      style={{ color: 'var(--rm-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <Bot size={10} strokeWidth={1.8} />
                      {agent?.nombre ?? 'Agente desconocido'}
                    </span>
                    <span
                      className="text-[11px] font-mono"
                      style={{ color: 'var(--rm-muted)' }}
                    >
                      {s.test_phone}
                    </span>
                    <span
                      className="text-[11px]"
                      style={{ color: 'var(--rm-muted)' }}
                      suppressHydrationWarning
                    >
                      último run: {mounted ? timeAgo(lastRun?.created_at ?? null) : '—'}
                    </span>
                  </div>
                </div>

                <span className={`rm-pill ${pill.cls}`}>{pill.text}</span>

                <span className="text-[11px]" style={{ color: 'var(--rm-muted)' }}>
                  {lastRun?.status === 'running' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span
                        className="rm-status-led"
                        style={{ background: 'var(--rm-teal)', boxShadow: '0 0 6px var(--rm-teal)' }}
                      />
                      Ejecutando…
                    </span>
                  ) : lastRun?.status === 'completed' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <CheckCircle2 size={11} strokeWidth={1.8} style={{ color: 'var(--rm-green)' }} />
                      Completo
                    </span>
                  ) : null}
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

      <SmokeSuiteCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agents={eligibleAgents}
        onCreated={(id) => router.push(`${prefix}/smoke-tester/${id}`)}
      />
    </div>
  )
}
