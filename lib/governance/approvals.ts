import { db } from '@/lib/supabase/admin';

/**
 * El vencimiento de las tarjetas.
 *
 * Cada tipo de aprobación declara qué pasa cuando el humano no contesta, y la
 * regla para elegirlo es una sola:
 *
 *   **Si no contestar puede hacer daño, se rechaza.**
 *   **Si no contestar ES el daño, se aprueba.**
 *
 * Lanzar una campaña sin respuesta es riesgo → se rechaza a las 48 h. Dejar
 * corriendo una campaña que pierde plata porque nadie autorizó pausarla también
 * es riesgo, y peor → se aprueba a las 4 h. Suprimir a alguien que pidió no ser
 * contactado nunca se niega por silencio.
 *
 * Sin esto el sistema se congela cuando el cliente está de vacaciones, que es
 * exactamente cuando más falta hace que siga funcionando.
 */

export interface VencimientoReporte {
  aprobadas: number;
  rechazadas: number;
}

export async function expirarAprobaciones(): Promise<VencimientoReporte> {
  const { data, error } = await db().rpc('expirar_aprobaciones');
  if (error) {
    console.error(`[gobierno:vencimientos] ${error.message}`);
    return { aprobadas: 0, rechazadas: 0 };
  }
  const resultado = (data ?? {}) as Record<string, number>;
  return {
    aprobadas: Number(resultado.aprobadas ?? 0),
    rechazadas: Number(resultado.rechazadas ?? 0),
  };
}

export interface ApprovalKind {
  kind: string;
  display_name: string;
  description: string | null;
  sla_minutes: number;
  on_expiry: 'approve' | 'reject';
  severity: 'low' | 'normal' | 'high';
}

export async function tiposDeAprobacion(): Promise<ApprovalKind[]> {
  const { data } = await db().from('approval_kinds').select('*').order('kind');
  return (data ?? []) as ApprovalKind[];
}

/**
 * Las tarjetas abiertas, con cuánto les queda.
 *
 * `vence_en_minutos` se calcula acá y no en la base porque es lo que se pinta y
 * cambia cada minuto: materializarlo obligaría a refrescarlo, y un contador
 * congelado es peor que ninguno.
 */
export async function pendientes(organizationId: string, limit = 20) {
  const { data } = await db()
    .from('approvals')
    .select('id, kind, title, rationale, severity, capability_id, decision_id, payload, expires_at, created_at')
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .order('severity', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  const ahora = Date.now();
  return (data ?? []).map((a) => ({
    ...a,
    vence_en_minutos: a.expires_at
      ? Math.max(0, Math.round((new Date(a.expires_at).getTime() - ahora) / 60_000))
      : null,
  }));
}
