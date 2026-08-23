import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { executeRun } from '@/lib/smoke-tester/runner'
import { logger } from '@/lib/logger'
import type { SequenceMessage } from '@/lib/smoke-tester/types'

export const dynamic = 'force-dynamic'
// 300s = máximo permitido por Vercel Hobby (cap del plan). En Pro/Fluid Compute
// se podría subir a 800s, pero hoy estamos en Hobby y el build falla si pedimos
// más. Con MAX_REPLY_WAIT_MS=240s + BURST_SILENCE_WINDOW_MS=12s una secuencia
// de 3 mensajes puede tomar hasta ~12 min en el peor caso, así que runs largos
// se van a cortar — el smoke-tester debe tolerar ejecuciones truncadas hasta
// que migremos a Pro o partamos el runner en chunks vía Queues/Workflow.
export const maxDuration = 300

export async function POST(
  _req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id, rol')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })
  }
  // Smoke tester abierto a cualquier rol.

  const db = createAdminClient()
  const { data: suite } = (await db
    .from('smoke_test_suites')
    .select('id, empresa_id, agente_ia_id, test_phone, target_phone')
    .eq('id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()) as {
    data: {
      id: string
      empresa_id: string
      agente_ia_id: string | null
      test_phone: string
      target_phone: string | null
    } | null
  }
  if (!suite) {
    return NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 })
  }
  if (!suite.target_phone) {
    return NextResponse.json(
      { error: 'La suite no tiene target_phone — re-créala con el número destino' },
      { status: 400 }
    )
  }

  // ─── Env var precheck ────────────────────────────────────────────────────
  // Without these the runner would call wzap and fail silently inside the
  // fire-and-forget background promise. Surface it now with a clean 400.
  if (!process.env.WZAP_TOKEN || !process.env.WZAP_DEVICE) {
    return NextResponse.json(
      {
        error:
          'Faltan WZAP_TOKEN o WZAP_DEVICE en el entorno de Vercel. Agrégalos en Settings → Environment Variables y vuelve a hacer deploy.',
        missing: {
          WZAP_TOKEN: !process.env.WZAP_TOKEN,
          WZAP_DEVICE: !process.env.WZAP_DEVICE,
        },
      },
      { status: 400 }
    )
  }

  // ─── Auto-cancel stuck/orphaned runs for this suite ─────────────────────
  // If a previous run got killed mid-flight (Vercel function timeout, deploy
  // mid-execution, etc.) it stays stuck in 'running'. Force-cancel them so a
  // new run can start cleanly and the UI doesn't disable the run button.
  const { data: stuckRuns } = await db
    .from('smoke_test_runs')
    .select('id')
    .eq('suite_id', suite.id)
    .in('status', ['running', 'pending'])
  if (stuckRuns && stuckRuns.length > 0) {
    const ids = stuckRuns.map((r) => (r as { id: string }).id)
    await db
      .from('smoke_test_runs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .in('id', ids)
    await db
      .from('smoke_test_results')
      .update({
        status: 'failed',
        error_message: 'Auto-cancelled — un nuevo run reemplazó éste',
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      .in('run_id', ids)
      .in('status', ['pending', 'running'])
    logger.info('smoke-runner', 'auto-cancelled stuck runs', {
      empresa_id: profile.empresa_id,
      context: { suite_id: suite.id, cancelled_run_ids: ids },
    })
  }

  const { data: sequenceRows } = await db
    .from('smoke_test_sequences')
    .select('id, nombre, messages')
    .eq('suite_id', suite.id)
    .order('orden', { ascending: true })

  const sequences = (sequenceRows || []).filter(
    (r) => Array.isArray((r as { messages?: unknown }).messages)
  ) as Array<{ id: string; nombre: string; messages: SequenceMessage[] }>

  if (sequences.length === 0) {
    return NextResponse.json(
      { error: 'La suite no tiene secuencias' },
      { status: 400 }
    )
  }

  const { data: run, error: runErr } = await db
    .from('smoke_test_runs')
    .insert({
      suite_id: suite.id,
      empresa_id: profile.empresa_id,
      status: 'pending',
      total_sequences: sequences.length,
      created_by: user.id,
    })
    .select('id')
    .single()
  if (runErr || !run) {
    return NextResponse.json(
      { error: runErr?.message || 'No se pudo crear el run' },
      { status: 500 }
    )
  }

  const resultRows = sequences.map((s) => ({
    run_id: run.id,
    sequence_id: s.id,
    status: 'pending' as const,
  }))
  const { data: createdResults, error: resultsErr } = await db
    .from('smoke_test_results')
    .insert(resultRows)
    .select('id, sequence_id')
  if (resultsErr) {
    return NextResponse.json({ error: resultsErr.message }, { status: 500 })
  }

  logger.info('smoke-runner', 'kicking off run', {
    empresa_id: profile.empresa_id,
    context: {
      run_id: run.id,
      suite_id: suite.id,
      target_phone: suite.target_phone,
      sequences: sequences.length,
    },
  })

  // Background execution via Vercel waitUntil — the function stays alive
  // until the promise resolves (up to maxDuration), even after we return
  // the response. Without this, fire-and-forget gets killed once the
  // 202 is sent and the runner never actually calls wzap.
  waitUntil(
    executeRun({
      runId: run.id,
      suiteId: suite.id,
      empresaId: profile.empresa_id,
      targetPhone: suite.target_phone as string,
      sequences,
      results: (createdResults || []).map((r) => ({
        id: (r as { id: string }).id,
        sequence_id: (r as { sequence_id: string }).sequence_id,
      })),
    }).catch((err) => {
      logger.error('smoke-runner', 'executeRun threw', {
        empresa_id: profile.empresa_id,
        context: { run_id: run.id, error: err instanceof Error ? err.message : String(err) },
      })
    })
  )

  return NextResponse.json({ run_id: run.id, total_sequences: sequences.length }, { status: 202 })
}
