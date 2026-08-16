import { db, mustWrite, tryWrite } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';
import type { Envelope, RiskClass, Level } from '@/lib/governance/types';

/**
 * El registro de habilidades: qué puede USAR un agente.
 *
 * P2 definió qué puede HACER. Son dos preguntas distintas y hasta P6 solo
 * teníamos la primera: un agente con permiso L4 para contactar partners y sin
 * forma de buscarlos en LinkedIn tiene una autorización que no puede ejercer.
 *
 * El tool list de runtime es la intersección de cuatro conjuntos, y se calcula
 * en SQL (`holaamigo.habilidades_activas`):
 *
 *   otorgadas al rol ∩ habilitadas para esta org ∩ permitidas por el plan
 *   ∩ alcanzables con el nivel de capacidad actual
 *
 * El cuarto es el que une P2 con P6, y es lo que hace que esto no sea una lista
 * de herramientas más: de nada sirve tener LinkedIn habilitado si el agente no
 * tiene permiso para acciones de esa clase de riesgo.
 *
 * Ver docs/adr/0022-habilidades-y-crm-con-actor.md
 */

export interface SkillActiva {
  skill_id: string;
  display_name: string;
  provider: 'mcp' | 'rest' | 'internal';
  risk_class: RiskClass;
  min_grant_level: Level;
  nivel_disponible: Level;
  envelope: Envelope;
  cost_model: { unit?: 'call' | 'credit'; credits?: number; price_usd?: number };
}

/**
 * Lo que este agente puede usar AHORA MISMO.
 *
 * Se consulta en cada corrida y no se cachea: habilitar una habilidad desde el
 * admin tiene que servir en la siguiente corrida sin desplegar, y una caché de
 * cinco minutos convierte "sin desplegar" en "sin desplegar, pero esperá".
 */
export async function habilidadesActivas(
  organizationId: string,
  role: AgentRole,
): Promise<SkillActiva[]> {
  const { data, error } = await db().rpc('habilidades_activas', {
    p_org: organizationId,
    p_role: role,
  });

  if (error) {
    // Falla cerrado, igual que el motor de permisos: sin lista de herramientas
    // el agente razona y propone, que es lo que hace sin herramientas de todos
    // modos. Lo que no puede pasar es que un error de lectura se convierta en
    // "puede usar todo".
    console.error(`[skills:${role}] ${error.message}`);
    return [];
  }

  return (data ?? []) as SkillActiva[];
}

/**
 * El tool list en el formato que espera el cliente de IA.
 *
 * Hoy devuelve la descripción para el prompt; cuando conectemos MCP de verdad,
 * este es el punto donde se traducen a definiciones de tool. Que exista ya —
 * aunque solo formatee texto— es lo que hace que el resto del código llame a un
 * solo lugar y no haya dos formas de saber qué puede usar un agente.
 */
export async function toolListFor(
  organizationId: string,
  role: AgentRole,
): Promise<{ bloque: string; skills: SkillActiva[] }> {
  const skills = await habilidadesActivas(organizationId, role);
  if (skills.length === 0) return { bloque: '', skills: [] };

  const lineas = skills.map((s) => {
    const costo = s.cost_model?.credits
      ? ` · cuesta ${s.cost_model.credits} crédito(s) por uso`
      : '';
    return `- ${s.skill_id}: ${s.display_name}${costo}`;
  });

  return {
    bloque: [
      '## Herramientas que tienes disponibles',
      '',
      ...lineas,
      '',
      'Si necesitas una que no está en esta lista, NO la inventes ni la simules:',
      'pídela con una justificación y di qué decisión te quedó bloqueada.',
    ].join('\n'),
    skills,
  };
}

/**
 * El "intraer": el agente pide lo que le falta.
 *
 * Es el loop que hace que el sistema crezca solo. Un agente se topa con un
 * muro, deja constancia de qué necesitaba y de qué decisión quedó bloqueada, y
 * eso aparece en nuestro admin como una tarjeta con contexto real — no como una
 * intuición de producto.
 *
 * `tryWrite` y no `mustWrite`: que no se pueda registrar el pedido no puede
 * tumbar la corrida. El agente ya estaba bloqueado; sumarle una excepción no
 * ayuda a nadie.
 */
