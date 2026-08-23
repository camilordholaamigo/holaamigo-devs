/**
 * La escalera de capacidades (P2).
 *
 * Sin imports de servidor: el panel del cliente que mueve los sliders va a leer
 * estos tipos y estas etiquetas en el navegador.
 *
 * Ver docs/adr/0018-la-escalera-de-capacidades.md
 */

export type Level = 0 | 1 | 2 | 3 | 4 | 5;

export type Verdict = 'allowed' | 'downgraded' | 'blocked';

/**
 * `self_outreach` sale del edificio, igual que `external_comms`, pero el que
 * recibe el mensaje es la PROPIA organización — no un contacto suyo. La
 * distinción no es semántica: el plan del cliente y la autonomía que le soltó a
 * sus agentes gobiernan lo segundo y no lo primero. Ver 0016 y ADR 0025.
 */
export type RiskClass =
  | 'read'
  | 'write'
  | 'external_comms'
  | 'self_outreach'
  | 'spend'
  | 'irreversible';

export type PlanTier = 'diagnostico' | 'starter' | 'growth' | 'enterprise';

/** Qué puede hacer el agente cuando el motor no lo deja ejecutar. */
export type AccionPermitida =
  | 'ejecutar'
  | 'ejecutar_con_visto_bueno'
  | 'pedir'
  | 'preparar'
  | 'proponer'
  | 'nada';

export const NIVELES: Record<Level, { nombre: string; que_puede: string }> = {
  0: { nombre: 'Prohibida', que_puede: 'Nada. Ni siquiera la menciona.' },
  1: { nombre: 'Proponer', que_puede: 'Escribe una propuesta. No produce artefacto.' },
  2: { nombre: 'Preparar', que_puede: 'Arma el artefacto completo y lo deja listo. No lo envía.' },
  3: { nombre: 'Con visto bueno', que_puede: 'Ejecuta ítem por ítem, cada uno aprobado antes.' },
  4: { nombre: 'Dentro del sobre', que_puede: 'Ejecuta libre dentro de límites declarados, y reporta.' },
  5: { nombre: 'Autónoma', que_puede: 'Ejecuta y se audita por muestreo.' },
};

/**
 * El sobre: los límites declarados que hacen posible L4.
 *
 * Todos los campos son opcionales y lo que no se declara no se limita. Es
 * deliberado: un sobre con veinte reglas que nadie entiende protege menos que
 * tres reglas que el cliente puede leer en voz alta.
 */
export interface Envelope {
  /** Tope de plata comprometible. 0 = no puede comprometer un peso. */
  max_amount_usd?: number;
  max_volume_per_day?: number;
  max_volume_per_week?: number;
  /** Etiquetas de contraparte permitidas. Vacío = cualquiera no prohibida. */
  allowed_counterparties?: string[];
  forbidden_counterparties?: string[];
  /** Promesas que el artefacto no puede contener. */
  forbidden_commitments?: string[];
  /** ISO. Un sobre vencido bloquea todo lo que dependía de él. */
  expires_at?: string;
  /** Si el mensaje tiene que decir que lo escribe un agente. */
  requires_disclosure?: boolean;
  /** Tope de reasignación de presupuesto, en porcentaje. */
  max_shift_pct?: number;
}

/** Lo que el llamador le cuenta al motor sobre la acción concreta. */
export interface AuthorizePayload {
  /** Cuántas unidades consume del sobre. Un correo = 1, un lote de 50 = 50. */
  volume?: number;
  amount_usd?: number;
  /**
   * Cuántas horas cuesta deshacer ESTA acción. Es lo que hace que la regla de
   * reversibilidad se evalúe en runtime: la misma capacidad puede ser
   * reversible o no según lo que se esté haciendo.
   */
  reversibility_hours?: number;
  counterparty_tags?: string[];
  commitments?: string[];
  /** Si el artefacto declara que lo escribió un agente. */
  discloses_agent?: boolean;
  [key: string]: unknown;
}

export interface EnvelopeViolation {
  rule: string;
  detail: string;
  used?: number;
}

export interface Authorization {
  verdict: Verdict;
  capability_id: string;
  requested_level: Level | null;
  effective_level: Level;
  ceilings: { platform: Level; client: Level; plan: Level; autonomy: Level };
  requires_approval: boolean;
  approval_kind: string | null;
  approval_id: string | null;
  accion_permitida: AccionPermitida;
  envelope_violations: EnvelopeViolation[];
  reason: string | null;
  guard_event_id: number | null;
}

export interface Capability {
  id: string;
  agent_role: 'president' | 'cmo' | 'sales' | 'todos';
  display_name: string;
  description: string;
  client_explanation: string;
  risk_class: RiskClass;
  platform_ceiling: Level;
  default_level: Level;
  min_plan: PlanTier;
  default_reversibility_hours: number | null;
  approval_kind: string | null;
  default_envelope: Envelope;
  status: string;
}

/** ¿El veredicto autoriza ejecutar ya, sin más trámite? */
export function puedeEjecutar(auth: Authorization): boolean {
  return auth.accion_permitida === 'ejecutar';
}

/**
 * La frase que se le muestra al humano cuando el motor frenó algo.
 *
 * Vive acá y no en cada llamador porque es la explicación que el cliente lee, y
 * doce versiones distintas de la misma frase es cómo un producto empieza a
 * sonar a que no sabe lo que hace.
 */
export function explicarVeredicto(auth: Authorization): string {
  if (auth.envelope_violations.length > 0) {
    return `Se pasa de los límites que le diste: ${auth.envelope_violations
      .map((v) => v.detail)
      .join(' · ')}`;
  }
  switch (auth.accion_permitida) {
    case 'ejecutar':
      return 'Autorizado.';
    case 'ejecutar_con_visto_bueno':
      return 'Necesita tu visto bueno antes de cada ítem.';
    case 'preparar':
      return 'El agente lo deja preparado. Enviarlo es tuyo.';
    case 'proponer':
      return 'El agente solo puede proponerlo.';
    case 'pedir':
      return 'El agente tiene que pedir permiso para esto.';
    default:
      return 'Esta capacidad está apagada y no se puede encender.';
  }
}
