import { db, unwrap } from '@/lib/supabase/admin';
import { balance } from '@/lib/credits';
import { resumenDeStaging, promoverAnalizados } from '@/lib/integrations/hubspot';
import { pushFeedItem } from '@/lib/feed/items';
import { recordDecision } from '@/lib/decisions/record';
import { agentIdFor } from '@/lib/agents/contracts';

/**
 * Lotes de análisis y reactivación.
 *
 * **El sistema propone el tamaño del lote, no el cliente.** El President mira
 * volumen, ticket y saldo y recomienda por dónde empezar:
 *
 *   "De tus 8.400 contactos, empezá con los 1.200 que interactuaron en los
 *    últimos 18 meses — 1.200 créditos, valor proyectado USD 34.000. Si
 *    funciona, seguimos con el resto."
 *
 * Un cliente al que se le pregunta "¿cuántos contactos querés analizar?" elige
 * mal en las dos direcciones: o mil para probar y no ve señal, o los ocho mil
 * de una y gasta el presupuesto del trimestre en una corazonada.
 *
 * Cotización → aprobación → cobro. En ese orden y nunca al revés.
 *
 * Ver docs/wiki/20-integraciones-crm-y-habilidades.md
 */

export type Profundidad = 'segment' | 'enrich' | 'reactivate';

/** Tarifa de referencia del plan §6C. La misma que `holaamigo.tarifa_de_lote`. */
export const TARIFA: Record<Profundidad, number> = {
  segment: 1,
  enrich: 3,
  reactivate: 5,
};

export interface Cotizacion {
  batchId: string | null;
  contactos: number;
  profundidad: Profundidad;
  creditos: number;
  saldo: number;
  alcanza: boolean;
  razon: string;
  valor_proyectado_usd: number;
  saltado?: string;
}

/**
 * Propone el lote con el que conviene empezar.
 *
 * La regla es explicable en una frase y por eso se puede discutir: se empieza
 * por los que interactuaron en los últimos 18 meses, acotado a lo que el saldo
 * alcanza. Si no hay ninguno reciente, se toma un décimo de la base — nunca
 * toda, porque un primer lote que se come el saldo no deja nada para actuar
 * sobre lo que el análisis encuentre.
 */
