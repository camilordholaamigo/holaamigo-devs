'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Sparkles, Send, AlertCircle, CheckCircle2, Database, Stethoscope } from 'lucide-react'

export interface ProdesaProjectLite {
  id: string
  nombre_proyecto: string
  categoria: string | null
  precio_min: number | null
  precio_max: number | null
  precio_desde: number | null
  ciudad: string | null
}

interface Props {
  suiteId: string
  projects: ProdesaProjectLite[]
}

const TEST_DEFAULTS = {
  nombre: 'camilo',
  phone: '573332420484',
  correo: 'camiloprojectfi@gmail.com',
  id_hubspot: '216739342874',
  unix: '138383883',
  owner: '',
}

function compactCurrency(n: number | null): string {
  if (!n || n <= 0) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`
  return `$${n.toLocaleString('es-CO')}`
}

export function SmokeProdesaTriggerForm({ suiteId, projects }: Props) {
  const router = useRouter()
  const [proyecto, setProyecto] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<{
    run_id: string
    proyecto: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<unknown>(null)

  const needsSeed = projects.length === 0

  async function handleDiagnose() {
    setDiagnosing(true)
    setDiagnosis(null)
    try {
      const res = await fetch('/api/smoke-test/admin/diagnose-bubble', {
        cache: 'no-store',
      })
      const data = await res.json()
      setDiagnosis(data)
    } catch (err) {
      setDiagnosis({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setDiagnosing(false)
    }
  }

  async function handleSeed() {
    setSeeding(true)
    setSeedMsg(null)
    setError(null)
    try {
      const res = await fetch('/api/smoke-test/admin/seed-prodesa', {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `Seed falló (${res.status})`)
        return
      }
      setSeedMsg(`✓ ${data.upserted} proyectos cargados${data.failed > 0 ? ` · ${data.failed} fallaron` : ''}`)
      // Refresh to load the projects into the dropdown.
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSeeding(false)
    }
  }

  const selected = projects.find((p) => p.nombre_proyecto === proyecto) || null

  async function handleSubmit() {
    if (!proyecto) return
    setSubmitting(true)
    setError(null)
    setRunResult(null)
    try {
      const res = await fetch(`/api/smoke-test/${suiteId}/run-form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: proyecto,
          custom_form_data: TEST_DEFAULTS,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `Error ${res.status}`)
        return
      }
      setRunResult({ run_id: data.run_id, proyecto: data.proyecto })
      // Refresh server-side data so the new run appears in the runs list.
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rm-bento" style={{ marginBottom: 0 }}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <div>
          <span className="rm-page-eyebrow" style={{ marginBottom: 0 }}>
            <Sparkles size={11} strokeWidth={1.8} />
            Prodesa campaign test
          </span>
        </div>
        <span className="rm-status-chip rm-status-chip-stable">
          {projects.length} proyectos
        </span>
      </div>
      <h3 className="rm-display-h2" style={{ marginBottom: 8 }}>
        Disparar <span className="rm-italic-accent">flujo de plantilla</span>
      </h3>
      <p
        className="text-sm"
        style={{ color: 'var(--rm-muted)', maxWidth: 600, marginBottom: 20 }}
      >
        Llena el formulario como si fuera un lead de Meta Ads. Hacemos POST a
        Bubble (mismo endpoint que la landing real), esperamos la plantilla,
        y arrancamos el flujo del auditor.
      </p>

      {/* Pre-filled, read-only fields */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <ReadOnlyField label="Nombre" value={TEST_DEFAULTS.nombre} />
        <ReadOnlyField label="Teléfono" value={TEST_DEFAULTS.phone} />
        <ReadOnlyField label="Email" value={TEST_DEFAULTS.correo} />
        <ReadOnlyField label="HubSpot ID" value={TEST_DEFAULTS.id_hubspot} />
        <ReadOnlyField label="Unix" value={TEST_DEFAULTS.unix} />
        <ReadOnlyField label="Owner" value={TEST_DEFAULTS.owner || '—'} />
      </div>

      {/* Seed warning + button when projects table is empty */}
      {needsSeed ? (
        <div
          className="mb-4 p-4 rounded-xl"
          style={{
            background: 'rgba(210, 152, 54, 0.08)',
            border: '1px solid rgba(210, 152, 54, 0.25)',
          }}
        >
          <div className="flex items-start gap-3">
            <Database
              size={16}
              strokeWidth={1.8}
              style={{ color: 'var(--rm-amber)', marginTop: 2, flexShrink: 0 }}
            />
            <div className="flex-1">
              <p
                className="text-sm font-semibold"
                style={{ color: 'var(--rm-ink)' }}
              >
                Catálogo Prodesa vacío
              </p>
              <p
                className="text-xs mt-1"
                style={{ color: 'var(--rm-ink-2)' }}
              >
                Hay 29 proyectos definidos en código. Click el botón para
                cargarlos a Supabase (idempotente — puedes correrlo varias veces).
              </p>
              <button
                type="button"
                onClick={handleSeed}
                disabled={seeding}
                className="rm-btn-primary mt-3"
                style={{ opacity: seeding ? 0.55 : 1 }}
              >
                {seeding ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> Cargando…
                  </>
                ) : (
                  <>
                    <Database size={13} strokeWidth={2} /> Cargar 29 proyectos
                  </>
                )}
              </button>
              {seedMsg ? (
                <p
                  className="text-xs mt-2"
                  style={{ color: 'var(--rm-green)', fontWeight: 600 }}
                >
                  {seedMsg}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Project picker */}
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
        Proyecto de interés
      </label>
      <select
        value={proyecto}
        onChange={(e) => setProyecto(e.target.value)}
        disabled={submitting || projects.length === 0}
        className="rm-input rm-select"
        style={{ width: '100%', marginBottom: 16 }}
      >
        <option value="">
          {projects.length === 0
            ? 'No hay proyectos cargados — corre el seed arriba'
            : 'Selecciona un proyecto…'}
        </option>
        {projects.map((p) => (
          <option key={p.id} value={p.nombre_proyecto}>
            {p.nombre_proyecto}
            {p.categoria ? ` · ${p.categoria}` : ''}
            {p.precio_desde
              ? ` · desde ${compactCurrency(p.precio_desde)}`
              : ''}
          </option>
        ))}
      </select>

      {selected ? (
        <div
          className="text-xs mb-4 p-3 rounded-lg"
          style={{
            background: 'var(--rm-surface-2)',
            color: 'var(--rm-ink-2)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <span>
            <strong style={{ color: 'var(--rm-ink)' }}>Categoría:</strong>{' '}
            {selected.categoria || '—'}
          </span>
          <span>
            <strong style={{ color: 'var(--rm-ink)' }}>Rango:</strong>{' '}
            {compactCurrency(selected.precio_min)} —{' '}
            {compactCurrency(selected.precio_max)}
          </span>
          {selected.ciudad ? (
            <span>
              <strong style={{ color: 'var(--rm-ink)' }}>Ciudad:</strong>{' '}
              {selected.ciudad}
            </span>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!proyecto || submitting || projects.length === 0}
        className="rm-btn-primary"
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '12px 20px',
          opacity: !proyecto || submitting || projects.length === 0 ? 0.55 : 1,
        }}
      >
        {submitting ? (
          <>
            <Loader2 size={14} className="animate-spin" /> Disparando Bubble…
          </>
        ) : (
          <>
            <Send size={14} strokeWidth={2} /> Disparar plantilla &amp; empezar test
          </>
        )}
      </button>

      {error ? (
        <div
          className="mt-4 p-4 rounded-xl"
          style={{
            background: 'rgba(193, 79, 58, 0.08)',
            border: '1px solid rgba(193, 79, 58, 0.2)',
          }}
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              size={14}
              strokeWidth={1.8}
              style={{ color: 'var(--rm-red)', marginTop: 2, flexShrink: 0 }}
            />
            <div className="flex-1">
              <p
                className="text-xs font-semibold"
                style={{ color: 'var(--rm-red)' }}
              >
                {error}
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--rm-ink-2)' }}>
                Si dice "fetch failed" o "Bubble HTTP 4xx/5xx", corré el diagnóstico
                para ver qué está pasando con la URL de Bubble.
              </p>
              <button
                type="button"
                onClick={handleDiagnose}
                disabled={diagnosing}
                className="rm-btn-ghost mt-2"
                style={{ opacity: diagnosing ? 0.55 : 1 }}
              >
                {diagnosing ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> Diagnosticando…
                  </>
                ) : (
                  <>
                    <Stethoscope size={12} strokeWidth={2} /> Diagnosticar Bubble
                  </>
                )}
              </button>
            </div>
          </div>

          {diagnosis ? (
            <pre
              className="mt-3 p-3 rounded-lg text-[11px] overflow-x-auto"
              style={{
                background: 'var(--rm-surface-2)',
                color: 'var(--rm-ink-2)',
                fontFamily: 'var(--rm-font-mono)',
                lineHeight: 1.5,
                maxHeight: 320,
                overflowY: 'auto',
              }}
            >
              {JSON.stringify(diagnosis, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {runResult ? (
        <div
          className="mt-4 p-4 rounded-lg flex items-start gap-3"
          style={{
            background: 'rgba(64, 217, 157, 0.08)',
            border: '1px solid rgba(64, 217, 157, 0.25)',
          }}
        >
          <CheckCircle2
            size={16}
            strokeWidth={1.8}
            style={{ color: 'var(--rm-green)', marginTop: 1 }}
          />
          <div className="flex-1">
            <p
              className="text-sm font-semibold"
              style={{ color: 'var(--rm-ink)' }}
            >
              Test iniciado para {runResult.proyecto}
            </p>
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--rm-ink-2)' }}
            >
              Bubble disparado correctamente. La plantilla llegará en 1-2 min y
              el flujo continuará automáticamente. Run ID:{' '}
              <code
                style={{
                  fontFamily: 'var(--rm-font-mono)',
                  fontSize: 10,
                  color: 'var(--rm-muted)',
                }}
              >
                {runResult.run_id.slice(0, 8)}
              </code>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--rm-muted)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          background: 'var(--rm-surface-2)',
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 12,
          color: 'var(--rm-ink)',
          fontFamily: 'var(--rm-font-mono)',
        }}
      >
        {value}
      </div>
    </div>
  )
}
