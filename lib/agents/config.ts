import { db } from '@/lib/supabase/admin';
import { clamp } from '@/lib/utils';
import type { AgentRole } from '@/lib/agents/contracts';

/**
 * Lo que el cliente SÍ puede configurar de sus agentes.
 *
 * La distinción que sostiene todo el módulo: el **contrato** (objetivo,
 * presupuesto, permisos, escalamiento) no es configurable — es lo que gobierna
 * y lo que le prometemos al cliente que el agente no va a hacer. La
 * **configuración** es cómo trabaja dentro de ese contrato.
 *
 * Si dejáramos editar los permisos, "PROHIBIDO enviar sin aprobación" sería una
 * preferencia. Y una prohibición que se puede apagar en un formulario no es una
 * prohibición: es una sugerencia con mala prensa.
 *
 * `autonomy` es la única palanca que cambia de verdad el comportamiento:
 *   · propose            → propone todo, no ejecuta nada. Por defecto.
 *   · approve_each       → puede agendar solo; el resto lo aprueba el humano.
 *   · auto_within_limits → responde y agenda solo, dentro de los topes.
 *
 * Ni en `auto_within_limits` el agente lanza una campaña, cambia un precio o
 * escribe a alguien sin base legal. Eso es contrato, no autonomía.
 *
 * Ver docs/wiki/13-feed-y-autonomia.md
 */

export type Autonomy = 'propose' | 'approve_each' | 'auto_within_limits';

export interface PresidentConfig {
  /** Hora local a la que publica el resumen y las propuestas. */
  briefing_hour: number;
  /** Cuántas cosas puede tener abiertas antes de callarse. */
  max_open_items: number;
  propose_sends: boolean;
}

export interface CmoConfig {
  /** Cómo suena la marca. Va al prompt como restricción, no como dato. */
  tone: string;
  /** Palabras y promesas que la marca nunca dice. */
  forbidden: string[];
  language: 'es' | 'en' | 'pt';
  auto_generate_copy: boolean;
}

export interface SalesConfig {
  auto_reply: boolean;
  auto_book: boolean;
  /** Tope propio del agente, por encima del de las bandejas. El menor manda. */
  daily_send_cap: number;
  /** Fuera de esta franja no sale nada. Hora local del cliente. */
  send_hours: { from: number; to: number };
  send_days: number[];
  /** Intenciones que SIEMPRE escalan, además de las del contrato. */
  always_escalate: string[];
}

export type AgentConfig = PresidentConfig | CmoConfig | SalesConfig;

export const DEFAULT_CONFIG: Record<AgentRole, AgentConfig> = {
  president: { briefing_hour: 8, max_open_items: 4, propose_sends: true },
  cmo: {
    tone: 'directo, sin relleno corporativo, tuteando',
    forbidden: ['descuento sin autorización', 'garantía de resultados', 'precio cerrado'],
    language: 'es',
    auto_generate_copy: true,
  },
  sales: {
    auto_reply: false,
    auto_book: true,
    daily_send_cap: 300,
    // 8 a 18 de lunes a viernes: un correo comercial que llega un domingo a
    // las 11 p.m. dice más de nosotros que su contenido.
    send_hours: { from: 8, to: 18 },
    send_days: [1, 2, 3, 4, 5],
    always_escalate: ['ask_price', 'complaint', 'legal'],
  },
};

export const DEFAULT_AUTONOMY: Record<AgentRole, Autonomy> = {
  // El President y el CMO nunca ejecutan, así que su autonomía es siempre
  // `propose` (§13.1). Están acá por completitud del tipo, no porque se puedan
  // cambiar.
  president: 'propose',
  cmo: 'propose',
  // SALES también arranca en `propose`, igual que el default de la columna en
  // SQL. Subirlo es una decisión del cliente, tomada a propósito, después de
  // haber visto al agente trabajar. Nunca un default nuestro.
  sales: 'propose',
};

/** Normaliza lo que llegue del formulario. Nunca confía en el cliente: los
 *  topes se acotan acá, no en la UI. */
