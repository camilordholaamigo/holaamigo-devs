import {
  DEFAULTS,
  WEEKS_BY_DEADLINE,
  closeRateFor,
  type Assumptions,
} from '@/config/assumptions';
import { clamp } from '@/lib/utils';

/**
 * Las fugas (§7.3) y la cuenta al revés (§7.4).
 *
 * Todo esto es aritmética pura, sin IA. Decisión deliberada: el número que le
 * ponemos en pantalla al cliente tiene que ser reproducible, auditable y
 * recalculable en el navegador cuando él edite un supuesto. Un modelo que
 * "estima" la fuga sería más impresionante y muchísimo peor: no podríamos
 * defender la cifra cuando nos pregunte de dónde salió.
 *
 * El modelo aporta la EVIDENCIA de por qué la fuga existe. El monto lo pone
 * este archivo. Ver docs/wiki/06-diagnostico-y-matematica.md
 */

// ═══════════════════════════════════════════════════════════════════════════
// SUPUESTOS: de las respuestas del quiz a números
// ═══════════════════════════════════════════════════════════════════════════

export interface QuizFacts {
  dormant_db?: string;
  ticket_band?: string;
  rev_band?: string;
  sales_team?: string;
  goal_deadline?: string;
  goal_90d?: number;
  industry?: string | null;
}

/** Punto medio de cada banda. Duplicado del seed de SQL a propósito: este es
 *  el que corre, el de SQL es solo para editar copy sin desplegar. */
const BAND_MIDPOINTS: Record<string, Record<string, number>> = {
  dormant_db: { unknown: 800, lt_500: 250, '500_2k': 1200, '2k_10k': 5500, gt_10k: 18000 },
  ticket_band: { lt_500: 300, '500_2k': 1200, '2k_10k': 5000, '10k_50k': 25000, gt_50k: 80000 },
  rev_band: { lt_10k: 5000, '10k_50k': 28000, '50k_200k': 110000, '200k_1m': 500000, gt_1m: 1500000 },
  sales_team: { '0': 0, '1_2': 1.5, '3_5': 4, '6_15': 10, gt_15: 25 },
};

function midpoint(question: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  return BAND_MIDPOINTS[question]?.[value] ?? fallback;
}

