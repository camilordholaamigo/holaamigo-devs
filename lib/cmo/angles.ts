import { db, mustWrite, unwrap } from '@/lib/supabase/admin';
import { hasOpenAI } from '@/lib/env';
import { runStructured } from '@/lib/ai/client';
import { NewAngleSchema } from '@/lib/ai/schemas';
import { NEW_ANGLE_SYSTEM } from '@/config/prompts';
import { newRunId } from '@/lib/traces/record';
import { currentPositioning } from '@/lib/cmo/positioning';
import { recordDecision } from '@/lib/decisions/record';
import { agentIdFor } from '@/lib/agents/contracts';
import { pushFeedItem } from '@/lib/feed/items';
import { authorize } from '@/lib/governance/authorize';

/**
 * La fábrica de ángulos.
 *
 * Un ángulo no es un texto: es una **hipótesis con estadísticas vivas**. Se
 * propone, se prueba, se mide y se retira cuando muere. Lo que hace posible eso
 * es que cada mensaje enviado sepa de qué ángulo salió — y hasta P5 no lo sabía,
 * así que `angles.sent` y `angles.replied` eran columnas decorativas.
 *
 * La saturación se detecta en SQL (`holaamigo.saturacion_de_angulos`): compara
 * la tasa de respuesta de la ventana reciente contra la anterior. Todo el
 * juicio numérico es determinista y verificable con una consulta; el modelo solo
 * escribe el ángulo nuevo (ADR 0007).
 *
 * Ver docs/wiki/19-la-cmo-expandida.md
 */

export interface Saturacion {
  angle_id: string;
  nombre: string;
  enviados_recientes: number;
  respuestas_recientes: number;
  tasa_reciente: number | null;
  enviados_previos: number;
  respuestas_previas: number;
  tasa_previa: number | null;
  caida: number | null;
  saturado: boolean;
}

export async function evaluarSaturacion(
  organizationId: string,
  opts: { dias?: number; minMuestra?: number; caida?: number } = {},
): Promise<Saturacion[]> {
  const { data, error } = await db().rpc('saturacion_de_angulos', {
    p_org: organizationId,
    p_dias: opts.dias ?? 14,
    p_min_muestra: opts.minMuestra ?? 30,
    p_caida: opts.caida ?? 0.4,
  });

  if (error) {
    console.error(`[cmo:saturacion] ${error.message}`);
    return [];
  }

  const filas = (data ?? []) as Saturacion[];

  // Se guarda el puntaje en el ángulo aunque no esté saturado: es lo que
  // permite ver la tendencia antes de que cruce el umbral, en vez de enterarse
  // el día que ya se quemó.
  for (const fila of filas) {
    await db()
      .from('angles')
      .update({ saturation_score: fila.caida, last_evaluated_at: new Date().toISOString() })
      .eq('id', fila.angle_id);
  }

  return filas;
}

export interface ReemplazoPropuesto {
  angleId: string;
  nombre: string;
  reemplazaA: string;
  feedItemId: string | null;
  decisionId: string | null;
}

/**
 * Propone el ángulo que reemplaza al que se quemó.
 *
 * Pasa por la correa (`angle.propose`) igual que todo lo demás. Aunque proponer
 * sea de las capacidades más inocuas del catálogo —techo L5, clase `read`—, el
 * punto de P2 es que **no haya excepciones**: la primera acción que se salta el
 * motor es la que enseña que el motor es opcional.
 */
