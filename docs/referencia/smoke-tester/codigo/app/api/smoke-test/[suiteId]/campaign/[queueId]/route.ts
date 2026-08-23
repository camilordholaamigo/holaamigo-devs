// ─── Campaign API — single queue (status + cancel) ────────────────────────
// GET   returns the queue + the current run + recent runs in this queue
// PATCH cancels the queue (does NOT abort the running conversation, just
//        prevents the next project from starting)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { suiteId: string; queueId: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })
  }

  const db = createAdminClient()

  const { data: queue } = await db
    .from('smoke_campaign_queues')
    .select('*')
    .eq('id', params.queueId)
    .eq('suite_id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()

  if (!queue) {
    return NextResponse.json({ error: 'Queue no encontrada' }, { status: 404 })
  }

  // Pull the current run (if any) and a snapshot of recent runs in this queue.
  const queueRow = queue as { current_run_id: string | null; project_ids: string[] }
  const [{ data: currentRun }, { data: queueRuns }] = await Promise.all([
    queueRow.current_run_id
      ? db
          .from('smoke_test_runs')
          .select('id, status, closed_with, started_at, completed_at, overall_score')
          .eq('id', queueRow.current_run_id)
          .single()
      : Promise.resolve({ data: null as unknown }),
    db
      .from('smoke_test_runs')
      .select('id, status, closed_with, started_at, completed_at, overall_score, form_data')
      .eq('campaign_queue_id', params.queueId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  return NextResponse.json({
    queue,
    current_run: currentRun || null,
    runs: queueRuns || [],
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { suiteId: string; queueId: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })
  }

  let body: { status?: string }
  try {
    body = (await req.json()) as { status?: string }
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if (body.status !== 'cancelled') {
    return NextResponse.json(
      { error: "Solo se permite status='cancelled'" },
      { status: 400 }
    )
  }

  const db = createAdminClient()

  // Confirm the queue is in this empresa + suite, and is currently running.
  const { data: queueData } = await db
    .from('smoke_campaign_queues')
    .select('id, status')
    .eq('id', params.queueId)
    .eq('suite_id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()
  const queue = queueData as { id: string; status: string } | null
  if (!queue) {
    return NextResponse.json({ error: 'Queue no encontrada' }, { status: 404 })
  }
  if (!['pending', 'running'].includes(queue.status)) {
    return NextResponse.json(
      { error: `Queue ya está ${queue.status}` },
      { status: 400 }
    )
  }

  // Set status='cancelled'. We intentionally DO NOT abort the in-flight run;
  // the advancer checks the queue status after each terminal exit and stops
  // before starting the next project.
  await db
    .from('smoke_campaign_queues')
    .update({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    })
    .eq('id', queue.id)

  logger.info('smoke-campaign', 'queue cancelled by user', {
    empresa_id: profile.empresa_id,
    context: { queue_id: queue.id, by: user.id },
  })

  return NextResponse.json({ ok: true, queue_id: queue.id, status: 'cancelled' })
}
