// ─── Smoke Tester — motor de conversación autónoma ─────────────────────────
//
// POR QUÉ EXISTE ESTE ARCHIVO (y no un for-loop más en runner.ts):
//
// El runner clásico mantiene UNA función viva haciendo polling: manda el
// mensaje, se queda esperando la respuesta hasta 4 minutos, manda el
// siguiente. Eso funciona para 2-3 mensajes y se cae para un flujo completo:
// Vercel mata la función a los 300s (tope del plan) y la conversación queda
// a medias, con el run colgado en 'running' para siempre.
//
// Aquí el flujo es POR EVENTOS. Nadie espera a nadie:
//
//   POST /run-auto  → manda el mensaje 1 y se muere (200 en ~2s)
//   webhook wzap    → llega la respuesta del agente → la guarda →
//                     espera a que termine la ráfaga (10s de silencio) →
//                     el comprador IA redacta el turno siguiente → lo manda →
//                     se muere
//   webhook wzap    → ... y así hasta el cierre
//
// Cada invocación dura ~30-60s. La conversación completa puede tomar 20
// minutos y no hay ningún límite de plataforma que la corte, porque nunca
// hay una función esperando.
//
// GUARDA DE CONCURRENCIA (turn_token): los agentes tipo Ema mandan 3-5
// mensajes por respuesta. Cada uno dispara un webhook y cada webhook querría
// contestar. Al programar un turno escribimos un token nuevo en el run; al
// despertar, el que ya no tiene el token vigente se retira en silencio. Gana
// el último chunk — que es justo el que vio la respuesta completa.

import { createAdminClient } from '../supabase/admin'
import { sendWzapMessage } from './wzap'
import { nextBuyerMessage, type BuyerPersona } from './buyer-ai'
import { detectTerminalTag } from './prodesa-auditor'
import { logger } from '../logger'
import type { ClosedWith, ConversationEntry } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

/** Silencio necesario para dar por cerrada la ráfaga del agente. */
const SETTLE_SILENCE_MS = 10_000
/** Techo duro del settle: si el agente sigue escribiendo, contestamos igual. */
const SETTLE_HARD_CAP_MS = 60_000
const SETTLE_POLL_MS = 2_000
/** Sin respuesta del agente por más de esto, el run se cierra por timeout. */
export const AUTONOMOUS_STALL_MS = 8 * 60_000
export const DEFAULT_MAX_TURNOS = 14

// ─── Estado del run autónomo ───────────────────────────────────────────────
// Vive en smoke_test_runs.form_data (jsonb que ya existe y que en los runs
// manuales está vacío). Cero migraciones: el smoke tester ya arrastra varias
// pendientes y una más habría dejado la función muerta hasta correrla.

export interface AutonomousState {
  modo: 'autonomo'
  objetivo: string
  persona: BuyerPersona
  contexto?: string | null
  max_turnos: number
  turno: number
  turn_token?: string | null
  motivo_cierre?: string | null
  ultimo_motivo?: string | null
  fuente_comprador?: 'ia' | 'heuristica' | null
}

export function isAutonomous(formData: unknown): formData is AutonomousState {
  return Boolean(
    formData &&
      typeof formData === 'object' &&
      (formData as { modo?: unknown }).modo === 'autonomo'
  )
}

export function newTurnToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

interface RunRow {
  id: string
  suite_id: string
  empresa_id: string
  status: string
  form_data: Record<string, unknown>
}

async function readRun(db: AdminClient, runId: string): Promise<RunRow | null> {
  const { data } = await db
    .from('smoke_test_runs')
    .select('id, suite_id, empresa_id, status, form_data')
    .eq('id', runId)
    .single()
  return (data as RunRow | null) ?? null
}

async function writeState(
  db: AdminClient,
  runId: string,
  patch: Partial<AutonomousState>
): Promise<void> {
  const run = await readRun(db, runId)
  if (!run) return
  const current = (run.form_data || {}) as Record<string, unknown>
  await db
    .from('smoke_test_runs')
    .update({ form_data: { ...current, ...patch } })
    .eq('id', runId)
}

/**
 * Reserva el próximo turno para quien llame de último. Devuelve el token que
 * hay que pasarle a `advanceAutonomousTurn`. Se llama desde el webhook, de
 * forma síncrona, ANTES de programar el trabajo en segundo plano.
 */
export async function scheduleTurn(db: AdminClient, runId: string): Promise<string> {
  const token = newTurnToken()
  await writeState(db, runId, { turn_token: token })
  return token
}