export async function proponerReemplazo(args: {
  organizationId: string;
  saturado: Saturacion;
}): Promise<ReemplazoPropuesto | null> {
  const { data: viejo } = await db()
    .from('angles')
    .select('id, name, hypothesis, target_segment, variants')
    .eq('id', args.saturado.angle_id)
    .maybeSingle();

  if (!viejo) return null;

  const auth = await authorize({
    organizationId: args.organizationId,
    capabilityId: 'angle.propose',
    title: `Proponer un ángulo que reemplace a «${viejo.name}»`,
    payload: { volume: 1, reversibility_hours: 0 },
  });
  if (auth.accion_permitida === 'nada') return null;

  const posicionamiento = await currentPositioning(args.organizationId);
  const nuevo = await escribirAngulo({
    organizationId: args.organizationId,
    viejo,
    saturado: args.saturado,
    posicionamiento,
  });
  if (!nuevo) return null;

  const insertado = unwrap(
    await db()
      .from('angles')
      .insert({
        organization_id: args.organizationId,
        name: nuevo.name,
        hypothesis: nuevo.hypothesis,
        target_segment: nuevo.target_segment || viejo.target_segment,
        variants: [{ label: 'apertura', body: nuevo.opener }],
        status: 'proposed',
        parent_angle_id: viejo.id,
        positioning_version: posicionamiento?.version ?? null,
      })
      .select('id')
      .single(),
    'angles.insert',
  ) as { id: string };

  const cmoId = await agentIdFor(args.organizationId, 'cmo');
  let decisionId: string | null = null;

  try {
    decisionId = await recordDecision({
      organizationId: args.organizationId,
      agentId: cmoId,
      role: 'cmo',
      kind: 'angle_select',
      question: `El ángulo «${viejo.name}» se quemó. ¿Con cuál lo reemplazamos?`,
      context: { segment: viejo.target_segment ?? null, channel: 'email' },
      optionsConsidered: [
        {
          label: nuevo.name,
          pros: [nuevo.por_que_distinto],
          cons: ['sin datos propios todavía'],
          est_impact: `volver a la tasa previa de ${pct(args.saturado.tasa_previa)}`,
        },
        {
          label: `insistir con ${viejo.name}`,
          pros: ['ya está aprobado y probado'],
          cons: [`la respuesta cayó ${pct(args.saturado.caida)} en dos semanas`],
          est_impact: `seguir en ${pct(args.saturado.tasa_reciente)}`,
        },
      ],
      chosen: { label: nuevo.name, payload: { angle_id: insertado.id } },
      rationale: nuevo.por_que_distinto,
      evidence: [
        {
          type: 'metric',
          ref: `saturacion:${viejo.id}`,
          note: `de ${pct(args.saturado.tasa_previa)} a ${pct(args.saturado.tasa_reciente)} sobre ${args.saturado.enviados_recientes} envíos`,
        },
      ],
      prediction: {
        metric: 'reply_rate',
        // Se predice recuperar la tasa previa, no superarla: prometer que el
        // ángulo nuevo va a ser mejor que el viejo en su mejor momento es la
        // clase de optimismo que después arruina la calibración.
        expected_value: Number(args.saturado.tasa_previa ?? 0),
        horizon_days: 14,
        confidence: 0.45,
        direction: 'up',
      },
      reversible: true,
    });
  } catch (err) {
    console.error('[cmo:angulos] no se pudo registrar la decisión', err);
  }

  const item = await pushFeedItem({
    organizationId: args.organizationId,
    kind: 'proposal',
    role: 'cmo',
    title: `«${viejo.name}» se quemó: propongo «${nuevo.name}»`,
    body:
      `La respuesta de «${viejo.name}» cayó de ${pct(args.saturado.tasa_previa)} a ` +
      `${pct(args.saturado.tasa_reciente)} en dos semanas, sobre ${args.saturado.enviados_recientes} envíos. ` +
      `${nuevo.por_que_distinto}\n\nAsí abre el nuevo:\n"${nuevo.opener}"`,
    rationale: nuevo.hypothesis,
    evidence: {
      envios_recientes: args.saturado.enviados_recientes,
      respuesta_antes: pct(args.saturado.tasa_previa),
      respuesta_ahora: pct(args.saturado.tasa_reciente),
      caida: pct(args.saturado.caida),
    },
    requires: 'approval',
    severity: 'normal',
    payload: { angle_id: insertado.id, replaces: viejo.id },
    dedupeKey: `angulo-quemado-${viejo.id}`,
    approval: {
      kind: 'angle_new',
      if_approved: 'SALES puede usar el ángulo nuevo y el viejo se retira.',
      if_rejected: 'Se sigue con el ángulo actual y la CMO no vuelve a proponer sobre este.',
      payload: { angle_id: insertado.id, replaces: viejo.id },
    },
  });

  return {
    angleId: insertado.id,
    nombre: nuevo.name,
    reemplazaA: viejo.name,
    feedItemId: item?.id ?? null,
    decisionId,
  };
}

async function escribirAngulo(args: {
  organizationId: string;
  viejo: { name: string; hypothesis: string | null; target_segment: string | null };
  saturado: Saturacion;
  posicionamiento: Awaited<ReturnType<typeof currentPositioning>>;
}) {
  if (!hasOpenAI()) return null;

  try {
    const result = await runStructured({
      step: 'angles',
      schemaName: 'new_angle',
      schema: NewAngleSchema,
      system: NEW_ANGLE_SYSTEM,
      input: [
        `ÁNGULO QUEMADO: ${args.viejo.name}`,
        `SU HIPÓTESIS ERA: ${args.viejo.hypothesis ?? 'sin declarar'}`,
        `SEGMENTO: ${args.viejo.target_segment ?? 'general'}`,
        '',
        'LOS NÚMEROS (ya calculados, no los recalcules)',
        `- Respuesta hace dos semanas: ${pct(args.saturado.tasa_previa)} sobre ${args.saturado.enviados_previos} envíos`,
        `- Respuesta ahora: ${pct(args.saturado.tasa_reciente)} sobre ${args.saturado.enviados_recientes} envíos`,
        `- Caída: ${pct(args.saturado.caida)}`,
        '',
        args.posicionamiento
          ? [
              `POSICIONAMIENTO VIGENTE: ${args.posicionamiento.statement}`,
              `DIFERENCIADORES: ${args.posicionamiento.differentiators.join(' · ')}`,
              `LO QUE LA MARCA NUNCA DICE: ${args.posicionamiento.forbidden_claims.join(' · ')}`,
            ].join('\n')
          : 'POSICIONAMIENTO: sin declarar todavía.',
      ].join('\n'),
      organizationId: args.organizationId,
      role: 'cmo',
      trigger: 'cron',
      runId: newRunId(),
    });
    return result.data;
  } catch (err) {
    // Sin ángulo nuevo no se propone nada. Es mejor que el cliente vea que
    // nadie le propuso un reemplazo a que reciba un reemplazo genérico: un
    // ángulo malo se aprueba, se envía y quema el segmento de verdad.
    console.error('[cmo:angulos] el modelo no pudo escribir el reemplazo', err);
    return null;
  }
}

export async function retirarAngulo(angleId: string, motivo: string): Promise<void> {
  await mustWrite(
    db().from('angles').update({ status: 'retired', retired_reason: motivo }).eq('id', angleId),
    'angles.retire',
  );
}

export async function anglesFor(organizationId: string, limit = 50) {
  const { data } = await db()
    .from('angles')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

function pct(valor: number | null): string {
  if (valor === null || valor === undefined) return '—';
  return `${Math.round(Number(valor) * 1000) / 10}%`;
}
