// ─── Adaptador 4 — OpenAI Responses ────────────────────────────────────────
// Reemplaza `lib/agent-openai/responses-client`.
//
// Mantiene la MISMA firma que usa buyer-ai.ts, así que ese archivo se copia
// sin tocarle el cuerpo — solo el import.
//
// Por qué Responses y no Chat Completions: `text.format.json_schema` con
// `strict: true` garantiza que el comprador devuelva SIEMPRE
// { mensaje, terminar, motivo }. Sin salida estructurada hay que parsear
// prosa, y el día que el modelo conteste "¡Claro! Aquí va: {...}" el turno se
// pierde. Si tu proveedor no tiene structured outputs, usá tool-calling con
// un tool obligatorio: es el mismo efecto.

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

export interface ResponsesInput {
  model: string
  input: string
  instructions?: string
  store?: boolean
  temperature?: number
  max_output_tokens?: number
  text?: Record<string, unknown>
  /** En el original registra el consumo de tokens por empresa. Aquí se ignora. */
  track?: Record<string, unknown>
}

export interface ResponsesResult {
  output_text: string
  raw: unknown
}

/** Los modelos de razonamiento (o1/o3/gpt-5*) rechazan `temperature`. */
function modelSupportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model)
}

export async function callResponses(req: ResponsesInput): Promise<ResponsesResult> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY no está configurada')

  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
    store: req.store ?? false,
  }
  if (req.instructions != null) body.instructions = req.instructions
  if (req.text) body.text = req.text
  if (req.max_output_tokens) body.max_output_tokens = req.max_output_tokens
  if (req.temperature != null && modelSupportsTemperature(req.model)) {
    body.temperature = req.temperature
  }

  const resp = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`OpenAI Responses ${resp.status}: ${text.slice(0, 300)}`)
  }

  const json = (await resp.json()) as {
    output_text?: string
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
  }

  // `output_text` es el atajo; si el endpoint no lo trae, se arma desde los
  // bloques de salida.
  const fromBlocks = (json.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')

  return { output_text: json.output_text ?? fromBlocks, raw: json }
}
