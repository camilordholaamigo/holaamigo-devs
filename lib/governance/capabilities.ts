import { db, mustWrite } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';
import type { Capability, Envelope, Level, PlanTier } from '@/lib/governance/types';

/**
 * El catálogo y los tres diales.
 *
 *   nivel_efectivo = MIN( techo_plataforma, techo_cliente, techo_plan )
 *
 * - **Plataforma:** lo definimos nosotros en la migración. Es el máximo que este
 *   producto va a permitir jamás para esa capacidad, en cualquier cliente y en
 *   cualquier plan. No es negociable y no está en ninguna pantalla.
 * - **Cliente:** lo mueve el cliente en su panel, con una explicación en
 *   español de qué se abre y qué se arriesga.
 * - **Plan:** L4 y L5 no existen en los tiers de abajo.
 *
 * El catálogo se siembra en `0007_gobierno.sql` y se actualiza cada vez que la
 * migración corre. Que sea nuestro y no del cliente es la razón de que viva en
 * SQL versionado y no en una tabla que alguien edite a mano.
 */

export async function catalogo(role?: AgentRole): Promise<Capability[]> {
  let query = db()
    .from('capabilities')
    .select('*')
    .eq('status', 'active')
    .order('agent_role')
    .order('id');

  if (role) query = query.in('agent_role', [role, 'todos']);

  const { data } = await query;
  return (data ?? []) as Capability[];
}

export interface GrantRow {
  capability_id: string;
  granted_level: Level;
  envelope: Envelope;
  granted_by: string;
  granted_by_type: 'client' | 'operator' | 'system';
  expires_at: string | null;
  updated_at: string;
}

export async function grantsFor(organizationId: string): Promise<GrantRow[]> {
  const { data } = await db()
    .from('capability_grants')
    .select('capability_id, granted_level, envelope, granted_by, granted_by_type, expires_at, updated_at')
    .eq('organization_id', organizationId);
  return (data ?? []) as GrantRow[];
}

export interface FilaDeMatriz extends Capability {
  /** Lo que el cliente otorgó, o el default del catálogo si nunca tocó nada. */
  granted_level: Level;
  /** El sobre efectivo: el nuestro con lo que el cliente haya apretado encima. */
  envelope: Envelope;
  /** El techo real que puede mover este cliente hoy, con su plan. */
  techo_disponible: Level;
  /** Si el plan de la organización ni siquiera alcanza para esta capacidad. */
  bloqueada_por_plan: boolean;
  personalizada: boolean;
}

const TECHO_DE_PLAN: Record<PlanTier, Level> = {
  diagnostico: 2,
  starter: 3,
  growth: 4,
  enterprise: 5,
};

const RANGO_DE_PLAN: Record<PlanTier, number> = {
  diagnostico: 0,
  starter: 1,
  growth: 2,
  enterprise: 3,
};

/**
 * Lo que el panel del cliente necesita para pintar un slider por capacidad.
 *
 * Los topes se recalculan acá con las MISMAS tablas que usa el motor en SQL. Es
 * duplicación consciente y acotada: son dos diccionarios de cuatro entradas, y
 * el alternativo —un viaje a la base por fila para pintar un formulario— es
 * peor. Si alguna vez difieren, manda SQL: el panel pintaría mal, pero el motor
 * seguiría frenando bien, que es el fallo en la dirección correcta.
 */
export async function matrizDeCapacidades(
  organizationId: string,
  role?: AgentRole,
): Promise<FilaDeMatriz[]> {
  const [caps, grants, org] = await Promise.all([
    catalogo(role),
    grantsFor(organizationId),
    db().from('organizations').select('plan').eq('id', organizationId).maybeSingle(),
  ]);

  const plan = ((org.data?.plan as PlanTier) ?? 'diagnostico') as PlanTier;
  const porId = new Map(grants.map((g) => [g.capability_id, g]));

  return caps.map((cap) => {
    const grant = porId.get(cap.id);
    const bloqueadaPorPlan = RANGO_DE_PLAN[plan] < RANGO_DE_PLAN[cap.min_plan];
    const techoDisponible = (
      bloqueadaPorPlan ? 0 : Math.min(cap.platform_ceiling, TECHO_DE_PLAN[plan])
    ) as Level;

    return {
      ...cap,
      granted_level: grant?.granted_level ?? cap.default_level,
      envelope: { ...cap.default_envelope, ...(grant?.envelope ?? {}) },
      techo_disponible: techoDisponible,
      bloqueada_por_plan: bloqueadaPorPlan,
      personalizada: Boolean(grant),
    };
  });
}

/**
 * Mueve el dial del cliente.
 *
 * No se valida el techo acá: lo recorta un trigger en la base
 * (`capability_grants_recorte`). Es a propósito — validar en la aplicación deja
 * la puerta abierta a cualquier escritura que no pase por esta función, y esa
 * puerta es exactamente la que este módulo existe para cerrar.
 *
 * Devuelve el nivel que QUEDÓ, no el que se pidió: si el formulario muestra L5
 * y la base guardó L3, el cliente cree que autorizó algo que nunca pasó.
 */
export async function otorgarCapacidad(args: {
  organizationId: string;
  capabilityId: string;
  level: Level;
  envelope?: Envelope;
  by: string;
  byType: 'client' | 'operator' | 'system';
  reason?: string | null;
  expiresAt?: string | null;
}): Promise<{ granted_level: Level; envelope: Envelope }> {
  await mustWrite(
    db()
      .from('capability_grants')
      .upsert(
        {
          organization_id: args.organizationId,
          capability_id: args.capabilityId,
          granted_level: args.level,
          envelope: args.envelope ?? {},
          granted_by: args.by,
          granted_by_type: args.byType,
          reason: args.reason ?? null,
          expires_at: args.expiresAt ?? null,
        },
        { onConflict: 'organization_id,capability_id' },
      ),
    'capability_grants.upsert',
  );

  const { data } = await db()
    .from('capability_grants')
    .select('granted_level, envelope')
    .eq('organization_id', args.organizationId)
    .eq('capability_id', args.capabilityId)
    .maybeSingle();

  return {
    granted_level: (data?.granted_level ?? 0) as Level,
    envelope: (data?.envelope ?? {}) as Envelope,
  };
}

export async function revocarCapacidad(organizationId: string, capabilityId: string): Promise<void> {
  await mustWrite(
    db()
      .from('capability_grants')
      .delete()
      .eq('organization_id', organizationId)
      .eq('capability_id', capabilityId),
    'capability_grants.delete',
  );
}

/** Cambiar de plan mueve el tercer dial para toda la organización de una vez. */
export async function cambiarPlan(organizationId: string, plan: PlanTier): Promise<void> {
  await mustWrite(
    db().from('organizations').update({ plan }).eq('id', organizationId),
    'organizations.plan',
  );
}
