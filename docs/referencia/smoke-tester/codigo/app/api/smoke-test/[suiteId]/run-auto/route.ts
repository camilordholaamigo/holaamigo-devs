// ─── Smoke Tester — flujo completo con comprador IA ────────────────────────
// POST /api/smoke-test/[suiteId]/run-auto
//
// Body (todo opcional salvo lo que no tenga default):
//   {
//     objetivo?: string
//     mensaje_inicial?: string        // default: primer mensaje de la 1ª secuencia
//     persona?: { nombre, correo, telefono, ciudad, presupuesto, notas }
//     max_turnos?: number             // default 14
//     contexto?: string               // default: ficha_tecnica de la secuencia
//   }
//
// A diferencia de /run (guion fijo, una función viva esperando), aquí solo
// mandamos el PRIMER mensaje y devolvemos. Cada respuesta del agente entra
// por el webhook de wzap y ahí mismo se redacta y envía el turno siguiente
// (lib/smoke-tester/conversation-engine.ts). Por eso la conversación puede
// durar 20 minutos sin chocar con el tope de 300s de la función.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  DEFAULT_MAX_TURNOS,
  sendAutonomousBuyerMessage,
  type AutonomousState,
} from '@/lib/smoke-tester/conversation-engine'
import { logger } from '@/lib/logger'
import type { BuyerPersona } from '@/lib/smoke-tester/buyer-ai'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DEFAULT_PERSONA: BuyerPersona = {
  nombre: 'Camila Restrepo',
  correo: 'camila.restrepo.pruebas@gmail.com',
  telefono: '3001234567',
  ciudad: 'Bogotá',
  presupuesto: '250 millones',
  notas: 'Busca su primera vivienda, trabaja como diseñadora y quiere mudarse este año.',
}

const DEFAULT_OBJETIVO =
  'Conocer el proyecto, sus precios y condiciones, y terminar agendando una visita a la sala de ventas con fecha y hora.'

interface Body {
  objetivo?: string
  mensaje_inicial?: string
  persona?: Partial<BuyerPersona>
  max_turnos?: number
  contexto?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: { suiteId: string } }
) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })
  }

  let body: Body = {}
  try {
    body = (await req.json()) as Body
  } catch {
    /* body opcional */
  }

  if (!process.env.WZAP_TOKEN || !process.env.WZAP_DEVICE) {
    return NextResponse.json(
      {
        error:
          'Faltan WZAP_TOKEN o WZAP_DEVICE en el entorno de Vercel. Agrégalos en Settings → Environment Variables y vuelve a desplegar.',
        missing: {
          WZAP_TOKEN: !process.env.WZAP_TOKEN,
          WZAP_DEVICE: !process.env.WZAP_DEVICE,
        },
      },
      { status: 400 }
    )
  }

  const db = createAdminClient()

  const { data: suiteRow } = await db
    .from('smoke_test_suites')
    .select('id, empresa_id, agente_ia_id, test_phone, target_phone')
    .eq('id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()
  const suite = suiteRow as {
    id: string
    empresa_id: string
    agente_ia_id: string | null
    test_phone: string
    target_phone: string | null
  } | null
  if (!suite) {
    return NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 })
  }
  if (!suite.target_phone) {
    return NextResponse.json(
      { error: 'La suite no tiene target_phone — re-créala con el número del agente bajo prueba' },
      { status: 400 }
    )
  }

  // La secuencia aporta el mensaje de arranque y la ficha técnica que el
  // comprador usa como contexto. No usamos el resto de sus mensajes: aquí el
  // guion lo escribe la IA turno a turno.
  const { data: seqRows } = await db
    .from('smoke_test_sequences')
    .select('id, nombre, messages, ficha_tecnica, proyecto_ref')
    .eq('suite_id', suite.id)
    .order('orden', { ascending: true })
    .limit(1)
  const sequence = (seqRows?.[0] ?? null) as {
    id: string
    nombre: string
    messages: { text?: string }[] | null
    ficha_tecnica: string | null
    proyecto_ref: string | null
  } | null
  if (!sequence) {
    return NextResponse.json(
      { error: 'La suite no tiene secuencias — crea al menos una con el mensaje de arranque' },
      { status: 400 }
    )
  }

  const mensajeInicial =
    body.mensaje_inicial?.trim() ||
    (Array.isArray(sequence.messages) ? sequence.messages[0]?.text?.trim() : '') ||
    'Hola, vi un proyecto que me interesa y quiero más información.'

  // Cancelar runs colgados de esta suite: con un solo número de pruebas dos
  // conversaciones vivas se pisarían en el webhook.
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
        error_message: 'Auto-cancelado — un nuevo flujo completo reemplazó éste',
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      .in('run_id', ids)
      .in('status', ['pending', 'running'])
  }

  const persona: BuyerPersona = {
    ...DEFAULT_PERSONA,
    ...(body.persona || {}),
  }
  const maxTurnos = Math.max(
    2,
    Math.min(Number(body.max_turnos) || DEFAULT_MAX_TURNOS, 40)
  )

  const state: AutonomousState = {
    modo: 'autonomo',
    objetivo: body.objetivo?.trim() || DEFAULT_OBJETIVO,
    persona,
    contexto: body.contexto?.trim() || sequence.ficha_tecnica || null,
    max_turnos: maxTurnos,
    turno: 0,
    turn_token: null,
  }

  const { data: runInsert, error: runErr } = await db
    .from('smoke_test_runs')
    .insert({
      suite_id: suite.id,
      empresa_id: profile.empresa_id,
      status: 'running',
      started_at: new Date().toISOString(),
      total_sequences: 1,
      created_by: user.id,
      trigger_type: 'manual',
      form_data: state as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()
  if (runErr || !runInsert) {
    return NextResponse.json(
      { error: runErr?.message || 'No se pudo crear el run' },
      { status: 500 }
    )
  }
  const runId = (runInsert as { id: string }).id

  const { data: resultInsert, error: resultErr } = await db
    .from('smoke_test_results')
    .insert({
      run_id: runId,
      sequence_id: sequence.id,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (resultErr || !resultInsert) {
    return NextResponse.json(
      { error: resultErr?.message || 'No se pudo crear el result' },
      { status: 500 }
    )
  }
  const resultId = (resultInsert as { id: string }).id

  logger.info('smoke-engine', 'flujo completo iniciado', {
    empresa_id: profile.empresa_id,
    context: {
      run_id: runId,
      result_id: resultId,
      suite_id: suite.id,
      target: suite.target_phone,
      objetivo: state.objetivo,
      max_turnos: maxTurnos,
    },
  })

  // Turno 1 en primer plano: si wzap rechaza el envío, el usuario lo ve al
  // instante en vez de descubrirlo en los logs.
  const sent = await sendAutonomousBuyerMessage({
    db,
    runId,
    resultId,
    empresaId: profile.empresa_id,
    targetPhone: suite.target_phone,
    texto: mensajeInicial,
    turno: 1,
    motivo: 'Mensaje de arranque',
  })

  if (!sent.ok) {
    return NextResponse.json(
      { error: `No se pudo enviar el primer mensaje: ${sent.error}`, run_id: runId },
      { status: 502 }
    )
  }

  return NextResponse.json(
    {
      run_id: runId,
      result_id: resultId,
      sequence_id: sequence.id,
      max_turnos: maxTurnos,
      objetivo: state.objetivo,
      message:
        'Flujo completo iniciado. Cada respuesta del agente dispara el siguiente turno del comprador IA.',
    },
    { status: 202 }
  )
}
