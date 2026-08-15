/**
 * Banco de preguntas fijas (PRD §6).
 *
 * Está duplicado con `supabase/migrations/0002_seed_quiz.sql` a propósito:
 * la tabla existe para poder corregir copy sin desplegar, y este archivo es el
 * fallback si la migración todavía no corrió. El servicio prefiere la tabla.
 * Si divergen, gana la tabla — y eso es intencional.
 */

export interface QuizOption {
  value: string;
  label: string;
  mid?: number;
}

export interface QuizQuestion {
  id: string;
  category: string;
  prompt: string;
  help_text: string | null;
  input_type: 'single' | 'multi' | 'number' | 'text' | 'scale' | 'upload';
  options: QuizOption[];
  required: boolean;
  sort_order: number;
  /** `fixed` = del banco · `generated` = del CMO · `closing` = la de cierre. */
  kind: 'fixed' | 'generated' | 'closing';
  /** Solo en las generadas. */
  slot?: string;
}

export const FIXED_QUESTIONS: QuizQuestion[] = [
  {
    id: 'main_offer',
    category: 'oferta',
    prompt: 'Si tuvieras que vender una sola cosa este trimestre, ¿cuál sería?',
    help_text: 'Una frase basta. Es lo que va a guiar todo lo demás.',
    input_type: 'text',
    options: [],
    required: true,
    sort_order: 10,
    kind: 'fixed',
  },
  {
    id: 'ticket_band',
    category: 'numeros',
    prompt: '¿Cuánto factura un cliente promedio la primera vez?',
    help_text: 'El valor del primer contrato o primera compra, no el lifetime value.',
    input_type: 'single',
    options: [
      { value: 'lt_500', label: 'Menos de USD 500', mid: 300 },
      { value: '500_2k', label: 'USD 500 – 2.000', mid: 1200 },
      { value: '2k_10k', label: 'USD 2.000 – 10.000', mid: 5000 },
      { value: '10k_50k', label: 'USD 10.000 – 50.000', mid: 25000 },
      { value: 'gt_50k', label: 'Más de USD 50.000', mid: 80000 },
    ],
    required: true,
    sort_order: 20,
    kind: 'fixed',
  },
  {
    id: 'rev_band',
    category: 'numeros',
    prompt: '¿Cuánto factura la empresa al mes hoy?',
    help_text: 'Aproximado está bien. Nadie va a auditar esto.',
    input_type: 'single',
    options: [
      { value: 'lt_10k', label: 'Menos de USD 10k', mid: 5000 },
      { value: '10k_50k', label: 'USD 10k – 50k', mid: 28000 },
      { value: '50k_200k', label: 'USD 50k – 200k', mid: 110000 },
      { value: '200k_1m', label: 'USD 200k – 1M', mid: 500000 },
      { value: 'gt_1m', label: 'Más de USD 1M', mid: 1500000 },
    ],
    required: true,
    sort_order: 30,
    kind: 'fixed',
  },
  {
    id: 'sales_team',
    category: 'equipo',
    prompt: '¿Cuántas personas se dedican a vender o a contestarle a los clientes?',
    help_text: null,
    input_type: 'single',
    options: [
      { value: '0', label: 'Nadie de tiempo completo', mid: 0 },
      { value: '1_2', label: '1 o 2', mid: 1.5 },
      { value: '3_5', label: '3 a 5', mid: 4 },
      { value: '6_15', label: '6 a 15', mid: 10 },
      { value: 'gt_15', label: 'Más de 15', mid: 25 },
    ],
    required: true,
    sort_order: 40,
    kind: 'fixed',
  },
  {
    id: 'dormant_db',
    category: 'data',
    prompt: '¿Cuántos contactos tienes guardados que mostraron interés y nunca compraron?',
    help_text: 'CRM, Excel, WhatsApp, la libreta — todo junto. Es la pregunta que más plata mueve.',
    input_type: 'single',
    options: [
      { value: 'unknown', label: 'No sé', mid: 800 },
      { value: 'lt_500', label: 'Menos de 500', mid: 250 },
      { value: '500_2k', label: '500 – 2.000', mid: 1200 },
      { value: '2k_10k', label: '2.000 – 10.000', mid: 5500 },
      { value: 'gt_10k', label: 'Más de 10.000', mid: 18000 },
    ],
    required: true,
    sort_order: 50,
    kind: 'fixed',
  },
  {
    id: 'main_channel',
    category: 'motor',
    prompt: '¿De dónde salen hoy la mayoría de tus clientes?',
    help_text: 'Puedes marcar varios.',
    input_type: 'multi',
    options: [
      { value: 'referidos', label: 'Referidos' },
      { value: 'pauta', label: 'Pauta' },
      { value: 'organico', label: 'Orgánico / SEO' },
      { value: 'outbound', label: 'Outbound' },
      { value: 'eventos', label: 'Eventos' },
      { value: 'marketplace', label: 'Marketplace' },
    ],
    required: true,
    sort_order: 60,
    kind: 'fixed',
  },
];

