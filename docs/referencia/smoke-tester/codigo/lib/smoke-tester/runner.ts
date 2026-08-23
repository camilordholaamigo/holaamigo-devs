// ─── Smoke Tester — runner engine ───────────────────────────────────────────
// Real end-to-end tester:
//   1. Sends scripted buyer messages via wzap.chat from the test device.
//   2. Marks the active smoke_test_results row as awaiting_reply.
//   3. The wzap webhook intercept (lib/smoke-tester/webhook-handler.ts)
//      writes the agent's reply onto that row and clears awaiting_reply.
//   4. We poll the row until the reply arrives (or timeout) and continue.
//   5. After the first reply lands, we wait a SILENCE window so multi-message
//      bursts from the agent (Ema sends 3-5 chunks per answer) get captured
//      together instead of triggering the next buyer message early.
//
// All replies are real WhatsApp deliveries — the customer sees them on their
// phone in real time, exactly like a production conversation.

import { createAdminClient } from '../supabase/admin'
import { sendWzapMessage } from './wzap'
import { triggerProdesaTemplate } from './bubble-trigger'
import {
  auditProdesaConversation,
  detectTerminalTag,
} from './prodesa-auditor'
import { logger } from '../logger'
import type {
  BubbleTemplatePayload,
  ConversationEntry,
  ProdesaProject,
  SequenceMessage,
  ResultStatus,
} from './types'

const MAX_REPLY_WAIT_MS = 240_000  // 4 min per buyer message (Ema is slow)
const POLL_INTERVAL_MS = 2_000
const INTER_MESSAGE_DELAY_MS = 1_500
// After the first agent message arrives, keep listening this long for
// additional chunks of the same answer before sending the next buyer message.
const BURST_SILENCE_WINDOW_MS = 12_000

type AdminClient = ReturnType<typeof createAdminClient>

interface SequenceRow {
  id: string
  nombre: string
  messages: SequenceMessage[]
}

interface ResultRow {
  id: string
  sequence_id: string
}

interface RunSpec {
  runId: string
  suiteId: string
  empresaId: string
  targetPhone: string       // Number we are testing against (recipient)
  sequences: SequenceRow[]
  results: ResultRow[]
}

// ─── Result + run state writers ──────────────────────────────────────────────

async function patchResult(
  db: AdminClient,
  resultId: string,
  patch: Partial<{
    status: ResultStatus
    conversation: ConversationEntry[]
    error_message: string | null
    started_at: string
    completed_at: string
    awaiting_reply: boolean
    last_buyer_at: string
  }>
): Promise<void> {
  const { error } = await db
    .from('smoke_test_results')
    .update(patch)
    .eq('id', resultId)
  if (error) {
    logger.warn('smoke-runner', `patchResult failed: ${error.message}`)
  }
}

async function patchRun(
  db: AdminClient,
  runId: string,
  patch: Partial<{
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    started_at: string
    completed_at: string
    completed_sequences: number
  }>
): Promise<void> {
  const { error } = await db.from('smoke_test_runs').update(patch).eq('id', runId)
  if (error) {
    logger.warn('smoke-runner', `patchRun failed: ${error.message}`)
  }
}

// ─── Wait for the webhook to deliver the agent's reply ───────────────────────

interface WaitResult {
  conversation: ConversationEntry[]
  timedOut: boolean
}

