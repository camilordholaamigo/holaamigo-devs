// ─── Smoke Tester — Campaign advancer ─────────────────────────────────────
// Drives serial campaign queues. Called by:
//   1. The runner, at every terminal exit (completed / failed / timeout).
//   2. The watchdog cron, as a recovery net if a previous advancer crashed.
//
// Flow:
//   • Find the queue this run belongs to (status='running', current_run_id=runId)
//   • Update completed/failed counters
//   • If we've run all projects → mark queue completed
//   • Otherwise wait inter_run_delay_seconds, re-check queue (it may have been
//     cancelled), then trigger the next project via /api/smoke-test/[suiteId]/run-form
//
// IMPORTANT: With only ONE WhatsApp test number available, parallel runs would
// mix conversations. The queue MUST run serially. Total time for 29 projects
// at ~12 min each = ~6h.

import { createAdminClient } from '../supabase/admin'
import { logger } from '../logger'
import { startFormTriggeredRun } from './runner'
import { generateProdesaSequence } from './prodesa-sequence-generator'
import { PRODESA_TEST_DEFAULTS } from './bubble-trigger'
import type { BubbleTemplatePayload, ProdesaProject } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

interface QueueRow {
  id: string
  suite_id: string
  empresa_id: string
  status: string
  project_ids: string[]
  current_index: number
  current_run_id: string | null
  total_projects: number
  completed_projects: number
  failed_projects: number
  inter_run_delay_seconds: number
  created_by: string | null
}

interface RunRow {
  id: string
  status: string
  closed_with: string | null
  campaign_queue_id: string | null
}

export async function advanceCampaignIfNeeded(runId: string): Promise<void> {
  const db = createAdminClient()

  // 1. Pull the run (we need its terminal status + campaign_queue_id).
  const { data: runData } = await db
    .from('smoke_test_runs')
    .select('id, status, closed_with, campaign_queue_id')
    .eq('id', runId)
    .single()
  const run = runData as RunRow | null
  if (!run) return
  if (!run.campaign_queue_id) return  // not part of a campaign

  // 2. Pull the queue. The queue is the source of truth for "what comes next".
  const { data: queueData } = await db
    .from('smoke_campaign_queues')
    .select('*')
    .eq('id', run.campaign_queue_id)
    .single()
  const queue = queueData as QueueRow | null
  if (!queue) return
  if (queue.status !== 'running') return  // cancelled / completed / failed

  // Defensive: only advance for terminal-state runs.
  const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled']
  if (!TERMINAL.includes(run.status)) return

  // 3. Update counters (atomic, single update).
  const completedDelta = run.status === 'completed' ? 1 : 0
  const failedDelta = run.status !== 'completed' ? 1 : 0
  await db
    .from('smoke_campaign_queues')
    .update({
      completed_projects: queue.completed_projects + completedDelta,
      failed_projects: queue.failed_projects + failedDelta,
    })
    .eq('id', queue.id)

  const newIndex = queue.current_index + 1

  // 4. End of queue?
  if (newIndex >= queue.total_projects) {
    await db
      .from('smoke_campaign_queues')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        current_run_id: null,
        current_index: queue.total_projects,
      })
      .eq('id', queue.id)
    logger.info('smoke-campaign', 'queue completed', {
      empresa_id: queue.empresa_id,
      context: {
        queue_id: queue.id,
        completed: queue.completed_projects + completedDelta,
        failed: queue.failed_projects + failedDelta,
      },
    })
    return
  }

  // 5. Wait the inter-run delay (give wzap/Bubble time to settle).
  const delayMs = Math.max(0, queue.inter_run_delay_seconds * 1000)
  if (delayMs > 0) {
    logger.info('smoke-campaign', `waiting ${queue.inter_run_delay_seconds}s before next project`, {
      empresa_id: queue.empresa_id,
      context: { queue_id: queue.id, next_index: newIndex },
    })
    await new Promise((r) => setTimeout(r, delayMs))
  }

  // 6. Re-check the queue — user may have cancelled during the wait.
  const { data: refreshed } = await db
    .from('smoke_campaign_queues')
    .select('status')
    .eq('id', queue.id)
    .single()
  if ((refreshed as { status: string } | null)?.status !== 'running') {
    logger.info('smoke-campaign', 'queue no longer running, abort advance', {
      empresa_id: queue.empresa_id,
      context: { queue_id: queue.id },
    })
    return
  }

  // 7. Resolve the next project.
  const nextProjectId = queue.project_ids[newIndex]
  if (!nextProjectId) {
    await markQueueFailed(db, queue.id, `Project ID at index ${newIndex} missing`)
    return
  }

  const { data: projectData } = await db
    .from('prodesa_projects')
    .select('*')
    .eq('id', nextProjectId)
    .single()
  const project = projectData as ProdesaProject | null
  if (!project) {
    logger.warn('smoke-campaign', 'project not found, skipping', {
      empresa_id: queue.empresa_id,
      context: { queue_id: queue.id, project_id: nextProjectId },
    })
    // Skip ahead by bumping current_index and recursing.
    await db
      .from('smoke_campaign_queues')
      .update({ current_index: newIndex, failed_projects: queue.failed_projects + 1 })
      .eq('id', queue.id)
    // Synthesize a "fake" advance call by trying again with same runId — this
    // lets the caller pretend the missing project was a failed run.
    return advanceCampaignIfNeeded(runId)
  }

  // 8. Create the next run via the same internal flow as /run-form.
  // We avoid an HTTP call (no internal-service-key needed) and call the
  // primitives directly: build sequence, persist sequence + run + result,
  // then fire startFormTriggeredRun.
  await triggerProjectRun(db, queue, project)
}

