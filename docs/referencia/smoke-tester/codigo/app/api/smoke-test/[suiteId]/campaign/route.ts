// ─── Campaign API — list + create ─────────────────────────────────────────
// POST creates a new serial campaign queue and kicks off the first project.
// GET lists campaigns for the suite (most recent first).

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { startCampaignQueue } from '@/lib/smoke-tester/campaign-advancer'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface CreateBody {
  project_ids?: string[]
  inter_run_delay_seconds?: number
}

export async function POST(
  req: NextRequest,
  { params }: { params: { suiteId: string } }
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

  let body: CreateBody
  try {
    body = (await req.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const projectIds = Array.isArray(body.project_ids)
    ? body.project_ids.filter((id): id is string => typeof id === 'string')
    : []
  if (projectIds.length === 0) {
    return NextResponse.json(
      { error: 'project_ids es requerido y debe contener al menos un id' },
      { status: 400 }
    )
  }

  const delaySec = Math.max(
    10,
    Math.min(900, body.inter_run_delay_seconds ?? 60)
  )

  if (!process.env.BUBBLE_PRODESA_TEMPLATE_URL) {
    return NextResponse.json(
      { error: 'BUBBLE_PRODESA_TEMPLATE_URL no está configurada' },
      { status: 400 }
    )
  }

  const db = createAdminClient()

  // Suite must belong to this empresa.
  const { data: suite } = (await db
    .from('smoke_test_suites')
    .select('id, target_phone')
    .eq('id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()) as { data: { id: string; target_phone: string | null } | null }
  if (!suite) {
    return NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 })
  }
  if (!suite.target_phone) {
    return NextResponse.json(
      { error: 'La suite no tiene target_phone configurado' },
      { status: 400 }
    )
  }

  // Refuse to start a new queue if there's already one running for this suite.
  const { data: active } = await db
    .from('smoke_campaign_queues')
    .select('id, status')
    .eq('suite_id', suite.id)
    .in('status', ['pending', 'running'])
    .limit(1)
  if (active && active.length > 0) {
    return NextResponse.json(
      {
        error: 'Ya hay una campaña activa para esta suite. Cancélala antes de crear otra.',
        active_queue_id: (active[0] as { id: string }).id,
      },
      { status: 409 }
    )
  }

  // Validate that all project IDs exist (catches stale UI selections early).
  const { data: existingProjects } = await db
    .from('prodesa_projects')
    .select('id')
    .in('id', projectIds)
  const existingIds = new Set(
    (existingProjects || []).map((p) => (p as { id: string }).id)
  )
  const missing = projectIds.filter((id) => !existingIds.has(id))
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `${missing.length} proyectos no existen`,
        missing_ids: missing,
      },
      { status: 400 }
    )
  }

  // Insert the queue row.
  const { data: queueRow, error: queueErr } = await db
    .from('smoke_campaign_queues')
    .insert({
      suite_id: suite.id,
      empresa_id: profile.empresa_id,
      status: 'pending',
      project_ids: projectIds,
      current_index: 0,
      total_projects: projectIds.length,
      inter_run_delay_seconds: delaySec,
      created_by: user.id,
    })
    .select('id')
    .single()
  if (queueErr || !queueRow) {
    return NextResponse.json(
      { error: queueErr?.message || 'No se pudo crear la queue' },
      { status: 500 }
    )
  }
  const queueId = (queueRow as { id: string }).id

  logger.info('smoke-campaign', 'queue created', {
    empresa_id: profile.empresa_id,
    context: {
      queue_id: queueId,
      suite_id: suite.id,
      total_projects: projectIds.length,
      inter_run_delay: delaySec,
    },
  })

  // Kick off the first project in the background. waitUntil keeps the
  // function alive long enough to actually fire Bubble; the rest of the
  // queue progresses via the advancer + watchdog cron.
  waitUntil(
    startCampaignQueue(queueId).catch((err: unknown) => {
      logger.error('smoke-campaign', 'startCampaignQueue threw', {
        context: {
          queue_id: queueId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
  )

  return NextResponse.json(
    {
      queue_id: queueId,
      total_projects: projectIds.length,
      inter_run_delay_seconds: delaySec,
      message: 'Campaña creada. Primer proyecto disparándose en background.',
    },
    { status: 202 }
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { suiteId: string } }
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
  const { data: queues } = await db
    .from('smoke_campaign_queues')
    .select('*')
    .eq('suite_id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .order('created_at', { ascending: false })
    .limit(20)

  return NextResponse.json({ queues: queues || [] })
}