export const CLOSING_QUESTION: QuizQuestion = {
  id: 'goal_deadline',
  category: 'cierre',
  prompt: '¿Para cuándo necesitas ver resultados?',
  help_text: null,
  input_type: 'single',
  options: [
    { value: 'week', label: 'Esta semana' },
    { value: 'month', label: 'Este mes' },
    { value: 'quarter', label: 'Este trimestre' },
    { value: 'exploring', label: 'Estoy explorando' },
  ],
  required: true,
  sort_order: 900,
  kind: 'closing',
};

/** Slots adaptativos válidos. El modelo solo puede devolver estos. */
export const ADAPTIVE_SLOTS = [
  'offer_margin',
  'real_competitor',
  'price_choice',
  'differentiator',
  'friction',
  'speed',
  'goal_90d',
  'tone',
  'limits',
] as const;

export type AdaptiveSlot = (typeof ADAPTIVE_SLOTS)[number];

/**
 * Preguntas adaptativas de respaldo. Se usan cuando el research quedó vacío o
 * cuando el modelo falla: el quiz nunca se queda corto. Ninguna depende de
 * hallazgos, y goal_90d va siempre porque alimenta la cuenta al revés.
 */
export const FALLBACK_ADAPTIVE: QuizQuestion[] = [
  {
    id: 'gen_differentiator',
    slot: 'differentiator',
    category: 'marca',
    prompt: '¿Qué haces distinto que un cliente notaría en la primera semana?',
    help_text: null,
    input_type: 'text',
    options: [],
    required: true,
    sort_order: 110,
    kind: 'generated',
  },
  {
    id: 'gen_friction',
    slot: 'friction',
    category: 'ventas',
    prompt: 'Cuando pierden un negocio, ¿cuál es la razón más común?',
    help_text: null,
    input_type: 'single',
    options: [
      { value: 'precio', label: 'El precio' },
      { value: 'tiempo', label: 'Nos demoramos en responder' },
      { value: 'competencia', label: 'Se fueron con otro' },
      { value: 'timing', label: 'No era el momento' },
      { value: 'no_sabemos', label: 'La verdad, no sabemos' },
    ],
    required: true,
    sort_order: 120,
    kind: 'generated',
  },
  {
    id: 'gen_speed',
    slot: 'speed',
    category: 'operacion',
    prompt: 'Si alguien escribe un sábado a las 9 p.m., ¿cuándo le contestan?',
    help_text: null,
    input_type: 'single',
    options: [
      { value: 'minutos', label: 'En minutos' },
      { value: 'horas', label: 'En un par de horas' },
      { value: 'lunes', label: 'El lunes' },
      { value: 'a_veces', label: 'Depende de quién esté' },
    ],
    required: true,
    sort_order: 130,
    kind: 'generated',
  },
  {
    id: 'gen_goal_90d',
    slot: 'goal_90d',
    category: 'meta',
    prompt: '¿Cuántos clientes nuevos necesitas en los próximos 90 días para que este trimestre sea bueno?',
    help_text: 'Un número. Este es el que arma toda la cuenta al revés.',
    input_type: 'number',
    options: [],
    required: true,
    sort_order: 140,
    kind: 'generated',
  },
  {
    id: 'gen_limits',
    slot: 'limits',
    category: 'marca',
    prompt: '¿Hay algo que tu marca nunca diría o nunca prometería?',
    help_text: 'Esto se convierte en una prohibición dura para los agentes.',
    input_type: 'text',
    options: [],
    required: false,
    sort_order: 150,
    kind: 'generated',
  },
];
