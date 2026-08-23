// ─── Smoke Tester — Form-trigger run (Prodesa template flow) ───────────────
// POST /api/smoke-test/[suiteId]/run-form
//
// Body:
//   {
//     project_name: string         // must match prodesa_projects.nombre_proyecto
//     custom_form_data?: Partial<BubbleTemplatePayload>  // overrides for testing
//   }
//
// Flow:
//   1. Validate auth + suite ownership.
//   2. Resolve the Prodesa project metadata.
//   3. Generate the buyer reply sequence for that project.
//   4. Create a smoke_test_sequences row (trigger_type='prodesa_template').
//   5. Create a smoke_test_runs row (trigger_type='form_trigger').
//   6. Create a smoke_test_results row (one per run for form-trigger).
//   7. Fire the Bubble webhook in the background via waitUntil — startFormTriggeredRun
//      flips waiting_for_template=true so the next inbound wzap event (the template)
//      is captured by webhook-handler.ts and resumes the buyer loop.
//   8. Return 202 with run_id + result_id.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { startFormTriggeredRun } from '@/lib/smoke-tester/runner'
import { generateProdesaSequence } from '@/lib/smoke-tester/prodesa-sequence-generator'
import { PRODESA_TEST_DEFAULTS } from '@/lib/smoke-tester/bubble-trigger'
import { logger } from '@/lib/logger'
import type { BubbleTemplatePayload, ProdesaProject } from '@/lib/smoke-tester/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface RunFormBody {
  project_name?: string
  custom_form_data?: Partial<BubbleTemplatePayload>
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

  let body: RunFormBody
  try {
    body = (await req.json()) as RunFormBody
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const projectName = body.project_name?.trim()
  if (!projectName) {
    return NextResponse.json(
      { error: 'project_name es requerido' },
      { status: 400 }
    )
  }

  // Env precheck — Bubble + WZAP are both required for the full flow.
  if (!process.env.BUBBLE_PRODESA_TEMPLATE_URL) {
    return NextResponse.json(
      {
        error: 'BUBBLE_PRODESA_TEMPLATE_URL no está configurada en Vercel',
        missing: { BUBBLE_PRODESA_TEMPLATE_URL: true },
      },
      { status: 400 }
    )
  }
  if (!process.env.WZAP_TOKEN || !process.env.WZAP_DEVICE) {
    return NextResponse.json(
      {
        error: 'Faltan WZAP_TOKEN o WZAP_DEVICE',
        missing: {
          WZAP_TOKEN: !process.env.WZAP_TOKEN,
          WZAP_DEVICE: !process.env.WZAP_DEVICE,
        },
      },
      { status: 400 }
    )
  }

  const db = createAdminClient()

  // 1. Suite must exist and belong to this empresa.
  const { data: suite } = (await db
    .from('smoke_test_suites')
    .select('id, empresa_id, agente_ia_id, target_phone')
    .eq('id', params.suiteId)
    .eq('empresa_id', profile.empresa_id)
    .single()) as {
    data: {
      id: string
      empresa_id: string
      agente_ia_id: string | null
      target_phone: string | null
    } | null
  }
  if (!suite) {
    return NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 })
  }
  if (!suite.target_phone) {
    return NextResponse.json(
      { error: 'La suite no tiene target_phone — re-créala con el número del agente bajo prueba' },
      { status: 400 }
    )
  }

  // 2. Resolve Prodesa project.
  const { data: projectRow, error: projectErr } = await db
    .from('prodesa_projects')
    .select('*')
    .eq('nombre_proyecto', projectName)
    .single()
  if (projectErr || !projectRow) {
    return NextResponse.json(
      {
        error: `Proyecto "${projectName}" no existe en prodesa_projects. Corre el seed (scripts/seed-prodesa-projects.mjs).`,
      },
      { status: 404 }
    )
  }
  const project = projectRow as unknown as ProdesaProject

  // 3. Generate buyer sequence.
  const messages = generateProdesaSequence(project)
  if (messages.length === 0) {
    return NextResponse.json(
      { error: 'Sequence generator devolvió 0 mensajes — revisa los datos del proyecto' },
      { status: 500 }
    )
  }

  // 4. Auto-cancel any stuck runs for this suite (same safety as manual run).
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
        error_message: 'Auto-cancelled — un nuevo form-trigger run reemplazó éste',
        awaiting_reply: false,
        completed_at: new Date().toISOString(),
      })
      .in('run_id', ids)
      .in('status', ['pending', 'running'])
  }

  // 5. Create the sequence row (trigger_type='prodesa_template' so we can
  //    distinguish form-triggered sequences from regular ones in the UI).
  const { data: seqInsert, error: seqErr } = await db
    .from('smoke_test_sequences')
    .insert({
      suite_id: suite.id,
      nombre: `Prodesa · ${project.nombre_proyecto} · ${new Date().toISOString().split('T')[0]}`,
      proyecto_ref: project.nombre_proyecto,
      messages,
      trigger_type: 'prodesa_template',
      prodesa_project_id: project.id,
      orden: 0,
      metadata: {
        generated_at: new Date().toISOString(),
        project_id: project.id,
        categoria: project.categoria,
      },
    })
    .select('id')
    .single()
  if (seqErr || !seqInsert) {
    return NextResponse.json(
      { error: seqErr?.message || 'No se pudo crear la sequence' },
      { status: 500 }
    )
  }
  const sequenceId = (seqInsert as { id: string }).id

  // 6. Build the Bubble payload (defaults + per-request overrides + proyecto).
  const bubblePayload: BubbleTemplatePayload = {
    ...PRODESA_TEST_DEFAULTS,
    ...(body.custom_form_data || {}),
    proyecto: project.nombre_proyecto,
  }

  // 7. Create the run row.
  const { data: runInsert, error: runErr } = await db
    .from('smoke_test_runs')
    .insert({
      suite_id: suite.id,
      empresa_id: profile.empresa_id,
      status: 'pending',
      total_sequences: 1,
      created_by: user.id,
      trigger_type: 'form_trigger',
      form_data: bubblePayload as unknown as Record<string, unknown>,
      waiting_for_template: false,  // flipped to true by startFormTriggeredRun
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

  // 8. Create the result row (one per run for form-trigger).
  const { data: resultInsert, error: resultErr } = await db
    .from('smoke_test_results')
    .insert({
      run_id: runId,
      sequence_id: sequenceId,
      status: 'pending',
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

  logger.info('smoke-runner', 'form-triggered run created', {
    empresa_id: profile.empresa_id,
    context: {
      run_id: runId,
      result_id: resultId,
      suite_id: suite.id,
      proyecto: project.nombre_proyecto,
      categoria: project.categoria,
    },
  })

  // 9. Fire Bubble webhook in the background. The function returns 202 right
  //    away; the user's UI polls run state. The webhook handler picks up the
  //    inbound template and resumes via continueFormTriggeredRun.
  waitUntil(
    startFormTriggeredRun({
      runId,
      resultId,
      bubblePayload,
    }).then((res) => {
      if (!res.ok) {
        logger.error('smoke-runner', 'startFormTriggeredRun failed', {
          empresa_id: profile.empresa_id,
          context: { run_id: runId, error: res.error },
        })
      }
    })
  )

  return NextResponse.json(
    {
      run_id: runId,
      result_id: resultId,
      sequence_id: sequenceId,
      proyecto: project.nombre_proyecto,
      categoria: project.categoria,
      message: 'Form-trigger armado. Esperando plantilla de Prodesa (1-2 min).',
    },
    { status: 202 }
  )
}