/**
 * Consume el turno reservado. Devuelve false si otro chunk se lo llevó
 * mientras redactábamos: en ese caso NO hay que mandar nada, porque el otro
 * va a contestar con la conversación completa a la vista.
 */
async function claimTurn(
  db: AdminClient,
  runId: string,
  token: string
): Promise<boolean> {
  const run = await readRun(db, runId)
  if (!run || run.status !== 'running') return false
  const state = run.form_data as unknown as AutonomousState
  if (state?.turn_token !== token) return false
  await db
    .from('smoke_test_runs')
    .update({ form_data: { ...(run.form_data || {}), turn_token: null } })
    .eq('id', runId)
  return true
}

async function readConversation(
  db: AdminClient,
  resultId: string
): Promise<ConversationEntry[]> {
  const { data } = await db
    .from('smoke_test_results')
    .select('conversation')
    .eq('id', resultId)
    .single()
  const row = data as { conversation: ConversationEntry[] | null } | null
  return Array.isArray(row?.conversation) ? row!.conversation : []
}

/**
 * Espera a que el agente deje de escribir. Sale cuando pasan
 * SETTLE_SILENCE_MS sin mensajes nuevos, o al llegar al techo duro.
 */
async function settleBurst(
  db: AdminClient,
  resultId: string
): Promise<ConversationEntry[]> {
  const hardDeadline = Date.now() + SETTLE_HARD_CAP_MS
  let conversation = await readConversation(db, resultId)
  let lastLength = conversation.length
  let quietUntil = Date.now() + SETTLE_SILENCE_MS

  while (Date.now() < quietUntil && Date.now() < hardDeadline) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS))
    conversation = await readConversation(db, resultId)
    if (conversation.length > lastLength) {
      lastLength = conversation.length
      quietUntil = Date.now() + SETTLE_SILENCE_MS
    }
  }
  return conversation
}

/** Texto del agente posterior al último mensaje del comprador. */
function lastAgentBlock(conversation: ConversationEntry[]): string {
  const out: string[] = []
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i].role === 'buyer') break
    out.unshift(conversation[i].text)
  }
  return out.join('\n\n')
}

// ─── Cierre ────────────────────────────────────────────────────────────────

export async function closeAutonomousRun(params: {
  db: AdminClient
  runId: string
  resultId: string
  conversation: ConversationEntry[]
  status: 'completed' | 'timeout' | 'failed'
  closedWith: ClosedWith | null
  motivo: string
  errorMessage?: string | null
}): Promise<void> {
  const now = new Date().toISOString()
  await params.db
    .from('smoke_test_results')
    .update({
      status: params.status,
      conversation: params.conversation,
      awaiting_reply: false,
      completed_at: now,
      error_message: params.errorMessage ?? null,
    })
    .eq('id', params.resultId)

  await params.db
    .from('smoke_test_runs')
    .update({
      status: params.status === 'failed' ? 'failed' : 'completed',
      completed_at: now,
      completed_sequences: 1,
      closed_with: params.closedWith,
    })
    .eq('id', params.runId)

  await writeState(params.db, params.runId, {
    turn_token: null,
    motivo_cierre: params.motivo,
  })

  logger.info('smoke-engine', 'run autónomo cerrado', {
    context: {
      run_id: params.runId,
      result_id: params.resultId,
      status: params.status,
      closed_with: params.closedWith,
      motivo: params.motivo,
      mensajes: params.conversation.length,
    },
  })
}

// ─── Un turno ──────────────────────────────────────────────────────────────

interface ResultJoin {
  id: string
  run_id: string
  status: string
  conversation: ConversationEntry[] | null
  smoke_test_sequences: {
    ficha_tecnica: string | null
    proyecto_ref: string | null
  } | null
}

/**
 * Contesta el último bloque del agente y manda el siguiente mensaje del
 * comprador — o cierra la conversación si ya no hay nada más que hacer.
 *
 * Se llama SIEMPRE en segundo plano (waitUntil) desde el webhook. Nunca
 * lanza: cualquier error se registra y deja el run marcado como fallido,
 * porque un throw aquí sería un run colgado en 'running' para siempre.
 */
