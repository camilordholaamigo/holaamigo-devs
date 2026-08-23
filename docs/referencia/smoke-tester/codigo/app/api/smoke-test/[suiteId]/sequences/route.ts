import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TEMPLATES, applyTemplateVariables } from '@/lib/smoke-tester/templates'
import type { SequenceMessage } from '@/lib/smoke-tester/types'

export const dynamic = 'force-dynamic'

async function ensureSuiteAccess(suiteId: string) {
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
  return { user, empresaId: profile.empresa_id, rol: profile.rol, suite, db }
}

function sanitizeMessages(raw: unknown): SequenceMessage[] | null {
  if (!Array.isArray(raw)) return null
  const out: SequenceMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const text = (item as { text?: unknown }).text
    if (typeof text !== 'string' || text.trim().length === 0) continue
    const delayRaw = (item as { delay?: unknown }).delay
    const delay = typeof delayRaw === 'number' && delayRaw > 0 && delayRaw < 60_000
      ? Math.floor(delayRaw)
      : undefined
    out.push({ text: text.trim(), delay })
  }
  return out
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const ctx = await ensureSuiteAccess(params.suiteId)
  if ('error' in ctx) return ctx.error

  const { data, error } = await ctx.db
    .from('smoke_test_sequences')
    .select('*')
    .eq('suite_id', params.suiteId)
    .order('orden', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: data || [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const ctx = await ensureSuiteAccess(params.suiteId)
  if ('error' in ctx) return ctx.error
  // Smoke tester abierto a cualquier rol.

  const body = await req.json().catch(() => ({}))
  const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : ''
  const proyecto_ref = typeof body.proyecto_ref === 'string' ? body.proyecto_ref : null
  const ficha_tecnica = typeof body.ficha_tecnica === 'string' ? body.ficha_tecnica : null
  const propiedad_id = typeof body.propiedad_id === 'string' ? body.propiedad_id : null

  if (!nombre) {
    return NextResponse.json({ error: 'Nombre requerido' }, { status: 400 })
  }

  let messages: SequenceMessage[] | null = null

  if (typeof body.template_id === 'string' && body.template_id.length > 0) {
    const tpl = TEMPLATES.find((t) => t.id === body.template_id)
    if (!tpl) {
      return NextResponse.json({ error: 'Template inválido' }, { status: 400 })
    }
    const vars = (body.template_vars && typeof body.template_vars === 'object'
      ? body.template_vars
      : {}) as Record<string, string>
    messages = applyTemplateVariables(tpl.messages, {
      proyecto: proyecto_ref || vars.proyecto || nombre,
      ...vars,
    })
  } else {
    messages = sanitizeMessages(body.messages)
  }

  if (!messages || messages.length === 0) {
    return NextResponse.json(
      { error: 'Debes proveer messages o template_id válido' },
      { status: 400 }
    )
  }

  // Optional: load ficha from propiedad
  let resolvedFicha = ficha_tecnica
  if (!resolvedFicha && propiedad_id) {
    const { data: prop } = await ctx.db
      .from('propiedades')
      .select('codigo, ubicacion, ciudad, tipo_inmueble, tipo_negocio, precio, precio_administracion, area_m2, habitaciones, banos, parqueaderos, estrato, descripcion')
      .eq('id', propiedad_id)
      .eq('empresa_id', ctx.empresaId)
      .single()
    if (prop) {
      const lines: string[] = []
      const p = prop as Record<string, unknown>
      if (p.codigo) lines.push(`Código: ${p.codigo}`)
      if (p.tipo_inmueble) lines.push(`Tipo: ${p.tipo_inmueble}`)
      if (p.tipo_negocio) lines.push(`Operación: ${p.tipo_negocio}`)
      if (p.ubicacion) lines.push(`Ubicación: ${p.ubicacion}`)
      if (p.ciudad) lines.push(`Ciudad: ${p.ciudad}`)
      if (p.precio) lines.push(`Precio: COP ${p.precio}`)
      if (p.precio_administracion) lines.push(`Administración: COP ${p.precio_administracion}`)
      if (p.area_m2) lines.push(`Área: ${p.area_m2} m²`)
      if (p.habitaciones != null) lines.push(`Habitaciones: ${p.habitaciones}`)
      if (p.banos != null) lines.push(`Baños: ${p.banos}`)
      if (p.parqueaderos != null) lines.push(`Parqueaderos: ${p.parqueaderos}`)
      if (p.estrato != null) lines.push(`Estrato: ${p.estrato}`)
      if (p.descripcion) lines.push(`\nDescripción:\n${p.descripcion}`)
      resolvedFicha = lines.join('\n')
    }
  }

  // Compute next orden
  const { data: existing } = await ctx.db
    .from('smoke_test_sequences')
    .select('orden')
    .eq('suite_id', params.suiteId)
    .order('orden', { ascending: false })
    .limit(1)
  const nextOrden = existing && existing.length > 0 ? ((existing[0] as { orden: number }).orden ?? 0) + 1 : 0

  const { data, error } = await ctx.db
    .from('smoke_test_sequences')
    .insert({
      suite_id: params.suiteId,
      nombre,
      proyecto_ref,
      messages,
      ficha_tecnica: resolvedFicha,
      propiedad_id,
      orden: nextOrden,
    })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data }, { status: 201 })
}