// ─── Internal: create + arm a single project run inside a queue ──────────

async function triggerProjectRun(
  db: AdminClient,
  queue: QueueRow,
  project: ProdesaProject
): Promise<void> {
  // Generate buyer messages for the project.
  const messages = generateProdesaSequence(project)
  if (messages.length === 0) {
    await markProjectFailed(db, queue, `Sequence generator returned 0 messages for ${project.nombre_proyecto}`)
    return
  }

  // Persist a fresh smoke_test_sequences row tied to this campaign step.
  const { data: seqInsert, error: seqErr } = await db
    .from('smoke_test_sequences')
    .insert({
      suite_id: queue.suite_id,
      nombre: `Prodesa · ${project.nombre_proyecto} · campaign ${queue.id.slice(0, 8)}`,
      proyecto_ref: project.nombre_proyecto,
      messages,
      trigger_type: 'prodesa_template',
      prodesa_project_id: project.id,
      orden: queue.current_index + 1,
      metadata: {
        campaign_queue_id: queue.id,
        campaign_index: queue.current_index + 1,
      },
    })
    .select('id')
    .single()
  if (seqErr || !seqInsert) {
    await markProjectFailed(db, queue, `seq insert: ${seqErr?.message || 'unknown'}`)
    return
  }
  const sequenceId = (seqInsert as { id: string }).id

  // Build Bubble payload (test defaults + project name override).
  const bubblePayload: BubbleTemplatePayload = {
    ...PRODESA_TEST_DEFAULTS,
    proyecto: project.nombre_proyecto,
  }

  // Persist the run row.
  const newIndex = queue.current_index + 1
  const { data: runInsert, error: runErr } = await db
    .from('smoke_test_runs')
    .insert({
      suite_id: queue.suite_id,
      empresa_id: queue.empresa_id,
      status: 'pending',
      total_sequences: 1,
      created_by: queue.created_by,
      trigger_type: 'form_trigger',
      form_data: bubblePayload as unknown as Record<string, unknown>,
      waiting_for_template: false,
      campaign_queue_id: queue.id,
    })
    .select('id')
    .single()
  if (runErr || !runInsert) {
    await markProjectFailed(db, queue, `run insert: ${runErr?.message || 'unknown'}`)
    return
  }
  const runId = (runInsert as { id: string }).id

  // Persist the result row.
  const { data: resultInsert, error: resErr } = await db
    .from('smoke_test_results')
    .insert({
      run_id: runId,
      sequence_id: sequenceId,
      status: 'pending',
    })
    .select('id')
    .single()
  if (resErr || !resultInsert) {
    await markProjectFailed(db, queue, `result insert: ${resErr?.message || 'unknown'}`)
    return
  }
  const resultId = (resultInsert as { id: string }).id

  // Update the queue pointer BEFORE firing Bubble — if Bubble fails, the
  // failed run is still reachable via current_run_id and the watchdog can
  // recover.
  await db
    .from('smoke_campaign_queues')
    .update({
      current_index: newIndex,
      current_run_id: runId,
    })
    .eq('id', queue.id)

  // Fire Bubble. startFormTriggeredRun handles the run/result state machine
  // (waiting_for_template=true on success, failed on Bubble error).
  await startFormTriggeredRun({
    runId,
    resultId,
    bubblePayload,
  })

  logger.info('smoke-campaign', 'next project triggered', {
    empresa_id: queue.empresa_id,
    context: {
      queue_id: queue.id,
      index: newIndex,
      project: project.nombre_proyecto,
      run_id: runId,
    },
  })
}

