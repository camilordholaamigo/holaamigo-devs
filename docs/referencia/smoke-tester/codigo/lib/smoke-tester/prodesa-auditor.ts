// ─── Smoke Tester — Prodesa 10-step deterministic auditor ─────────────────
// Audits a complete form-triggered conversation against the 10-step Prodesa
// playbook. 100% rule-based: regex + string checks, NO LLM calls. The LLM
// evaluator (lib/smoke-tester/evaluator.ts) handles tone/nuance separately.
//
// Mapping strategy:
//   conversation = [agent_template, buyer_1, agent_block_1, buyer_2, agent_block_2, ...]
//   The agent's response to the i-th buyer reply is the agent text BETWEEN
//   buyer[i] and buyer[i+1]. We identify the "step" of each agent block by
//   pattern-matching its content against step-specific keywords (CTA phrasing,
//   terminal tags, etc). This means the auditor is robust to:
//     • VIS vs NO VIS branching (NO VIS skips Step 5)
//     • Agent burst chunks (multiple ConversationEntry per logical block)
//     • Reordering / missing steps

import type {
  ConversationEntry,
  ProdesaAuditResult,
  ProdesaProject,
  StepAudit,
  ClosedWith,
} from './types'

export const PRODESA_STEP_TITLES: Record<number, string> = {
  1: 'Bienvenida + info Ciudadela + #ID + CTA ¿buscas en X?',
  2: 'Info del proyecto + #ID + CTA presupuesto',
  3: 'Subtipos con BREAK + #ID por subtipo + CTA dual',
  4: 'Respuesta empática a TIPO elegido + intent',
  5: 'Subsidio aprobado o en proceso (solo VIS)',
  6: 'Reporte en centrales de riesgo',
  7: 'Ingreso mensual',
  8: 'Ahorros / cesantías',
  9: 'Oferta de cotización antes de cerrar',
  10: 'Cierre con #agendado o #cotizacion',
}

// ─── Public API ───────────────────────────────────────────────────────────

export function auditProdesaConversation(
  conversation: ConversationEntry[],
  project: ProdesaProject
): ProdesaAuditResult {
  const blocks = splitAgentBlocks(conversation)
  // blocks[0] is the agent text BEFORE the first buyer message (= the template).
  // We tag it for later but it's NOT step 1's audited message.
  const template = blocks[0] || ''
  const responseBlocks = blocks.slice(1)
  const isVIS = project.categoria === 'VIS' || project.categoria === 'VIS Renovación'

  // Map response blocks to steps by content. This handles VIS branching
  // (which has an extra step) and missing steps gracefully.
  const stepBlocks = mapBlocksToSteps(responseBlocks, isVIS)

  const steps: StepAudit[] = [
    auditStep1(stepBlocks[1] ?? '', project, template),
    auditStep2(stepBlocks[2] ?? '', project),
    auditStep3(stepBlocks[3] ?? '', project),
    auditStep4(stepBlocks[4] ?? '', project),
    auditStep5(stepBlocks[5] ?? '', project, isVIS),
    auditStep6(stepBlocks[6] ?? ''),
    auditStep7(stepBlocks[7] ?? ''),
    auditStep8(stepBlocks[8] ?? ''),
    auditStep9(stepBlocks[9] ?? ''),
    auditStep10(stepBlocks[10] ?? '', responseBlocks),
  ]

  const critical_count = steps.reduce((s, st) => s + st.critical_errors.length, 0)
  const warning_count = steps.reduce((s, st) => s + st.warning_errors.length, 0)
  const passedCount = steps.filter((s) => s.passed).length

  // Score = base from passed steps − penalties.
  const score =
    Math.round((passedCount / steps.length) * 100) -
    critical_count * 10 -
    warning_count * 3
  const overall_score = Math.max(0, Math.min(100, score))

  const closed_with = detectClosedWith(responseBlocks)

  return {
    steps,
    critical_count,
    warning_count,
    overall_score,
    flow_complete: closed_with === 'agendado' || closed_with === 'cotizacion',
    closed_with,
    agent_message_count: conversation.filter((m) => m.role === 'agent').length,
    buyer_message_count: conversation.filter((m) => m.role === 'buyer').length,
    audited_at: new Date().toISOString(),
  }
}

