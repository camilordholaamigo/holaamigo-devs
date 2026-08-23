import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { reapStalledAutonomousRun } from '@/lib/smoke-tester/conversation-engine'

export const dynamic = 'force-dynamic'

async function ensureRunAccess(runId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id, rol')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return { error: NextResponse.json({ error: 'Sin empresa' }, { status: 400 }) }
  }
  const db = createAdminClient()
  const { data: run } = await db
    .from('smoke_test_runs')
    .select('*')
    .eq('id', runId)
    .eq('empresa_id', profile.empresa_id)
    .single()
  if (!run) {
    return { error: NextResponse.json({ error: 'Run no encontrado' }, { status: 404 }) }
  }
  return { db, run, rol: profile.rol, empresaId: profile.empresa_id }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { runId: string } }
) {
  const ctx = await ensureRunAccess(params.runId)
  if ('error' in ctx) return ctx.error

  // Red de seguridad del flujo autónomo: si el agente nunca contestó no hay
  // webhook que lo cierre, y en el plan Hobby el cron watchdog solo corre una
  // vez al día. La UI consulta este GET cada 2.5s, así que aquí es donde el
  // run colgado se recoge de verdad.
  let run = ctx.run as Record<string, unknown>
  if ((run.status as string) === 'running') {
    const reaped = await reapStalledAutonomousRun(ctx.db, params.runId)
    if (reaped) {
      const { data: refreshed } = await ctx.db
        .from('smoke_test_runs')
        .select('*')
        .eq('id', params.runId)
        .single()
      if (refreshed) run = refreshed as Record<string, unknown>
    }
  }

  const [{ data: results }, { data: sequences }] = await Promise.all([
    ctx.db
      .from('smoke_test_results')
      .select('*')
      .eq('run_id', params.runId)
      .order('created_at', { ascending: true }),
    ctx.db
      .from('smoke_test_sequences')
      .select('id, nombre, proyecto_ref, ficha_tecnica, messages, orden')
      .eq('suite_id', ctx.run.suite_id)
      .order('orden', { ascending: true }),
  ])

  const seqMap = new Map<string, { nombre: string; proyecto_ref: string | null; orden: number }>()
  for (const s of sequences || []) {
    const row = s as { id: string; nombre: string; proyecto_ref: string | null; orden: number }
    seqMap.set(row.id, { nombre: row.nombre, proyecto_ref: row.proyecto_ref, orden: row.orden })
  }

  const enrichedResults = (results || [])
    .map((r) => {
      const row = r as Record<string, unknown> & { sequence_id: string }
      const meta = seqMap.get(row.sequence_id)
      return {
        ...row,
        sequence_nombre: meta?.nombre ?? null,
        sequence_proyecto_ref: meta?.proyecto_ref ?? null,
        sequence_orden: meta?.orden ?? 0,
      }
    })
    .sort((a, b) => (a.sequence_orden as number) - (b.sequence_orden as number))

  return NextResponse.json({
    data: {
      run,
      results: enrichedResults,
      sequences: sequences || [],
    },
  })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { runId: string } }
) {
  const ctx = await ensureRunAccess(params.runId)
  if ('error' in ctx) return ctx.error
  // Smoke tester abierto a cualquier rol.

  const status = (ctx.run as { status: string }).status
  if (!['pending', 'running'].includes(status)) {
    return NextResponse.json(
      { error: 'Solo se pueden cancelar runs activos' },
      { status: 400 }
    )
  }

  const { error } = await ctx.db
    .from('smoke_test_runs')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', params.runId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await ctx.db
    .from('smoke_test_results')
    .update({ status: 'failed', error_message: 'Cancelled by user', completed_at: new Date().toISOString() })
    .eq('run_id', params.runId)
    .in('status', ['pending', 'running'])

  return NextResponse.json({ success: true })
}