async function markQueueFailed(
  db: AdminClient,
  queueId: string,
  reason: string
): Promise<void> {
  await db
    .from('smoke_campaign_queues')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', queueId)
  logger.error('smoke-campaign', `queue failed: ${reason}`, {
    context: { queue_id: queueId },
  })
}

async function markProjectFailed(
  db: AdminClient,
  queue: QueueRow,
  reason: string
): Promise<void> {
  // Bump counters but keep the queue running so it can try the next project.
  await db
    .from('smoke_campaign_queues')
    .update({
      current_index: queue.current_index + 1,
      failed_projects: queue.failed_projects + 1,
      current_run_id: null,
    })
    .eq('id', queue.id)
  logger.warn('smoke-campaign', `project skip: ${reason}`, {
    context: { queue_id: queue.id, index: queue.current_index + 1 },
  })
}

// ─── Public helper used by the campaign API to start a fresh queue ───────

/**
 * Kick off a queue's first project. Used by POST /api/smoke-test/[suiteId]/campaign.
 * Caller is responsible for creating the queue row first.
 */
export async function startCampaignQueue(queueId: string): Promise<void> {
  const db = createAdminClient()
  const { data: queueData } = await db
    .from('smoke_campaign_queues')
    .select('*')
    .eq('id', queueId)
    .single()
  const queue = queueData as QueueRow | null
  if (!queue) throw new Error(`Queue ${queueId} not found`)
  if (queue.status !== 'pending') {
    logger.info('smoke-campaign', 'queue not pending, skipping start', {
      context: { queue_id: queueId, status: queue.status },
    })
    return
  }

  if (queue.total_projects === 0 || queue.project_ids.length === 0) {
    await markQueueFailed(db, queueId, 'queue has zero projects')
    return
  }

  // Mark as running BEFORE triggering, so the advancer can detect the queue
  // even if startFormTriggeredRun completes super-fast.
  await db
    .from('smoke_campaign_queues')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      current_index: -1,  // triggerProjectRun will bump to 0
    })
    .eq('id', queueId)

  // Pull the first project and fire.
  const firstId = queue.project_ids[0]
  const { data: projectData } = await db
    .from('prodesa_projects')
    .select('*')
    .eq('id', firstId)
    .single()
  const project = projectData as ProdesaProject | null
  if (!project) {
    await markQueueFailed(db, queueId, `first project ${firstId} not found`)
    return
  }

  await triggerProjectRun(
    db,
    { ...queue, current_index: -1, status: 'running' },
    project
  )
}
