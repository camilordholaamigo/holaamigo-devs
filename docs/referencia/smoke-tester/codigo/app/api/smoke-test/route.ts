import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

async function requireEmpresa(req: NextRequest) {
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
  // Smoke tester abierto a cualquier rol — solo requiere auth + empresa.
  return { user, empresaId: profile.empresa_id, rol: profile.rol }
}

export async function GET(req: NextRequest) {
  const ctx = await requireEmpresa(req)
  if ('error' in ctx) return ctx.error

  const db = createAdminClient()
  const { data: suites, error } = await db
    .from('smoke_test_suites')
    .select('id, nombre, descripcion, test_phone, agente_ia_id, created_at, updated_at')
    .eq('empresa_id', ctx.empresaId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const suiteIds = (suites || []).map((s) => s.id)
  if (suiteIds.length === 0) return NextResponse.json({ data: [] })

  const [{ data: sequenceCounts }, { data: lastRuns }, { data: agents }] = await Promise.all([
    db
      .from('smoke_test_sequences')
      .select('suite_id')
      .in('suite_id', suiteIds),
    db
      .from('smoke_test_runs')
      .select('id, suite_id, status, overall_score, created_at, completed_at')
      .in('suite_id', suiteIds)
      .order('created_at', { ascending: false }),
    db
      .from('agentes_ia')
      .select('id, nombre, canal, numero_whatsapp')
      .eq('empresa_id', ctx.empresaId),
  ])

  const seqCountBySuite: Record<string, number> = {}
  for (const r of sequenceCounts || []) {
    const k = (r as { suite_id: string }).suite_id
    seqCountBySuite[k] = (seqCountBySuite[k] || 0) + 1
  }

  const lastRunBySuite: Record<string, { id: string; status: string; overall_score: number | null; created_at: string; completed_at: string | null }> = {}
  for (const r of lastRuns || []) {
    const row = r as { suite_id: string; id: string; status: string; overall_score: number | null; created_at: string; completed_at: string | null }
    if (!lastRunBySuite[row.suite_id]) {
      lastRunBySuite[row.suite_id] = {
        id: row.id,
        status: row.status,
        overall_score: row.overall_score,
        created_at: row.created_at,
        completed_at: row.completed_at,
      }
    }
  }

  const agentById: Record<string, { id: string; nombre: string; canal: string; numero_whatsapp: string | null }> = {}
  for (const a of agents || []) {
    const row = a as { id: string; nombre: string; canal: string; numero_whatsapp: string | null }
    agentById[row.id] = row
  }

  const data = (suites || []).map((s) => ({
    ...s,
    sequence_count: seqCountBySuite[s.id] || 0,
    last_run: lastRunBySuite[s.id] ?? null,
    agent: agentById[s.agente_ia_id] ?? null,
  }))

  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const ctx = await requireEmpresa(req)
  if ('error' in ctx) return ctx.error

  const body = await req.json().catch(() => ({}))
  const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : ''
  const agente_ia_id = typeof body.agente_ia_id === 'string' && body.agente_ia_id
    ? body.agente_ia_id
    : null
  const target_phone_raw = typeof body.target_phone === 'string' ? body.target_phone.trim() : ''
  const initial_message = typeof body.initial_message === 'string' ? body.initial_message.trim() : ''
  const descripcion = typeof body.descripcion === 'string' ? body.descripcion : null

  if (!nombre) return NextResponse.json({ error: 'Nombre requerido' }, { status: 400 })
  if (!target_phone_raw) return NextResponse.json({ error: 'Número destino requerido' }, { status: 400 })

  // Normalize destination to digits-only.
  const target_phone = target_phone_raw.replace(/[^\d]/g, '')
  // test_phone is the wzap device's WhatsApp number — not strictly needed for
  // sending (wzap routes by device id) but we keep it for display/reporting.
  const test_phone = (typeof body.test_phone === 'string' ? body.test_phone : '').replace(/[^\d]/g, '') || target_phone

  const db = createAdminClient()

  // agente_ia_id is optional — if provided, validate scope to the empresa.
  let agente_id_to_save: string | null = null
  if (agente_ia_id) {
    const { data: agent } = await db
      .from('agentes_ia')
      .select('id')
      .eq('id', agente_ia_id)
      .eq('empresa_id', ctx.empresaId)
      .single()
    if (!agent) {
      return NextResponse.json({ error: 'Agente no encontrado en tu empresa' }, { status: 404 })
    }
    agente_id_to_save = agente_ia_id
  } else {
    // Schema requires agente_ia_id — fall back to any agent in the empresa.
    // If the empresa has no agents at all, auto-create a hidden placeholder
    // so the user can start testing without manually setting one up.
    const { data: anyAgent } = await db
      .from('agentes_ia')
      .select('id')
      .eq('empresa_id', ctx.empresaId)
      .limit(1)
      .maybeSingle()

    if (anyAgent) {
      agente_id_to_save = (anyAgent as { id: string }).id
    } else {
      const { data: placeholder, error: placeholderErr } = await db
        .from('agentes_ia')
        .insert({
          empresa_id: ctx.empresaId,
          nombre: 'Smoke Tester (placeholder)',
          canal: 'whatsapp',
          activo: false,
          metadata: { smoke_tester_placeholder: true },
        })
        .select('id')
        .single()
      if (placeholderErr || !placeholder) {
        return NextResponse.json(
          {
            error:
              placeholderErr?.message ||
              'No se pudo crear el agente placeholder. Crea uno manualmente en /terminal/agentes-ia.',
          },
          { status: 500 }
        )
      }
      agente_id_to_save = (placeholder as { id: string }).id
    }
  }

  const { data: suite, error } = await db
    .from('smoke_test_suites')
    .insert({
      empresa_id: ctx.empresaId,
      agente_ia_id: agente_id_to_save,
      nombre,
      descripcion,
      test_phone,
      target_phone,
      created_by: ctx.user.id,
    })
    .select('id, nombre, agente_ia_id, test_phone, target_phone, created_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // If an initial message was supplied, create the first sequence so the
  // suite is immediately runnable from the dashboard.
  if (initial_message) {
    await db.from('smoke_test_sequences').insert({
      suite_id: (suite as { id: string }).id,
      nombre: 'Conversación inicial',
      messages: [{ text: initial_message }],
      orden: 0,
    })
  }

  return NextResponse.json({ data: suite }, { status: 201 })
}
