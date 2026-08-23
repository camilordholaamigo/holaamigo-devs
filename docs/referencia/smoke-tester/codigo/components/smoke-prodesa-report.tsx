'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, FileText } from 'lucide-react'
import type { ProdesaAuditResult, ProdesaProject, ConversationEntry } from '@/lib/smoke-tester/types'

interface Props {
  audit: ProdesaAuditResult
  project: Pick<
    ProdesaProject,
    'nombre_proyecto' | 'categoria' | 'precio_min' | 'precio_max' | 'subtipos' | 'ciudadela_id' | 'proyecto_id'
  > | null
  conversation: ConversationEntry[]
  runId: string
}

function compactCurrency(n: number | null): string {
  if (!n || n <= 0) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`
  return `$${n.toLocaleString('es-CO')}`
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--rm-green)'
  if (score >= 60) return 'var(--rm-amber)'
  return 'var(--rm-red)'
}

export function SmokeProdesaReport({ audit, project, conversation, runId }: Props) {
  const [showTranscript, setShowTranscript] = useState(false)
  const [showFicha, setShowFicha] = useState(false)

  return (
    <div className="rm-bento">
      {/* Header — score + closed_with */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div>
          <span className="rm-page-eyebrow" style={{ marginBottom: 0 }}>
            <FileText size={11} strokeWidth={1.8} />
            Audit report
          </span>
          <h3 className="rm-display-h2" style={{ marginTop: 4 }}>
            Reporte <span className="rm-italic-accent">final</span>
          </h3>
          <p
            className="text-xs mt-1 font-mono"
            style={{ color: 'var(--rm-muted)' }}
          >
            run · {runId.slice(0, 8)}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <ClosedWithBadge value={audit.closed_with} />
          <div
            style={{
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '8px 18px',
              background: 'var(--rm-surface-2)',
              borderRadius: 14,
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
                fontSize: 36,
                fontWeight: 700,
                color: scoreColor(audit.overall_score),
                letterSpacing: '-0.03em',
                lineHeight: 1,
                marginTop: 2,
              }}
            >
              {audit.overall_score}
            </span>
          </div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <SummaryStat
          label="Pasos OK"
          value={`${audit.steps.filter((s) => s.passed).length}/${audit.steps.length}`}
          color="var(--rm-green)"
        />
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
          label="Mensajes"
          value={`${audit.agent_message_count}A · ${audit.buyer_message_count}B`}
          color="var(--rm-ink)"
        />
      </div>

      {/* Project ficha (collapsible) */}
      {project ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowFicha((v) => !v)}
            className="flex items-center gap-2 w-full text-left"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--rm-green)',
              background: 'transparent',
              border: 0,
              padding: '8px 0',
              cursor: 'pointer',
            }}
          >
            {showFicha ? (
              <ChevronUp size={12} strokeWidth={2} />
            ) : (
              <ChevronDown size={12} strokeWidth={2} />
            )}
            Ficha del proyecto
          </button>
          {showFicha ? (
            <div
              className="p-4 rounded-xl"
              style={{
                background: 'var(--rm-surface-2)',
                fontSize: 12,
                color: 'var(--rm-ink-2)',
              }}
            >
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
                <FichaField label="Proyecto" value={project.nombre_proyecto} />
                <FichaField label="Categoría" value={project.categoria || '—'} />
                <FichaField
                  label="Rango"
                  value={`${compactCurrency(project.precio_min)} — ${compactCurrency(project.precio_max)}`}
                />
                {project.ciudadela_id ? (
                  <FichaField label="Ciudadela #ID" value={project.ciudadela_id} />
                ) : null}
                {project.proyecto_id ? (
                  <FichaField label="Proyecto #ID" value={project.proyecto_id} />
                ) : null}
              </div>
              {project.subtipos && project.subtipos.length > 0 ? (
                <div>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--rm-muted)',
                    }}
                  >
                    Subtipos
                  </span>
                  <ul className="mt-2 space-y-1">
                    {project.subtipos.map((s, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between text-xs"
                        style={{ color: 'var(--rm-ink)' }}
                      >
                        <span>{s.name}</span>
                        <span className="font-mono">
                          {compactCurrency(s.price)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Conversation transcript (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setShowTranscript((v) => !v)}
          className="flex items-center gap-2 w-full text-left"
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--rm-green)',
            background: 'transparent',
            border: 0,
            padding: '8px 0',
            cursor: 'pointer',
          }}
        >
          {showTranscript ? (
            <ChevronUp size={12} strokeWidth={2} />
          ) : (
            <ChevronDown size={12} strokeWidth={2} />
          )}
          Transcripción ({conversation.length} mensajes)
        </button>
        {showTranscript ? (
          <div
            className="p-4 rounded-xl flex flex-col gap-3"
            style={{
              background: 'var(--rm-surface-2)',
              maxHeight: 360,
              overflowY: 'auto',
            }}
          >
            {conversation.length === 0 ? (
              <p
                className="text-xs"
                style={{ color: 'var(--rm-muted)' }}
              >
                Sin mensajes en la transcripción.
              </p>
            ) : (
              conversation.map((m, i) => (
                <div
                  key={i}
                  className="rounded-lg p-3"
                  style={{
                    alignSelf: m.role === 'agent' ? 'flex-start' : 'flex-end',
                    maxWidth: '80%',
                    background:
                      m.role === 'agent'
                        ? 'var(--rm-surface)'
                        : 'rgba(64, 217, 157, 0.14)',
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--rm-muted)',
                      marginBottom: 4,
                    }}
                  >
                    {m.role === 'agent' ? 'Agent' : 'Buyer'} ·{' '}
                    {m.timestamp ? new Date(m.timestamp).toLocaleTimeString('es-CO') : ''}
                  </div>
                  <div
                    className="text-sm"
                    style={{ color: 'var(--rm-ink)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
                  >
                    {m.text}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ClosedWithBadge({ value }: { value: string }) {
  if (value === 'agendado') {
    return (
      <span className="rm-status-chip rm-status-chip-active">
        Cerrado · #agendado
      </span>
    )
  }
  if (value === 'cotizacion') {
    return (
      <span className="rm-status-chip rm-status-chip-connected">
        Cerrado · #cotizacion
      </span>
    )
  }
  if (value === 'timeout') {
    return <span className="rm-status-chip rm-status-chip-pending">Timeout</span>
  }
  return <span className="rm-status-chip rm-status-chip-error">Incompleto</span>
}

function SummaryStat({
  label,
  value,
  color,
}: {
  label: string
  value: number | string
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
        {value}
      </div>
    </div>
  )
}

function FichaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--rm-muted)',
        }}
      >
        {label}
      </div>
      <div className="text-sm font-medium mt-1" style={{ color: 'var(--rm-ink)' }}>
        {value}
      </div>
    </div>
  )
}