// ─── Closed-with detection (also used by runner for early termination) ────

const TERMINAL_TAGS = ['#agendado', '#cotizacion', '#cotización'] as const

export function detectTerminalTag(text: string): ClosedWith | null {
  const t = text.toLowerCase()
  if (t.includes('#agendado')) return 'agendado'
  if (t.includes('#cotizacion') || t.includes('#cotización')) return 'cotizacion'
  return null
}

function detectClosedWith(responseBlocks: string[]): ClosedWith {
  // Scan from the latest block backward; the closing tag is usually in the
  // very last agent message, but the auditor is forgiving.
  for (let i = responseBlocks.length - 1; i >= 0; i--) {
    const tag = detectTerminalTag(responseBlocks[i])
    if (tag) return tag
  }
  return 'incomplete'
}

// ─── Conversation slicing ─────────────────────────────────────────────────

/**
 * Split a conversation into agent text blocks separated by buyer messages.
 * Returns an array where blocks[0] is the agent text before the FIRST buyer
 * message (i.e. the template) and blocks[i] (i>=1) is the agent text BETWEEN
 * buyer[i-1] and buyer[i] (or after buyer[i-1] if it's the last).
 *
 * Burst chunks within a block are concatenated with double newline.
 */
function splitAgentBlocks(conv: ConversationEntry[]): string[] {
  const blocks: string[] = []
  let cursor = 0
  // Block 0: agent text up to the first buyer message.
  let i = 0
  while (i < conv.length && conv[i].role !== 'buyer') i++
  blocks.push(joinAgent(conv.slice(0, i)))
  cursor = i

  // For each buyer message, the next block is the agent text up to the
  // next buyer message.
  while (cursor < conv.length) {
    cursor++ // skip the buyer message itself
    let next = cursor
    while (next < conv.length && conv[next].role !== 'buyer') next++
    blocks.push(joinAgent(conv.slice(cursor, next)))
    cursor = next
  }

  return blocks
}

function joinAgent(slice: ConversationEntry[]): string {
  return slice
    .filter((m) => m.role === 'agent')
    .map((m) => m.text)
    .join('\n\n')
}

/**
 * Map response blocks (in order) to step numbers 1..10.
 * Returns a record keyed by step number → block text.
 *
 * The order in which the agent replies should be:
 *   block 1 → Step 1 (welcome)
 *   block 2 → Step 2 (project info)
 *   block 3 → Step 3 (subtipos with BREAK)
 *   block 4 → Step 4 (empathic response)
 *   block 5 (VIS only) → Step 5 (subsidio)
 *   block N → Step 6 (centrales de riesgo)
 *   block N+1 → Step 7 (ingresos)
 *   block N+2 → Step 8 (ahorros)
 *   block N+3 → Step 9 (cotización)
 *   block N+4 → Step 10 (closing with tag)
 *
 * For NO VIS, block 5 maps to Step 6, block 6 to Step 7, etc.
 */
function mapBlocksToSteps(
  responseBlocks: string[],
  isVIS: boolean
): Record<number, string> {
  const map: Record<number, string> = {}
  const stepOrder = isVIS
    ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    : [1, 2, 3, 4, 6, 7, 8, 9, 10]

  for (let i = 0; i < responseBlocks.length && i < stepOrder.length; i++) {
    map[stepOrder[i]] = responseBlocks[i]
  }
  return map
}

// ─── Per-step audit functions ─────────────────────────────────────────────

