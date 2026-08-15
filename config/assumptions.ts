/**
 * Supuestos por defecto de las fugas y de la cuenta al revés (PRD §7.3, §7.4).
 *
 * Estos números son la parte más delicada del producto: son los que convierten
 * el diagnóstico en una cifra en pesos. Reglas que nos impusimos:
 *
 *  - Son CONSERVADORES a propósito. Un número inflado que el cliente no cree
 *    mata la venta más rápido que un número modesto que sí cree.
 *  - Todos son editables en pantalla. Al editarlos, el número se recalcula en
 *    vivo. Eso convierte el diagnóstico en algo suyo, no en algo nuestro.
 *  - Cada uno lleva su fuente o su razonamiento en el comentario. Cuando
 *    alguien pregunte "¿de dónde sale el 4%?", la respuesta está aquí.
 *
 * Ver docs/wiki/06-diagnostico-y-matematica.md
 */

export interface Assumptions {
  /** Contactos dormidos en la base del cliente. Viene de `dormant_db`. */
  dormant_contacts: number;
  /** Ticket promedio del primer contrato, USD. Viene de `ticket_band`. */
  avg_ticket_usd: number;
  /** Facturación mensual, USD. Viene de `rev_band`. */
  monthly_revenue_usd: number;
  /** Leads nuevos al mes. Derivado, editable. */
  leads_per_month: number;
  /** Tasa de cierre lead → cliente. */
  close_rate: number;
  /** % de la base dormida que se reactiva con una secuencia bien hecha. */
  reactivation_rate: number;
  /** % de leads que llegan fuera de horario (noche y fin de semana). */
  after_hours_share: number;
  /** % de leads que se abandonan antes del 5º toque. */
  followup_abandon_share: number;
  /** % de oportunidad perdida por idioma o canal desatendido. */
  language_channel_share: number;

  // ── Cuenta al revés ──
  /** Clientes nuevos que el cliente dice necesitar en 90 días. */
  goal_customers_90d: number;
  /** Cierre desde reunión sostenida. */
  close_from_meeting: number;
  /** % de contactados que aceptan una reunión. */
  booking_rate: number;
  /** Toques por contacto antes de rendirse. */
  touches_per_contact: number;
  /** Semanas disponibles según el deadline declarado. */
  weeks_available: number;
  /** Envíos seguros por buzón por semana. Estándar de la industria. */
  sends_per_mailbox_week: number;
}

/**
 * Tasa de cierre por industria. Cuando no reconocemos la industria usamos
 * `default`. Fuentes: benchmarks públicos de B2B SaaS y servicios; ajustados
 * hacia abajo porque los benchmarks los publica quien queda bien en ellos.
 */
export const CLOSE_RATE_BY_INDUSTRY: Record<string, number> = {
  default: 0.18,
  inmobiliaria: 0.08,
  'real estate': 0.08,
  saas: 0.15,
  software: 0.15,
  agencia: 0.22,
  agency: 0.22,
  consultoria: 0.25,
  consulting: 0.25,
  salud: 0.3,
  health: 0.3,
  educacion: 0.12,
  education: 0.12,
  ecommerce: 0.03,
  retail: 0.03,
  legal: 0.28,
  seguros: 0.14,
  insurance: 0.14,
  construccion: 0.16,
  manufactura: 0.2,
  logistica: 0.2,
  turismo: 0.1,
  fitness: 0.15,
  automotriz: 0.12,
};

export function closeRateFor(industry: string | null | undefined): number {
  if (!industry) return CLOSE_RATE_BY_INDUSTRY.default;
  const key = industry.toLowerCase().trim();
  for (const [name, rate] of Object.entries(CLOSE_RATE_BY_INDUSTRY)) {
    if (key.includes(name)) return rate;
  }
  return CLOSE_RATE_BY_INDUSTRY.default;
}

export const DEFAULTS = {
  /** Meta-análisis de campañas de reactivación: 3–6% responde y compra. */
  reactivation_rate: 0.04,
  /** Leads que entran noche o fin de semana en negocios locales de LatAm. */
  after_hours_share: 0.35,
  /** El clásico: la mayoría del equipo comercial se rinde en el 2º toque. */
  followup_abandon_share: 0.5,
  language_channel_share: 0.15,

  close_from_meeting: 0.25,
  booking_rate: 0.05,
  touches_per_contact: 5,
  sends_per_mailbox_week: 125,
} as const;

/** Semanas disponibles según lo que respondió en `goal_deadline`. */
export const WEEKS_BY_DEADLINE: Record<string, number> = {
  week: 2,
  month: 4,
  quarter: 12,
  exploring: 12,
};

/**
 * Tasa de referencia USD→COP para mostrar cifras en pesos colombianos.
 * v1: constante. Es una aproximación deliberada — el diagnóstico habla de
 * órdenes de magnitud, no de tesorería. Ver docs/adr/0006-moneda.md
 */
export const FX_USD: Record<string, number> = {
  USD: 1,
  COP: 4000,
  MXN: 18,
  PEN: 3.7,
  CLP: 950,
  ARS: 1000,
  BRL: 5.4,
  EUR: 0.92,
};

export function toCurrency(usd: number, currency: string): number {
  return usd * (FX_USD[currency] ?? 1);
}

/** País ISO → moneda local. Fuera de esta lista, USD. */
export const CURRENCY_BY_COUNTRY: Record<string, string> = {
  CO: 'COP',
  MX: 'MXN',
  PE: 'PEN',
  CL: 'CLP',
  AR: 'ARS',
  BR: 'BRL',
  ES: 'EUR',
  US: 'USD',
};
