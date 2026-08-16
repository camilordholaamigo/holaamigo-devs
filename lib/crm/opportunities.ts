import { db, mustWrite, tryWrite, unwrap } from '@/lib/supabase/admin';

/**
 * El CRM propio.
 *
 * Lo que lo hace distinto no es el pipeline —eso lo tiene cualquiera— sino la
 * **trazabilidad de actor**: cada toque sabe quién lo hizo (agente o humano),
 * qué decisión lo originó y cuánto costó.
 *
 * La vista de un lead es una línea de tiempo intercalada:
 *
 *   la CMO propuso el ángulo → SALES envió → el lead respondió →
 *   el agente calificó → EL HUMANO ENTRÓ ACÁ → se agendó → se cerró
 *
 * Ningún CRM del mercado puede pintar esa línea, porque ninguno tiene el
 * concepto de "esta acción la tomó un agente por esta decisión". Y esa columna
 * es lo que después contesta "¿qué decisión de hace 60 días funcionó?" (P4).
 *
 * Ver docs/wiki/20-integraciones-crm-y-habilidades.md
 */

export type Stage = 'nuevo' | 'contactado' | 'interesado' | 'reunion' | 'propuesta' | 'ganada' | 'perdida';
export type ActorType = 'agent' | 'human' | 'system';

export const ETAPAS: Stage[] = [
  'nuevo',
  'contactado',
  'interesado',
  'reunion',
  'propuesta',
  'ganada',
  'perdida',
];

