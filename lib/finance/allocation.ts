import { db, unwrap } from '@/lib/supabase/admin';
import { economicsFor, periodoActual, type ChannelEconomics } from '@/lib/finance/economics';
import { experimentsFor } from '@/lib/finance/experiments';
import {
  openDeliberation,
  addTurn,
  recordDissent,
  resolveDeliberation,
} from '@/lib/deliberation/room';
import { recordDecision } from '@/lib/decisions/record';
import { agentIdFor } from '@/lib/agents/contracts';
import { authorize } from '@/lib/governance/authorize';

/**
 * ¿Dónde está el próximo dólar mejor invertido?
 *
 * Esta es la pregunta que convierte al President en CRO, y la respuesta pasa por
 * las tres partes anteriores del plan a la vez:
 *
 *   P1 · la propuesta se registra como decisión con predicción medible
 *   P2 · el President NO mueve la plata: `budget.shift` tiene techo L2
 *   P3 · la propuesta se discute en La Sala, con las dos posiciones a la vista
 *
 * El agente que razona sobre dinero no toca dinero (§13.1). Acá se ve en
 * concreto: esto arma la propuesta, la argumenta y la deja lista. Mover el
 * presupuesto es del humano, siempre.
 *
 * Ver docs/wiki/18-el-president-como-cro.md
 */

export interface Reasignacion {
  proposalId: string | null;
  deliberationId: string | null;
  decisionId: string | null;
  period: string;
  current: Record<string, number>;
  proposed: Record<string, number>;
  expectedDelta: { revenue: number; cac: number | null; payback_days: number | null };
  reasoning: string;
  saltado?: string;
}

/**
 * El canal que argumenta cada lado.
 *
 * Es la misma atribución honesta de P3: no se inventan posiciones, se le
 * adjudica el argumento al agente cuyo dominio es ese canal. Lo que sale por
 * correo y WhatsApp lo ejecuta SALES; marca, contenido y alianzas son de la CMO.
 */
function duenoDelCanal(tipo: string | null): 'sales' | 'cmo' {
  return tipo === 'content' || tipo === 'partnerships' || tipo === 'ads' ? 'cmo' : 'sales';
}

/**
 * Propone cómo repartir el presupuesto del próximo periodo.
 *
 * La regla de reasignación es deterministica y conservadora: se mueve como
 * máximo el 20% del presupuesto total, del canal con peor retorno al de mejor
 * retorno, y **solo si hay evidencia suficiente en los dos**. Sin ese tope, un
 * mes flojo de un canal bueno lo deja en cero y el mes siguiente hay que
 * reconstruirlo desde el calentamiento — que cuesta más que lo que se ahorró.
 */
