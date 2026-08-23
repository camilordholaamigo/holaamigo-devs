// ─── Smoke Tester — comprador IA ────────────────────────────────────────────
// El problema que resuelve: una secuencia guionada se queda muda apenas el
// agente pregunta algo que el guion no anticipó ("confírmame tu correo,
// nombre y apellido"). Con el guion agotado el run se marca 'completed' y el
// flujo real —política de datos → identificación → proyecto → presupuesto →
// agendamiento— nunca llega a probarse.
//
// Aquí vive el otro lado de la conversación: un comprador sintético que LEE
// lo que el agente acaba de decir y contesta como contestaría una persona,
// con datos consistentes (mismo nombre y correo toda la conversación) y un
// objetivo (agendar visita / pedir cotización). Decide también CUÁNDO parar.
//
// Sin OPENAI_API_KEY el módulo no explota: cae a un comprador heurístico que
// reconoce las preguntas típicas (correo, nombre, presupuesto, ciudad) y
// empuja hacia el objetivo. Peor conversación, mismo flujo completo.

import { callResponses } from '../agent-openai/responses-client'
import { logger } from '../logger'
import type { ConversationEntry } from './types'

export interface BuyerPersona {
  nombre: string
  correo: string
  telefono: string
  ciudad?: string | null
  presupuesto?: string | null
  notas?: string | null
}

export interface BuyerTurn {
  mensaje: string
  terminar: boolean
  motivo: string
  fuente: 'ia' | 'heuristica'
}

export interface NextBuyerMessageParams {
  conversation: ConversationEntry[]
  objetivo: string
  persona: BuyerPersona
  /** Ficha técnica / contexto del proyecto, si la suite lo tiene cargado. */
  contexto?: string | null
  turno: number
  maxTurnos: number
  empresaId?: string | null
  agenteIaId?: string | null
}

const MODEL = process.env.SMOKE_BUYER_MODEL || 'gpt-4o-mini'
const MAX_TRANSCRIPT_ENTRIES = 40

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['mensaje', 'terminar', 'motivo'],
  properties: {
    mensaje: {
      type: 'string',
      description:
        'El siguiente mensaje del comprador, tal cual lo escribiría por WhatsApp. Vacío solo si terminar es true.',
    },
    terminar: {
      type: 'boolean',
      description: 'true cuando la conversación ya cumplió el objetivo o el agente la cerró.',
    },
    motivo: {
      type: 'string',
      description: 'Una frase corta explicando por qué sigue o por qué termina.',
    },
  },
}

