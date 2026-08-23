'use client'

import { useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react'
import { TEMPLATES } from '@/lib/smoke-tester/templates'

interface Props {
  open: boolean
  onClose: () => void
  suiteId: string
  onCreated: (sequence: any) => void
}

type Mode = 'template' | 'custom'

export function SmokeSequenceCreateModal({ open, onClose, suiteId, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>('template')
  const [nombre, setNombre] = useState('')
  const [proyectoRef, setProyectoRef] = useState('')
  const [templateId, setTemplateId] = useState<string>('standard')
  const [customMessages, setCustomMessages] = useState<string[]>([
    'Hola, buenas tardes',
    '¿Cuánto cuesta?',
  ])
  const [fichaTecnica, setFichaTecnica] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  function reset() {
    setMode('template')
    setNombre('')
    setProyectoRef('')
    setTemplateId('standard')
    setCustomMessages(['Hola, buenas tardes', '¿Cuánto cuesta?'])
    setFichaTecnica('')
    setError(null)
    setSaving(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  function updateCustomMessage(i: number, value: string) {
    setCustomMessages((prev) => prev.map((m, idx) => (idx === i ? value : m)))
  }

  function addCustomMessage() {
    setCustomMessages((prev) => [...prev, ''])
  }

  function removeCustomMessage(i: number) {
    setCustomMessages((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function handleSave() {
    if (!nombre.trim()) {
      setError('El nombre es obligatorio')
      return
    }
    const payload: Record<string, unknown> = {
      nombre: nombre.trim(),
      proyecto_ref: proyectoRef.trim() || null,
      ficha_tecnica: fichaTecnica.trim() || null,
    }

    if (mode === 'template') {
      payload.template_id = templateId
      payload.template_vars = { proyecto: proyectoRef.trim() || nombre.trim() }
    } else {
      const cleaned = customMessages
        .map((m) => m.trim())
        .filter(Boolean)
        .map((text) => ({ text }))
      if (cleaned.length === 0) {
        setError('Agrega al menos un mensaje del comprador')
        return
      }
      payload.messages = cleaned
    }

    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/smoke-test/${suiteId}/sequences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Error al crear la secuencia')
        setSaving(false)
        return
      }
      onCreated(data.data)
      reset()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
      setSaving(false)
    }
  }

  const selectedTemplate = TEMPLATES.find((t) => t.id === templateId)

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 20, 16, 0.45)' }}
      onClick={saving ? undefined : handleClose}
    >
      <div
        className="rm-card w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: 'var(--rm-shadow-lg)' }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="rm-eyebrow">Nueva secuencia</span>
            <h2 className="rm-h2 mt-1">Configurar prueba</h2>
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
            <AlertCircle
              size={14}
              strokeWidth={1.8}
              style={{ color: 'var(--rm-red)', marginTop: 2 }}
            />
            <p className="text-xs" style={{ color: 'var(--rm-red)' }}>{error}</p>
          </div>
        ) : null}

        <div className="space-y-4">
          <div className="rm-form-grid">
            <div className="rm-field">
              <label className="rm-label">Nombre</label>
              <input
                type="text"
                className="rm-input"
                placeholder="Torres de Toberín"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
              />
            </div>
            <div className="rm-field">
              <label className="rm-label">Referencia (opcional)</label>
              <input
                type="text"
                className="rm-input"
                placeholder="Código del proyecto"
                value={proyectoRef}
                onChange={(e) => setProyectoRef(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="rm-label">Modo</label>
            <div className="rm-tab-row" style={{ width: 'fit-content' }}>
              <button
                type="button"
                className="rm-tab"
                data-active={mode === 'template'}
                onClick={() => setMode('template')}
              >
                Usar template
              </button>
              <button
                type="button"
                className="rm-tab"
                data-active={mode === 'custom'}
                onClick={() => setMode('custom')}
              >
                Mensajes personalizados
              </button>
            </div>
          </div>

          {mode === 'template' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {TEMPLATES.map((t) => {
                  const active = templateId === t.id
                  return (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => setTemplateId(t.id)}
                      className="rm-card text-left"
                      style={{
                        padding: 12,
                        cursor: 'pointer',
                        background: active ? 'rgba(64, 217, 157, 0.06)' : 'var(--rm-surface)',
                        border: `1px solid ${active ? 'var(--rm-teal)' : 'var(--rm-border)'}`,
                      }}
                    >
                      <p className="text-sm font-semibold" style={{ color: 'var(--rm-ink)' }}>
                        {t.label}
                      </p>
                      <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
                        {t.description}
                      </p>
                    </button>
                  )
                })}
              </div>
              {selectedTemplate ? (
                <div
                  className="p-3 rounded-lg"
                  style={{
                    background: 'var(--rm-surface-2)',
                    border: '1px solid var(--rm-border)',
                  }}
                >
                  <span className="rm-eyebrow">Vista previa</span>
                  <ul className="mt-2 space-y-1.5">
                    {selectedTemplate.messages.map((m, i) => (
                      <li
                        key={i}
                        className="text-xs"
                        style={{ color: 'var(--rm-ink-2)' }}
                      >
                        <span style={{ color: 'var(--rm-muted)', marginRight: 6 }}>{i + 1}.</span>
                        {m.text.replace(/\{proyecto\}/g, proyectoRef.trim() || '{proyecto}')}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="rm-label">Mensajes del comprador</label>
              {customMessages.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className="text-[11px]"
                    style={{
                      color: 'var(--rm-muted)',
                      width: 24,
                      fontFamily: 'var(--rm-font-mono)',
                    }}
                  >
                    {i + 1}.
                  </span>
                  <input
                    type="text"
                    className="rm-input"
                    value={m}
                    onChange={(e) => updateCustomMessage(i, e.target.value)}
                    placeholder={`Mensaje ${i + 1}`}
                  />
                  {customMessages.length > 1 ? (
                    <button
                      type="button"
                      className="rm-icon-btn"
                      onClick={() => removeCustomMessage(i)}
                      aria-label="Eliminar mensaje"
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="rm-btn-ghost"
                onClick={addCustomMessage}
              >
                <Plus size={13} strokeWidth={1.8} /> Agregar mensaje
              </button>
            </div>
          )}

          <div>
            <label className="rm-label">Ficha técnica (datos reales del proyecto)</label>
            <textarea
              className="rm-input rm-input-textarea"
              rows={6}
              placeholder={`Ej:\nCódigo: TT-2026\nUbicación: Cra 15 #128, Bogotá\nPrecio: COP 580.000.000\nHabitaciones: 3 · Baños: 2 · Parqueaderos: 1\nÁrea: 78 m² · Estrato: 5\n...`}
              value={fichaTecnica}
              onChange={(e) => setFichaTecnica(e.target.value)}
              style={{ fontFamily: 'var(--rm-font-mono)', fontSize: 11 }}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
              El evaluador IA usará esto como verdad de referencia. Si lo dejas vacío, solo medirá tono y completitud.
            </p>
          </div>
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
                <Loader2 size={13} className="animate-spin" /> Guardando…
              </>
            ) : (
              'Crear secuencia'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
