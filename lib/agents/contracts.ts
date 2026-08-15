import { db } from '@/lib/supabase/admin';
import { track } from '@/lib/events';

/**
 * Los tres contratos (PRD §3).
 *
 * Un agente NO es un prompt: es un contrato con cuatro campos obligatorios —
 * objetivo, presupuesto, permisos, escalamiento. El prompt es un detalle de
 * implementación que vive en config/prompts.ts; esto es lo que gobierna qué
 * puede y qué no puede hacer.
 *
 * Regla transversal §3: ningún agente ejecuta una acción con dinero o con un
 * tercero humano al otro lado sin una aprobación registrada en `approvals`.
 * President y CMO nunca ejecutan (Principio §13.1).
 *
 * Ver docs/wiki/03-agentes.md
 */

export type AgentRole = 'president' | 'cmo' | 'sales';

export interface AgentContract {
  role: AgentRole;
  title: string;
  objective: { metric: string; target: string; deadline: string };
  budget: { tokens_per_run: number; msgs_per_day: number | null; usd_per_month: number };
  permissions: { can: string[]; cannot: string[] };
  escalation_rules: { when: string[]; to: 'admin'; sla_minutes: number };
}

export function contractsFor(args: {
  goalCustomers90d: number;
  dailyMessageCap: number;
}): AgentContract[] {
  return [
    {
      role: 'president',
      title: 'PRESIDENT · el estratega',
      objective: {
        metric: 'plan vigente con cuenta al revés válida',
        target: `${args.goalCustomers90d} clientes nuevos`,
        deadline: '90 días',
      },
      budget: { tokens_per_run: 120_000, msgs_per_day: null, usd_per_month: 0 },
      permissions: {
        can: [
          'leer todo el contexto de la organización',
          'escribir y versionar el Brief',
          'proponer objetivos y presupuestos',
          'priorizar las 3 rutas y marcar la recomendada',
        ],
        cannot: [
          'ejecutar en cualquier canal',
          'gastar dinero',
          'contactar a nadie',
          'enviar un mensaje, un correo o una notificación a un tercero',
        ],
      },
      escalation_rules: {
        when: [
          'la meta declarada es aritméticamente imposible con el presupuesto declarado',
          'el cliente edita un supuesto de forma que rompe la cuenta al revés',
        ],
        to: 'admin',
        sla_minutes: 60,
      },
    },

    {
      role: 'cmo',
      title: 'CMO · la marca y el mensaje',
      objective: {
        metric: 'ángulos con hipótesis y segmento asignado',
        target: '5 o más',
        deadline: 'por corrida de diagnóstico',
      },
      budget: { tokens_per_run: 80_000, msgs_per_day: null, usd_per_month: 0 },
      permissions: {
        can: [
          'buscar en la web',
          'generar ángulos, copy, guiones y plan de contenido',
          'proponer preguntas adaptativas del quiz',
        ],
        cannot: ['publicar nada', 'enviar nada', 'contactar a nadie'],
      },
      escalation_rules: {
        when: [
          'no encuentra 3 o más competidores identificables',
          'el sitio no permite inferir la oferta',
        ],
        to: 'admin',
        sla_minutes: 120,
      },
    },

    {
      role: 'sales',
      title: 'SALES · la ejecución',
      objective: {
        metric: 'primer lead trabajado desde la carga',
        target: 'menos de 24 horas',
        deadline: 'continuo',
      },
      budget: {
        tokens_per_run: 40_000,
        msgs_per_day: args.dailyMessageCap,
        usd_per_month: 300,
      },
      permissions: {
        can: [
          'enviar dentro de ángulos y plantillas aprobadas',
          'responder inbound',
          'agendar reuniones',
          'suprimir contactos que piden salir',
        ],
        cannot: [
          'usar un ángulo que no esté en estado approved',
          'prometer un precio fuera del rango del Brief',
          'enviar a contactos sin consent_basis',
          'enviar a contactos en la lista de supresión',
          'lanzar una campaña sin aprobación registrada',
        ],
      },
      escalation_rules: {
        when: [
          'respuesta negativa hacia la marca',
          'petición legal o mención de habeas data',
          'precio solicitado fuera del rango del Brief',
          'queja de spam',
          'caída de deliverability o subida de rebotes',
        ],
        to: 'admin',
        sla_minutes: 30,
      },
    },
  ];
}

/** Instancia los tres contratos. Idempotente: re-llamarla actualiza. */
export async function provisionAgents(
  organizationId: string,
  args: { goalCustomers90d: number; dailyMessageCap?: number },
): Promise<{ provisioned: number }> {
  const contracts = contractsFor({
    goalCustomers90d: args.goalCustomers90d,
    dailyMessageCap: args.dailyMessageCap ?? 500,
  });

  await db()
    .from('agents')
    .upsert(
      contracts.map((c) => ({
        organization_id: organizationId,
        role: c.role,
        // President y CMO arrancan activos: solo razonan. SALES arranca en
        // draft porque ejecuta, y no ejecuta nada hasta que haya canal y
        // aprobación. Ver §13.1 y §13.3.
        status: c.role === 'sales' ? 'draft' : 'active',
        objective: c.objective,
        budget: c.budget,
        permissions: c.permissions,
        escalation_rules: c.escalation_rules,
      })),
      { onConflict: 'organization_id,role' },
    );

  await track('agents_provisioned', {
    organizationId,
    props: { roles: contracts.map((c) => c.role) },
  });

  return { provisioned: contracts.length };
}

export async function agentsFor(organizationId: string) {
  const { data } = await db()
    .from('agents')
    .select('*')
    .eq('organization_id', organizationId)
    .order('role');
  return data ?? [];
}

export async function agentIdFor(
  organizationId: string,
  role: AgentRole,
): Promise<string | null> {
  const { data } = await db()
    .from('agents')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('role', role)
    .maybeSingle();
  return data?.id ?? null;
}