export async function proponerLote(args: {
  organizationId: string;
  profundidad?: Profundidad;
  ticketPromedioUsd?: number;
}): Promise<Cotizacion> {
  const profundidad = args.profundidad ?? 'segment';
  const [staging, saldo] = await Promise.all([
    resumenDeStaging(args.organizationId),
    balance(args.organizationId),
  ]);

  if (staging.total === 0) {
    return {
      batchId: null,
      contactos: 0,
      profundidad,
      creditos: 0,
      saldo,
      alcanza: false,
      razon: '',
      valor_proyectado_usd: 0,
      saltado: 'no hay contactos en staging',
    };
  }

  const { data: pendiente } = await db()
    .from('analysis_batches')
    .select('id')
    .eq('organization_id', args.organizationId)
    .in('status', ['quoted', 'approved', 'running'])
    .maybeSingle();

  if (pendiente) {
    return {
      batchId: pendiente.id as string,
      contactos: 0,
      profundidad,
      creditos: 0,
      saldo,
      alcanza: false,
      razon: '',
      valor_proyectado_usd: 0,
      saltado: 'ya hay un lote esperando decisión o corriendo',
    };
  }

  const tarifa = TARIFA[profundidad];
  const candidatos =
    staging.con_interaccion_reciente > 0
      ? staging.con_interaccion_reciente
      : Math.max(1, Math.ceil(staging.total / 10));

  // Nunca se propone un lote que no alcanza a pagarse: proponer 5.000 con saldo
  // para 800 es pedirle al cliente que compre créditos antes de haber visto que
  // esto sirve.
  const porSaldo = Math.floor(saldo / tarifa);
  const contactos = Math.max(0, Math.min(candidatos, porSaldo));

  if (contactos === 0) {
    return {
      batchId: null,
      contactos: 0,
      profundidad,
      creditos: 0,
      saldo,
      alcanza: false,
      razon: `hacen falta al menos ${tarifa} créditos y hay ${saldo}`,
      valor_proyectado_usd: 0,
      saltado: 'sin saldo para analizar ni un contacto',
    };
  }

  const creditos = contactos * tarifa;
  const ticket = args.ticketPromedioUsd ?? (await ticketPromedio(args.organizationId));

  // Proyección conservadora y con sus supuestos a la vista: 8% de respuesta
  // sobre la base reactivada, 12% de cierre sobre esa respuesta. Son los
  // benchmarks de reactivación del producto, no una estimación optimista para
  // que la cotización se vea mejor.
  const valorProyectado = Math.round(contactos * 0.08 * 0.12 * ticket);

  const razon =
    staging.con_interaccion_reciente > 0
      ? `De tus ${staging.total} contactos, empezá por los ${contactos} que interactuaron en los últimos 18 meses. ` +
        `Son los más baratos de despertar: ya te conocen.`
      : `Ninguno de tus ${staging.total} contactos tiene interacción reciente registrada, así que arrancamos ` +
        `con ${contactos} —un décimo— para ver qué devuelve antes de gastar en el resto.`;

  const batch = unwrap(
    await db()
      .from('analysis_batches')
      .insert({
        organization_id: args.organizationId,
        source: 'hubspot',
        contact_count: contactos,
        depth: profundidad,
        credits_quoted: creditos,
        quote_reason: razon,
      })
      .select('id')
      .single(),
    'analysis_batches.insert',
  ) as { id: string };

  const presidentId = await agentIdFor(args.organizationId, 'president');
  let decisionId: string | null = null;

  try {
    decisionId = await recordDecision({
      organizationId: args.organizationId,
      agentId: presidentId,
      role: 'president',
      kind: 'allocation',
      question: `¿Con cuántos contactos arrancamos el análisis de la base?`,
      context: { segment: 'reactivacion', channel: 'email' },
      optionsConsidered: [
        {
          label: `${contactos}`,
          pros: ['son los que más probablemente contesten', 'deja saldo para actuar sobre lo que salga'],
          cons: ['deja el resto de la base sin tocar por ahora'],
          est_cost_usd: creditos * 0.02,
          est_impact: `USD ${valorProyectado} proyectados`,
        },
        {
          label: `${staging.total} (toda la base)`,
          pros: ['no queda nada sin analizar'],
          cons: [`cuesta ${staging.total * tarifa} créditos y el saldo es ${saldo}`],
          est_cost_usd: staging.total * tarifa * 0.02,
          est_impact: 'sin saldo para ejecutar lo que el análisis encuentre',
        },
      ],
      chosen: { label: `${contactos}`, payload: { batch_id: batch.id, profundidad } },
      rationale: razon,
      evidence: [
        { type: 'metric', ref: 'staging', note: `${staging.total} en staging, ${staging.con_interaccion_reciente} recientes` },
        { type: 'metric', ref: 'saldo', note: `${saldo} créditos disponibles` },
      ],
      prediction: {
        metric: 'ingreso_usd_reactivacion',
        expected_value: valorProyectado,
        horizon_days: 45,
        confidence: 0.4,
        direction: 'up',
      },
      reversible: true,
    });

    await db().from('analysis_batches').update({ decision_id: decisionId }).eq('id', batch.id);
  } catch (err) {
    console.error('[lotes] no se pudo registrar la decisión', err);
  }

  await pushFeedItem({
    organizationId: args.organizationId,
    kind: 'proposal',
    role: 'president',
    title: `Analizar ${contactos} contactos por ${creditos} créditos`,
    body: `${razon}\n\nSi funciona, seguimos con el resto.`,
    rationale:
      `Proyección: USD ${valorProyectado}, con 8% de respuesta y 12% de cierre sobre esa respuesta. ` +
      'Son los benchmarks de reactivación del producto, no una estimación optimista.',
    evidence: {
      contactos_en_staging: staging.total,
      con_interaccion_reciente: staging.con_interaccion_reciente,
      contactos_del_lote: contactos,
      creditos: creditos,
      saldo_actual: saldo,
      saldo_despues: saldo - creditos,
      valor_proyectado_usd: valorProyectado,
    },
    requires: 'approval',
    severity: 'normal',
    payload: { batch_id: batch.id },
    dedupeKey: `lote-${batch.id}`,
    approval: {
      kind: 'campaign_launch',
      if_approved: `Se cobran ${creditos} créditos y el análisis arranca.`,
      if_rejected: 'No se cobra nada y los contactos siguen esperando en staging.',
      payload: { batch_id: batch.id, creditos },
    },
  });

  return {
    batchId: batch.id,
    contactos,
    profundidad,
    creditos,
    saldo,
    alcanza: saldo >= creditos,
    razon,
    valor_proyectado_usd: valorProyectado,
  };
}

/**
 * Aprueba y cobra. El cobro es atómico en SQL.
 *
 * Entre leer el saldo y escribir el débito, dos aprobaciones simultáneas del
 * mismo lote lo dejarían en negativo. `holaamigo.cobrar_lote` lo hace en una
 * sentencia y usa el estado del lote como candado.
 */
