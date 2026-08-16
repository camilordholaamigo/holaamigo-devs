import { db, mustWrite, unwrap } from '@/lib/supabase/admin';

/**
 * La economía del negocio del cliente, por canal.
 *
 * Es lo que le permite al President contestar las dos preguntas que un dueño
 * hace todas las semanas: **cuánto cuesta traer un cliente por cada canal** y
 * **en cuánto se paga solo**.
 *
 * Todo sale de `holaamigo.channel_economics`, que agrega ingresos y gastos por
 * separado antes de unirlos. La versión ingenua —unir los dos lados por canal y
 * agrupar— multiplica cada ingreso por cada gasto del mes: con 10 ingresos y 8
 * gastos reporta 80 veces cada cifra. Por eso el criterio de aceptación es que
 * la vista cuadre contra la suma cruda; no es una formalidad.
 *
 * Ver docs/wiki/18-el-president-como-cro.md
 */

export type ChannelKind =
  | 'outbound_email'
  | 'whatsapp'
  | 'ads'
  | 'partnerships'
  | 'content'
  | 'referral'
  | 'inbound'
  | 'otro';

export type RevenueKind = 'new' | 'expansion' | 'renewal' | 'refund' | 'churn';
export type CostCategory =
  | 'ads'
  | 'tooling'
  | 'data'
  | 'agent_compute'
  | 'human_ops'
  | 'infra'
  | 'credits'
  | 'fee';

export interface ChannelEconomics {
  channel_id: string | null;
  canal: string | null;
  tipo: ChannelKind | null;
  mes: string;
  ingreso_usd: number;
  costo_usd: number;
  margen_usd: number;
  clientes_nuevos: number;
  cac_usd: number | null;
  roas: number | null;
}

const NOMBRE_POR_TIPO: Record<ChannelKind, string> = {
  outbound_email: 'Correo en frío',
  whatsapp: 'WhatsApp',
  ads: 'Pauta',
  partnerships: 'Alianzas',
  content: 'Contenido',
  referral: 'Referidos',
  inbound: 'Inbound',
  otro: 'Otro',
};

/** Devuelve el canal, creándolo si hace falta. Clave plana (ADR 0015). */
export async function ensureChannel(organizationId: string, kind: ChannelKind): Promise<string> {
  const row = unwrap(
    await db()
      .from('channels')
      .upsert(
        { organization_id: organizationId, kind, name: NOMBRE_POR_TIPO[kind] },
        { onConflict: 'organization_id,kind' },
      )
      .select('id')
      .single(),
    'channels.upsert',
  ) as { id: string };
  return row.id;
}

export async function recordRevenue(args: {
  organizationId: string;
  amountUsd: number;
  kind: RevenueKind;
  occurredAt: Date;
  channelKind?: ChannelKind | null;
  opportunityId?: string | null;
  source?: 'manual' | 'hubspot' | 'stripe' | 'wompi' | 'agent' | 'import';
  externalRef?: string | null;
  note?: string | null;
}): Promise<void> {
  const channelId = args.channelKind
    ? await ensureChannel(args.organizationId, args.channelKind)
    : null;

  await mustWrite(
    db()
      .from('revenue_events')
      .upsert(
        {
          organization_id: args.organizationId,
          channel_id: channelId,
          opportunity_id: args.opportunityId ?? null,
          amount_usd: args.amountUsd,
          kind: args.kind,
          occurred_at: args.occurredAt.toISOString(),
          source: args.source ?? 'manual',
          external_ref: args.externalRef ?? null,
          note: args.note ?? null,
        },
        // Sin esto, reimportar un mes de Stripe duplica la facturación entera.
        // El índice es parcial (solo cuando hay `external_ref`), así que el
        // upsert solo se apoya en él cuando la fila viene de una fuente externa.
        args.externalRef ? { onConflict: 'organization_id,source,external_ref' } : undefined,
      ),
    'revenue_events.insert',
  );
}

export async function recordCost(args: {
  organizationId: string;
  amountUsd: number;
  category: CostCategory;
  occurredAt: Date;
  channelKind?: ChannelKind | null;
  vendor?: string | null;
  decisionId?: string | null;
  source?: string;
  externalRef?: string | null;
  note?: string | null;
}): Promise<void> {
  const channelId = args.channelKind
    ? await ensureChannel(args.organizationId, args.channelKind)
    : null;

  await mustWrite(
    db()
      .from('cost_events')
      .upsert(
        {
          organization_id: args.organizationId,
          channel_id: channelId,
          amount_usd: args.amountUsd,
          category: args.category,
          vendor: args.vendor ?? null,
          decision_id: args.decisionId ?? null,
          occurred_at: args.occurredAt.toISOString(),
          source: args.source ?? 'manual',
          external_ref: args.externalRef ?? null,
          note: args.note ?? null,
        },
        args.externalRef ? { onConflict: 'organization_id,source,external_ref' } : undefined,
      ),
    'cost_events.insert',
  );
}