export async function advanceAutonomousTurn(
  resultId: string,
  token: string
): Promise<void> {
  const db = createAdminClient()

  try {
    // 1. Dejar que el agente termine de escribir.
    const conversation = await settleBurst(db, resultId)

    // 2. Releer estado — puede haber llegado otro chunk que reprogramó el turno.
    const { data: resultData } = await db
      .from('smoke_test_results')
      .select(
        'id, run_id, status, conversation, smoke_test_sequences!inner(ficha_tecnica, proyecto_ref)'
      )
      .eq('id', resultId)
      .single()
    const result = resultData as unknown as ResultJoin | null
    if (!result) return

    const run = await readRun(db, result.run_id)
    if (!run) return
    if (run.status !== 'running') return
    if (!isAutonomous(run.form_data)) return

    const state = run.form_data as unknown as AutonomousState
    if (state.turn_token !== token) {
      // Otro chunk más nuevo se quedó con el turno (o el turno ya se gastó).
      // Nos retiramos: el que tiene el token vigente vio más conversación.
      return
    }

    // 3. ¿El agente cerró con etiqueta?
    const bloque = lastAgentBlock(conversation)
    const tag = detectTerminalTag(bloque)
    if (tag) {
      await closeAutonomousRun({
        db,
        runId: run.id,
        resultId,
        conversation,
        status: 'completed',
        closedWith: tag,
        motivo: `El agente cerró con #${tag}`,
      })
      return
    }

    // 4. ¿Se acabaron los turnos?
    const maxTurnos = state.max_turnos || DEFAULT_MAX_TURNOS
    if (state.turno >= maxTurnos) {
      await closeAutonomousRun({
        db,
        runId: run.id,
        resultId,
        conversation,
        status: 'completed',
        closedWith: 'incomplete',
        motivo: `Se alcanzó el máximo de ${maxTurnos} turnos sin cierre`,
      })
      return
    }

    // 5. El comprador decide qué contestar (o si ya no hay nada que contestar).
    const { data: suiteData } = await db
      .from('smoke_test_suites')
      .select('target_phone, agente_ia_id')
      .eq('id', run.suite_id)
      .single()
    const suite = suiteData as {
      target_phone: string | null
      agente_ia_id: string | null
    } | null
    if (!suite?.target_phone) {
      await closeAutonomousRun({
        db,
        runId: run.id,
        resultId,
        conversation,
        status: 'failed',
        closedWith: null,
        motivo: 'La suite no tiene target_phone',
        errorMessage: 'La suite no tiene target_phone configurado',
      })
      return
    }

    const turn = await nextBuyerMessage({
      conversation,
      objetivo: state.objetivo,
      persona: state.persona,
      contexto: state.contexto ?? result.smoke_test_sequences?.ficha_tecnica ?? null,
      turno: state.turno + 1,
      maxTurnos,
      empresaId: run.empresa_id,
      agenteIaId: suite.agente_ia_id,
    })

    if (turn.terminar || !turn.mensaje) {
      await closeAutonomousRun({
        db,
        runId: run.id,
        resultId,
        conversation,
        status: 'completed',
        closedWith: null,
        motivo: turn.motivo || 'El comprador dio la conversación por terminada',
      })
      return
    }

    // 6. Reclamar el turno JUSTO antes de mandar. Redactar el mensaje toma
    //    varios segundos y en esa ventana puede haber llegado otro chunk que
    //    reprogramó el turno; si pasó, ese otro contestará con la respuesta
    //    completa y nosotros sobramos.
    const claimed = await claimTurn(db, run.id, token)
    if (!claimed) return

    await sendAutonomousBuyerMessage({
      db,
      runId: run.id,
      resultId,
      empresaId: run.empresa_id,
      targetPhone: suite.target_phone,
      texto: turn.mensaje,
      turno: state.turno + 1,
      motivo: turn.motivo,
      fuente: turn.fuente,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('smoke-engine', 'advanceAutonomousTurn falló', {
      context: { result_id: resultId, error: message },
    })
    try {
      const conversation = await readConversation(db, resultId)
      const { data } = await db
        .from('smoke_test_results')
        .select('run_id')
        .eq('id', resultId)
        .single()
      const runId = (data as { run_id: string } | null)?.run_id
      // Solo cerramos si el run sigue vivo Y es autónomo: nunca tumbar por
      // error nuestro un run que ya cerró o que maneja otro runner.
      const run = runId ? await readRun(db, runId) : null
      if (runId && run?.status === 'running' && isAutonomous(run.form_data)) {
        await closeAutonomousRun({
          db,
          runId,
          resultId,
          conversation,
          status: 'failed',
          closedWith: null,
          motivo: 'Error del motor de conversación',
          errorMessage: message,
        })
      }
    } catch {
      /* si ni siquiera podemos cerrar, el watchdog lo recoge */
    }
  }
}

/**
 * Manda un mensaje del comprador por wzap y deja el resultado esperando la
 * respuesta del agente. Compartido por el arranque (`/run-auto`) y por cada
 * turno del motor.
 */
export async function sendAutonomousBuyerMessage(params: {
  db: AdminClient
  runId: string
  resultId: string
  empresaId: string
  targetPhone: string
  texto: string
  turno: number
  motivo?: string
  fuente?: 'ia' | 'heuristica'
}): Promise<{ ok: boolean; error?: string }> {
  const { db, runId, resultId } = params
  // Releemos la conversación en vez de confiar en la que traía el llamador:
  // entre el settle y este punto pudo entrar un chunk rezagado, y escribir
  // una copia vieja lo borraría del historial.
  const conversation = [
    ...(await readConversation(db, resultId)),
    {
      role: 'buyer' as const,
      text: params.texto,
      timestamp: new Date().toISOString(),
    },
  ]

  // Marcamos awaiting_reply ANTES de mandar: si el agente contesta rapidísimo,
  // el webhook tiene que encontrar la fila ya armada.
  await db
    .from('smoke_test_results')
    .update({
      conversation,
      awaiting_reply: true,
      last_buyer_at: new Date().toISOString(),
      status: 'running',
    })
    .eq('id', resultId)

  await writeState(db, runId, {
    turno: params.turno,
    ultimo_motivo: params.motivo ?? null,
    fuente_comprador: params.fuente ?? null,
  })

  logger.info('smoke-engine', 'turno del comprador', {
    empresa_id: params.empresaId,
    context: {
      run_id: runId,
      result_id: resultId,
      turno: params.turno,
      fuente: params.fuente ?? 'n/a',
      target: params.targetPhone,
      preview: params.texto.slice(0, 100),
    },
  })

  try {
    const sent = await sendWzapMessage({
      phone: params.targetPhone,
      message: params.texto,
    })
    if (!sent.ok) {
      throw new Error(`wzap ${sent.status}: ${sent.body.slice(0, 200)}`)
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await closeAutonomousRun({
      db,
      runId,
      resultId,
      conversation: [
        ...conversation,
        {
          role: 'agent' as const,
          text: `[ERROR enviando vía wzap — ${message}]`,
          timestamp: new Date().toISOString(),
        },
      ],
      status: 'failed',
      closedWith: null,
      motivo: 'Falló el envío por wzap',
      errorMessage: message,
    })
    return { ok: false, error: message }
  }
}

/**
 * Red de seguridad para el caso "el agente nunca contestó": sin respuesta no
 * hay webhook, y sin webhook no hay nadie que cierre el run. Se llama desde
 * el GET del run (que la UI ya consulta cada 2.5s) y desde el cron watchdog.
 *
 * Devuelve true si cerró algo.
 */
export async function reapStalledAutonomousRun(
  db: AdminClient,
  runId: string
): Promise<boolean> {
  const run = await readRun(db, runId)
  if (!run || run.status !== 'running' || !isAutonomous(run.form_data)) return false

  const { data } = await db
    .from('smoke_test_results')
    .select('id, conversation, awaiting_reply, last_buyer_at')
    .eq('run_id', runId)
    .order('created_at', { ascending: false })
    .limit(1)
  const result = (data?.[0] ?? null) as {
    id: string
    conversation: ConversationEntry[] | null
    awaiting_reply: boolean
    last_buyer_at: string | null
  } | null
  if (!result || !result.awaiting_reply) return false

  const lastBuyer = result.last_buyer_at ? Date.parse(result.last_buyer_at) : NaN
  if (!Number.isFinite(lastBuyer)) return false
  if (Date.now() - lastBuyer < AUTONOMOUS_STALL_MS) return false

  const conversation = Array.isArray(result.conversation) ? result.conversation : []
  await closeAutonomousRun({
    db,
    runId,
    resultId: result.id,
    conversation: [
      ...conversation,
      {
        role: 'agent' as const,
        text: `[TIMEOUT — el agente no respondió en ${Math.round(
          AUTONOMOUS_STALL_MS / 60_000
        )} minutos]`,
        timestamp: new Date().toISOString(),
      },
    ],
    status: 'timeout',
    closedWith: 'timeout',
    motivo: 'El agente dejó de responder',
  })
  return true
}
