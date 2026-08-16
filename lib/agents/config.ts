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
 * `autonomy` es el dial GRUESO, y desde P2 es una de las tres entradas del
 * techo del cliente en la escalera de capacidades:
 *
 *   · propose            → L1. Propone todo, no ejecuta nada. Por defecto.
 *   · approve_each       → L3. Ejecuta ítem por ítem, cada uno aprobado antes.
 *   · auto_within_limits → L4. Ejecuta dentro del sobre declarado y reporta.
 *   · sampled            → L5. Sin sobre, auditado por muestreo.
 *
 * **El dial grueso gobierna lo que sale del edificio.** Investigar, puntuar y
 * escribir en objetos propios (el Brief, el CRM, un borrador) no lo toca: no
 * afecta a ningún tercero y se deshace editando. Por eso la CMO en `propose`
 * sigue pudiendo vigilar competidores.
 *
 * `sampled` NO está en el formulario del cliente (el `zod` de
 * `/api/agents/config` acepta tres valores). Lo abre un operador nuestro a mano,
 * cliente por cliente: nada se automatiza antes de haberse hecho tres veces a
 * mano (§13.3). Cuando lo hayamos hecho tres veces, entra al formulario.
 *
 * Ni en `sampled` el agente firma nada, publica a nombre de la marca o cotiza un
 * precio: eso lo frena el techo de PLATAFORMA de cada capacidad, que no depende
 * de este dial ni de ningún plan. Ver `supabase/migrations/0007_gobierno.sql`.
 *
 * Ver docs/wiki/13-feed-y-autonomia.md y docs/wiki/16-gobierno-capacidades-y-sobres.md
 */

export type Autonomy = 'propose' | 'approve_each' | 'auto_within_limits' | 'sampled';

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
  // El President nunca ejecuta: es el que razona sobre dinero (§13.1). Su valor
  // es fijo, no un default.
  president: 'propose',
  // La CMO arranca en `propose` por defecto, pero desde P2 el cliente puede
  // subirla. Lo que cambió no es el principio: es que ahora hay una escalera
  // por capacidad en vez de un interruptor para todo el agente.
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
  const valid: Autonomy[] = ['propose', 'approve_each', 'auto_within_limits', 'sampled'];

  // El President se queda en `propose` siempre, y ahora se puede decir POR QUÉ
  // con precisión: es el agente que razona sobre dinero, y el que razona sobre
  // dinero no lo toca (§13.1). Su techo de plataforma en `budget.shift` es L2 —
  // prepara la reasignación, no la ejecuta— así que su autonomía es irrelevante
  // y dejarla fija evita la duda.
  if (role === 'president') return 'propose';

  // La CMO SÍ puede subir desde P2. Antes estaba forzada a `propose` porque la
  // única alternativa era un dial de todo-o-nada; con la escalera, cada cosa
  // que hace tiene su propio techo y su propio sobre. Investigar es L5 aunque
  // esté en `propose`; contactar a un partner exige que el cliente lo abra a
  // propósito; firmar es L0 y no se puede encender.
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