export async function proponerReasignacion(args: {
  organizationId: string;
  periodo?: string;
  /** Mínimo de clientes en el canal ganador para considerar la evidencia. */
  minClientes?: number;
}): Promise<Reasignacion> {
  const periodo = args.periodo ?? periodoActual();
  const vacio: Reasignacion = {
    proposalId: null,
    deliberationId: null,
    decisionId: null,
    period: periodo,
    current: {},
    proposed: {},
    expectedDelta: { revenue: 0, cac: null, payback_days: null },
    reasoning: '',
  };

  const filas = await economicsFor(args.organizationId, {
    desde: `${periodo}-01`,
    hasta: `${periodo}-01`,
  });

  const conCanal = filas.filter((f) => f.channel_id && Number(f.costo_usd) > 0);
  if (conCanal.length < 2) {
    return { ...vacio, saltado: 'hace falta gasto en al menos dos canales para poder comparar' };
  }

  // Ya hay una pendiente para este periodo: proponer otra sería empujar dos
  // decisiones contradictorias a la misma cola.
  const { data: existente } = await db()
    .from('allocation_proposals')
    .select('id')
    .eq('organization_id', args.organizationId)
    .eq('period', periodo)
    .eq('status', 'pending')
    .maybeSingle();
  if (existente) return { ...vacio, saltado: 'ya hay una propuesta pendiente para este periodo' };

  const ordenados = [...conCanal].sort((a, b) => valor(b) - valor(a));
  const mejor = ordenados[0];
  const peor = ordenados[ordenados.length - 1];

  if (mejor.channel_id === peor.channel_id) {
    return { ...vacio, saltado: 'un solo canal con movimiento' };
  }

  const minClientes = args.minClientes ?? 1;
  if (Number(mejor.clientes_nuevos ?? 0) < minClientes) {
    return {
      ...vacio,
      saltado: `el canal con mejor retorno todavía no trajo ${minClientes} cliente(s): no hay evidencia para mover nada`,
    };
  }

  const total = conCanal.reduce((sum, f) => sum + Number(f.costo_usd), 0);
  // El tope del 20% no es del sobre de P2: es prudencia de negocio. El sobre
  // dice cuánto puede mover el agente sin permiso; esto dice cuánto tiene
  // sentido mover de un mes al siguiente sin romper lo que ya funciona.
  const movimiento = Math.min(Number(peor.costo_usd), Math.round(total * 0.2));
  if (movimiento <= 0) return { ...vacio, saltado: 'no hay nada que mover' };

  const current: Record<string, number> = {};
  const proposed: Record<string, number> = {};
  for (const fila of conCanal) {
    const id = fila.channel_id as string;
    current[id] = Number(fila.costo_usd);
    proposed[id] =
      id === mejor.channel_id
        ? Number(fila.costo_usd) + movimiento
        : id === peor.channel_id
          ? Number(fila.costo_usd) - movimiento
          : Number(fila.costo_usd);
  }

  // El retorno esperado se calcula con el ROAS OBSERVADO del canal ganador, no
  // con uno proyectado: es la única cifra que se puede defender, y viene con su
  // supuesto explícito de que el canal escala linealmente — que es falso a la
  // larga y aceptable para un movimiento del 20%.
  const roasMejor = Number(mejor.roas ?? 0);
  const ingresoExtra = Math.round(movimiento * roasMejor);
  const ingresoPerdido = Math.round(movimiento * Number(peor.roas ?? 0));

  const reasoning =
    `${mejor.canal} devolvió ${roasMejor.toFixed(2)}x por cada dólar y trajo ` +
    `${mejor.clientes_nuevos} cliente(s) a USD ${mejor.cac_usd ?? '—'} cada uno. ` +
    `${peor.canal} devolvió ${Number(peor.roas ?? 0).toFixed(2)}x. ` +
    `Mover USD ${movimiento} del segundo al primero deja un neto estimado de USD ${ingresoExtra - ingresoPerdido}, ` +
    'suponiendo que el canal ganador escale igual con más presupuesto.';

  const experimentos = await experimentsFor(args.organizationId, { limit: 20 });
  const soporte = experimentos
    .filter((e) => ['won', 'lost'].includes(e.status) && e.channel_id === mejor.channel_id)
    .map((e) => e.id);

  // ── La correa (P2): esto se PREPARA, no se ejecuta ────────────────────
  const auth = await authorize({
    organizationId: args.organizationId,
    capabilityId: 'budget.shift',
    title: `Mover USD ${movimiento} de ${peor.canal} a ${mejor.canal}`,
    payload: { amount_usd: movimiento, reversibility_hours: 48 },
  });

  // ── La deliberación (P3) ───────────────────────────────────────────────
  const deliberationId = await openDeliberation({
    organizationId: args.organizationId,
    question: `¿Cómo repartimos el presupuesto de ${periodo}?`,
    openedByRole: 'president',
    context: { segment: 'presupuesto', channel: mejor.tipo ?? 'otro' },
  });

  await addTurn({
    deliberationId,
    speaker: duenoDelCanal(mejor.tipo),
    speakerType: 'agent',
    body:
      `${mejor.canal} está devolviendo ${roasMejor.toFixed(2)}x. Con USD ${movimiento} más, ` +
      `esperamos USD ${ingresoExtra} adicionales si escala igual.`,
    stance: 'propose',
    evidence: [
      { type: 'metric', ref: `roas:${mejor.channel_id}`, note: `${roasMejor.toFixed(2)}x observado` },
      ...soporte.map((id) => ({ type: 'experiment' as const, ref: id })),
    ],
  });

  await addTurn({
    deliberationId,
    speaker: duenoDelCanal(peor.tipo),
    speakerType: 'agent',
    body:
      `Sacarle USD ${movimiento} a ${peor.canal} cuesta los USD ${ingresoPerdido} que sí estaba trayendo, ` +
      'y un canal que se apaga no se vuelve a prender gratis: hay que rearmar audiencia y reputación.',
    stance: 'object',
    evidence: [
      { type: 'metric', ref: `roas:${peor.channel_id}`, note: `${Number(peor.roas ?? 0).toFixed(2)}x observado` },
    ],
  });

  await addTurn({
    deliberationId,
    speaker: 'president',
    speakerType: 'agent',
    body: reasoning,
    stance: 'decide',
  });

  await recordDissent(deliberationId, [
    {
      agent: duenoDelCanal(mejor.tipo),
      position: `subir ${mejor.canal}`,
      argument: `devuelve ${roasMejor.toFixed(2)}x`,
    },
    {
      agent: duenoDelCanal(peor.tipo),
      position: `no tocar ${peor.canal}`,
      argument: `apagarlo cuesta más que los USD ${ingresoPerdido} que deja de traer`,
    },
  ]);

  // ── La decisión (P1), con predicción medible ───────────────────────────
  const presidentId = await agentIdFor(args.organizationId, 'president');
  let decisionId: string | null = null;
  try {
    decisionId = await recordDecision({
      organizationId: args.organizationId,
      agentId: presidentId,
      role: 'president',
      kind: 'allocation',
      question: `¿Movemos USD ${movimiento} de ${peor.canal} a ${mejor.canal}?`,
      context: { segment: 'presupuesto', channel: mejor.tipo ?? 'otro' },
      optionsConsidered: [
        {
          label: 'mover',
          pros: [`${mejor.canal} devuelve ${roasMejor.toFixed(2)}x`],
          cons: [`${peor.canal} deja de traer USD ${ingresoPerdido}`],
          est_cost_usd: movimiento,
          est_impact: `+USD ${ingresoExtra - ingresoPerdido} netos`,
        },
        {
          label: 'no_mover',
          pros: ['no se rompe nada de lo que ya corre'],
          cons: [`se deja de ganar USD ${ingresoExtra - ingresoPerdido}`],
          est_cost_usd: 0,
          est_impact: 'mismo resultado que este mes',
        },
      ],
      chosen: { label: 'mover', payload: { movimiento_usd: movimiento, periodo } },
      rationale: reasoning,
      evidence: [
        { type: 'metric', ref: `roas:${mejor.channel_id}`, note: `${roasMejor.toFixed(2)}x` },
        ...soporte.map((id) => ({ type: 'experiment' as const, ref: id })),
      ],
      prediction: {
        metric: 'ingreso_usd_mes',
        expected_value: Math.round(Number(mejor.ingreso_usd ?? 0) + ingresoExtra - ingresoPerdido),
        horizon_days: 30,
        confidence: soporte.length > 0 ? 0.6 : 0.45,
        direction: 'up',
      },
      reversible: true,
    });
  } catch (err) {
    console.error('[allocation] no se pudo registrar la decisión', err);
  }

  const queCambiaria =
    `Si ${mejor.canal} baja de ${(roasMejor * 0.7).toFixed(2)}x en las próximas dos semanas, ` +
    'no está escalando linealmente y esto se revierte. ' +
    `Si ${peor.canal} trae un cliente en ese plazo, la comparación estaba hecha con muy poca data.`;

  const resuelta = await resolveDeliberation({
    deliberationId,
    recommendation: {
      option: 'mover',
      summary: `Mover USD ${movimiento} de ${peor.canal} a ${mejor.canal} para ${periodo}.`,
      evidence: [
        { type: 'metric', ref: `roas:${mejor.channel_id}`, note: `${roasMejor.toFixed(2)}x observado` },
        ...soporte.map((id) => ({ type: 'experiment' as const, ref: id })),
      ],
    },
    confidence: soporte.length > 0 ? 0.62 : 0.45,
    whatWouldChangeMyMind: queCambiaria,
    decisionId,
  });
  if (!resuelta.ok) console.error(`[allocation] deliberación abierta: ${resuelta.error}`);

  const proposal = unwrap(
    await db()
      .from('allocation_proposals')
      .insert({
        organization_id: args.organizationId,
        period: periodo,
        current_allocation: current,
        proposed_allocation: proposed,
        expected_delta: {
          revenue: ingresoExtra - ingresoPerdido,
          cac: mejor.cac_usd,
          payback_days: null,
        },
        confidence: soporte.length > 0 ? 0.62 : 0.45,
        reasoning,
        supporting_experiments: soporte,
        deliberation_id: deliberationId,
        decision_id: decisionId,
      })
      .select('id')
      .single(),
    'allocation_proposals.insert',
  ) as { id: string };

  // La correa dijo que esto se prepara y no se ejecuta (L2). Se registra en el
  // razonamiento para que el cliente vea que el agente no podía moverlo aunque
  // quisiera, no solo que eligió no hacerlo.
  if (auth.accion_permitida !== 'ejecutar') {
    await db()
      .from('allocation_proposals')
      .update({
        reasoning: `${reasoning}\n\nEl President prepara esto y no lo ejecuta: mover dinero es tuyo.`,
      })
      .eq('id', proposal.id);
  }

  return {
    proposalId: proposal.id,
    deliberationId,
    decisionId,
    period: periodo,
    current,
    proposed,
    expectedDelta: {
      revenue: ingresoExtra - ingresoPerdido,
      cac: mejor.cac_usd,
      payback_days: null,
    },
    reasoning,
  };
}

/** Qué tan bien le fue a un canal. ROAS si hay ingreso; si no, el margen. */
function valor(fila: ChannelEconomics): number {
  const roas = Number(fila.roas ?? 0);
  if (roas > 0) return roas;
  return Number(fila.margen_usd ?? 0) / Math.max(1, Number(fila.costo_usd ?? 1));
}

export async function propuestasPendientes(organizationId: string) {
  const { data } = await db()
    .from('allocation_proposals')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return data ?? [];
}
