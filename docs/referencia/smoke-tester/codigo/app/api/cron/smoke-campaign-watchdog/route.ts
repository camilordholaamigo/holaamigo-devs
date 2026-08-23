// ─── Smoke Tester — Campaign watchdog ─────────────────────────────────────
// Cron: diario (vercel.json — el plan Hobby no permite crons más frecuentes,
// así que ESTA NO ES la red de seguridad principal del flujo autónomo: esa
// vive en el GET del run, que la UI consulta cada 2.5s).
// Cuatro fallas a recuperar:
//
//   A. Template never arrived
//      Run.trigger_type='form_trigger' && waiting_for_template=true && created
//      more than 5 min ago. Mark failed + advance the campaign (if any).
//
//   B. Stuck mid-conversation
//      Run.status='running' && updated_at older than 30 min. Mark timeout +
//      advance the campaign (if any).
//
//   C. Campaign queue lost its advancer
//      Queue.status='running' && current_run_id is in a terminal state.
//      Re-call advanceCampaignIfNeeded(current_run_id) to recover.
//
//   D. Runs zombis
//      Run.status='running' sin ninguna fila esperando respuesta y sin
//      actividad hace más de 60 min. Se cancelan: si no, el webhook los sigue
//      considerando el "run activo" y empareja mensajes contra ellos.
//
// Active polling is intentional ONLY for these recovery cases — the normal
// happy path uses webhook-driven progression (no polling).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { advanceCampaignIfNeeded } from '@/lib/smoke-tester/campaign-advancer'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const TEMPLATE_TIMEOUT_MIN = 5
const STUCK_RUN_TIMEOUT_MIN = 30
const ZOMBIE_RUN_TIMEOUT_MIN = 60

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return req.headers.get('x-vercel-cron') === '1'
  }
  const auth = req.headers.get('authorization') || ''
  if (auth === `Bearer ${secret}`) return true
  return req.headers.get('x-vercel-cron') === '1'
}