export function buildAssumptions(facts: QuizFacts): Assumptions {
  const dormant = midpoint('dormant_db', facts.dormant_db, 800);
  const ticket = midpoint('ticket_band', facts.ticket_band, 1200);
  const revenue = midpoint('rev_band', facts.rev_band, 28000);
  const closeRate = closeRateFor(facts.industry);

  // Leads/mes no se pregunta: se deriva. clientes_mes = facturación ÷ ticket,
  // y leads_mes = clientes_mes ÷ tasa_cierre. Se acota porque las bandas son
  // gruesas y los extremos producen cifras que nadie se cree.
  const customersPerMonth = ticket > 0 ? revenue / ticket : 0;
  const derivedLeads = closeRate > 0 ? customersPerMonth / closeRate : 0;
  const leadsPerMonth = clamp(Math.round(derivedLeads), 10, 5000);

  const weeks = WEEKS_BY_DEADLINE[facts.goal_deadline ?? 'quarter'] ?? 12;

  return {
    dormant_contacts: dormant,
    avg_ticket_usd: ticket,
    monthly_revenue_usd: revenue,
    leads_per_month: leadsPerMonth,
    close_rate: closeRate,
    reactivation_rate: DEFAULTS.reactivation_rate,
    after_hours_share: DEFAULTS.after_hours_share,
    followup_abandon_share: DEFAULTS.followup_abandon_share,
    language_channel_share: DEFAULTS.language_channel_share,

    goal_customers_90d: clamp(Math.round(facts.goal_90d ?? Math.max(1, customersPerMonth * 3)), 1, 100000),
    close_from_meeting: DEFAULTS.close_from_meeting,
    booking_rate: DEFAULTS.booking_rate,
    touches_per_contact: DEFAULTS.touches_per_contact,
    weeks_available: weeks,
    sends_per_mailbox_week: DEFAULTS.sends_per_mailbox_week,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FUGAS
// ═══════════════════════════════════════════════════════════════════════════

export type LeakKey = 'dormant_db' | 'response_time' | 'followup' | 'language_channel';

export interface Leak {
  key: LeakKey;
  name: string;
  /** Monto mensual en USD. La conversión a moneda local es de presentación. */
  monthly_value_usd: number;
  /** La fórmula escrita como el cliente la leería. */
  formula: string;
  /** Qué supuestos entran, para poder resaltarlos y editarlos. */
  inputs: (keyof Assumptions)[];
  evidence: string;
  source_url: string | null;
  confidence: number;
}

export interface LeakContext {
  /** ¿El research detectó público bilingüe o un canal desatendido? */
  languageChannelDetected: boolean;
  /** Evidencia por fuga, aportada por el President. */
  evidence: Partial<Record<LeakKey, { text: string; source_url: string | null; confidence: number }>>;
}

const EMPTY_CONTEXT: LeakContext = { languageChannelDetected: false, evidence: {} };

export function computeLeaks(a: Assumptions, ctx: LeakContext = EMPTY_CONTEXT): Leak[] {
  const leaks: Leak[] = [];

  // fuga_base_dormida = contactos × 4% × ticket ÷ 12
  // El ÷12 reparte en el año la recuperación de una base que se trabaja una vez.
  const dormant = (a.dormant_contacts * a.reactivation_rate * a.avg_ticket_usd) / 12;
  if (dormant > 0) {
    leaks.push({
      key: 'dormant_db',
      name: 'La base que dejaste de tocar',
      monthly_value_usd: dormant,
      formula: `${fmt(a.dormant_contacts)} contactos × ${pct(a.reactivation_rate)} de reactivación × ${usd(a.avg_ticket_usd)} de ticket ÷ 12 meses`,
      inputs: ['dormant_contacts', 'reactivation_rate', 'avg_ticket_usd'],
      ...ev(ctx, 'dormant_db', 'Contactos que ya levantaron la mano y nunca volvieron a saber de ti.'),
    });
  }

  // fuga_tiempo_respuesta = leads_mes × 35% × ticket × tasa_cierre
  const responseTime =
    a.leads_per_month * a.after_hours_share * a.avg_ticket_usd * a.close_rate;
  if (responseTime > 0) {
    leaks.push({
      key: 'response_time',
      name: 'Lo que entra cuando nadie está mirando',
      monthly_value_usd: responseTime,
      formula: `${fmt(a.leads_per_month)} leads/mes × ${pct(a.after_hours_share)} fuera de horario × ${usd(a.avg_ticket_usd)} × ${pct(a.close_rate)} de cierre`,
      inputs: ['leads_per_month', 'after_hours_share', 'avg_ticket_usd', 'close_rate'],
      ...ev(
        ctx,
        'response_time',
        'Los mensajes de la noche y del fin de semana se contestan el lunes, cuando el interés ya se enfrió.',
      ),
    });
  }

  // fuga_seguimiento = leads_mes × 50% × ticket × tasa_cierre
  const followup =
    a.leads_per_month * a.followup_abandon_share * a.avg_ticket_usd * a.close_rate;
  if (followup > 0) {
    leaks.push({
      key: 'followup',
      name: 'Los que se abandonan antes del quinto toque',
      monthly_value_usd: followup,
      formula: `${fmt(a.leads_per_month)} leads/mes × ${pct(a.followup_abandon_share)} sin seguimiento × ${usd(a.avg_ticket_usd)} × ${pct(a.close_rate)} de cierre`,
      inputs: ['leads_per_month', 'followup_abandon_share', 'avg_ticket_usd', 'close_rate'],
      ...ev(
        ctx,
        'followup',
        'La mayoría de los equipos se rinde en el segundo intento. La venta suele estar en el quinto.',
      ),
    });
  }

  // fuga_idioma_canal: SOLO si el research lo detectó (§7.3).
  if (ctx.languageChannelDetected) {
    const languageChannel =
      a.leads_per_month * a.language_channel_share * a.avg_ticket_usd * a.close_rate;
    if (languageChannel > 0) {
      leaks.push({
        key: 'language_channel',
        name: 'El canal que nadie está atendiendo',
        monthly_value_usd: languageChannel,
        formula: `${fmt(a.leads_per_month)} leads/mes × ${pct(a.language_channel_share)} en canal o idioma desatendido × ${usd(a.avg_ticket_usd)} × ${pct(a.close_rate)} de cierre`,
        inputs: ['leads_per_month', 'language_channel_share', 'avg_ticket_usd', 'close_rate'],
        ...ev(ctx, 'language_channel', 'Hay demanda entrando por una puerta que nadie abre.'),
      });
    }
  }

  // 2 a 4 fugas, las más grandes primero (§7.3).
  return leaks.sort((x, y) => y.monthly_value_usd - x.monthly_value_usd).slice(0, 4);
}

function ev(
  ctx: LeakContext,
  key: LeakKey,
  fallback: string,
): { evidence: string; source_url: string | null; confidence: number } {
  const found = ctx.evidence[key];
  return {
    evidence: found?.text ?? fallback,
    source_url: found?.source_url ?? null,
    confidence: found?.confidence ?? 0.5,
  };
}

export function totalLeakUsd(leaks: Leak[]): number {
  return leaks.reduce((sum, leak) => sum + leak.monthly_value_usd, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// LA CUENTA AL REVÉS (§7.4)
// ═══════════════════════════════════════════════════════════════════════════

export interface InverseMathStep {
  label: string;
  formula: string;
  value: number;
  unit: string;
}

export interface InverseMath {
  goal_customers: number;
  meetings_needed: number;
  contacts_needed: number;
  contacts_per_week: number;
  sends_per_week: number;
  mailboxes_needed: number;
  steps: InverseMathStep[];
  /** El President escala si la meta es aritméticamente imposible (§3.1). */
  feasible: boolean;
  infeasible_reason: string | null;
}

export function computeInverseMath(a: Assumptions): InverseMath {
  const meetings = a.close_from_meeting > 0 ? a.goal_customers_90d / a.close_from_meeting : 0;
  const contacts = a.booking_rate > 0 ? meetings / a.booking_rate : 0;
  const contactsPerWeek = a.weeks_available > 0 ? contacts / a.weeks_available : 0;
  const sendsPerWeek = contactsPerWeek * a.touches_per_contact;
  const mailboxes =
    a.sends_per_mailbox_week > 0 ? Math.ceil(sendsPerWeek / a.sends_per_mailbox_week) : 0;

  const steps: InverseMathStep[] = [
    {
      label: 'Reuniones necesarias',
      formula: `${fmt(a.goal_customers_90d)} clientes ÷ ${pct(a.close_from_meeting)} de cierre desde reunión`,
      value: Math.ceil(meetings),
      unit: 'reuniones',
    },
    {
      label: 'Contactos necesarios',
      formula: `${fmt(Math.ceil(meetings))} reuniones ÷ ${pct(a.booking_rate)} de agendamiento`,
      value: Math.ceil(contacts),
      unit: 'contactos',
    },
    {
      label: 'Contactos por semana',
      formula: `${fmt(Math.ceil(contacts))} contactos ÷ ${a.weeks_available} semanas`,
      value: Math.ceil(contactsPerWeek),
      unit: 'contactos/semana',
    },
    {
      label: 'Envíos por semana',
      formula: `${fmt(Math.ceil(contactsPerWeek))} contactos × ${a.touches_per_contact} toques`,
      value: Math.ceil(sendsPerWeek),
      unit: 'envíos/semana',
    },
    {
      label: 'Buzones necesarios',
      formula: `${fmt(Math.ceil(sendsPerWeek))} envíos ÷ ${a.sends_per_mailbox_week} por buzón`,
      value: mailboxes,
      unit: 'buzones',
    },
  ];

  // Criterio de imposibilidad: si hay que construir más contactos de los que
  // el mercado plausiblemente tiene, o más buzones de los que se pueden
  // calentar en el plazo (1 buzón por semana disponible es ya agresivo).
  let feasible = true;
  let reason: string | null = null;

  if (contacts > 200_000) {
    feasible = false;
    reason = `La meta exige contactar ${fmt(Math.ceil(contacts))} personas en ${a.weeks_available} semanas. Eso no es un problema de ejecución, es un problema de tamaño de mercado.`;
  } else if (mailboxes > a.weeks_available) {
    feasible = false;
    reason = `Harían falta ${mailboxes} buzones y solo hay ${a.weeks_available} semanas para calentarlos. O se baja la meta, o se alarga el plazo, o se cambia a un canal que no dependa de dominios fríos.`;
  }

  return {
    goal_customers: a.goal_customers_90d,
    meetings_needed: Math.ceil(meetings),
    contacts_needed: Math.ceil(contacts),
    contacts_per_week: Math.ceil(contactsPerWeek),
    sends_per_week: Math.ceil(sendsPerWeek),
    mailboxes_needed: mailboxes,
    steps,
    feasible,
    infeasible_reason: reason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function fmt(value: number): string {
  return new Intl.NumberFormat('es-CO').format(Math.round(value));
}

function usd(value: number): string {
  return `USD ${fmt(value)}`;
}