function auditStep1(
  text: string,
  project: ProdesaProject,
  template: string
): StepAudit {
  // Step 1 expects: welcome + Ciudadela info + #ID del Ciudadela + CTA "¿Estás buscando proyectos en X?"
  // Forbidden: "Mi Casa Ya", premature subtipos, premature precios.
  const ciudadelaId = project.ciudadela_id || ''
  const has_id = ciudadelaId
    ? text.includes(ciudadelaId)
    : /#ID\s*\d+/i.test(text)
  const has_cta = /¿estás buscando proyectos en/i.test(text)
  const has_mi_casa_ya = /mi casa ya/i.test(text)
  const has_subtipos = /\bsubtipo\b|\btipo\s+a\b|\btipo\s+b\b|\btipo\s+1\b/i.test(text)
  const has_precio = hasExplicitPrice(text)
  const word_count = countWords(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 1 ausente: el agente no respondió al primer mensaje del buyer.')
  } else {
    if (has_mi_casa_ya) critical.push('Menciona "Mi Casa Ya" (PROHIBIDO).')
    if (!has_id) critical.push('Falta #ID válido de la Ciudadela.')
    if (!has_cta) critical.push('CTA del Paso 1 incorrecto o ausente: "¿Estás buscando proyectos en X?".')
    if (has_subtipos) warnings.push('Menciona subtipos prematuramente.')
    if (has_precio) warnings.push('Menciona precios prematuramente.')
    if (word_count > 85) warnings.push(`Excede 85 palabras (${word_count}).`)
  }

  return {
    step: 1,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      template_received: !!template,
      has_ciudadela_id: has_id,
      has_cta: has_cta,
      no_mi_casa_ya: !has_mi_casa_ya,
      no_premature_subtipos: !has_subtipos,
      no_premature_price: !has_precio,
      under_85_words: word_count <= 85,
    },
  }
}

function auditStep2(text: string, project: ProdesaProject): StepAudit {
  // Step 2: project info (10 fields) + #ID del proyecto + CTA "Confirmame tu presupuesto"
  // Forbidden: subtipos still, "Mi Casa Ya".
  const projectId = project.proyecto_id || ''
  const has_proyecto_id = projectId
    ? text.includes(projectId)
    : /#ID\s*\d+/i.test(text)
  const has_cta = /confirma(?:me)?\s+tu\s+presupuesto|presupuesto\s+aproximado/i.test(text)
  const has_mi_casa_ya = /mi casa ya/i.test(text)
  const has_subtipos = /\bsubtipo\b|\btipo\s+a\b|\btipo\s+b\b/i.test(text)
  const mentions_project = project.nombre_proyecto
    ? text.toLowerCase().includes(project.nombre_proyecto.toLowerCase())
    : true

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 2 ausente: el agente no respondió tras la confirmación de ciudad.')
  } else {
    if (has_mi_casa_ya) critical.push('Menciona "Mi Casa Ya" (PROHIBIDO).')
    if (!has_proyecto_id) warnings.push('Falta #ID del proyecto en el Paso 2.')
    if (!has_cta) critical.push('CTA del Paso 2 ausente: solicitud de presupuesto.')
    if (has_subtipos) warnings.push('Menciona subtipos prematuramente (esto va en Paso 3).')
    if (!mentions_project) warnings.push(`No menciona el nombre del proyecto (${project.nombre_proyecto}).`)
  }

  return {
    step: 2,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      has_proyecto_id,
      has_cta_presupuesto: has_cta,
      no_mi_casa_ya: !has_mi_casa_ya,
      mentions_project: mentions_project,
      no_premature_subtipos: !has_subtipos,
    },
  }
}

function auditStep3(text: string, project: ProdesaProject): StepAudit {
  // Step 3: subtipos del proyecto que se ajustan al presupuesto, separados
  // por BREAK, cada uno con su #ID + CTA dual.
  const breaks = (text.match(/BREAK/g) || []).length
  const ids = text.match(/#ID\s*\d+/gi) || []
  const has_cta_dual =
    /apartamento\s+que\s+(te|le)\s+(haya|haya)\s+gustado/i.test(text) ||
    /(nuevo\s+hogar|inversi[oó]n)/i.test(text)
  const has_mi_casa_ya = /mi casa ya/i.test(text)

  const expectedSubtipos = (project.subtipos?.length || 0)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 3 ausente: el agente no envió los subtipos.')
  } else {
    if (has_mi_casa_ya) critical.push('Menciona "Mi Casa Ya" (PROHIBIDO).')
    if (breaks === 0 && expectedSubtipos > 1) {
      critical.push('Falta separador BREAK entre subtipos.')
    }
    if (!has_cta_dual) critical.push('CTA dual ausente (nuevo hogar / inversión).')
    if (ids.length === 0) warnings.push('No se detectó ningún #ID en los subtipos.')
    if (expectedSubtipos > 0 && ids.length < expectedSubtipos) {
      warnings.push(
        `Menos #ID (${ids.length}) que subtipos esperados (${expectedSubtipos}).`
      )
    }
  }

  return {
    step: 3,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      has_break: breaks > 0,
      ids_count_ok: ids.length >= Math.max(1, expectedSubtipos),
      has_cta_dual,
      no_mi_casa_ya: !has_mi_casa_ya,
    },
  }
}

