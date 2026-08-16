import { db, unwrap } from '@/lib/supabase/admin';
import { hasOpenAI } from '@/lib/env';
import { runStructured } from '@/lib/ai/client';
import { CaseStudyDraftSchema } from '@/lib/ai/schemas';
import { CASE_STUDY_SYSTEM } from '@/config/prompts';
import { newRunId } from '@/lib/traces/record';
import { pushFeedItem } from '@/lib/feed/items';

/**
 * Prueba social industrializada.
 *
 * Es la función más subestimada del plan. Escribir el caso de estudio del
 * cliente que acaba de ganar es **puro trabajo humano que nunca se hace porque
 * nadie tiene tiempo** — y agentificado compone: cada cliente que cierra deja un
 * activo que ayuda a cerrar al siguiente.
 *
 * El flujo completo:
 *
 *   deal cerrado → borrador con los números REALES → aprobación del cliente
 *   final → biblioteca de activos → ruteo a los ángulos que lo necesitan
 *
 * Dos reglas que no se negocian:
 *
 *  1. **Los números salen del CRM, no del modelo.** El borrador lleva el nombre
 *     de una empresa real y se le va a pedir permiso a una persona real. Una
 *     cifra inflada no es un texto flojo: es un problema.
 *  2. **Nada se publica sin que el cliente final apruebe.** Es un `check` en la
 *     base, no una costumbre.
 *
 * Ver docs/wiki/19-la-cmo-expandida.md
 */

export interface CasoDetectado {
  id: string;
  cliente: string | null;
  valor_usd: number;
  status: string;
  titulo: string | null;
}

/**
 * Busca deals cerrados que merezcan un caso de estudio.
 *
 * El umbral es relativo, no absoluto: un deal de USD 24.000 es enorme para un
 * negocio de tickets de 800 y es rutina para uno de tickets de 20.000. Se usa el
 * doble del ticket promedio del periodo, con un piso para no disparar en cuentas
 * sin historia.
 */
export async function detectarCasos(args: {
  organizationId: string;
  desde?: Date;
  pisoUsd?: number;
}): Promise<CasoDetectado[]> {
  const desde = args.desde ?? new Date(Date.now() - 2 * 86_400_000);

  const { data: ingresos } = await db()
    .from('revenue_events')
    .select('id, amount_usd, opportunity_id, occurred_at, note')
    .eq('organization_id', args.organizationId)
    .eq('kind', 'new')
    .gte('occurred_at', desde.toISOString())
    .order('amount_usd', { ascending: false })
    .limit(20);

  if (!ingresos || ingresos.length === 0) return [];

  const { data: historicos } = await db()
    .from('revenue_events')
    .select('amount_usd')
    .eq('organization_id', args.organizationId)
    .eq('kind', 'new')
    .limit(500);

  const montos = (historicos ?? []).map((r) => Number(r.amount_usd ?? 0)).filter((m) => m > 0);
  const promedio = montos.length > 0 ? montos.reduce((a, b) => a + b, 0) / montos.length : 0;
  const umbral = Math.max(args.pisoUsd ?? 500, promedio * 2);

  const detectados: CasoDetectado[] = [];

  for (const ingreso of ingresos) {
    if (Number(ingreso.amount_usd) < umbral) continue;

    // El índice único sobre `revenue_event_id` es el que garantiza de verdad
    // que no se repita; esta consulta solo evita el trabajo de redactar otra
    // vez lo que ya existe.
    const { data: existente } = await db()
      .from('case_studies')
      .select('id, status, cliente_nombre, draft')
      .eq('revenue_event_id', ingreso.id)
      .maybeSingle();

    if (existente) continue;

    const contexto = await contextoDelDeal(args.organizationId, ingreso.opportunity_id);

    const caso = unwrap(
      await db()
        .from('case_studies')
        .insert({
          organization_id: args.organizationId,
          revenue_event_id: ingreso.id,
          opportunity_id: ingreso.opportunity_id,
          deal_value_usd: ingreso.amount_usd,
          cliente_nombre: contexto.cliente,
          numbers: {
            valor_usd: Number(ingreso.amount_usd),
            dias_a_cierre: contexto.diasACierre,
            toques: contexto.toques,
            canal: contexto.canal,
          },
          status: 'detected',
        })
        .select('id')
        .single(),
      'case_studies.insert',
    ) as { id: string };

    detectados.push({
      id: caso.id,
      cliente: contexto.cliente,
      valor_usd: Number(ingreso.amount_usd),
      status: 'detected',
      titulo: null,
    });
  }

  return detectados;
}

