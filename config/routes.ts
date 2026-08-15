import type { Assumptions } from '@/config/assumptions';
import type { InverseMath } from '@/lib/diagnostic/math';

/**
 * Las 3 rutas (PRD §4.4).
 *
 * El costo va SIEMPRE separado en infraestructura y fee. Copiamos
 * deliberadamente la transparencia de LetGrowth: en este mercado, decir "esto
 * te cuesta USD 180 de infraestructura y USD 900 de fee" convierte mejor que
 * decir "desde USD 1.080". El cliente ya sabe que hay costos abajo; el que los
 * esconde parece que esconde más cosas.
 *
 * Los roadmaps llevan FECHAS REALES calculadas desde hoy, no "semana 1".
 * Y los prerequisitos van visibles: la aprobación de plantillas de Meta tarda
 * 24–48 h y a veces la rechazan. Mejor decirlo en la tarjeta que en la
 * llamada de reclamo.
 */

export type RouteKey = 'whatsapp' | 'email' | 'brand_content';

export interface Milestone {
  milestone: string;
  eta_days: number;
  owner: 'holaamigo' | 'cliente' | 'meta' | 'compartido';
}

export interface RouteSpec {
  route: RouteKey;
  label: string;
  tagline: string;
  what_it_is: string;
  bullets: string[];
  prerequisites: string[];
  roadmap: Milestone[];
  cost_infra_usd: number;
  cost_fee_usd: number;
  cost_notes: string[];
  /** El CTA de brand_content va a conversación humana, no a autoservicio. */
  cta: 'self_serve' | 'human';
  projected_impact: Record<string, number | string>;
}

/** Costo Meta por conversación de marketing iniciada por el negocio (LatAm). */
const META_MARKETING_PER_CONVERSATION_USD = 0.0125;
const MAILBOX_COST_USD = 3.5;
const DOMAIN_COST_USD = 1.2;
const DATA_TOOLING_USD = 99;

const FEE = {
  whatsapp: 890,
  email: 1290,
  brand_content: 1900,
} as const;