async function waitForReply(
  db: AdminClient,
  resultId: string,
  expectedConvLength: number,
  timeoutMs: number
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { data } = await db
      .from('smoke_test_results')
      .select('conversation, awaiting_reply')
      .eq('id', resultId)
      .single()

    const row = data as { conversation: ConversationEntry[] | null; awaiting_reply: boolean } | null
    const conversation = Array.isArray(row?.conversation) ? row!.conversation : []

    // Webhook clears awaiting_reply once it appends the agent message.
    if (row && !row.awaiting_reply && conversation.length > expectedConvLength) {
      return { conversation, timedOut: false }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  // Timed out — read the final conversation state for the report.
  const { data } = await db
    .from('smoke_test_results')
    .select('conversation')
    .eq('id', resultId)
    .single()
  const row = data as { conversation: ConversationEntry[] | null } | null
  return {
    conversation: Array.isArray(row?.conversation) ? row!.conversation : [],
    timedOut: true,
  }
}

// Agents like Ema send several short messages in a burst as one logical
// answer. After we capture the first chunk, keep watching the conversation
// row — any new agent entries appended by the webhook (Path 2) extend the
// silence window. We exit when no new chunk arrives for the window duration.
async function settleBurst(
  db: AdminClient,
  resultId: string,
  startingLength: number,
  windowMs: number
): Promise<ConversationEntry[]> {
  let lastSeenLength = startingLength
  let silenceUntil = Date.now() + windowMs

  while (Date.now() < silenceUntil) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    const { data } = await db
      .from('smoke_test_results')
      .select('conversation')
      .eq('id', resultId)
      .single()
    const row = data as { conversation: ConversationEntry[] | null } | null
    const conversation = Array.isArray(row?.conversation) ? row!.conversation : []

    if (conversation.length > lastSeenLength) {
      lastSeenLength = conversation.length
      silenceUntil = Date.now() + windowMs   // reset window
    }
  }

  const { data } = await db
    .from('smoke_test_results')
    .select('conversation')
    .eq('id', resultId)
    .single()
  const row = data as { conversation: ConversationEntry[] | null } | null
  return Array.isArray(row?.conversation) ? row!.conversation : []
}

// ─── Core: run one sequence ──────────────────────────────────────────────────

