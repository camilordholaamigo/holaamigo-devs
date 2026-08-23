import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  evaluateConversation,
  aggregateRunSummary,
} from '@/lib/smoke-tester/evaluator'
import { logger } from '@/lib/logger'
import type { ConversationEntry } from '@/lib/smoke-tester/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(
  _req: NextRequest,
  { params }: { params: { runId: string } }
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
  const { data: run } = await db
    .from('smoke_test_runs')
    .select('*')
    .eq('id', params.runId)
    .eq('empresa_id', profile.empresa_id)
    .single()
  if (!run) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 })
  }

  const { data: suite } = await db
    .from('smoke_test_suites')
    .select('agente_ia_id')
    .eq('id', (run as { suite_id: string }).suite_id)
    .single()
  if (!suite) {
    return NextResponse.json({ error: 'Suite no encontrada' }, { status: 404 })
  }

  const { data: agent } = await db
    .from('agentes_ia')
    .select('instrucciones')
    .eq('id', (suite as { agente_ia_id: string }).agente_ia_id)
    .single()

  const { data: results } = await db
    .from('smoke_test_results')
    .select('id, sequence_id, status, conversation')
    .eq('run_id', params.runId)
    .eq('status', 'completed')

  const completed = results || []
  if (completed.length === 0) {
    return NextResponse.json(
      { error: 'No hay resultados completados para evaluar' },
      { status: 400 }
    )
  }

  const sequenceIds = completed.map((r) => (r as { sequence_id: string }).sequence_id)
  const { data: sequences } = await db
    .from('smoke_test_sequences')
    .select('id, nombre, proyecto_ref, ficha_tecnica')
    .in('id', sequenceIds)

  const seqMap = new Map<string, { nombre: string; proyecto_ref: string | null; ficha_tecnica: string | null }>()
  for (const s of sequences || []) {
    const row = s as { id: string; nombre: string; proyecto_ref: string | null; ficha_tecnica: string | null }
    seqMap.set(row.id, row)
  }

  const evaluations: import('@/lib/smoke-tester/types').EvaluationResult[] = []
  let evaluated = 0
  let failed = 0

  for (const r of completed) {
    const result = r as { id: string; sequence_id: string; conversation: ConversationEntry[] }
    const seq = seqMap.get(result.sequence_id)
    if (!seq) continue
    const conversation = Array.isArray(result.conversation) ? result.conversation : []
    if (conversation.length === 0) continue

    try {
      const evalResult = await evaluateConversation({
        conversation,
        fichaTecnica: seq.ficha_tecnica,
        instrucciones: (agent as { instrucciones?: string | null } | null)?.instrucciones ?? null,
        proyectoNombre: seq.proyecto_ref || seq.nombre,
      })

      await db
        .from('smoke_test_results')
        .update({
          score: evalResult.overall_score,
          evaluation: evalResult,
        })
        .eq('id', result.id)

      evaluations.push(evalResult)
      evaluated++
    } catch (err) {
      failed++
      logger.warn('smoke-evaluate', `evaluation failed for ${result.id}`, {
        empresa_id: profile.empresa_id,
        context: { error: err instanceof Error ? err.message : String(err) },
      })
      await db
        .from('smoke_test_results')
        .update({
          evaluation: {
            error: err instanceof Error ? err.message : String(err),
          },
        })
        .eq('id', result.id)
    }
  }

  const summary = aggregateRunSummary(evaluations)
  await db
    .from('smoke_test_runs')
    .update({
      overall_score: summary.average_score,
      summary,
    })
    .eq('id', params.runId)

  return NextResponse.json({
    evaluated,
    failed,
    overall_score: summary.average_score,
    summary,
  })
}
