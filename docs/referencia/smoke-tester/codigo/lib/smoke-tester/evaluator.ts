// ─── Smoke Tester — Claude evaluator ────────────────────────────────────────
// Grades a single conversation against the ground-truth ficha técnica + the
// agent's instructions. Returns 0-100 sub-scores plus halucinations / errors.

import type { ConversationEntry, EvaluationResult } from './types'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = process.env.SMOKE_TESTER_MODEL || 'claude-sonnet-4-5'
const MAX_TOKENS = 2000

const SYSTEM_PROMPT_TEMPLATE = (proyecto: string, ficha: string, instrucciones: string) =>
  `Eres un evaluador de calidad de agentes IA inmobiliarios en Colombia. Tu trabajo es calificar una conversación entre un comprador y un agente IA, comparando lo que dijo el agente contra los datos reales del proyecto y las instrucciones que recibió.

DATOS REALES DEL PROYECTO "${proyecto}":
${ficha || '(no se proporcionó ficha técnica)'}

INSTRUCCIONES DEL AGENTE:
${instrucciones || '(no se proporcionaron instrucciones)'}

Evalúa con escala 0-100 estas dimensiones:
- accuracy: ¿Los datos que mencionó el agente son correctos según la ficha?
- tone: ¿El tono fue profesional, amable y apropiado para inmobiliaria colombiana?
- completeness: ¿Respondió cada pregunta del comprador completamente?
- proactivity: ¿Ofreció información relevante sin que se la pidieran?
- hallucination_risk: 100=no inventó nada, 0=todo inventado.

Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto fuera del JSON, sin markdown), con esta forma:
{
  "accuracy": number,
  "tone": number,
  "completeness": number,
  "proactivity": number,
  "hallucination_risk": number,
  "overall_score": number,
  "hallucinations": string[],
  "errors": string[],
  "suggestions": string[],
  "summary": string
}

Notas:
- "hallucinations": cita textual de cada dato inventado por el agente.
- "errors": problemas concretos (datos incorrectos, pregunta sin responder, tono inapropiado).
- "suggestions": cómo ajustar la ficha o las instrucciones del agente para corregir los errores.
- "summary": 2-3 frases en español neutro.
- "overall_score" debe ser un promedio razonable de las 5 dimensiones.`

export interface EvaluateParams {
  conversation: ConversationEntry[]
  fichaTecnica: string | null
  instrucciones: string | null
  proyectoNombre: string
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  // Fallback: take from first { to last }
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) return raw.slice(first, last + 1)
  return raw
}

function clamp(n: unknown, fallback = 0): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(0, Math.min(100, Math.round(v)))
}

function ensureArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string').slice(0, 50)
}

function formatTranscript(conversation: ConversationEntry[]): string {
  return conversation
    .map((m) => `${m.role === 'buyer' ? 'COMPRADOR' : 'AGENTE IA'}: ${m.text}`)
    .join('\n\n')
}

export async function evaluateConversation(
  params: EvaluateParams
): Promise<EvaluationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY no configurado')
  }
  if (params.conversation.length === 0) {
    throw new Error('La conversación está vacía')
  }

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT_TEMPLATE(
      params.proyectoNombre || 'Proyecto sin nombre',
      params.fichaTecnica ?? '',
      params.instrucciones ?? ''
    ),
    messages: [
      {
        role: 'user',
        content: `Evalúa esta conversación:\n\n${formatTranscript(params.conversation)}`,
      },
    ],
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text')
  const raw = textBlock?.text ?? ''
  if (!raw) throw new Error('Anthropic respondió sin texto')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `No se pudo parsear JSON del evaluador: ${err instanceof Error ? err.message : err}`
    )
  }

  const accuracy = clamp(parsed.accuracy)
  const tone = clamp(parsed.tone)
  const completeness = clamp(parsed.completeness)
  const proactivity = clamp(parsed.proactivity)
  const hallucination_risk = clamp(parsed.hallucination_risk, 100)
  const overall_score = clamp(
    parsed.overall_score ??
      (accuracy + tone + completeness + proactivity + hallucination_risk) / 5
  )

  return {
    accuracy,
    tone,
    completeness,
    proactivity,
    hallucination_risk,
    overall_score,
    hallucinations: ensureArray(parsed.hallucinations),
    errors: ensureArray(parsed.errors),
    suggestions: ensureArray(parsed.suggestions),
    summary:
      typeof parsed.summary === 'string'
        ? parsed.summary
        : 'Sin resumen disponible.',
  }
}

export interface RunSummary {
  average_score: number
  total: number
  evaluated: number
  common_errors: string[]
  common_suggestions: string[]
  top_hallucinations: string[]
}

export function aggregateRunSummary(
  evaluations: Array<Partial<EvaluationResult>>
): RunSummary {
  const evaluated = evaluations.filter((e) => typeof e.overall_score === 'number')
  const total = evaluated.length
  if (total === 0) {
    return {
      average_score: 0,
      total: 0,
      evaluated: 0,
      common_errors: [],
      common_suggestions: [],
      top_hallucinations: [],
    }
  }
  const average_score = Math.round(
    evaluated.reduce((acc, e) => acc + (e.overall_score ?? 0), 0) / total
  )

  const tally = (key: 'errors' | 'suggestions' | 'hallucinations') => {
    const counts = new Map<string, number>()
    for (const e of evaluated) {
      const arr = (e as Record<string, unknown>)[key]
      if (!Array.isArray(arr)) continue
      for (const v of arr) {
        if (typeof v !== 'string') continue
        const norm = v.trim()
        if (!norm) continue
        counts.set(norm, (counts.get(norm) ?? 0) + 1)
      }
    }
    const entries: Array<[string, number]> = []
    counts.forEach((count, value) => entries.push([value, count]))
    return entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([v]) => v)
  }

  return {
    average_score,
    total: evaluations.length,
    evaluated: total,
    common_errors: tally('errors'),
    common_suggestions: tally('suggestions'),
    top_hallucinations: tally('hallucinations'),
  }
}