export async function pedirHabilidad(args: {
  organizationId: string;
  agentId?: string | null;
  role: AgentRole;
  skillId?: string | null;
  requestedCapability?: string | null;
  justification: string;
  blockedDecisionId?: string | null;
}): Promise<boolean> {
  return tryWrite(
    db().from('skill_requests').insert({
      organization_id: args.organizationId,
      agent_id: args.agentId ?? null,
      agent_role: args.role,
      skill_id: args.skillId ?? null,
      requested_capability: args.requestedCapability ?? args.skillId ?? null,
      justification: args.justification,
      blocked_decision_id: args.blockedDecisionId ?? null,
    }),
    'skill_requests.insert',
  );
}

/** Los pedidos pendientes, con la decisión que bloquearon. Cola del admin. */
export async function pedidosPendientes(limit = 50) {
  const { data } = await db()
    .from('skill_requests')
    .select('*, organizations(name, domain), decisions(question, kind, created_at)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/**
 * Enciende una habilidad. Solo operador.
 *
 * Las de clase `spend` e `irreversible` exigen sobre, y eso lo hace cumplir un
 * trigger en la base: sin tope no es un permiso, es una firma en blanco.
 */
export async function otorgarHabilidad(args: {
  organizationId?: string | null;
  role: AgentRole | 'todos';
  skillId: string;
  envelope?: Envelope;
  by: string;
  enabled?: boolean;
}): Promise<void> {
  await mustWrite(
    db()
      .from('skill_grants')
      .upsert(
        {
          organization_id: args.organizationId ?? null,
          agent_role: args.role,
          skill_id: args.skillId,
          enabled: args.enabled ?? true,
          envelope: args.envelope ?? {},
          granted_by: args.by,
          granted_by_type: 'operator',
        },
        { onConflict: 'scope_key,agent_role,skill_id' },
      ),
    'skill_grants.upsert',
  );
}

export async function resolverPedido(args: {
  requestId: string;
  status: 'granted' | 'rejected' | 'duplicate';
  by: string;
  note?: string | null;
}): Promise<void> {
  await mustWrite(
    db()
      .from('skill_requests')
      .update({
        status: args.status,
        resolved_by: args.by,
        resolution_note: args.note ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', args.requestId),
    'skill_requests.resolve',
  );
}

export async function catalogoDeHabilidades() {
  const { data } = await db().from('skills').select('*').order('risk_class').order('id');
  return data ?? [];
}

/**
 * Ejecuta algo solo si el agente tiene la habilidad, y si no, la pide.
 *
 * Es el "intraer" hecho función. El patrón correcto tiene que ser el más corto
 * de escribir: un llamador que comprueba la habilidad a mano y se olvida de
 * registrar el pedido cuando falta deja al agente mudo contra el mismo muro
 * todas las corridas, y nadie se entera nunca.
 *
 * Devuelve `null` cuando la habilidad no está — el llamador decide si eso es un
 * fallo o simplemente algo que hoy no se puede hacer.
 */
export async function conHabilidad<T>(
  args: {
    organizationId: string;
    role: AgentRole;
    skillId: string;
    /** Qué se estaba intentando lograr. Va a la tarjeta del admin. */
    justification: string;
    blockedDecisionId?: string | null;
  },
  accion: (skill: SkillActiva) => Promise<T>,
): Promise<T | null> {
  const disponibles = await habilidadesActivas(args.organizationId, args.role);
  const skill = disponibles.find((s) => s.skill_id === args.skillId);

  if (!skill) {
    await pedirHabilidad({
      organizationId: args.organizationId,
      role: args.role,
      skillId: args.skillId,
      justification: args.justification,
      blockedDecisionId: args.blockedDecisionId ?? null,
    });
    return null;
  }

  return accion(skill);
}