async function recoverTemplateNeverArrived(): Promise<{
  scanned: number
  fixed: number
}> {
  const db = createAdminClient()
  const cutoff = new Date(Date.now() - TEMPLATE_TIMEOUT_MIN * 60_000).toISOString()

  const { data: stuckRuns } = await db
    .from('smoke_test_runs')
    .select('id, suite_id, campaign_queue_id, created_at')
    .eq('trigger_type', 'form_trigger')
    .eq('waiting_for_template', true)
    .eq('status', 'running')
    .lt('created_at', cutoff)
    .limit(20)

  const runs = (stuckRuns || []) as Array<{
    id: string
    suite_id: string
    campaign_queue_id: string | null
    created_at: string
  }>

  let fixed = 0
  for (const r of runs) {
    await db
      .from('smoke_test_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        waiting_for_template: false,
        closed_with: 'incomplete',
      })
      .eq('id', r.id)
    await db
      .from('smoke_test_results')
      .update({
        status: 'failed',
        error_message: `Template no llegó en ${TEMPLATE_TIMEOUT_MIN} min — Bubble webhook posiblemente falló`,
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      .eq('run_id', r.id)
      .in('status', ['pending', 'running'])

    if (r.campaign_queue_id) {
      await advanceCampaignIfNeeded(r.id).catch((err: unknown) => {
        logger.warn('smoke-watchdog', 'advance after template-never-arrived failed', {
          context: { run_id: r.id, error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    fixed++
  }

  return { scanned: runs.length, fixed }
}

async function recoverStuckMidConversation(): Promise<{
  scanned: number
  fixed: number
}> {
  const db = createAdminClient()
  const cutoff = new Date(Date.now() - STUCK_RUN_TIMEOUT_MIN * 60_000).toISOString()

  // We use smoke_test_results.last_buyer_at as the "last activity" marker
  // since smoke_test_runs doesn't have an updated_at (only completed_at).
  // Sin filtro por trigger_type a propósito: los runs manuales y los del
  // flujo autónomo (PRD 52) se cuelgan igual cuando el agente deja de
  // responder, y antes se quedaban en 'running' para siempre ensuciando el
  // emparejamiento del webhook.
  const { data: results } = await db
    .from('smoke_test_results')
    .select('id, run_id, last_buyer_at, smoke_test_runs!inner(id, status, trigger_type, campaign_queue_id)')
    .eq('smoke_test_runs.status', 'running')
    .eq('awaiting_reply', true)
    .lt('last_buyer_at', cutoff)
    .limit(20)

  const rows = (results || []) as unknown as Array<{
    id: string
    run_id: string
    last_buyer_at: string | null
    smoke_test_runs: {
      id: string
      status: string
      trigger_type: string
      campaign_queue_id: string | null
    }
  }>

  let fixed = 0
  for (const r of rows) {
    await db
      .from('smoke_test_results')
      .update({
        status: 'timeout',
        error_message: `Conversación estancada >${STUCK_RUN_TIMEOUT_MIN} min sin respuesta del agente`,
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    await db
      .from('smoke_test_runs')
      .update({
        status: 'completed',
        closed_with: 'timeout',
        completed_at: new Date().toISOString(),
      })
      .eq('id', r.run_id)

    if (r.smoke_test_runs.campaign_queue_id) {
      await advanceCampaignIfNeeded(r.run_id).catch((err: unknown) => {
        logger.warn('smoke-watchdog', 'advance after stuck-conversation failed', {
          context: { run_id: r.run_id, error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    fixed++
  }

  return { scanned: rows.length, fixed }
}

// Caso D — runs zombis: quedaron en 'running' sin ninguna fila esperando
// respuesta (la función murió a mitad de camino, hubo un deploy, etc.). No
// los recoge ningún otro caso y envenenan el webhook, que empareja los
// mensajes entrantes contra "el run running más reciente".
async function recoverZombieRuns(): Promise<{ scanned: number; fixed: number }> {
  const db = createAdminClient()
  const cutoff = new Date(Date.now() - ZOMBIE_RUN_TIMEOUT_MIN * 60_000).toISOString()

  const { data: runs } = await db
    .from('smoke_test_runs')
    .select('id, created_at')
    .eq('status', 'running')
    .lt('created_at', cutoff)
    .limit(50)

  const rows = (runs || []) as Array<{ id: string; created_at: string }>
  let fixed = 0
  for (const r of rows) {
    const { data: activity } = await db
      .from('smoke_test_results')
      .select('awaiting_reply, last_buyer_at')
      .eq('run_id', r.id)
      .order('created_at', { ascending: false })
      .limit(1)
    const latest = (activity?.[0] ?? null) as {
      awaiting_reply: boolean
      last_buyer_at: string | null
    } | null
    if (latest?.awaiting_reply) continue // lo cubre el caso B
    // Un run autónomo pasa ~1 min sin awaiting_reply mientras el comprador
    // redacta el turno siguiente. No lo matemos por eso.
    const lastActivity = latest?.last_buyer_at ? Date.parse(latest.last_buyer_at) : NaN
    if (Number.isFinite(lastActivity) && lastActivity > Date.parse(cutoff)) continue

    await db
      .from('smoke_test_runs')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        waiting_for_template: false,
      })
      .eq('id', r.id)
    await db
      .from('smoke_test_results')
      .update({
        status: 'failed',
        error_message: `Run abandonado más de ${ZOMBIE_RUN_TIMEOUT_MIN} min sin actividad`,
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      .eq('run_id', r.id)
      .in('status', ['pending', 'running'])
    fixed++
  }

  return { scanned: rows.length, fixed }
}

async function recoverOrphanedQueues(): Promise<{
  scanned: number
  fixed: number
}> {
  const db = createAdminClient()

  // Queues stuck in 'running' whose current_run_id is in a terminal state
  // mean the advancer crashed before triggering the next project.
  const { data: queues } = await db
    .from('smoke_campaign_queues')
    .select('id, current_run_id, smoke_test_runs!inner(id, status)')
    .eq('status', 'running')
    .in('smoke_test_runs.status', ['completed', 'failed', 'timeout', 'cancelled'])
    .limit(20)

  const rows = (queues || []) as unknown as Array<{
    id: string
    current_run_id: string | null
    smoke_test_runs: { id: string; status: string }
  }>

  let fixed = 0
  for (const q of rows) {
    if (!q.current_run_id) continue
    await advanceCampaignIfNeeded(q.current_run_id).catch((err: unknown) => {
      logger.warn('smoke-watchdog', 'orphaned queue recover failed', {
        context: { queue_id: q.id, error: err instanceof Error ? err.message : String(err) },
      })
    })
    fixed++
  }

  return { scanned: rows.length, fixed }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const [a, b, c, d] = await Promise.all([
    recoverTemplateNeverArrived().catch((err) => {
      logger.error('smoke-watchdog', 'caseA failed', {
        context: { error: err instanceof Error ? err.message : String(err) },
      })
      return { scanned: 0, fixed: 0 }
    }),
    recoverStuckMidConversation().catch((err) => {
      logger.error('smoke-watchdog', 'caseB failed', {
        context: { error: err instanceof Error ? err.message : String(err) },
      })
      return { scanned: 0, fixed: 0 }
    }),
    recoverOrphanedQueues().catch((err) => {
      logger.error('smoke-watchdog', 'caseC failed', {
        context: { error: err instanceof Error ? err.message : String(err) },
      })
      return { scanned: 0, fixed: 0 }
    }),
    recoverZombieRuns().catch((err) => {
      logger.error('smoke-watchdog', 'caseD failed', {
        context: { error: err instanceof Error ? err.message : String(err) },
      })
      return { scanned: 0, fixed: 0 }
    }),
  ])

  const summary = {
    elapsed_ms: Date.now() - startedAt,
    template_never_arrived: a,
    stuck_mid_conversation: b,
    orphaned_queues: c,
    zombie_runs: d,
  }
  logger.info('smoke-watchdog', 'sweep complete', { context: summary })
  return NextResponse.json(summary)
}
