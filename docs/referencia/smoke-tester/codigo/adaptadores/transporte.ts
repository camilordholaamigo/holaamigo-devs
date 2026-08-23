// ─── Adaptador 5 — TRANSPORTE (la costura que define todo) ─────────────────
// Reemplaza `lib/smoke-tester/wzap.ts`.
//
// El transporte es el canal por el que el comprador sintético le habla al
// agente bajo prueba. Su naturaleza —síncrono o asíncrono— decide qué tanta
// máquina necesitás:
//
//   ASÍNCRONO (WhatsApp, SMS, email, cualquier cosa con webhook)
//     mandás → devolvés → minutos después llega la respuesta por otro HTTP.
//     Requiere: motor por eventos, turn_token, settle de ráfagas, watchdogs.
//     Es lo que hace este repo.
//
//   SÍNCRONO (HTTP contra el agente, WebSocket, SDK en proceso)
//     const respuesta = await agente.enviar(texto)
//     Requiere: un for loop. Nada más.
//
// Si tu agente se puede probar por HTTP, andá por el síncrono. La mitad del
// código del smoke tester existe solo para sobrevivir al asincronismo.

// ═══════════════════════════════════════════════════════════════════════════
// A. Transporte asíncrono
// ═══════════════════════════════════════════════════════════════════════════

export interface EnvioResult {
  ok: boolean
  status: number
  body: string
  /** Id del mensaje en el proveedor, si lo devuelve. Sirve para rastrear. */
  id?: string
}

export interface TransporteAsincrono {
  /** Manda un mensaje del comprador al agente. */
  enviar(params: { phone: string; message: string }): Promise<EnvioResult>
  /**
   * Traduce el payload crudo del webhook del proveedor a algo uniforme.
   * Devolver null cuando el evento no es un mensaje entrante de texto.
   */
  parsearEntrante(raw: unknown): { fromPhone: string; text: string; fromMe: boolean } | null
}

// ─── Implementación de referencia: wzap.chat ───────────────────────────────
// (idéntica a lib/smoke-tester/wzap.ts, aquí con la interfaz explícita)

const WZAP_URL = process.env.WZAP_URL || 'https://api.wzap.chat/v1/messages'
const TIMEOUT_MS = 15_000

function formatPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return digits.startsWith('+') ? digits : `+${digits}`
}