function buildInstructions(params: NextBuyerMessageParams): string {
  const p = params.persona
  const extra = [
    p.ciudad ? `- Ciudad: ${p.ciudad}` : null,
    p.presupuesto ? `- Presupuesto: ${p.presupuesto}` : null,
    p.notas ? `- Contexto adicional: ${p.notas}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const contexto = params.contexto
    ? `LO QUE SABES DEL PROYECTO (no se lo recites al asesor, solo úsalo para preguntar cosas coherentes):\n${params.contexto}\n\n`
    : ''

  return [
    'Eres una PERSONA REAL buscando vivienda en Colombia y estás escribiendo por WhatsApp a un asesor inmobiliario. NO eres un asistente, no eres una IA y jamás mencionas que esto es una prueba.',
    '',
    'TU IDENTIDAD (úsala siempre igual, nunca la cambies ni la inventes de nuevo):',
    `- Nombre completo: ${p.nombre}`,
    `- Correo: ${p.correo}`,
    `- Celular: ${p.telefono}`,
    extra,
    '',
    'TU OBJETIVO EN ESTA CONVERSACIÓN:',
    params.objetivo,
    '',
    contexto + 'CÓMO ESCRIBES:',
    '- Mensajes cortos, de 1 a 2 frases, en español colombiano natural. Nada de listas ni markdown.',
    '- SIEMPRE respondes primero lo último que te preguntaron. Si te piden el correo, das el correo. Si te piden autorizar el tratamiento de datos, aceptas. Si te piden nombre y apellido, los das completos.',
    '- Si te preguntan varias cosas a la vez, contéstalas todas en el mismo mensaje.',
    '- Después de contestar, empujas hacia tu objetivo (preguntas precios, área, cuota inicial, disponibilidad, o pides la visita).',
    '- No repitas tu mensaje anterior. Si el asesor no entendió, reformula.',
    '- Nunca inventes que ya diste un dato: revisa el historial.',
    '',
    'CUÁNDO TERMINAR (terminar = true):',
    '- El asesor confirmó la cita o visita con fecha y hora, o dijo que ya envió la cotización.',
    '- El asesor cerró con una etiqueta de cierre (#agendado, #cotizacion).',
    '- El asesor te dijo que un humano te contactará y ya no hay nada más que hacer.',
    `- Vas en el turno ${params.turno} de máximo ${params.maxTurnos} y la conversación se está repitiendo en círculos.`,
    'En cualquier otro caso terminar = false y mandas el siguiente mensaje.',
    '',
    'Devuelve únicamente el JSON pedido.',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

function formatTranscript(conversation: ConversationEntry[]): string {
  const recent = conversation.slice(-MAX_TRANSCRIPT_ENTRIES)
  if (recent.length === 0) return '(la conversación aún no empieza)'
  return recent
    .map((m) => `${m.role === 'buyer' ? 'TÚ' : 'ASESOR'}: ${m.text}`)
    .join('\n\n')
}

// ─── Comprador heurístico (sin OPENAI_API_KEY o si OpenAI falla) ───────────

const LADDER = [
  '¿Qué precios manejan y desde cuánto está la cuota inicial?',
  '¿Cuántos metros cuadrados tiene y cuántas habitaciones?',
  '¿En qué zona queda exactamente y cuándo entregan?',
  '¿Aplica subsidio o crédito hipotecario? ¿Con qué bancos trabajan?',
  'Me interesa. ¿Podemos agendar una visita a la sala de ventas?',
  'Perfecto, ¿qué día y a qué hora tienen disponible?',
]

function heuristicTurn(params: NextBuyerMessageParams): BuyerTurn {
  const lastAgent = [...params.conversation].reverse().find((c) => c.role === 'agent')
  const t = (lastAgent?.text || '').toLowerCase()
  const p = params.persona

  if (/#agendado|#cotizacion|#cotización/.test(t)) {
    return {
      mensaje: '',
      terminar: true,
      motivo: 'El asesor cerró con etiqueta',
      fuente: 'heuristica',
    }
  }

  const pide: string[] = []
  if (/correo|email|e-mail/.test(t)) pide.push(p.correo)
  if (/nombre|apellido/.test(t)) pide.push(p.nombre)
  if (/celular|tel[eé]fono|whatsapp|n[uú]mero de contacto/.test(t)) pide.push(p.telefono)
  if (/presupuesto|rango de precio/.test(t) && p.presupuesto) {
    pide.push(`mi presupuesto es de ${p.presupuesto}`)
  }
  if (/ciudad/.test(t) && p.ciudad) pide.push(p.ciudad)

  if (pide.length > 0) {
    const acepta = /tratamiento de datos|pol[ií]tica|autoriz/.test(t) ? 'Sí, acepto. ' : ''
    return {
      mensaje: `${acepta}${pide.join(', ')}`,
      terminar: false,
      motivo: 'El asesor pidió datos personales',
      fuente: 'heuristica',
    }
  }

  if (/tratamiento de datos|pol[ií]tica de datos|autoriz/.test(t)) {
    return {
      mensaje: `Sí, autorizo. Mi nombre es ${p.nombre} y mi correo es ${p.correo}.`,
      terminar: false,
      motivo: 'Autorización de tratamiento de datos',
      fuente: 'heuristica',
    }
  }

  const idx = Math.min(Math.max(params.turno - 1, 0), LADDER.length - 1)
  return {
    mensaje: LADDER[idx],
    terminar: params.turno > LADDER.length,
    motivo: 'Escalera heurística de comprador',
    fuente: 'heuristica',
  }
}

// ─── Punto de entrada ──────────────────────────────────────────────────────

export async function nextBuyerMessage(
  params: NextBuyerMessageParams
): Promise<BuyerTurn> {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('smoke-buyer', 'sin OPENAI_API_KEY — usando comprador heurístico')
    return heuristicTurn(params)
  }

  try {
    const result = await callResponses({
      model: MODEL,
      instructions: buildInstructions(params),
      input: `Conversación hasta ahora (turno ${params.turno} de ${params.maxTurnos}):\n\n${formatTranscript(
        params.conversation
      )}\n\nEscribe tu siguiente mensaje.`,
      store: false,
      temperature: 0.4,
      max_output_tokens: 500,
      text: {
        format: {
          type: 'json_schema',
          name: 'buyer_turn',
          strict: true,
          schema: SCHEMA,
        },
      },
      track: {
        fuente: 'desconocida',
        etapa: 'otro',
        empresa_id: params.empresaId ?? null,
        agente_ia_id: params.agenteIaId ?? null,
      },
    })

    const raw = (result.output_text || '').trim()
    if (!raw) throw new Error('respuesta vacía del comprador IA')
    const parsed = JSON.parse(raw) as {
      mensaje?: unknown
      terminar?: unknown
      motivo?: unknown
    }
    const mensaje = typeof parsed.mensaje === 'string' ? parsed.mensaje.trim() : ''
    const terminar = parsed.terminar === true
    if (!terminar && !mensaje) {
      throw new Error('el comprador IA no devolvió mensaje ni terminó')
    }
    return {
      mensaje,
      terminar,
      motivo: typeof parsed.motivo === 'string' ? parsed.motivo : '',
      fuente: 'ia',
    }
  } catch (err) {
    logger.warn('smoke-buyer', 'comprador IA falló — cayendo a heurística', {
      context: { error: err instanceof Error ? err.message : String(err) },
    })
    return heuristicTurn(params)
  }
}
