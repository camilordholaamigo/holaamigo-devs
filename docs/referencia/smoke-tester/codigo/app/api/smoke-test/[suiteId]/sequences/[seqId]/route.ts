import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

async function requireAccess(suiteId: string) {
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
    .select('id, empresa_id')
    .eq('id', suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()
  if (!suite) {
    return { error: NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 }) }
  }
  return { db, suite, rol: profile.rol, empresaId: profile.empresa_id }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { suiteId: string; seqId: string } }
) {
  const ctx = await requireAccess(params.suiteId)
  if ('error' in ctx) return ctx.error
  // Smoke tester abierto a cualquier rol.

  const body = await req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.nombre === 'string') patch.nombre = body.nombre.trim()
  if (typeof body.proyecto_ref === 'string') patch.proyecto_ref = body.proyecto_ref
  if (typeof body.ficha_tecnica === 'string') patch.ficha_tecnica = body.ficha_tecnica
  if (Array.isArray(body.messages)) {
    const cleaned = body.messages
      .map((m: unknown) => {
        if (!m || typeof m !== 'object') return null
        const t = (m as { text?: unknown }).text
        if (typeof t !== 'string' || t.trim().length === 0) return null
        const d = (m as { delay?: unknown }).delay
        return {
          text: t.trim(),
          delay: typeof d === 'number' && d > 0 && d < 60_000 ? d : undefined,
        }
      })
      .filter(Boolean)
    if (cleaned.length === 0) {
      return NextResponse.json({ error: 'messages vacío' }, { status: 400 })
    }
    patch.messages = cleaned
  }
  if (typeof body.orden === 'number') patch.orden = body.orden

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Sin cambios' }, { status: 400 })
  }

  const { data, error } = await ctx.db
    .from('smoke_test_sequences')
    .update(patch)
    .eq('id', params.seqId)
    .eq('suite_id', params.suiteId)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { suiteId: string; seqId: string } }
) {
  const ctx = await requireAccess(params.suiteId)
  if ('error' in ctx) return ctx.error
  // Smoke tester abierto a cualquier rol.

  const { error } = await ctx.db
    .from('smoke_test_sequences')
    .delete()
    .eq('id', params.seqId)
    .eq('suite_id', params.suiteId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