export const transporteWzap: TransporteAsincrono = {
  async enviar({ phone, message }) {
    const token = process.env.WZAP_TOKEN
    const device = process.env.WZAP_DEVICE
    if (!token) throw new Error('WZAP_TOKEN no configurado')
    if (!device) throw new Error('WZAP_DEVICE no configurado')

    // Timeout explícito: sin AbortController un proveedor caído deja la
    // función colgada hasta el maxDuration y te come el presupuesto entero.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(WZAP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Token: token },
        body: JSON.stringify({ phone: formatPhone(phone), message, device }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const body = await res.text().catch(() => '')
    let id: string | undefined
    try {
      const json = JSON.parse(body)
      if (json && typeof json === 'object') id = json.id ?? json._id ?? undefined
    } catch {
      /* body no-JSON */
    }
    return { ok: res.ok, status: res.status, body, id }
  },

  parsearEntrante(raw) {
    // Ver lib/smoke-tester/webhook-handler.ts → parseWzapEvent(), que es la
    // versión endurecida: acepta 6 formas distintas de payload y busca el
    // texto en profundidad porque las plantillas de WhatsApp Business lo
    // esconden en message.text.body / template.body.
    const r = raw as Record<string, unknown>
    const from = (r?.from ?? r?.phone ?? '') as string
    const text = (r?.message ?? r?.body ?? r?.text ?? '') as string
    if (!from || !text) return null
    return {
      fromPhone: String(from).replace(/[^\d]/g, ''),
      text: String(text),
      fromMe: Boolean(r?.fromMe),
    }
  },
}

// ─── Otros proveedores asíncronos ──────────────────────────────────────────
//
// Callbell   POST https://api.callbell.eu/v1/messages
//            headers: Authorization: Bearer <API_KEY>
//            body: { to, from: 'whatsapp', type: 'text', content: { text } }
//            webhook: { payload: { from, text, status } }, evento
//            'message_created' con status 'received' = entrante.
//
// Twilio     POST /2010-04-01/Accounts/<SID>/Messages.json (form-encoded)
//            body: To=whatsapp:+57..., From=whatsapp:+1..., Body=texto
//            webhook: form-encoded con From / Body.
//
// Meta Cloud POST /v17.0/<PHONE_ID>/messages
//            webhook: entry[].changes[].value.messages[] — OJO: también manda
//            `statuses[]` (entregado/leído). Si no los filtrás, cada mensaje
//            propio dispara 2-3 falsos entrantes.
//
// En TODOS: descartar los ecos de mensajes propios (fromMe / status) antes de
// tocar la base. Si no, el comprador se contesta a sí mismo.

// ═══════════════════════════════════════════════════════════════════════════
// B. Transporte síncrono — el caso fácil
// ═══════════════════════════════════════════════════════════════════════════

export interface TransporteSincrono {
  /** Manda y devuelve la respuesta del agente en la misma llamada. */
  preguntar(params: {
    sessionId: string
    texto: string
  }): Promise<{ ok: boolean; respuesta: string; error?: string }>
}

/** Ejemplo: agente expuesto por HTTP (el caso típico de una API propia). */
export function transporteHttp(opts: {
  url: string
  apiKey?: string
  timeoutMs?: number
}): TransporteSincrono {
  return {
    async preguntar({ sessionId, texto }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000)
      try {
        const res = await fetch(opts.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({ session_id: sessionId, message: texto }),
          signal: controller.signal,
        })
        const body = await res.text().catch(() => '')
        if (!res.ok) {
          return { ok: false, respuesta: '', error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
        }
        let respuesta = body
        try {
          const json = JSON.parse(body)
          respuesta = json.respuesta ?? json.message ?? json.output_text ?? body
        } catch {
          /* texto plano */
        }
        return { ok: true, respuesta: String(respuesta) }
      } catch (err) {
        return {
          ok: false,
          respuesta: '',
          error: err instanceof Error ? err.message : String(err),
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ─── El motor entero, en modo síncrono ─────────────────────────────────────
// Esto REEMPLAZA conversation-engine.ts + webhook-handler.ts + el watchdog
// cuando el transporte es síncrono. Sí: son ~40 líneas contra ~900.

import { nextBuyerMessage, type BuyerPersona } from '../lib/smoke-tester/buyer-ai'
import type { ConversationEntry } from '../lib/smoke-tester/types'

export async function correrConversacionSincrona(params: {
  transporte: TransporteSincrono
  sessionId: string
  mensajeInicial: string
  objetivo: string
  persona: BuyerPersona
  contexto?: string | null
  maxTurnos?: number
  /** Se llama en cada turno para que la UI pueda mostrar el avance. */
  onTurno?: (conversation: ConversationEntry[]) => Promise<void> | void
}): Promise<{ conversation: ConversationEntry[]; motivo: string }> {
  const maxTurnos = params.maxTurnos ?? 14
  const conversation: ConversationEntry[] = []
  let texto = params.mensajeInicial

  for (let turno = 1; turno <= maxTurnos; turno++) {
    conversation.push({ role: 'buyer', text: texto, timestamp: new Date().toISOString() })
    const r = await params.transporte.preguntar({ sessionId: params.sessionId, texto })
    if (!r.ok) {
      conversation.push({
        role: 'agent',
        text: `[ERROR de transporte — ${r.error}]`,
        timestamp: new Date().toISOString(),
      })
      return { conversation, motivo: `Falló el transporte: ${r.error}` }
    }
    conversation.push({
      role: 'agent',
      text: r.respuesta,
      timestamp: new Date().toISOString(),
    })
    await params.onTurno?.(conversation)

    // Cierre por etiqueta del agente (adaptá las etiquetas a tu dominio).
    if (/#agendado|#cotizacion|#cotización/i.test(r.respuesta)) {
      return { conversation, motivo: 'El agente cerró con etiqueta' }
    }

    const siguiente = await nextBuyerMessage({
      conversation,
      objetivo: params.objetivo,
      persona: params.persona,
      contexto: params.contexto ?? null,
      turno: turno + 1,
      maxTurnos,
    })
    if (siguiente.terminar || !siguiente.mensaje) {
      return { conversation, motivo: siguiente.motivo || 'El comprador dio por terminada la conversación' }
    }
    texto = siguiente.mensaje
  }

  return { conversation, motivo: `Se alcanzó el máximo de ${maxTurnos} turnos sin cierre` }
}

// OJO con el modo síncrono en serverless: un flujo de 14 turnos × 20s por
// respuesta = ~5 min, y Vercel corta a los 300s. Si tu agente es lento,
// partilo igual en turnos disparados por un cron corto o por una cola
// (Vercel Queues / Workflow), o corré el runner fuera de serverless.