function auditStep4(text: string, _project: ProdesaProject): StepAudit {
  // Step 4: respuesta empática + CTA según VIS/NO VIS. Forbidden: repeated
  // info, #ID nuevo, "Mi Casa Ya".
  const has_mi_casa_ya = /mi casa ya/i.test(text)
  const has_id = /#ID\s*\d+/i.test(text)
  const has_empathy = /(gusto|excelente|gran\s+elecci[oó]n|perfecto|me\s+alegra|qu[eé]\s+bueno)/i.test(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 4 ausente: el agente no respondió al subtipo elegido.')
  } else {
    if (has_mi_casa_ya) critical.push('Menciona "Mi Casa Ya" (PROHIBIDO).')
    if (has_id) warnings.push('Repite #ID innecesariamente en Paso 4.')
    if (!has_empathy) warnings.push('Falta tono empático en la respuesta.')
  }

  return {
    step: 4,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      has_empathy,
      no_repeated_id: !has_id,
      no_mi_casa_ya: !has_mi_casa_ya,
    },
  }
}

function auditStep5(
  text: string,
  _project: ProdesaProject,
  isVIS: boolean
): StepAudit {
  // Step 5 ONLY for VIS: "¿Subsidio aprobado o en proceso?"
  // For NO VIS, this step doesn't apply — mark detected=false, passed=true.
  if (!isVIS) {
    return {
      step: 5,
      detected: false,
      agent_message_text: null,
      passed: true,
      critical_errors: [],
      warning_errors: [],
      validations: { not_applicable_no_vis: true },
    }
  }

  const has_subsidio_q = /subsidio\s+(aprobado|en\s+proceso|tienes|cuentas)/i.test(text)
  const has_mi_casa_ya = /mi casa ya/i.test(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 5 ausente: en proyectos VIS debe preguntar por subsidio.')
  } else {
    if (has_mi_casa_ya) critical.push('Menciona "Mi Casa Ya" (PROHIBIDO).')
    if (!has_subsidio_q) critical.push('No pregunta sobre el subsidio (aprobado o en proceso).')
  }

  return {
    step: 5,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      asks_subsidio: has_subsidio_q,
      no_mi_casa_ya: !has_mi_casa_ya,
    },
  }
}

function auditStep6(text: string): StepAudit {
  // Step 6: pregunta sobre centrales de riesgo. OBLIGATORIO antes de cerrar.
  const has_centrales =
    /centrales?\s+de\s+riesgo|datacr[eé]dito|reportad[oa]s?\s+(en|a)|reporte\s+(en|a)\s+centrales/i.test(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 6 ausente: pregunta de centrales de riesgo es OBLIGATORIA.')
  } else {
    if (!has_centrales) critical.push('No pregunta sobre centrales de riesgo.')
  }

  return {
    step: 6,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      asks_centrales: has_centrales,
    },
  }
}

function auditStep7(text: string): StepAudit {
  // Step 7: pregunta sobre ingreso mensual. OBLIGATORIO.
  const has_ingreso = /ingreso(?:s)?\s+(mensuales?|aproximados?)|cu[aá]nto\s+ganas|salario/i.test(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 7 ausente: pregunta de ingreso es OBLIGATORIA.')
  } else {
    if (!has_ingreso) critical.push('No pregunta por el ingreso mensual.')
  }

  return {
    step: 7,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      asks_ingreso: has_ingreso,
    },
  }
}

function auditStep8(text: string): StepAudit {
  // Step 8: pregunta sobre ahorros / cesantías. OBLIGATORIO.
  const has_ahorros = /ahorros?|cesant[ií]as|recursos\s+propios|inicial/i.test(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 8 ausente: pregunta de ahorros/cesantías es OBLIGATORIA.')
  } else {
    if (!has_ahorros) critical.push('No pregunta por ahorros o cesantías.')
  }

  return {
    step: 8,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      asks_ahorros_cesantias: has_ahorros,
    },
  }
}

