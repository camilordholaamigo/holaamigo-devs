'use client'

import { useState } from 'react'
import { X, Loader2, AlertCircle, Sparkles, User, Target } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  suiteId: string
  /** Primer mensaje de la secuencia, usado como arranque por defecto. */
  defaultMensajeInicial?: string
  onStarted: (runId: string) => void
}

const DEFAULT_OBJETIVO =
  'Conocer el proyecto, sus precios y condiciones, y terminar agendando una visita a la sala de ventas con fecha y hora.'

export function SmokeAutonomousRunModal({
  open,
  onClose,
  suiteId,
  defaultMensajeInicial,
  onStarted,
}: Props) {
  const [objetivo, setObjetivo] = useState(DEFAULT_OBJETIVO)
  const [mensajeInicial, setMensajeInicial] = useState(defaultMensajeInicial || '')
  const [nombre, setNombre] = useState('Camila Restrepo')
  const [correo, setCorreo] = useState('camila.restrepo.pruebas@gmail.com')
  const [telefono, setTelefono] = useState('3001234567')
  const [presupuesto, setPresupuesto] = useState('250 millones')
  const [ciudad, setCiudad] = useState('Bogotá')
  const [maxTurnos, setMaxTurnos] = useState(14)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  async function handleStart() {
    if (!objetivo.trim()) {
      setError('Escribe el objetivo del comprador')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/smoke-test/${suiteId}/run-auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objetivo: objetivo.trim(),
          mensaje_inicial: mensajeInicial.trim() || undefined,
          max_turnos: maxTurnos,
          persona: {
            nombre: nombre.trim(),
            correo: correo.trim(),
            telefono: telefono.trim(),
            ciudad: ciudad.trim() || null,
            presupuesto: presupuesto.trim() || null,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No se pudo iniciar el flujo completo')
        setSaving(false)
        return
      }
      setSaving(false)
      onClose()
      onStarted(data.run_id as string)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 20, 16, 0.45)' }}
      onClick={saving ? undefined : onClose}
    >
      <div
        className="rm-card w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: 'var(--rm-shadow-lg)', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="rm-eyebrow">Smoke Tester</span>
            <h2 className="rm-h2 mt-1">Flujo completo</h2>
            <p className="text-xs mt-1" style={{ color: 'var(--rm-muted)' }}>
              Un comprador IA conversa con el agente hasta cerrar: contesta lo que le
              pregunten, entrega sus datos y empuja hacia el objetivo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
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
          <div>
            <label
              className="rm-eyebrow flex items-center gap-1.5"
              style={{ marginBottom: 6 }}
            >
              <Target size={11} strokeWidth={2} /> Objetivo del comprador
            </label>
            <textarea
              className="rm-input"
              rows={3}
              value={objetivo}
              onChange={(e) => setObjetivo(e.target.value)}
              disabled={saving}
              style={{ resize: 'vertical' }}
            />
          </div>

          <div>
            <label className="rm-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Mensaje de arranque
            </label>
            <input
              className="rm-input"
              value={mensajeInicial}
              onChange={(e) => setMensajeInicial(e.target.value)}
              placeholder={defaultMensajeInicial || 'Hola, quiero información…'}
              disabled={saving}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
              Si lo dejas vacío se usa el primer mensaje de la secuencia.
            </p>
          </div>

          <div>
            <label
              className="rm-eyebrow flex items-center gap-1.5"
              style={{ marginBottom: 6 }}
            >
              <User size={11} strokeWidth={2} /> Identidad del comprador
            </label>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="rm-input"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Nombre y apellido"
                disabled={saving}
              />
              <input
                className="rm-input"
                value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="Correo"
                disabled={saving}
              />
              <input
                className="rm-input"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="Celular"
                disabled={saving}
              />
              <input
                className="rm-input"
                value={ciudad}
                onChange={(e) => setCiudad(e.target.value)}
                placeholder="Ciudad"
                disabled={saving}
              />
              <input
                className="rm-input"
                value={presupuesto}
                onChange={(e) => setPresupuesto(e.target.value)}
                placeholder="Presupuesto"
                disabled={saving}
              />
              <input
                className="rm-input"
                type="number"
                min={2}
                max={40}
                value={maxTurnos}
                onChange={(e) => setMaxTurnos(Number(e.target.value) || 14)}
                placeholder="Máx. turnos"
                disabled={saving}
              />
            </div>
            <p className="text-[11px] mt-1" style={{ color: 'var(--rm-muted)' }}>
              Estos datos son los que el comprador entregará cuando el agente los pida.
              El último campo es el tope de mensajes antes de cortar.
            </p>
          </div>

          <div
            className="p-3 rounded-lg text-[11px]"
            style={{
              background: 'var(--rm-surface-2)',
              border: '1px solid var(--rm-border)',
              color: 'var(--rm-ink-2)',
            }}
          >
            La conversación se cierra sola cuando el agente responde{' '}
            <span style={{ fontFamily: 'var(--rm-font-mono)' }}>#agendado</span> o{' '}
            <span style={{ fontFamily: 'var(--rm-font-mono)' }}>#cotizacion</span>,
            cuando el comprador considera cumplido el objetivo, al llegar al tope de
            turnos, o si el agente deja de responder por 8 minutos.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button type="button" className="rm-btn-ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            className="rm-btn-primary"
            onClick={handleStart}
            disabled={saving}
          >
            {saving ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Iniciando…
              </>
            ) : (
              <>
                <Sparkles size={13} strokeWidth={2} /> Iniciar flujo completo
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
