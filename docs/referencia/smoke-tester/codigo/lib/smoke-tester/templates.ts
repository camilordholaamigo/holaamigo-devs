// ─── Smoke Tester — pre-built buyer message sequences ──────────────────────
// Each `delay` is the minimum wait (ms) AFTER the agent's response before
// sending the next buyer message. Simulates real chat pacing.

import type { SequenceMessage } from './types'

export const BUYER_FLOW_STANDARD: SequenceMessage[] = [
  { text: 'Hola, buenas tardes' },
  { text: 'Vi un apartamento de ustedes en internet, ¿todavía está disponible?', delay: 8000 },
  { text: '¿Cuánto cuesta?', delay: 10000 },
  { text: '¿Cuántas habitaciones tiene?', delay: 8000 },
  { text: '¿Tiene parqueadero?', delay: 8000 },
  { text: '¿Puedo agendar una visita para el sábado?', delay: 10000 },
]

export const BUYER_FLOW_PRICE_NEGOTIATION: SequenceMessage[] = [
  { text: 'Buenas, me interesa el proyecto {proyecto}' },
  { text: '¿Cuáles tipologías tienen disponibles?', delay: 10000 },
  { text: '¿Cuál es el más económico?', delay: 8000 },
  { text: '¿Aceptan crédito hipotecario?', delay: 8000 },
  { text: '¿Hay descuento si pago de contado?', delay: 10000 },
]

export const BUYER_FLOW_COMPARISON: SequenceMessage[] = [
  { text: 'Hola, estoy buscando apartamento de 3 habitaciones' },
  { text: '¿Qué proyectos tienen en esa zona?', delay: 10000 },
  { text: '¿Cuál me recomiendas?', delay: 10000 },
  { text: '¿Cuál tiene mejor precio por metro cuadrado?', delay: 10000 },
]

export const BUYER_FLOW_QUICK: SequenceMessage[] = [
  { text: 'Hola' },
  { text: '¿Tienen apartamentos disponibles?', delay: 6000 },
  { text: '¿Cuál es el precio?', delay: 6000 },
]

// ─── Prodesa — flujo clásico que cubre las 11 preguntas obligatorias ─────────
// Ema (agente de Prodesa) tiene un guion que exige resolver, antes de agendar
// o cotizar: proyecto, ciudad, presupuesto, vivir/inversión, subsidio (si VIS),
// habitaciones, método de pago, reportado, ingresos familiares, ahorros, y
// correo + día/hora de agendamiento o cotización.
//
// El comprador no responde pregunta-por-pregunta sino que vuelca la información
// en bloques naturales — eso refleja conversaciones reales y deja que Ema
// extraiga los datos en cualquier orden. Variable {proyecto} se rellena al
// crear la secuencia (por defecto: "Avenida Colón").
export const BUYER_FLOW_PRODESA_FULL: SequenceMessage[] = [
  { text: 'Hola, vi el proyecto {proyecto} en internet y me interesa mucho' },
  { text: 'Es para vivir, estoy buscando en Bogotá. Mi presupuesto máximo son 350 millones', delay: 10000 },
  { text: 'Quiero un apartamento de 2 habitaciones. Si es VIS, necesitaría aplicar subsidio', delay: 10000 },
  { text: 'Pagaría con crédito hipotecario, no estoy reportado en centrales de riesgo', delay: 10000 },
  { text: 'Mis ingresos familiares son de 5 millones mensuales y tengo 30 millones en ahorros y cesantías', delay: 12000 },
  { text: 'Mi correo es prueba.rentmies@gmail.com. ¿Podríamos agendar una visita el sábado a las 10 de la mañana?', delay: 12000 },
]

export interface TemplateMeta {
  id: string
  label: string
  description: string
  messages: SequenceMessage[]
}

export const TEMPLATES: TemplateMeta[] = [
  {
    id: 'standard',
    label: 'Estándar — comprador interesado',
    description: '6 mensajes · saludo, disponibilidad, precio, habitaciones, parqueadero, visita.',
    messages: BUYER_FLOW_STANDARD,
  },
  {
    id: 'price',
    label: 'Negociación de precio',
    description: '5 mensajes · tipologías, precio, financiación, descuentos.',
    messages: BUYER_FLOW_PRICE_NEGOTIATION,
  },
  {
    id: 'comparison',
    label: 'Comparación de proyectos',
    description: '4 mensajes · busca opciones en una zona y pide recomendación.',
    messages: BUYER_FLOW_COMPARISON,
  },
  {
    id: 'quick',
    label: 'Rápido — smoke test mínimo',
    description: '3 mensajes · valida solo que el agente responde y da precio.',
    messages: BUYER_FLOW_QUICK,
  },
  {
    id: 'prodesa-full',
    label: 'Prodesa — flujo completo (11 preguntas obligatorias)',
    description:
      '6 mensajes · cubre proyecto, ciudad, presupuesto, vivir/inversión, subsidio, habitaciones, método de pago, reportado, ingresos, ahorros, correo y agendamiento. Pensado para validar que Ema recoja todos los datos antes de agendar/cotizar.',
    messages: BUYER_FLOW_PRODESA_FULL,
  },
]

export function applyTemplateVariables(
  messages: SequenceMessage[],
  vars: Record<string, string>
): SequenceMessage[] {
  return messages.map((m) => ({
    ...m,
    text: m.text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`),
  }))
}