export interface Opportunity {
  id: string;
  organization_id: string;
  lead_id: string | null;
  name: string;
  value_usd: number | null;
  stage: Stage;
  probability: number | null;
  origin_decision_id: string | null;
  owner_type: 'agent' | 'human';
  owner_ref: string | null;
  expected_close: string | null;
  outcome: 'won' | 'lost' | null;
  lost_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface TimelineEntry {
  id: number;
  actor_type: ActorType;
  actor_ref: string;
  action: string;
  channel: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
  decision_id: string | null;
  costo_usd: number | null;
  decision_question: string | null;
  decision_kind: string | null;
}

/**
 * Probabilidad por etapa.
 *
 * Números fijos y no un modelo: con menos de cien oportunidades cerradas,
 * cualquier probabilidad "aprendida" es ruido con decimales. Cuando haya
 * historia, sale de los datos y este objeto desaparece — y hasta entonces, que
 * sea una tabla de constantes hace obvio que es una convención y no una
 * predicción.
 */
const PROBABILIDAD: Record<Stage, number> = {
  nuevo: 0.05,
  contactado: 0.1,
  interesado: 0.25,
  reunion: 0.4,
  propuesta: 0.6,
  ganada: 1,
  perdida: 0,
};

export async function crearOportunidad(args: {
  organizationId: string;
  leadId?: string | null;
  name: string;
  valueUsd?: number | null;
  stage?: Stage;
  channelId?: string | null;
  originDecisionId?: string | null;
  ownerType?: 'agent' | 'human';
  ownerRef?: string | null;
  expectedClose?: string | null;
}): Promise<string> {
  const stage = args.stage ?? 'nuevo';

  const row = unwrap(
    await db()
      .from('opportunities')
      .insert({
        organization_id: args.organizationId,
        lead_id: args.leadId ?? null,
        name: args.name,
        value_usd: args.valueUsd ?? null,
        stage,
        probability: PROBABILIDAD[stage],
        channel_id: args.channelId ?? null,
        origin_decision_id: args.originDecisionId ?? null,
        owner_type: args.ownerType ?? 'agent',
        owner_ref: args.ownerRef ?? 'sales',
        expected_close: args.expectedClose ?? null,
      })
      .select('id')
      .single(),
    'opportunities.insert',
  ) as { id: string };

  await registrarToque({
    organizationId: args.organizationId,
    leadId: args.leadId ?? null,
    opportunityId: row.id,
    actorType: args.ownerType === 'human' ? 'human' : 'agent',
    actorRef: args.ownerRef ?? 'sales',
    action: 'opportunity_created',
    decisionId: args.originDecisionId ?? null,
  });

  return row.id;
}

/**
 * Mueve de etapa y deja el rastro.
 *
 * El toque se escribe SIEMPRE, incluso si la etapa no cambió: "alguien la miró
 * y decidió dejarla donde estaba" es información, y es la que falta cuando una
 * oportunidad lleva tres semanas quieta y nadie sabe si está muerta o si
 * alguien la está trabajando.
 */
export async function moverEtapa(args: {
  opportunityId: string;
  stage: Stage;
  actorType: ActorType;
  actorRef: string;
  decisionId?: string | null;
  note?: string | null;
}): Promise<void> {
  const { data: opp } = await db()
    .from('opportunities')
    .select('organization_id, lead_id, stage')
    .eq('id', args.opportunityId)
    .maybeSingle();

  if (!opp) return;

  const cierra = args.stage === 'ganada' || args.stage === 'perdida';

  await mustWrite(
    db()
      .from('opportunities')
      .update({
        stage: args.stage,
        probability: PROBABILIDAD[args.stage],
        // El `check` de la base exige que `outcome` y `closed_at` vayan juntos:
        // una oportunidad "ganada" sin fecha de cierre rompe cualquier reporte
        // de ciclo de venta, y romperlo en silencio es peor que fallar acá.
        outcome: cierra ? (args.stage === 'ganada' ? 'won' : 'lost') : null,
        closed_at: cierra ? new Date().toISOString() : null,
        lost_reason: args.stage === 'perdida' ? (args.note ?? null) : null,
      })
      .eq('id', args.opportunityId),
    'opportunities.stage',
  );

  await registrarToque({
    organizationId: opp.organization_id,
    leadId: opp.lead_id,
    opportunityId: args.opportunityId,
    actorType: args.actorType,
    actorRef: args.actorRef,
    action: 'stage_change',
    decisionId: args.decisionId ?? null,
    payload: { de: opp.stage, a: args.stage, nota: args.note ?? null },
  });
}

/**
 * Registra un toque. Nunca lanza.
 *
 * Es el equivalente de las trazas en el CRM: perder un toque es un hueco en la
 * línea de tiempo; tumbar el envío de un correo por no poder escribir el toque
 * es una venta menos.
 */
export async function registrarToque(args: {
  organizationId: string;
  leadId?: string | null;
  opportunityId?: string | null;
  actorType: ActorType;
  actorRef: string;
  action: string;
  channel?: string | null;
  decisionId?: string | null;
  costUsd?: number | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await tryWrite(
    db().from('touchpoints').insert({
      organization_id: args.organizationId,
      lead_id: args.leadId ?? null,
      opportunity_id: args.opportunityId ?? null,
      actor_type: args.actorType,
      actor_ref: args.actorRef,
      action: args.action,
      channel: args.channel ?? null,
      decision_id: args.decisionId ?? null,
      cost_usd: args.costUsd ?? null,
      payload: args.payload ?? {},
    }),
    `touchpoints.${args.action}`,
  );
}

/** La línea de tiempo, con el costo de cada paso ya resuelto por la vista. */
export async function timeline(args: {
  leadId?: string | null;
  opportunityId?: string | null;
  limit?: number;
}): Promise<TimelineEntry[]> {
  let query = db()
    .from('lead_timeline')
    .select('*')
    .order('occurred_at')
    .limit(args.limit ?? 200);

  if (args.opportunityId) query = query.eq('opportunity_id', args.opportunityId);
  else if (args.leadId) query = query.eq('lead_id', args.leadId);
  else return [];

  const { data } = await query;
  return (data ?? []) as TimelineEntry[];
}

/** Lo que costó perseguir a este lead, sumando lo que cada paso costó. */
export function costoDeLaLinea(entries: TimelineEntry[]): number {
  const total = entries.reduce((sum, e) => sum + Number(e.costo_usd ?? 0), 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}

export interface PipelineColumna {
  stage: Stage;
  oportunidades: Opportunity[];
  valor_usd: number;
  valor_ponderado_usd: number;
}

/**
 * El pipeline por etapa, con valor ponderado.
 *
 * El ponderado usa la probabilidad de la etapa, que es una convención declarada
 * (ver `PROBABILIDAD`). Se muestra al lado del valor bruto y no en su lugar:
 * un pipeline que solo enseña el ponderado esconde de cuánto se está hablando,
 * y uno que solo enseña el bruto promete lo que no va a entrar.
 */
export async function pipeline(organizationId: string): Promise<PipelineColumna[]> {
  const { data } = await db()
    .from('opportunities')
    .select('*')
    .eq('organization_id', organizationId)
    .order('updated_at', { ascending: false })
    .limit(500);

  const filas = (data ?? []) as Opportunity[];

  return ETAPAS.map((stage) => {
    const oportunidades = filas.filter((o) => o.stage === stage);
    const valor = oportunidades.reduce((sum, o) => sum + Number(o.value_usd ?? 0), 0);
    return {
      stage,
      oportunidades,
      valor_usd: Math.round(valor * 100) / 100,
      valor_ponderado_usd: Math.round(valor * PROBABILIDAD[stage] * 100) / 100,
    };
  });
}

export async function oportunidad(id: string): Promise<Opportunity | null> {
  const { data } = await db().from('opportunities').select('*').eq('id', id).maybeSingle();
  return (data as Opportunity | null) ?? null;
}