async function runSequence(
  db: AdminClient,
  spec: RunSpec,
  sequence: SequenceRow,
  resultId: string
): Promise<void> {
  let conversation: ConversationEntry[] = []
  const startedAt = new Date().toISOString()

  await patchResult(db, resultId, {
    status: 'running',
    started_at: startedAt,
    conversation: [],
    awaiting_reply: false,
  })

  for (const msg of sequence.messages) {
    const trimmed = (msg.text ?? '').trim()
    if (!trimmed) continue

    // Append buyer entry locally + persist + flag awaiting_reply BEFORE sending,
    // so the webhook can correlate when the reply arrives.
    conversation.push({
      role: 'buyer',
      text: trimmed,
      timestamp: new Date().toISOString(),
    })
    const lastBuyerAt = new Date().toISOString()
    await patchResult(db, resultId, {
      conversation,
      awaiting_reply: true,
      last_buyer_at: lastBuyerAt,
    })

    // Send via wzap.chat — real WhatsApp delivery from the wzap device
    // to the target (the agent under test).
    logger.info('smoke-runner', 'sending wzap message', {
      empresa_id: spec.empresaId,
      context: {
        run_id: spec.runId,
        result_id: resultId,
        target: spec.targetPhone,
        text_preview: trimmed.slice(0, 80),
      },
    })
    try {
      const result = await sendWzapMessage({
        phone: spec.targetPhone,
        message: trimmed,
      })
      logger.info('smoke-runner', 'wzap response', {
        empresa_id: spec.empresaId,
        context: {
          run_id: spec.runId,
          result_id: resultId,
          status: result.status,
          ok: result.ok,
          wzap_id: result.id ?? null,
          body_preview: result.body.slice(0, 200),
        },
      })
      if (!result.ok) {
        throw new Error(`wzap ${result.status}: ${result.body.slice(0, 200)}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      conversation.push({
        role: 'agent',
        text: `[ERROR enviando vía wzap — ${message}]`,
        timestamp: new Date().toISOString(),
      })
      await patchResult(db, resultId, {
        status: 'failed',
        conversation,
        awaiting_reply: false,
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      return
    }

    // Wait for the agent reply to land via the webhook.
    const expectedLen = conversation.length
    const { conversation: updated, timedOut } = await waitForReply(
      db,
      resultId,
      expectedLen,
      MAX_REPLY_WAIT_MS
    )

    if (timedOut) {
      conversation = updated.length > 0 ? updated : conversation
      conversation.push({
        role: 'agent',
        text: `[TIMEOUT — el agente no respondió en ${Math.round(MAX_REPLY_WAIT_MS / 1000)} segundos]`,
        timestamp: new Date().toISOString(),
      })
      await patchResult(db, resultId, {
        status: 'timeout',
        conversation,
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      return
    }

    // First chunk landed. Wait for any follow-up chunks of the same answer.
    const settled = await settleBurst(
      db,
      resultId,
      updated.length,
      BURST_SILENCE_WINDOW_MS
    )
    conversation = settled.length > 0 ? settled : updated

    // Small breathing room between buyer messages so we don't trip the
    // remote agent's anti-burst accumulator.
    const customDelay = msg.delay
    if (typeof customDelay === 'number' && customDelay > 0) {
      await new Promise((r) => setTimeout(r, Math.min(customDelay, 30_000)))
    } else {
      await new Promise((r) => setTimeout(r, INTER_MESSAGE_DELAY_MS))
    }
  }

  await patchResult(db, resultId, {
    status: 'completed',
    conversation,
    awaiting_reply: false,
    completed_at: new Date().toISOString(),
  })
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function executeRun(spec: RunSpec): Promise<void> {
  const db = createAdminClient()

  await patchRun(db, spec.runId, {
    status: 'running',
    started_at: new Date().toISOString(),
  })

  let completed = 0
  for (const seq of spec.sequences) {
    const result = spec.results.find((r) => r.sequence_id === seq.id)
    if (!result) continue
    try {
      await runSequence(db, spec, seq, result.id)
    } catch (err) {
      await patchResult(db, result.id, {
        status: 'failed',
        error_message: err instanceof Error ? err.message : String(err),
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
    }
    completed++
    await patchRun(db, spec.runId, { completed_sequences: completed })
  }

  await patchRun(db, spec.runId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_sequences: completed,
  })
}

export const SMOKE_RUNNER_DEFAULTS = {
  maxReplyWaitMs: MAX_REPLY_WAIT_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  interMessageDelayMs: INTER_MESSAGE_DELAY_MS,
}

// ─── Phase 2 — form-triggered (Prodesa template) flow ─────────────────────
//
// Manual flow:    runner sends a buyer message first, agent replies, repeat.
// Form-triggered: Bubble fires a template AT the wzap device. The webhook
// captures it and starts the buyer reply loop here. The agent's first message
// is therefore the template, already appended to the conversation when this
// function is called.

export interface StartFormTriggeredRunParams {
  runId: string
  resultId: string
  bubblePayload: BubbleTemplatePayload
}

/**
 * Arm the run for template arrival, THEN fire the Bubble webhook.
 *
 * Order matters: we set `waiting_for_template=true` BEFORE calling Bubble so
 * that even if Meta WhatsApp delivers the template message faster than our
 * HTTP roundtrip with Bubble (rare but possible — Bubble is async; the
 * template has already been queued the moment Bubble's workflow runs), the
 * webhook handler's Path 1.5 can find a matching run.
 *
 * If Bubble fails, we revert state to 'failed'. If Bubble succeeds, we
 * persist the response for diagnostics.
 */
export async function startFormTriggeredRun(
  params: StartFormTriggeredRunParams
): Promise<{ ok: boolean; error?: string }> {
  const db = createAdminClient()

  // 1. Arm the run for template arrival (BEFORE the Bubble call).
  const armedAt = new Date().toISOString()
  await db
    .from('smoke_test_runs')
    .update({
      status: 'running',
      started_at: armedAt,
      waiting_for_template: true,
    })
    .eq('id', params.runId)

  await patchResult(db, params.resultId, {
    status: 'running',
    started_at: armedAt,
    awaiting_reply: false,
  })

  logger.info('smoke-runner', 'form-trigger armed; calling Bubble', {
    context: {
      run_id: params.runId,
      result_id: params.resultId,
      proyecto: params.bubblePayload.proyecto,
    },
  })

  // 2. Fire Bubble. If this fails, revert to failed state.
  const bubble = await triggerProdesaTemplate(params.bubblePayload)

  if (!bubble.ok) {
    logger.error('smoke-runner', 'Bubble call failed; reverting run to failed', {
      context: { run_id: params.runId, error: bubble.error },
    })
    await patchRun(db, params.runId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    await db
      .from('smoke_test_runs')
      .update({
        waiting_for_template: false,
        bubble_response: { error: bubble.error || 'unknown' },
      })
      .eq('id', params.runId)
    await patchResult(db, params.resultId, {
      status: 'failed',
      error_message: `Bubble webhook failed: ${bubble.error || 'unknown'}`,
      awaiting_reply: false,
      completed_at: new Date().toISOString(),
    })
    return { ok: false, error: bubble.error }
  }

  // 3. Persist Bubble's response for debugging (HubSpot side-effects, etc.).
  await db
    .from('smoke_test_runs')
    .update({
      bubble_response: (bubble.response as Record<string, unknown>) ?? {},
    })
    .eq('id', params.runId)

  logger.info('smoke-runner', 'form-trigger ready; webhook will resume on template', {
    context: {
      run_id: params.runId,
      result_id: params.resultId,
    },
  })

  return { ok: true }
}

interface FormResultRow {
  id: string
  run_id: string
  sequence_id: string
  conversation: ConversationEntry[] | null
  smoke_test_runs: {
    id: string
    suite_id: string
    empresa_id: string
    campaign_queue_id: string | null
  } | null
  smoke_test_sequences: {
    id: string
    messages: SequenceMessage[] | null
    prodesa_project_id: string | null
  } | null
}

// Fire-and-forget call to the campaign advancer. Wrapped so a failure here
// never bubbles up and breaks the runner's terminal cleanup.
async function safeAdvanceCampaign(runId: string): Promise<void> {
  try {
    const { advanceCampaignIfNeeded } = await import('./campaign-advancer')
    await advanceCampaignIfNeeded(runId)
  } catch (err) {
    logger.warn('smoke-runner', 'advanceCampaignIfNeeded failed (non-fatal)', {
      context: {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/**
 * Run the rule-based auditor over the final conversation and persist
 * audit_steps + critical_errors + warning_errors + step_validations on the
 * result row, plus closed_with + audit_result on the run row. Best-effort:
 * a failure here should not block the run from being marked completed.
 */
async function persistAuditResults(
  db: AdminClient,
  resultId: string,
  runId: string,
  conversation: ConversationEntry[],
  project: ProdesaProject | null
): Promise<void> {
  if (!project) {
    logger.warn('smoke-runner', 'cannot audit: no project metadata', {
      context: { result_id: resultId, run_id: runId },
    })
    return
  }
  try {
    const audit = auditProdesaConversation(conversation, project)
    await db
      .from('smoke_test_results')
      .update({
        audit_steps: audit.steps,
        critical_errors: audit.steps.flatMap((s) => s.critical_errors),
        warning_errors: audit.steps.flatMap((s) => s.warning_errors),
        step_validations: audit.steps.reduce(
          (acc, s) => {
            acc[String(s.step)] = s.validations
            return acc
          },
          {} as Record<string, Record<string, boolean>>
        ),
        score: audit.overall_score,
      })
      .eq('id', resultId)
    await db
      .from('smoke_test_runs')
      .update({
        audit_result: audit as unknown as Record<string, unknown>,
        closed_with: audit.closed_with,
        overall_score: audit.overall_score,
      })
      .eq('id', runId)
    logger.info('smoke-runner', 'audit persisted', {
      context: {
        run_id: runId,
        result_id: resultId,
        score: audit.overall_score,
        closed_with: audit.closed_with,
        critical: audit.critical_count,
        warnings: audit.warning_count,
      },
    })
  } catch (err) {
    logger.error('smoke-runner', 'audit failed', {
      context: {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/**
 * Continue a form-triggered run after the WhatsApp template has arrived.
 * Called by the webhook handler (Path 1.5 in webhook-handler.ts).
 *
 * The result row already has the template message in conversation[0]. We
 * iterate the buyer sequence, send each message via wzap, and rely on the
 * existing webhook intercept (Path 1) + burst settling to capture agent
 * replies — exactly the same way the manual flow works.
 */
export async function continueFormTriggeredRun(resultId: string): Promise<void> {
  const db = createAdminClient()

  const { data, error } = await db
    .from('smoke_test_results')
    .select(`
      id,
      run_id,
      sequence_id,
      conversation,
      smoke_test_runs!inner(id, suite_id, empresa_id, campaign_queue_id),
      smoke_test_sequences!inner(id, messages, prodesa_project_id)
    `)
    .eq('id', resultId)
    .single()

  if (error || !data) {
    logger.error('smoke-runner', 'continueFormTriggeredRun: result not found', {
      context: { result_id: resultId, error: error?.message },
    })
    return
  }

  const result = data as unknown as FormResultRow
  const runRow = result.smoke_test_runs
  const seqRow = result.smoke_test_sequences
  if (!runRow || !seqRow) {
    logger.error('smoke-runner', 'continueFormTriggeredRun: missing relations', {
      context: { result_id: resultId },
    })
    return
  }

  const messages = Array.isArray(seqRow.messages) ? seqRow.messages : []
  if (messages.length === 0) {
    await patchResult(db, resultId, {
      status: 'failed',
      error_message: 'Secuencia vacía para form-triggered run',
      awaiting_reply: false,
      completed_at: new Date().toISOString(),
    })
    await patchRun(db, runRow.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    return
  }

  // Resolve target phone (the agent we're testing) from the suite.
  const { data: suiteData } = await db
    .from('smoke_test_suites')
    .select('target_phone')
    .eq('id', runRow.suite_id)
    .single()
  const targetPhone =
    (suiteData as { target_phone: string | null } | null)?.target_phone || null

  // Resolve project metadata for the auditor (best-effort; if missing the
  // audit step is skipped but the conversation still runs).
  let project: ProdesaProject | null = null
  if (seqRow.prodesa_project_id) {
    const { data: projectData } = await db
      .from('prodesa_projects')
      .select('*')
      .eq('id', seqRow.prodesa_project_id)
      .single()
    project = (projectData as ProdesaProject | null) ?? null
  }

  if (!targetPhone) {
    await patchResult(db, resultId, {
      status: 'failed',
      error_message: 'Suite sin target_phone configurado',
      awaiting_reply: false,
      completed_at: new Date().toISOString(),
    })
    await patchRun(db, runRow.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    return
  }

  let conversation: ConversationEntry[] = Array.isArray(result.conversation)
    ? result.conversation
    : []

  // Drive the buyer reply loop. Mirrors runSequence but reuses the existing
  // conversation (which already contains the template as agent[0]).
  for (const msg of messages) {
    const trimmed = (msg.text ?? '').trim()
    if (!trimmed) continue

    conversation.push({
      role: 'buyer',
      text: trimmed,
      timestamp: new Date().toISOString(),
    })
    const lastBuyerAt = new Date().toISOString()
    await patchResult(db, resultId, {
      conversation,
      awaiting_reply: true,
      last_buyer_at: lastBuyerAt,
    })

    logger.info('smoke-runner', 'form-trigger: sending buyer message', {
      empresa_id: runRow.empresa_id,
      context: {
        run_id: runRow.id,
        result_id: resultId,
        target: targetPhone,
        text_preview: trimmed.slice(0, 80),
      },
    })

    try {
      const sent = await sendWzapMessage({ phone: targetPhone, message: trimmed })
      if (!sent.ok) {
        throw new Error(`wzap ${sent.status}: ${sent.body.slice(0, 200)}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      conversation.push({
        role: 'agent',
        text: `[ERROR enviando vía wzap — ${message}]`,
        timestamp: new Date().toISOString(),
      })
      await patchResult(db, resultId, {
        status: 'failed',
        conversation,
        awaiting_reply: false,
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      await patchRun(db, runRow.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      })
      await safeAdvanceCampaign(runRow.id)
      return
    }

    // Wait for first chunk of agent reply via webhook.
    const expectedLen = conversation.length
    const { conversation: updated, timedOut } = await waitForReply(
      db,
      resultId,
      expectedLen,
      MAX_REPLY_WAIT_MS
    )

    if (timedOut) {
      conversation = updated.length > 0 ? updated : conversation
      conversation.push({
        role: 'agent',
        text: `[TIMEOUT — el agente no respondió en ${Math.round(MAX_REPLY_WAIT_MS / 1000)} segundos]`,
        timestamp: new Date().toISOString(),
      })
      await patchResult(db, resultId, {
        status: 'timeout',
        conversation,
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      await patchRun(db, runRow.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        completed_sequences: 1,
      })
      await db
        .from('smoke_test_runs')
        .update({ closed_with: 'timeout' })
        .eq('id', runRow.id)
      await persistAuditResults(db, resultId, runRow.id, conversation, project)
      await safeAdvanceCampaign(runRow.id)
      return
    }

    // Capture trailing burst chunks.
    const settled = await settleBurst(
      db,
      resultId,
      updated.length,
      BURST_SILENCE_WINDOW_MS
    )
    conversation = settled.length > 0 ? settled : updated

    // ─── Terminal-tag short-circuit ──────────────────────────────────────
    // If any agent message in the just-received block contains #agendado or
    // #cotizacion the conversation is closed. Stop sending buyer messages,
    // run the auditor, and let the campaign advancer pick up the next
    // project (if any).
    const lastBlockText = conversation
      .slice(-Math.max(1, conversation.length - expectedLen + 1))
      .filter((c) => c.role === 'agent')
      .map((c) => c.text)
      .join('\n\n')
    const tag = detectTerminalTag(lastBlockText)
    if (tag) {
      logger.info('smoke-runner', 'terminal tag detected — closing run early', {
        empresa_id: runRow.empresa_id,
        context: { run_id: runRow.id, tag },
      })
      await patchResult(db, resultId, {
        status: 'completed',
        conversation,
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      await patchRun(db, runRow.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        completed_sequences: 1,
      })
      await persistAuditResults(db, resultId, runRow.id, conversation, project)
      await safeAdvanceCampaign(runRow.id)
      return
    }

    const customDelay = msg.delay
    if (typeof customDelay === 'number' && customDelay > 0) {
      await new Promise((r) => setTimeout(r, Math.min(customDelay, 30_000)))
    } else {
      await new Promise((r) => setTimeout(r, INTER_MESSAGE_DELAY_MS))
    }
  }

  await patchResult(db, resultId, {
    status: 'completed',
    conversation,
    awaiting_reply: false,
    completed_at: new Date().toISOString(),
  })
  await patchRun(db, runRow.id, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_sequences: 1,
  })
  await persistAuditResults(db, resultId, runRow.id, conversation, project)
  await safeAdvanceCampaign(runRow.id)

  logger.info('smoke-runner', 'form-triggered run completed', {
    empresa_id: runRow.empresa_id,
    context: {
      run_id: runRow.id,
      result_id: resultId,
      total_messages: conversation.length,
    },
  })
}

// waitForReply, settleBurst, patchResult, patchRun are exported implicitly
// via continueFormTriggeredRun closing over them — they remain private to
// the module. See those helpers above for the polling & burst logic.