export async function economicsFor(
  organizationId: string,
  opts: { desde?: string; hasta?: string } = {},
): Promise<ChannelEconomics[]> {
  let query = db()
    .from('channel_economics')
    .select('*')
    .eq('organization_id', organizationId)
    .order('mes', { ascending: false });

  if (opts.desde) query = query.gte('mes', opts.desde);
  if (opts.hasta) query = query.lte('mes', opts.hasta);

  const { data, error } = await query;
  if (error) {
    console.error(`[finance:economics] ${error.message}`);
    return [];
  }
  return (data ?? []) as ChannelEconomics[];
}

/**
 * Trae de vuelta los costos de agente al P&G.
 *
 * Sin esto el P&G miente por omisión: muestra lo que se gastó en anuncios y
 * herramientas, y no lo que costó pensar. Corre en el cron nocturno.
 */
export async function importarCostosDeAgentes(organizationId: string, desde?: string): Promise<number> {
  const { data, error } = await db().rpc('importar_costos_de_agentes', {
    p_org: organizationId,
    p_desde: desde ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  });
  if (error) {
    console.error(`[finance:importar_costos] ${error.message}`);
    return 0;
  }
  return Number(data ?? 0);
}

export interface PnL {
  periodo: string;
  ingreso_usd: number;
  costo_usd: number;
  margen_usd: number;
  clientes_nuevos: number;
  cac_promedio_usd: number | null;
  roas: number | null;
  /** Días hasta que un cliente devuelve lo que costó traerlo. */
  payback_dias: number | null;
  por_canal: ChannelEconomics[];
  por_categoria: Record<string, number>;
}

/**
 * El P&G del periodo.
 *
 * `payback_dias` usa el ingreso promedio mensual por cliente del periodo. Es
 * una aproximación y se dice: con contratos de duración distinta, lo correcto
 * es la cohorte, y la cohorte necesita meses de historia que un cliente nuevo
 * no tiene. Cuando los tenga, esta función cambia y el libro de resultados
 * seguirá leyendo lo mismo.
 */
export async function pnl(organizationId: string, periodo: string): Promise<PnL> {
  const desde = `${periodo}-01`;
  const filas = await economicsFor(organizationId, { desde, hasta: desde });

  const ingreso = filas.reduce((sum, f) => sum + Number(f.ingreso_usd ?? 0), 0);
  const costo = filas.reduce((sum, f) => sum + Number(f.costo_usd ?? 0), 0);
  const clientes = filas.reduce((sum, f) => sum + Number(f.clientes_nuevos ?? 0), 0);

  const { data: categorias } = await db()
    .from('cost_events')
    .select('category, amount_usd')
    .eq('organization_id', organizationId)
    .gte('occurred_at', `${desde}T00:00:00Z`)
    .lt('occurred_at', siguienteMes(periodo));

  const porCategoria: Record<string, number> = {};
  for (const row of categorias ?? []) {
    porCategoria[row.category] = (porCategoria[row.category] ?? 0) + Number(row.amount_usd ?? 0);
  }

  const cac = clientes > 0 ? Math.round((costo / clientes) * 100) / 100 : null;
  const arpuMensual = clientes > 0 ? ingreso / clientes : null;
  const payback =
    cac !== null && arpuMensual !== null && arpuMensual > 0
      ? Math.round((cac / (arpuMensual / 30)) * 10) / 10
      : null;

  return {
    periodo,
    ingreso_usd: redondear(ingreso),
    costo_usd: redondear(costo),
    margen_usd: redondear(ingreso - costo),
    clientes_nuevos: clientes,
    cac_promedio_usd: cac,
    roas: costo > 0 ? Math.round((ingreso / costo) * 1000) / 1000 : null,
    payback_dias: payback,
    por_canal: filas,
    por_categoria: Object.fromEntries(
      Object.entries(porCategoria).map(([k, v]) => [k, redondear(v)]),
    ),
  };
}

function siguienteMes(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes, 1));
  return fecha.toISOString();
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/** El periodo actual en formato AAAA-MM. */
export function periodoActual(fecha = new Date()): string {
  return fecha.toISOString().slice(0, 7);
}
