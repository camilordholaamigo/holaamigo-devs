import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

async function ensureSuiteAccess(req: NextRequest, suiteId: string) {
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
  const { data: suite } = await db
    .from('smoke_test_suites')
    .select('*')
    .eq('id', suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()
  if (!suite) {
    return { error: NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 }) }
  }
  return { user, empresaId: profile.empresa_id, rol: profile.rol, suite, db }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const ctx = await ensureSuiteAccess(req, params.suiteId)
  if ('error' in ctx) return ctx.error

  const [{ data: sequences }, { data: runs }, { data: agent }] = await Promise.all([
    ctx.db
      .from('smoke_test_sequences')
      .select('*')
      .eq('suite_id', params.suiteId)
      .order('orden', { ascending: true }),
    ctx.db
      .from('smoke_test_runs')
      .select('id, status, started_at, completed_at, total_sequences, completed_sequences, overall_score, created_at')
      .eq('suite_id', params.suiteId)
      .order('created_at', { ascending: false })
      .limit(20),
    ctx.db
      .from('agentes_ia')
      .select('id, nombre, canal, numero_whatsapp, channel_uuid_callbell, instrucciones')
      .eq('id', ctx.suite.agente_ia_id)
      .single(),
  ])

  return NextResponse.json({
    data: {
      ...ctx.suite,
      sequences: sequences || [],
      runs: runs || [],
      agent: agent || null,
    },
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const ctx = await ensureSuiteAccess(req, params.suiteId)
  if ('error' in ctx) return ctx.error
  // Smoke tester abierto a cualquier rol.

  const body = await req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.nombre === 'string') patch.nombre = body.nombre.trim()
  if (typeof body.descripcion === 'string') patch.descripcion = body.descripcion
  if (typeof body.test_phone === 'string') patch.test_phone = body.test_phone.trim()

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Sin cambios' }, { status: 400 })
  }

  const { data, error } = await ctx.db
    .from('smoke_test_suites')
    .update(patch)
    .eq('id', params.suiteId)
    .select('id, nombre, descripcion, test_phone, updated_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const ctx = await ensureSuiteAccess(req, params.suiteId)
  if ('error' in ctx) return ctx.error
  // Smoke tester abierto a cualquier rol.

  const { error } = await ctx.db
    .from('smoke_test_suites')
    .delete()
    .eq('id', params.suiteId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