export function sanitize(role: AgentRole, raw: Record<string, unknown>): AgentConfig {
  const base = DEFAULT_CONFIG[role];

  if (role === 'president') {
    const value = { ...(base as PresidentConfig), ...raw } as PresidentConfig;
    return {
      briefing_hour: clamp(Number(value.briefing_hour) || 8, 0, 23),
      max_open_items: clamp(Number(value.max_open_items) || 4, 1, 12),
      propose_sends: Boolean(value.propose_sends),
    };
  }

  if (role === 'cmo') {
    const value = { ...(base as CmoConfig), ...raw } as CmoConfig;
    return {
      tone: String(value.tone ?? '').slice(0, 300),
      forbidden: (Array.isArray(value.forbidden) ? value.forbidden : [])
        .map((item) => String(item).slice(0, 120))
        .slice(0, 20),
      language: ['es', 'en', 'pt'].includes(value.language) ? value.language : 'es',
      auto_generate_copy: Boolean(value.auto_generate_copy),
    };
  }

  const value = { ...(base as SalesConfig), ...raw } as SalesConfig;
  return {
    auto_reply: Boolean(value.auto_reply),
    auto_book: Boolean(value.auto_book),
    daily_send_cap: clamp(Number(value.daily_send_cap) || 300, 0, 5000),
    send_hours: {
      from: clamp(Number(value.send_hours?.from) || 8, 0, 23),
      to: clamp(Number(value.send_hours?.to) || 18, 1, 24),
    },
    send_days: (Array.isArray(value.send_days) ? value.send_days : [1, 2, 3, 4, 5])
      .map((day) => clamp(Number(day), 0, 6))
      .filter((day, index, all) => all.indexOf(day) === index),
    always_escalate: (Array.isArray(value.always_escalate) ? value.always_escalate : [])
      .map((item) => String(item).slice(0, 40))
      .slice(0, 12),
  };
}

export function sanitizeAutonomy(role: AgentRole, raw: unknown): Autonomy {
  const value = String(raw);
  const valid: Autonomy[] = ['propose', 'approve_each', 'auto_within_limits'];

  // El President y el CMO no ejecutan nunca (§13.1). Aunque llegue otra cosa
  // en el formulario, se queda en `propose`.
  if (role !== 'sales') return 'propose';

  return (valid as string[]).includes(value) ? (value as Autonomy) : DEFAULT_AUTONOMY[role];
}

export async function updateAgentConfig(args: {
  organizationId: string;
  role: AgentRole;
  config: Record<string, unknown>;
  autonomy?: unknown;
  status?: 'active' | 'paused' | 'draft';
}): Promise<{ ok: boolean }> {
  const patch: Record<string, unknown> = {
    config: sanitize(args.role, args.config),
    autonomy: sanitizeAutonomy(args.role, args.autonomy),
  };

  if (args.status && ['active', 'paused', 'draft'].includes(args.status)) {
    patch.status = args.status;
  }

  const { error } = await db()
    .from('agents')
    .update(patch)
    .eq('organization_id', args.organizationId)
    .eq('role', args.role);

  return { ok: !error };
}

export async function agentConfigFor(
  organizationId: string,
  role: AgentRole,
): Promise<{ config: AgentConfig; autonomy: Autonomy; status: string }> {
  const { data } = await db()
    .from('agents')
    .select('config, autonomy, status')
    .eq('organization_id', organizationId)
    .eq('role', role)
    .maybeSingle();

  const stored = (data?.config ?? {}) as Record<string, unknown>;
  return {
    config: Object.keys(stored).length > 0 ? sanitize(role, stored) : DEFAULT_CONFIG[role],
    autonomy: sanitizeAutonomy(role, data?.autonomy ?? DEFAULT_AUTONOMY[role]),
    status: data?.status ?? 'draft',
  };
}

/**
 * ¿Es una hora válida para enviar según la configuración del agente SALES?
 * El despachador lo consulta antes de armar el lote: los correos programados
 * fuera de franja no se pierden, esperan a la mañana siguiente.
 */
export function withinSendWindow(config: SalesConfig, now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    weekday: 'short',
  }).formatToParts(now);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdays.indexOf(parts.find((part) => part.type === 'weekday')?.value ?? 'Mon');

  return config.send_days.includes(weekday) && hour >= config.send_hours.from && hour < config.send_hours.to;
}
