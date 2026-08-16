import { db, mustWrite, tryWrite } from '@/lib/supabase/admin';
import { CREDIT_COST, WELCOME_CREDITS, type CreditAction } from '@/config/credits';

/**
 * Contabilidad de créditos (ADR 0011).
 *
 * Partida simple e inmutable: solo se INSERTA. El saldo es la suma del ledger,
 * nunca una columna. Un saldo guardado se desincroniza el primer día que dos
 * envíos corran a la vez; una suma sobre un ledger inmutable se audita línea
 * por línea cuando el cliente pregunte "¿en qué se me fueron 3.000 créditos?".
 *
 * El débito ocurre en el ENVÍO REAL, no al aprobar la campaña. Aprobar es
 * autorizar un presupuesto; cobrar antes de gastar obligaría a devolver por
 * cada correo que no salió, y "devolver créditos" es una operación que no
 * quiero tener que explicar ni construir.
 */

export async function balance(organizationId: string): Promise<number> {
  const { data, error } = await db().rpc('credit_balance', { org: organizationId });
  if (!error && typeof data === 'number') return data;

  // La función SQL puede no existir todavía en un entorno sin migrar. La suma
  // en cliente es más lenta pero devuelve lo mismo.
  const { data: rows } = await db()
    .from('credit_ledger')
    .select('delta')
    .eq('organization_id', organizationId);
  return (rows ?? []).reduce((sum, row) => sum + Number(row.delta ?? 0), 0);
}

export async function grantCredits(args: {
  organizationId: string;
  credits: number;
  note: string;
  createdBy?: string;
}): Promise<void> {
  // Un abono perdido es saldo que el cliente cree tener y no tiene: se entera
  // cuando una campaña no sale. Tiene que fallar de frente.
  await mustWrite(
    db().from('credit_ledger').insert({
      organization_id: args.organizationId,
      delta: Math.abs(args.credits),
      kind: 'grant',
      note: args.note,
      created_by: args.createdBy ?? 'system',
    }),
    'credit_ledger.grant',
  );
}

/**
 * Débito por una acción. Devuelve el saldo resultante.
 *
 * NO bloquea si el saldo queda negativo: bloquear acá dejaría una secuencia a
 * medias, que es peor que un saldo en rojo. El bloqueo va antes, en el
 * despachador, que revisa saldo antes de armar el lote del día.
 */
export async function debit(args: {
  organizationId: string;
  action: CreditAction;
  quantity?: number;
  referenceTable?: string;
  referenceId?: string | null;
  note?: string;
}): Promise<number> {
  const amount = Math.ceil(CREDIT_COST[args.action] * (args.quantity ?? 1));
  if (amount === 0) return 0;

  // Un débito perdido es plata que no cobramos; una excepción acá es un correo
  // que no sale. Preferimos lo primero — pero queda en el log, que es lo que
  // antes no pasaba: `supabase-js` no lanza y el catch nunca corría.
  await tryWrite(
    db().from('credit_ledger').insert({
      organization_id: args.organizationId,
      delta: -amount,
      kind: args.action,
      reference_table: args.referenceTable ?? null,
      reference_id: args.referenceId ?? null,
      note: args.note ?? null,
    }),
    'credit_ledger.debit',
  );

  return amount;
}

export async function hasCredits(organizationId: string, needed: number): Promise<boolean> {
  return (await balance(organizationId)) >= needed;
}

/** Créditos de bienvenida. Idempotente: si ya se otorgaron, no se repiten. */
export async function grantWelcomeCredits(organizationId: string): Promise<void> {
  const { data } = await db()
    .from('credit_ledger')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('kind', 'grant')
    .limit(1);

  if ((data ?? []).length > 0) return;

  await grantCredits({
    organizationId,
    credits: WELCOME_CREDITS,
    note: 'Créditos de bienvenida: alcanzan para una reactivación completa sin poner tarjeta.',
  });
}

export async function ledgerFor(organizationId: string, limit = 100) {
  const { data } = await db()
    .from('credit_ledger')
    .select('id, created_at, delta, kind, note, reference_table, reference_id')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Consumo agrupado por tipo en los últimos N días. Alimenta la pantalla de
 *  observabilidad: "en qué se está yendo el saldo". */
export async function consumptionByKind(
  organizationId: string,
  days = 30,
): Promise<{ kind: string; credits: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db()
    .from('credit_ledger')
    .select('kind, delta')
    .eq('organization_id', organizationId)
    .lt('delta', 0)
    .gte('created_at', since)
    .limit(10_000);

  const totals = new Map<string, number>();
  for (const row of data ?? []) {
    totals.set(row.kind, (totals.get(row.kind) ?? 0) + Math.abs(Number(row.delta)));
  }
  return [...totals.entries()]
    .map(([kind, credits]) => ({ kind, credits }))
    .sort((a, b) => b.credits - a.credits);
}