export async function aprobarLote(args: {
  batchId: string;
  by: string;
}): Promise<{ ok: boolean; cobrado?: number; saldo?: number; motivo?: string }> {
  await db().from('analysis_batches').update({ status: 'approved' }).eq('id', args.batchId).eq('status', 'quoted');

  const { data, error } = await db().rpc('cobrar_lote', {
    p_batch: args.batchId,
    p_por: args.by,
  });

  if (error) return { ok: false, motivo: error.message };
  const result = (data ?? {}) as { ok?: boolean; cobrado?: number; saldo_despues?: number; motivo?: string };

  if (!result.ok) return { ok: false, motivo: result.motivo };
  return { ok: true, cobrado: result.cobrado, saldo: result.saldo_despues };
}

/**
 * Corre el análisis: segmenta, clasifica temperatura y arma el plan.
 *
 * La clasificación es **determinista** y por reglas de recencia. Es a propósito
 * (ADR 0007): lo que el cliente compra es un plan de reactivación con cifras
 * que se sostienen, y "el modelo cree que este contacto está tibio" no se
 * sostiene contra la pregunta "¿por qué?".
 */
export async function correrLote(batchId: string): Promise<{
  analizados: number;
  promovidos: number;
  resultados: Record<string, unknown>;
}> {
  const { data: batch } = await db()
    .from('analysis_batches')
    .select('*')
    .eq('id', batchId)
    .maybeSingle();

  if (!batch || batch.status !== 'running') {
    return { analizados: 0, promovidos: 0, resultados: {} };
  }

  const { data: contactos } = await db()
    .from('staging_contacts')
    .select('id, mapped')
    .eq('organization_id', batch.organization_id)
    .eq('status', 'staged')
    .limit(batch.contact_count);

  const filas = (contactos ?? []) as Array<{ id: string; mapped: Record<string, string | null> }>;
  const ahora = Date.now();
  const porTemperatura: Record<string, number> = { hot: 0, warm: 0, cold: 0, dead: 0 };
  const porSegmento: Record<string, number> = {};

  for (const fila of filas) {
    const fecha = fila.mapped?.last_interaction_at;
    const dias = fecha ? Math.floor((ahora - new Date(fecha).getTime()) / 86_400_000) : null;

    // Recencia, y nada más. Un contacto que escribió hace un mes está más cerca
    // de comprar que uno que no contesta hace dos años: no hace falta un modelo
    // para saberlo, y con reglas el cliente puede discutir el umbral.
    const temperatura =
      dias === null ? 'cold' : dias <= 90 ? 'hot' : dias <= 365 ? 'warm' : dias <= 730 ? 'cold' : 'dead';

    const segmento = fila.mapped?.company ? 'con_empresa' : 'sin_empresa';
    porTemperatura[temperatura] += 1;
    porSegmento[segmento] = (porSegmento[segmento] ?? 0) + 1;

    await db()
      .from('staging_contacts')
      .update({
        status: 'analyzed',
        batch_id: batchId,
        analysis: {
          temperatura,
          segmento,
          dias_sin_interaccion: dias,
          motivo:
            dias === null
              ? 'sin fecha de última interacción registrada'
              : `${dias} días desde la última interacción`,
        },
      })
      .eq('id', fila.id);
  }

  const promovidos = await promoverAnalizados(batch.organization_id, batchId);

  const plan = {
    orden: ['hot', 'warm', 'cold'],
    hot: 'Escribir esta semana, mensaje corto que retoma la última conversación.',
    warm: 'Reactivación con novedad: qué cambió desde la última vez que hablaron.',
    cold: 'Ángulo de valor puro, sin pedir reunión en el primer toque.',
    dead: 'No contactar: dos años sin interacción es una queja de spam esperando.',
  };

  const resultados = {
    by_temperature: porTemperatura,
    by_segment: porSegmento,
    contactos_analizados: filas.length,
    contactos_promovidos: promovidos,
    top_opportunities: porTemperatura.hot + porTemperatura.warm,
  };

  await db()
    .from('analysis_batches')
    .update({
      status: 'done',
      results: resultados,
      reactivation_plan: plan,
      finished_at: new Date().toISOString(),
    })
    .eq('id', batchId);

  return { analizados: filas.length, promovidos, resultados };
}

async function ticketPromedio(organizationId: string): Promise<number> {
  const { data } = await db()
    .from('diagnostics')
    .select('assumptions')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1);
  const supuestos = data?.[0]?.assumptions as { avg_ticket_usd?: number } | undefined;
  return supuestos?.avg_ticket_usd ?? 1200;
}

export async function lotesDe(organizationId: string, limit = 20) {
  const { data } = await db()
    .from('analysis_batches')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}
