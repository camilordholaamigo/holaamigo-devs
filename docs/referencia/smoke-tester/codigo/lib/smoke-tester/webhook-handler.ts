// ─── Smoke Tester — WZAP webhook intercept ─────────────────────────────────
// wzap.chat fires a webhook on incoming WhatsApp messages. We use this to
// capture the agent-under-test's replies and append them to the awaiting
// smoke_test_results row, then clear awaiting_reply so the runner advances.
//
// wzap webhook payload shapes seen in the wild can vary; we accept several
// common field names for robustness.

import { waitUntil } from '@vercel/functions'
import { createAdminClient } from '../supabase/admin'
import { normalizePhone } from '../phone-utils'
import { logger } from '../logger'
import {
  advanceAutonomousTurn,
  isAutonomous,
  scheduleTurn,
} from './conversation-engine'
import type { ConversationEntry } from './types'

interface AwaitingResult {
  id: string
  run_id: string
  conversation: ConversationEntry[] | null
  smoke_test_runs: {
    suite_id: string
    status: string
    waiting_for_template?: boolean
    trigger_type?: string
    form_data?: Record<string, unknown> | null
  } | null
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Runs autónomos (PRD 52): el webhook no solo GUARDA la respuesta del agente,
 * también DISPARA el siguiente turno del comprador. Sin esto la conversación
 * dependería de una función viva haciendo polling, que Vercel mata a los
 * 300s — justo lo que dejaba el flujo a medias.
 *
 * El token se reserva de forma síncrona para que, si el agente manda varios
 * chunks, solo el último termine contestando.
 */
async function scheduleAutonomousTurnIfNeeded(
  db: AdminClient,
  row: AwaitingResult
): Promise<void> {
  const run = row.smoke_test_runs
  if (!run || run.status !== 'running') return
  if (!isAutonomous(run.form_data)) return

  const token = await scheduleTurn(db, row.run_id)
  waitUntil(
    advanceAutonomousTurn(row.id, token).catch((err: unknown) => {
      logger.error('smoke-webhook', 'advanceAutonomousTurn falló', {
        context: {
          result_id: row.id,
          run_id: row.run_id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
  )
}

// Window during which extra inbound chunks are still considered part of the
// same agent answer (burst). After this, late replies are dropped as stray.
const BURST_APPEND_WINDOW_MS = 30_000

// Accepts {phone,message,device}, {from,body}, {payload:{...}}, etc.
// Also handles WhatsApp Business template payloads where the visible text
// lives inside nested fields (message.text.body, template.body, etc.).
export interface WzapWebhookPayload {
  phone?: string
  from?: string
  fromNumber?: string
  message?: unknown
  text?: unknown
  body?: unknown
  caption?: string
  device?: string
  fromMe?: boolean
  type?: string
  payload?: WzapWebhookPayload
  data?: WzapWebhookPayload
  template?: { body?: string; name?: string }
  // wzap.chat sometimes wraps the inbound under different keys:
  contact?: { number?: string; name?: string }
  sender?: { number?: string; phone?: string }
}

interface ParsedEvent {
  fromPhone: string
  text: string
  fromMe: boolean
}

/** Best-effort string extractor — handles nested text shapes from
 *  WhatsApp Business templates (e.g. `{ message: { text: { body: '...' } } }`)
 *  while staying tolerant of plain string payloads. */
function extractText(node: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node !== 'object') return ''
  const obj = node as Record<string, unknown>
  // Common shapes, ordered most-specific first.
  const candidates = [
    obj.body,
    obj.text,
    obj.caption,
    obj.message,
    (obj.template as Record<string, unknown> | undefined)?.body,
    obj.content,
    obj.value,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
    if (c && typeof c === 'object') {
      const nested = extractText(c, depth + 1)
      if (nested) return nested
    }
  }
  return ''
}

export function parseWzapEvent(raw: WzapWebhookPayload): ParsedEvent | null {
  // Drill into wrappers (some wzap formats nest under payload/data).
  const inner = (raw.payload || raw.data || raw) as WzapWebhookPayload
  const fromRaw =
    inner.from ??
    inner.fromNumber ??
    inner.phone ??
    inner.contact?.number ??
    inner.sender?.number ??
    inner.sender?.phone ??
    raw.from ??
    raw.phone ??
    ''
  // Try the simple shapes first, then drill deeper.
  let text =
    (typeof inner.message === 'string' ? inner.message : '') ||
    (typeof inner.text === 'string' ? inner.text : '') ||
    (typeof inner.body === 'string' ? inner.body : '') ||
    inner.caption ||
    inner.template?.body ||
    extractText(inner) ||
    extractText(raw)
  const fromMe = Boolean(inner.fromMe ?? raw.fromMe)

  if (!fromRaw || !text) return null

  return {
    fromPhone: normalizePhone(String(fromRaw)),
    text: String(text),
    fromMe,
  }
}

/**
 * Records an inbound wzap message on the awaiting smoke-test result.
 * Returns true when the event was consumed.
 */
export async function handleSmokeTesterWebhook(
  raw: WzapWebhookPayload
): Promise<boolean> {
  // Always log the raw payload structure (keys + small previews). Helps
  // diagnose template messages where the parser silently drops events.
  try {
    const summary = summarizeRawPayload(raw)
    logger.info('smoke-webhook', 'inbound wzap event', { context: summary })
  } catch {
    /* no-op — never let logging break the handler */
  }

  const event = parseWzapEvent(raw)
  if (!event) {
    logger.warn('smoke-webhook', 'parseWzapEvent returned null — payload not recognized', {
      context: { raw_keys: Object.keys(raw || {}).slice(0, 20) },
    })
    return false
  }

  // Ignore echoes of our own outbound messages.
  if (event.fromMe) {
    logger.info('smoke-webhook', 'ignored fromMe echo', {
      context: { from: event.fromPhone, preview: event.text.slice(0, 80) },
    })
    return false
  }

  const db = createAdminClient()

  // Path 1 — primary match: result that's actively awaiting a reply.
  // wzap doesn't tell us which run this belongs to, so we rely on the
  // single-active-run invariant (we run them sequentially per device).
  const { data: results } = await db
    .from('smoke_test_results')
    .select('id, run_id, conversation, smoke_test_runs!inner(suite_id, status, waiting_for_template, trigger_type, form_data)')
    .eq('awaiting_reply', true)
    .eq('smoke_test_runs.status', 'running')
    .order('last_buyer_at', { ascending: false })
    .limit(1)

  const awaiting = (results?.[0] ?? null) as AwaitingResult | null

  if (awaiting) {
    const conversation: ConversationEntry[] = Array.isArray(awaiting.conversation)
      ? awaiting.conversation
      : []
    conversation.push({
      role: 'agent',
      text: event.text,
      timestamp: new Date().toISOString(),
    })

    await db
      .from('smoke_test_results')
      .update({ conversation, awaiting_reply: false })
      .eq('id', awaiting.id)

    logger.info('smoke-webhook', 'Captured agent reply', {
      context: {
        result_id: awaiting.id,
        run_id: awaiting.run_id,
        from: event.fromPhone,
      },
    })

    await scheduleAutonomousTurnIfNeeded(db, awaiting)
    return true
  }

  // Path 1.5 — form-triggered template arrival.
  // For runs created by /api/smoke-test/[suiteId]/run-form, the FIRST inbound
  // message is the WhatsApp template fired by Bubble — not a reply to a buyer
  // message. Match those runs by waiting_for_template=true and treat the
  // incoming text as the conversation opener.
  const { data: templateAwaiting } = await db
    .from('smoke_test_results')
    .select('id, run_id, conversation, smoke_test_runs!inner(suite_id, status, waiting_for_template, trigger_type)')
    .eq('smoke_test_runs.waiting_for_template', true)
    .eq('smoke_test_runs.trigger_type', 'form_trigger')
    .eq('smoke_test_runs.status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)

  const templateRow = (templateAwaiting?.[0] ?? null) as AwaitingResult | null
  if (templateRow) {
    const conversation: ConversationEntry[] = Array.isArray(templateRow.conversation)
      ? templateRow.conversation
      : []
    conversation.push({
      role: 'agent',
      text: event.text,
      timestamp: new Date().toISOString(),
    })

    await db
      .from('smoke_test_results')
      .update({ conversation })
      .eq('id', templateRow.id)

    // Mark the run as: template arrived, ready to start sending buyer replies.
    await db
      .from('smoke_test_runs')
      .update({
        waiting_for_template: false,
        template_received_at: new Date().toISOString(),
      })
      .eq('id', templateRow.run_id)

    logger.info('smoke-webhook', 'Captured Prodesa template, starting buyer sequence', {
      context: {
        result_id: templateRow.id,
        run_id: templateRow.run_id,
        from: event.fromPhone,
        preview: event.text.slice(0, 80),
      },
    })

    // Schedule the buyer-reply loop on the same function instance via
    // waitUntil — Vercel keeps the function alive until the promise resolves
    // (up to maxDuration on the route). Without this the webhook returns 200,
    // Vercel kills the function, and the runner dies after the first buyer
    // message goes out (the agent's later replies still land via Path 1, but
    // there is nobody alive to send buyer2).
    //
    // The dynamic import breaks the runner ↔ webhook circular dep at module
    // load time; the import promise is wrapped so a failed import surfaces
    // in logs instead of becoming an unhandled rejection.
    waitUntil(
      import('./runner')
        .then(({ continueFormTriggeredRun }) => {
          if (typeof continueFormTriggeredRun !== 'function') return
          return continueFormTriggeredRun(templateRow.id).catch((err: unknown) => {
            logger.error('smoke-webhook', 'continueFormTriggeredRun failed', {
              context: {
                result_id: templateRow.id,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          })
        })
        .catch((err: unknown) => {
          logger.error('smoke-webhook', 'failed to import runner', {
            context: { error: err instanceof Error ? err.message : String(err) },
          })
        })
    )

    return true
  }

  // Path 2 — burst continuation: agents like Ema send several chunks per
  // answer. The first chunk consumed Path 1 and cleared awaiting_reply.
  // Any extra chunks arriving within BURST_APPEND_WINDOW_MS get appended
  // to the most recent running result whose last entry was an agent reply.
  const { data: recentResults } = await db
    .from('smoke_test_results')
    .select('id, run_id, conversation, smoke_test_runs!inner(suite_id, status, form_data)')
    .eq('smoke_test_runs.status', 'running')
    .order('last_buyer_at', { ascending: false })
    .limit(1)

  const recent = (recentResults?.[0] ?? null) as AwaitingResult | null
  if (recent && Array.isArray(recent.conversation) && recent.conversation.length > 0) {
    const last = recent.conversation[recent.conversation.length - 1]
    const lastTs = last?.timestamp ? Date.parse(last.timestamp) : NaN
    const isFreshAgent =
      last?.role === 'agent' &&
      Number.isFinite(lastTs) &&
      Date.now() - lastTs < BURST_APPEND_WINDOW_MS

    if (isFreshAgent) {
      const conversation = [...recent.conversation, {
        role: 'agent' as const,
        text: event.text,
        timestamp: new Date().toISOString(),
      }]
      await db
        .from('smoke_test_results')
        .update({ conversation })
        .eq('id', recent.id)

      logger.info('smoke-webhook', 'Appended burst chunk', {
        context: {
          result_id: recent.id,
          run_id: recent.run_id,
          from: event.fromPhone,
          chunks_total: conversation.filter((c) => c.role === 'agent').length,
        },
      })

      // Reprograma el turno: este chunk es más nuevo que el que lo programó,
      // así que el settle anterior se retira y contesta éste, ya con la
      // respuesta completa a la vista.
      await scheduleAutonomousTurnIfNeeded(db, recent)
      return true
    }
  }

  // No path matched — log what's currently in DB so we can diagnose.
  // This is by far the most useful signal when something silently fails.
  const { data: activeRuns } = await db
    .from('smoke_test_runs')
    .select('id, status, trigger_type, waiting_for_template, created_at')
    .in('status', ['running', 'pending'])
    .order('created_at', { ascending: false })
    .limit(5)

  logger.warn('smoke-webhook', 'No awaiting result matched inbound message', {
    context: {
      from: event.fromPhone,
      preview: event.text.slice(0, 120),
      active_runs:
        (activeRuns || []).map((r) => {
          const row = r as {
            id: string
            status: string
            trigger_type: string
            waiting_for_template: boolean
            created_at: string
          }
          return {
            id: row.id.slice(0, 8),
            status: row.status,
            trigger: row.trigger_type,
            waiting_template: row.waiting_for_template,
          }
        }) ?? [],
    },
  })
  return false
}

// ─── helpers ───────────────────────────────────────────────────────────

function summarizeRawPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { type: typeof raw }
  }
  const obj = raw as Record<string, unknown>
  const summary: Record<string, unknown> = {
    keys: Object.keys(obj).slice(0, 20),
  }
  // Include a short preview of any string-valued top-level fields, plus
  // the keys of nested objects (so we can see structure of template events).
  for (const [k, v] of Object.entries(obj).slice(0, 20)) {
    if (typeof v === 'string') {
      summary[`str_${k}`] = v.length > 120 ? v.slice(0, 120) + '…' : v
    } else if (v && typeof v === 'object') {
      summary[`obj_${k}_keys`] = Object.keys(v as Record<string, unknown>).slice(0, 12)
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      summary[`val_${k}`] = v
    }
  }
  return summary
}