function auditStep9(text: string): StepAudit {
  // Step 9: ofrece COTIZACIÓN antes de agendamiento (sin tag aún).
  const offers_cotizacion = /cotizaci[oó]n|cotizar/i.test(text)
  const has_terminal_tag = /#agendado|#cotizaci[oó]n/i.test(text)

  const critical: string[] = []
  const warnings: string[] = []
  if (!text) {
    critical.push('Paso 9 ausente.')
  } else {
    if (!offers_cotizacion) warnings.push('No ofrece cotización explícitamente.')
    if (has_terminal_tag) {
      warnings.push('Cierre con tag aparece en Paso 9 (debe estar en Paso 10).')
    }
  }

  return {
    step: 9,
    detected: !!text,
    agent_message_text: text || null,
    passed: !!text && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      offers_cotizacion,
      no_premature_tag: !has_terminal_tag,
    },
  }
}

function auditStep10(text: string, allBlocks: string[]): StepAudit {
  // Step 10A: "#agendado" with day+hour, OR Step 10B: "#cotizacion".
  // The closing tag may appear in any of the LAST few blocks if Step 9 ran
  // long. So we check `text` first, then fall back to scanning allBlocks
  // from the end.
  const candidate = text || allBlocks.slice(-1)[0] || ''

  const tag = detectTerminalTag(candidate)
  const has_agendado = tag === 'agendado'
  const has_cotizacion = tag === 'cotizacion'
  const has_dia_hora = /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(candidate) &&
    /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|hrs?)\b/i.test(candidate)
  const has_seven_questions = checkSevenQuestionsCompleted(allBlocks)

  const critical: string[] = []
  const warnings: string[] = []
  if (!candidate) {
    critical.push('Paso 10 ausente: la conversación nunca se cerró con #agendado o #cotizacion.')
  } else {
    if (!has_agendado && !has_cotizacion) {
      critical.push('Falta tag de cierre (#agendado o #cotizacion).')
    }
    if (has_agendado && !has_dia_hora) {
      warnings.push('Cierre con #agendado sin día y hora claros.')
    }
    if (has_cotizacion && !has_seven_questions) {
      warnings.push('Cierre con #cotizacion antes de completar las 7 preguntas obligatorias.')
    }
  }

  return {
    step: 10,
    detected: !!candidate && !!tag,
    agent_message_text: candidate || null,
    passed: !!candidate && critical.length === 0,
    critical_errors: critical,
    warning_errors: warnings,
    validations: {
      has_terminal_tag: !!tag,
      has_agendado,
      has_cotizacion,
      has_dia_hora_if_agendado: !has_agendado || has_dia_hora,
      seven_questions_complete: has_seven_questions,
    },
  }
}

// ─── Helper utilities ─────────────────────────────────────────────────────

function countWords(text: string): number {
  if (!text) return 0
  return text.trim().split(/\s+/).filter(Boolean).length
}

// Detects "$300" or "$300.000.000" or "300 millones" etc.
function hasExplicitPrice(text: string): boolean {
  return /\$\s?[\d.,]{2,}/.test(text) || /\d+\s*millones?/i.test(text)
}

// Verify the 7 mandatory questions appeared somewhere in the conversation.
function checkSevenQuestionsCompleted(blocks: string[]): boolean {
  const all = blocks.join(' ').toLowerCase()
  const checks = [
    /ciudad|en\s+(bogot|soach|mosquer|medell|cali)/.test(all), // ciudad
    /presupuesto/.test(all),                                    // presupuesto
    /\btipo\b|\bsubtipo\b|\bvivir\b|\binvertir\b/.test(all),    // tipo + intent
    /pago|cr[eé]dito|contado|hipotecari/.test(all),             // método pago
    /centrales\s+de\s+riesgo|datacr[eé]dito|reportad/.test(all),// centrales
    /ingreso/.test(all),                                        // ingreso
    /ahorros?|cesant[ií]as/.test(all),                          // ahorros
  ]
  return checks.filter(Boolean).length >= 6 // tolerate 1 missing
}

export const __TERMINAL_TAGS = TERMINAL_TAGS