/** Lo que sabemos del deal, del CRM. Todo verificable, nada estimado. */
async function contextoDelDeal(
  organizationId: string,
  opportunityId: string | null,
): Promise<{ cliente: string | null; diasACierre: number | null; toques: number; canal: string | null }> {
  if (!opportunityId) return { cliente: null, diasACierre: null, toques: 0, canal: null };

  const { data: mensajes } = await db()
    .from('messages')
    .select('sent_at, channel')
    .eq('organization_id', organizationId)
    .not('sent_at', 'is', null)
    .order('sent_at')
    .limit(200);

  const toques = mensajes?.length ?? 0;
  const primero = mensajes?.[0]?.sent_at;
  const ultimo = mensajes?.[mensajes.length - 1]?.sent_at;

  const dias =
    primero && ultimo
      ? Math.max(1, Math.round((new Date(ultimo).getTime() - new Date(primero).getTime()) / 86_400_000))
      : null;

  return {
    cliente: null,
    diasACierre: dias,
    toques,
    canal: mensajes?.[0]?.channel ?? null,
  };
}

/**
 * Redacta el borrador y lo manda a aprobación.
 *
 * El item del feed pide una cosa concreta: el visto bueno del cliente final. No
 * pregunta "¿te gusta?" — pregunta si podemos escribirle a esa persona. Es la
 * diferencia entre un activo que se puede publicar y uno que se queda en la
 * carpeta para siempre.
 */
export async function redactarCaso(caseStudyId: string): Promise<{ ok: boolean; titulo?: string }> {
  const { data: caso } = await db()
    .from('case_studies')
    .select('*')
    .eq('id', caseStudyId)
    .maybeSingle();

  if (!caso || caso.status !== 'detected') return { ok: false };
  if (!hasOpenAI()) return { ok: false };

  const numeros = (caso.numbers ?? {}) as Record<string, unknown>;

  try {
    const result = await runStructured({
      step: 'angles',
      schemaName: 'case_study',
      schema: CaseStudyDraftSchema,
      system: CASE_STUDY_SYSTEM,
      input: [
        `CLIENTE: ${caso.cliente_nombre ?? 'sin nombre registrado (usa "el cliente")'}`,
        '',
        'CIFRAS REALES (las únicas que puedes escribir)',
        ...Object.entries(numeros).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v ?? 'sin dato'}`),
      ].join('\n'),
      organizationId: caso.organization_id,
      role: 'cmo',
      trigger: 'cron',
      runId: newRunId(),
    });

    await db()
      .from('case_studies')
      .update({ draft: result.data, status: 'drafted' })
      .eq('id', caseStudyId);

    await pushFeedItem({
      organizationId: caso.organization_id,
      kind: 'ask',
      role: 'cmo',
      title: `Caso de estudio listo: ${result.data.titulo}`,
      body:
        `${result.data.situacion}\n\n${result.data.que_hicimos}\n\n${result.data.resultado}\n\n` +
        `Cita propuesta: "${result.data.cita_sugerida}"`,
      rationale:
        'Está armado con los números reales del cierre. Falta lo único que no podemos hacer nosotros: ' +
        'pedirle permiso a tu cliente para publicarlo con su nombre.',
      evidence: numeros,
      requires: 'input',
      inputKind: 'aprobacion_cliente',
      severity: 'low',
      payload: { case_study_id: caseStudyId },
      dedupeKey: `caso-${caseStudyId}`,
    });

    return { ok: true, titulo: result.data.titulo };
  } catch (err) {
    console.error('[cmo:prueba-social] no se pudo redactar el caso', err);
    return { ok: false };
  }
}

export async function aprobarCaso(args: {
  caseStudyId: string;
  approvedBy: string;
}): Promise<void> {
  await db()
    .from('case_studies')
    .update({
      status: 'approved',
      approved_by: args.approvedBy,
      approved_at: new Date().toISOString(),
    })
    .eq('id', args.caseStudyId);
}

export async function casosDe(organizationId: string, limit = 20) {
  const { data } = await db()
    .from('case_studies')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}
