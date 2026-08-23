'use client'

import { useState } from 'react'
import { X, Loader2, AlertCircle, Target, MessageSquare, Bot } from 'lucide-react'

interface AgentOption {
  id: string
  nombre: string
  canal: string
  numero_whatsapp: string | null
  assistant_id: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  agents: AgentOption[]
  onCreated: (id: string) => void
}

const DEFAULT_INITIAL_MESSAGE =
  'Hola, vi un proyecto que me interesa y quiero más información. ¿Me puedes ayudar?'
const DEFAULT_TARGET_PHONE = '+573103565492'

export function SmokeSuiteCreateModal({ open, onClose, agents, onCreated }: Props) {
  const [nombre, setNombre] = useState('')
  const [agenteId, setAgenteId] = useState('')
  const [targetPhone, setTargetPhone] = useState(DEFAULT_TARGET_PHONE)
  const [initialMessage, setInitialMessage] = useState(DEFAULT_INITIAL_MESSAGE)
  const [autoRun, setAutoRun] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  function reset() {
    setNombre('')
    setAgenteId('')
    setTargetPhone(DEFAULT_TARGET_PHONE)
    setInitialMessage(DEFAULT_INITIAL_MESSAGE)
    setAutoRun(true)
    setError(null)
    setSaving(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleSave() {
    if (!nombre.trim() || !targetPhone.trim() || !initialMessage.trim()) {
      setError('Completa nombre, número destino y mensaje inicial')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 1. Create suite (+ first sequence with initial_message inline).
      const res = await fetch('/api/smoke-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: nombre.trim(),
          agente_ia_id: agenteId || undefined,
          target_phone: targetPhone.trim(),
          initial_message: initialMessage.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Error al crear la conversación')
        setSaving(false)
        return
      }
      const suiteId = data.data.id as string

      // 2. Optionally fire the run immediately so the user sees the message
      // hit the wzap device on send.
      if (autoRun) {
        const runRes = await fetch(`/api/smoke-test/${suiteId}/run`, {
          method: 'POST',
        })
        if (!runRes.ok) {
          const runData = await runRes.json().catch(() => ({}))
          setError(
            runData.error ||
              'La suite se creó pero la ejecución no arrancó. Entra a la suite y dale "Ejecutar prueba".'
          )
          setSaving(false)
          // Don't reset/close — leave the error visible so the user can act.
          // Still redirect on close so they can see the new suite.
          return
        }
      }

      reset()
      onClose()
      onCreated(suiteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 20, 16, 0.45)' }}
      onClick={saving ? undefined : handleClose}
    >
      <div
        className="rm-card w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: 'var(--rm-shadow-lg)' }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="rm-eyebrow">Smoke Tester</span>
            <h2 className="rm-h2 mt-1">Iniciar conversación</h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rm-btn-ghost"
            style={{ width: 32, height: 32, padding: 0, justifyContent: 'center' }}
            disabled={saving}
            aria-label="Cerrar"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {error ? (
          <div
            className="flex items-start gap-2 p-3 rounded-lg mb-4"
            style={{
              background: 'rgba(193, 79, 58, 0.08)',
              border: '1px solid rgba(193, 79, 58, 0.2)',
            }}
          >
            <AlertCircle size={14} strokeWidth={1.8} style={{ color: 'var(--rm-red)', marginTop: 2 }} />
            <p className="text-xs" style={{ color: 'var(--rm-red)' }}>{error}</p>
          </div>
        ) : null}

        <div className="space-y-4">
          <div>
            <label className="rm-label">Nombre de la prueba</label>
            <input
              type="text"
              className="rm-input"
              placeholder="Prodesa - flujo comprador inicial"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>

          <div>
            <label className="rm-label">Número destino (a quien le escribimos)</label>
            <input
              type="tel"
              className="rm-input"
              placeholder="+573103565492"
              value={targetPhone}
              onChange={(e) => setTargetPhone(e.target.value)}
              style={{ fontFamily: 'var(--rm-font-mono)' }}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
              <Target size={10} strokeWidth={1.8} style={{ display: 'inline', marginRight: 4 }} />
              WhatsApp del agente IA a probar. wzap envía desde el device configurado.
            </p>
          </div>

          <div>
            <label className="rm-label">Mensaje inicial</label>
            <textarea
              className="rm-input rm-input-textarea"
              rows={4}
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
              <MessageSquare size={10} strokeWidth={1.8} style={{ display: 'inline', marginRight: 4 }} />
              Editable. Es el primer mensaje que el "comprador" enviará al agente.
            </p>
          </div>

          {agents.length > 0 ? (
            <div>
              <label className="rm-label">Agente (opcional, solo etiqueta)</label>
              <select
                className="rm-select"
                value={agenteId}
                onChange={(e) => setAgenteId(e.target.value)}
              >
                <option value="">Sin agente — usar el primero por defecto</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre} {a.numero_whatsapp ? `· ${a.numero_whatsapp}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
                <Bot size={10} strokeWidth={1.8} style={{ display: 'inline', marginRight: 4 }} />
                Solo se usa para agrupar conversaciones, no se invoca.
              </p>
            </div>
          ) : null}

          <label
            className="flex items-center gap-2 text-xs cursor-pointer"
            style={{ color: 'var(--rm-ink-2)' }}
          >
            <input
              type="checkbox"
              checked={autoRun}
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            Enviar el mensaje inmediatamente al crear
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            type="button"
            className="rm-btn-ghost"
            onClick={handleClose}
            disabled={saving}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="rm-btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Creando…
              </>
            ) : autoRun ? (
              'Iniciar conversación'
            ) : (
              'Crear sin enviar'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
