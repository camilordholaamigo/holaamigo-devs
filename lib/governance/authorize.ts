import { db } from '@/lib/supabase/admin';
import type { Authorization, AuthorizePayload } from '@/lib/governance/types';

/**
 * La única puerta.
 *
 * **Ninguna herramienta se ejecuta sin pasar por acá.** No es una convención de
 * estilo: es lo que convierte la lista de permisos en español de
 * `agents.permissions` —que ningún código consultaba— en una máquina que sí
 * frena.
 *
 * La decisión vive en SQL (`holaamigo.autorizar`) por tres razones, en orden:
 *
 *   1. Escribe la auditoría en la misma transacción en que decide. Un motor de
 *      aplicación se puede llamar y olvidar de registrar; este no.
 *   2. El conteo de volumen del sobre es una consulta. Acá serían dos viajes a
 *      la base con una carrera en el medio.
 *   3. Se prueba contra Postgres real (`scripts/test-gobierno.mjs`).
 *
 * Esta función es la envoltura tipada y el punto donde se decide qué pasa
 * cuando el motor mismo falla.
 *
 * Ver docs/wiki/16-gobierno-capacidades-y-sobres.md
 */

export interface AuthorizeArgs {
  organizationId: string;
  capabilityId: string;
  payload?: AuthorizePayload;
  agentId?: string | null;
  /** Título de la tarjeta si hace falta crear una. En español, para el cliente. */
  title?: string | null;
  /** La decisión (P1) que originó esta acción. Enlaza gobierno con aprendizaje. */
  decisionId?: string | null;
  /** Una aprobación humana que el llamador ya tiene. Evita pedir dos veces. */
  approvalId?: string | null;
  /** `true` para simular sin dejar rastro ni crear tarjetas. */
  dryRun?: boolean;
}

/**
 * El veredicto que se devuelve cuando el motor no responde.
 *
 * Falla CERRADO. Es incómodo —una caída de la base frena a los agentes— y es la
 * única opción defendible: la alternativa es que un timeout se convierta en
 * permiso para mandarle correos a mil personas.
 */
function bloqueoPorFalla(capabilityId: string, motivo: string): Authorization {
  return {
    verdict: 'blocked',
    capability_id: capabilityId,
    requested_level: null,
    effective_level: 0,
    ceilings: { platform: 0, client: 0, plan: 0, autonomy: 0 },
    requires_approval: false,
    approval_kind: null,
    approval_id: null,
    accion_permitida: 'nada',
    envelope_violations: [],
    reason: `el motor de permisos no respondió: ${motivo}`,
    guard_event_id: null,
  };
}

export async function authorize(args: AuthorizeArgs): Promise<Authorization> {
  const { data, error } = await db().rpc('autorizar', {
    p_org: args.organizationId,
    p_capability: args.capabilityId,
    p_payload: args.payload ?? {},
    p_agent: args.agentId ?? null,
    p_registrar: !args.dryRun,
    p_titulo: args.title ?? null,
    p_decision_id: args.decisionId ?? null,
    p_approval_id: args.approvalId ?? null,
  });

  if (error || !data) {
    console.error(`[gobierno:${args.capabilityId}] ${error?.message ?? 'sin respuesta'}`);
    return bloqueoPorFalla(args.capabilityId, error?.message ?? 'sin respuesta');
  }

  return data as Authorization;
}

/**
 * Ejecuta `accion` solo si el motor autoriza, y devuelve el veredicto siempre.
 *
 * Existe para que el patrón correcto sea el más corto de escribir. Un llamador
 * que hace `const auth = await authorize(...)` y se olvida del `if` es un
 * llamador sin correa, y ese olvido no da error en ninguna parte.
 */
export async function withAuthorization<T>(
  args: AuthorizeArgs,
  accion: (auth: Authorization) => Promise<T>,
): Promise<{ auth: Authorization; result: T | null }> {
  const auth = await authorize(args);
  if (auth.accion_permitida !== 'ejecutar') return { auth, result: null };
  return { auth, result: await accion(auth) };
}

/** La auditoría de una organización: qué se intentó, qué pasó y qué se frenó. */
export async function guardEventsFor(
  organizationId: string,
  opts: { limit?: number; capabilityId?: string; soloBloqueados?: boolean } = {},
) {
  let query = db()
    .from('guard_events')
    .select('id, capability_id, requested_level, effective_level, verdict, reason, envelope_check, payload, approval_id, decision_id, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);

  if (opts.capabilityId) query = query.eq('capability_id', opts.capabilityId);
  if (opts.soloBloqueados) query = query.in('verdict', ['blocked', 'downgraded']);

  const { data } = await query;
  return data ?? [];
}

/**
 * Resumen para el panel: qué frenó la correa esta semana.
 *
 * Lo que se bloqueó vale tanto como lo que pasó. Es la evidencia de que los
 * límites existen — y para el cliente que duda de darle más autonomía a un
 * agente, es el argumento más convincente que tenemos.
 */
export async function resumenDeCorrea(organizationId: string, dias = 7) {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const { data } = await db()
    .from('guard_events')
    .select('capability_id, verdict')
    .eq('organization_id', organizationId)
    .gte('created_at', desde)
    .limit(5000);

  const resumen: Record<string, { allowed: number; downgraded: number; blocked: number }> = {};
  for (const row of data ?? []) {
    const key = row.capability_id ?? 'desconocida';
    resumen[key] ??= { allowed: 0, downgraded: 0, blocked: 0 };
    resumen[key][row.verdict as 'allowed' | 'downgraded' | 'blocked'] += 1;
  }
  return resumen;
}