export function buildRoutes(a: Assumptions, m: InverseMath): RouteSpec[] {
  // ── A · WhatsApp ────────────────────────────────────────────────────────
  const monthlyConversations = Math.ceil(a.dormant_contacts / 3 + a.leads_per_month * 2);
  const whatsappInfra = Math.round(monthlyConversations * META_MARKETING_PER_CONVERSATION_USD);

  const whatsapp: RouteSpec = {
    route: 'whatsapp',
    label: 'Ruta A · WhatsApp',
    tagline: 'Manejo de leads y citas, inbound y outbound, 24/7.',
    what_it_is:
      'Un agente que contesta cada mensaje en segundos, califica, agenda y reactiva tu base dormida con plantillas aprobadas por Meta.',
    bullets: [
      `~${fmt(monthlyConversations)} conversaciones al mes`,
      'Tiempo de respuesta objetivo: menos de 60 segundos, incluyendo domingos',
      'Reactivación de tu base propia desde tu propio número',
      'Agenda conectada: la cita queda puesta sin que nadie intervenga',
    ],
    prerequisites: [
      'Un número de teléfono que no esté ya en la app de WhatsApp',
      'Cuenta de WhatsApp Business verificada con Meta',
      'Aprobación de plantillas por Meta: 24 a 48 horas, con posibilidad de rechazo',
    ],
    roadmap: [
      { milestone: 'Número conectado y verificación iniciada', eta_days: 1, owner: 'compartido' },
      { milestone: 'Plantillas enviadas a aprobación de Meta', eta_days: 2, owner: 'holaamigo' },
      { milestone: 'Base cargada, segmentada y primer envío aprobado', eta_days: 4, owner: 'holaamigo' },
      { milestone: 'Agente operando en automático con cola de decisiones', eta_days: 10, owner: 'holaamigo' },
    ],
    cost_infra_usd: whatsappInfra,
    cost_fee_usd: FEE.whatsapp,
    cost_notes: [
      `Meta cobra ~USD ${META_MARKETING_PER_CONVERSATION_USD} por conversación de marketing. Las que inicia el cliente son gratis las primeras 24 h.`,
      'El infra sube o baja con tu volumen real. No lo marcamos.',
    ],
    cta: 'self_serve',
    projected_impact: {
      conversaciones_mes: monthlyConversations,
      tiempo_respuesta_objetivo_seg: 60,
      primer_resultado_horas: 24,
    },
  };

  // ── B · Correo ──────────────────────────────────────────────────────────
  const mailboxes = Math.max(2, m.mailboxes_needed);
  const domains = Math.max(1, Math.ceil(mailboxes / 3));
  const emailInfra = Math.round(
    mailboxes * MAILBOX_COST_USD + domains * DOMAIN_COST_USD + DATA_TOOLING_USD,
  );

  const email: RouteSpec = {
    route: 'email',
    label: 'Ruta B · Correo',
    tagline: 'Agente de correo con construcción de listas y secuencias.',
    what_it_is:
      'Construimos la lista con tu ICP, calentamos la infraestructura y el agente envía, responde y agenda. Conecta con Apollo, Apify e Instantly.',
    bullets: [
      `${fmt(m.contacts_needed)} contactos a construir para tu meta`,
      `${mailboxes} buzones sobre ${domains} dominio${domains > 1 ? 's' : ''} secundario${domains > 1 ? 's' : ''}`,
      '2 a 3 semanas de calentamiento antes del primer envío en frío',
      'Bandeja de recepción conectada desde el día 1 para responder inbound',
    ],
    prerequisites: [
      'Un dominio secundario para envío en frío (nunca el principal)',
      'Acceso a Google Workspace o Microsoft 365 para los buzones',
      'Definición del ICP y de la base legal de contacto',
    ],
    roadmap: [
      { milestone: 'Dominios comprados y DNS configurado (SPF, DKIM, DMARC)', eta_days: 2, owner: 'holaamigo' },
      { milestone: 'Buzones creados, calentamiento arrancado', eta_days: 3, owner: 'holaamigo' },
      { milestone: 'Lista construida y validada, secuencias aprobadas', eta_days: 10, owner: 'compartido' },
      { milestone: 'Primer envío en frío a volumen', eta_days: 21, owner: 'holaamigo' },
    ],
    cost_infra_usd: emailInfra,
    cost_fee_usd: FEE.email,
    cost_notes: [
      `Buzones: ${mailboxes} × USD ${MAILBOX_COST_USD}. Dominios: ${domains} × USD ${DOMAIN_COST_USD}/mes. Datos y envío: USD ${DATA_TOOLING_USD}.`,
      'La promesa de 24 horas NO aplica al correo en frío: sin calentamiento se queman los dominios y la reputación no se recupera.',
      'La reactivación de tu base propia desde tu dominio actual sí arranca en 24 horas.',
    ],
    cta: 'self_serve',
    projected_impact: {
      contactos_a_construir: m.contacts_needed,
      buzones: mailboxes,
      semanas_de_calentamiento: 3,
    },
  };

  // ── C · Marca y contenido ───────────────────────────────────────────────
  const brand: RouteSpec = {
    route: 'brand_content',
    label: 'Ruta C · Marca y contenido',
    tagline: 'Vía la agencia. Arreglamos qué dices antes de decirlo más veces.',
    what_it_is:
      'Si el mensaje no es claro, automatizarlo solo escala la confusión. Reposicionamiento, mensajes por segmento y plan de contenido asistido por IA.',
    bullets: [
      'Diagnóstico de marca y reposicionamiento contra tu set competitivo',
      'Mensajes por segmento, con guiones y ángulos probados',
      'Plan de contenido con cadencia semanal, producido con IA y editado por humanos',
      'Los ángulos que ganen aquí alimentan directo a las rutas A y B',
    ],
    prerequisites: [
      'Una conversación de 45 minutos con tu equipo',
      'Acceso a lo que ya publicaste, para no repetir lo que no funcionó',
    ],
    roadmap: [
      { milestone: 'Sesión de posicionamiento', eta_days: 3, owner: 'compartido' },
      { milestone: 'Territorio de marca y mensajes por segmento', eta_days: 10, owner: 'holaamigo' },
      { milestone: 'Plan de contenido y primeras piezas', eta_days: 18, owner: 'holaamigo' },
      { milestone: 'Cadencia en marcha, ángulos alimentando a los agentes', eta_days: 30, owner: 'holaamigo' },
    ],
    cost_infra_usd: 0,
    cost_fee_usd: FEE.brand_content,
    cost_notes: [
      'Sin costo de infraestructura: es trabajo, no software.',
      'Esta ruta arranca con una conversación. No hay botón de autoservicio y es a propósito.',
    ],
    cta: 'human',
    projected_impact: {
      entregables: 'posicionamiento + mensajes + plan de contenido',
      cadencia: 'semanal',
      primeras_piezas_dias: 18,
    },
  };

  return [whatsapp, email, brand];
}

function fmt(value: number): string {
  return new Intl.NumberFormat('es-CO').format(Math.round(value));
}
