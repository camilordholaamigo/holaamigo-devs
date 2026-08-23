// ─── Smoke Tester — Prodesa buyer sequence generator ──────────────────────
// Builds the buyer's reply sequence for the 10-step Prodesa template flow.
// Replies are dynamic per project so the conversation makes sense:
//   • Median subtipo price → buyer's stated budget
//   • First subtipo name   → buyer's "TIPO of interest"
//   • VIS branching        → adds the 2 extra steps about subsidio/método
//
// The sequence ASSUMES the agent's first message is the WhatsApp template,
// already received and appended to the conversation by webhook-handler.ts.
// The first entry below is the buyer's reply to that template.

import type { ProdesaProject, SequenceMessage } from './types'

// Inter-message delay in ms. The runner caps custom delays at 30s anyway, so
// these are tuned to give EMA breathing room without padding the total run.
const DELAY_AFTER_TEMPLATE = 30_000
const DELAY_DEFAULT = 45_000

export function generateProdesaSequence(project: ProdesaProject): SequenceMessage[] {
  const isVIS = project.categoria === 'VIS' || project.categoria === 'VIS Renovación'
  const ciudad = project.ciudad || extractCiudad(project.ubicacion)
  const budgetText = formatBudget(pickBudget(project))
  const targetSubtipo = pickTargetSubtipo(project)

  const sequence: SequenceMessage[] = [
    // Step 1 reply — after the template arrives, buyer confirms interest
    {
      text: `Hola, sí me interesa conocer más sobre ${project.nombre_proyecto}`,
      delay: DELAY_AFTER_TEMPLATE,
    },

    // Step 2 reply — confirms the city
    {
      text: `Sí, estoy buscando en ${ciudad}`,
      delay: DELAY_DEFAULT,
    },

    // Step 3 reply — gives a concrete budget
    {
      text: `Mi presupuesto es de ${budgetText}`,
      delay: DELAY_DEFAULT,
    },

    // Step 4 reply — picks a subtipo + states intent (vivir/invertir)
    {
      text: `Me gusta el ${targetSubtipo}. Lo busco para vivir`,
      delay: DELAY_DEFAULT,
    },
  ]

  // VIS branch — Step 5 + 5b (payment + subsidio)
  if (isVIS) {
    sequence.push({
      text: 'Voy a pagar con crédito hipotecario y sí cuento con subsidio',
      delay: DELAY_DEFAULT,
    })
    sequence.push({
      text: 'El subsidio ya está aprobado',
      delay: DELAY_DEFAULT,
    })
  } else {
    sequence.push({
      text: 'Voy a pagar con crédito hipotecario',
      delay: DELAY_DEFAULT,
    })
  }

  // Step 6 — centrales de riesgo
  sequence.push({
    text: 'No, no estoy reportado en centrales de riesgo',
    delay: DELAY_DEFAULT,
  })

  // Step 7 — ingresos
  sequence.push({
    text: 'Mis ingresos mensuales son de 8 millones de pesos',
    delay: DELAY_DEFAULT,
  })

  // Step 8 — ahorros / cesantías
  sequence.push({
    text: 'Sí, planeo usar ahorros y tengo 30 millones en cesantías',
    delay: DELAY_DEFAULT,
  })

  // Step 9 — pide cotización
  sequence.push({
    text: 'Sí, por favor envíame la cotización personalizada',
    delay: DELAY_DEFAULT,
  })

  return sequence
}

// ─── helpers ───────────────────────────────────────────────────────────────

function pickBudget(project: ProdesaProject): number {
  const subPrices = (project.subtipos || [])
    .map((s) => s.price)
    .filter((p): p is number => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b)

  if (subPrices.length > 0) {
    return subPrices[Math.floor(subPrices.length / 2)]
  }
  if (project.precio_desde && project.precio_desde > 0) return project.precio_desde
  if (project.precio_min && project.precio_max) {
    return Math.round((project.precio_min + project.precio_max) / 2)
  }
  if (project.precio_min) return project.precio_min
  // Conservative default ($250M) so the budget message never ends up empty.
  return 250_000_000
}

function pickTargetSubtipo(project: ProdesaProject): string {
  const first = project.subtipos?.[0]?.name
  if (first && first.trim()) return first.trim()
  return 'TIPO A'
}

function formatBudget(amount: number): string {
  // "$300 millones" reads more naturally than "$300,000,000" in Spanish chat.
  const millones = Math.round(amount / 1_000_000)
  return `${millones} millones`
}

function extractCiudad(ubicacion: string | null): string {
  if (!ubicacion) return 'Bogotá'
  // Handles "BOGOTA - AVENIDA COLON" → "Bogotá"
  const first = ubicacion.split('-')[0].trim().toUpperCase()
  const map: Record<string, string> = {
    BOGOTA: 'Bogotá',
    'BOGOTÁ': 'Bogotá',
    SOACHA: 'Soacha',
    MOSQUERA: 'Mosquera',
    MEDELLIN: 'Medellín',
    'MEDELLÍN': 'Medellín',
    CALI: 'Cali',
    BARRANQUILLA: 'Barranquilla',
    CARTAGENA: 'Cartagena',
    BUCARAMANGA: 'Bucaramanga',
    CHIA: 'Chía',
    'CHÍA': 'Chía',
  }
  return map[first] || titleCase(first)
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}
