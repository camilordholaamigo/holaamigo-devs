import { z } from 'zod';

/**
 * Esquemas de salida de los agentes (PRD §8.4).
 *
 * Dos reglas que vienen de cómo funciona `strict: true` en la Responses API:
 *
 *  1. NADA de `.optional()`. En modo estricto todos los campos son requeridos;
 *     lo que puede faltar se modela con `.nullable()`.
 *  2. NADA de `.min()`, `.max()`, `.url()`, `.email()`. Esos keywords no están
 *     en el subconjunto de JSON Schema que acepta el modo estricto y hacen que
 *     el API rechace la petición. Los rangos se validan después con `clamp`.
 *
 * Cada esquema tiene un hermano `*Minimal` para el camino degradado: si la
 * salida completa falla dos veces, pedimos lo mínimo renderizable en vez de
 * dejar al usuario sin diagnóstico.
 */

export const SourceSchema = z.object({
  url: z.string(),
  title: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH — lo que el motor de investigación devuelve del sitio del cliente
// ═══════════════════════════════════════════════════════════════════════════

export const ResearchSchema = z.object({
  company_name: z.string().nullable().describe('Nombre comercial tal como se presenta.'),
  country: z.string().nullable().describe('Código ISO de 2 letras si es deducible.'),
  industry: z.string().nullable(),
  language: z.string().nullable().describe('Idioma principal del sitio: es, en, pt.'),

  offer: z.object({
    summary: z.string().describe('Qué vende, en una frase.'),
    products: z.array(
      z.object({ name: z.string(), description: z.string() }),
    ),
    confidence: z.number().describe('0 a 1.'),
  }),

  pricing: z.object({
    is_public: z.boolean(),
    observed: z.array(z.string()).describe('Precios textuales encontrados.'),
    notes: z.string(),
    confidence: z.number(),
  }),

  icp: z.object({
    description: z.string(),
    segments: z.array(z.string()),
    confidence: z.number(),
  }),

  competitors: z.array(
    z.object({
      name: z.string(),
      url: z.string().nullable(),
      promise: z.string().describe('Qué prometen en su home.'),
      positioning: z.string().describe('Cómo se posicionan: precio, premium, nicho…'),
      publishes_pricing: z.boolean(),
    }),
  ),

  positioning: z.object({
    claim: z.string().describe('La promesa central del cliente.'),
    differentiators: z.array(z.string()),
    weaknesses: z.array(z.string()).describe('Dónde pierde contra los competidores.'),
    confidence: z.number(),
  }),

  channels: z.object({
    detected: z.array(z.string()).describe('whatsapp, instagram, formulario, chat, teléfono…'),
    has_whatsapp: z.boolean(),
    bilingual_audience: z.boolean(),
    response_promise: z.string().nullable().describe('Si el sitio promete tiempo de respuesta.'),
    notes: z.string(),
  }),

  social_proof: z.object({
    has_testimonials: z.boolean(),
    has_case_studies: z.boolean(),
    notes: z.string(),
  }),

  crawl_ok: z.boolean().describe('false si el sitio bloqueó o no se pudo leer.'),
  sources: z.array(SourceSchema),
});
export type ResearchOutput = z.infer<typeof ResearchSchema>;

export const ResearchMinimalSchema = z.object({
  company_name: z.string().nullable(),
  country: z.string().nullable(),
  industry: z.string().nullable(),
  language: z.string().nullable(),
  offer_summary: z.string(),
  competitors: z.array(z.object({ name: z.string(), url: z.string().nullable() })),
  sources: z.array(SourceSchema),
});
export type ResearchMinimal = z.infer<typeof ResearchMinimalSchema>;

/** Adapta la salida degradada a la forma completa para no bifurcar el render. */
export function inflateResearch(min: ResearchMinimal): ResearchOutput {
  return {
    company_name: min.company_name,
    country: min.country,
    industry: min.industry,
    language: min.language,
    offer: { summary: min.offer_summary, products: [], confidence: 0.3 },
    pricing: { is_public: false, observed: [], notes: '', confidence: 0 },
    icp: { description: '', segments: [], confidence: 0 },
    competitors: min.competitors.map((c) => ({
      name: c.name,
      url: c.url,
      promise: '',
      positioning: '',
      publishes_pricing: false,
    })),
    positioning: { claim: '', differentiators: [], weaknesses: [], confidence: 0 },
    channels: {
      detected: [],
      has_whatsapp: false,
      bilingual_audience: false,
      response_promise: null,
      notes: '',
    },
    social_proof: { has_testimonials: false, has_case_studies: false, notes: '' },
    crawl_ok: false,
    sources: min.sources,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// QUIZ ADAPTATIVO — el CMO instancia plantillas de intención con datos reales
// ═══════════════════════════════════════════════════════════════════════════

export const AdaptiveQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      slot: z
        .string()
        .describe('Clave estable: offer_margin, real_competitor, price_choice, differentiator, friction, speed, goal_90d, tone, limits.'),
      prompt: z.string().describe('La pregunta, en español, tuteando, máximo 22 palabras.'),
      help_text: z.string().nullable(),
      input_type: z.enum(['single', 'multi', 'number', 'text', 'scale']),
      options: z.array(z.object({ value: z.string(), label: z.string() })),
    }),
  ),
});
export type AdaptiveQuestions = z.infer<typeof AdaptiveQuestionsSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO — lo ensambla el President con insumo del CMO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `source` obligatorio en cada afirmación: o va una URL, o va la marca
 * `inferido`. Sin una de las dos, no se renderiza (Principio §13.4).
 */
export const ClaimSchema = z.object({
  text: z.string(),
  source_url: z.string().nullable(),
  inferred: z.boolean(),
});

export const DiagnosisSchema = z.object({
  // §7.1 Quién eres — exactamente tres frases.
  identity: z.object({
    sentences: z.array(ClaimSchema).describe('Tres frases: oferta, ICP, modelo de negocio.'),
    business_model: z.string(),
  }),

  // §7.2 Tu posición
  position: z.object({
    axis_x_label: z.string().describe('Eje horizontal de la matriz, ej. "Precio".'),
    axis_y_label: z.string().describe('Eje vertical, ej. "Especialización".'),
    you: z.object({ x: z.number(), y: z.number(), note: z.string() }),
    competitors: z.array(
      z.object({
        name: z.string(),
        url: z.string().nullable(),
        promise: z.string(),
        positioning: z.string(),
        publishes_pricing: z.boolean(),
        you_win_on: z.string(),
        you_lose_on: z.string(),
        x: z.number(),
        y: z.number(),
      }),
    ),
    summary: z.string(),
  }),

  // Insumo del CMO para el copy de las rutas.
  brand: z.object({
    clarity_score: z.number().describe('0 a 100: qué tan claro es qué vende.'),
    tone: z.string(),
    strengths: z.array(z.string()),
    gaps: z.array(z.string()),
  }),

  // §7.3 Las fugas. El motor calcula los montos; el modelo aporta evidencia.
  leaks: z.array(
    z.object({
      key: z.enum(['dormant_db', 'response_time', 'followup', 'language_channel']),
      name: z.string().describe('Título en español, concreto, sin adjetivos vacíos.'),
      evidence: z.string().describe('Por qué creemos que esta fuga existe en ESTE negocio.'),
      source_url: z.string().nullable(),
      confidence: z.number(),
    }),
  ),

  // §7.5 Rationale de la ruta recomendada, en una frase.
  recommended_route: z.enum(['whatsapp', 'email', 'brand_content']),
  recommended_rationale: z.string().describe('Una sola frase. Por qué esta y no otra.'),
  route_notes: z.object({
    whatsapp: z.string(),
    email: z.string(),
    brand_content: z.string(),
  }),

  // Ángulos del CMO (§3.2: mínimo 5).
  angles: z.array(
    z.object({
      name: z.string(),
      hypothesis: z.string(),
      target_segment: z.string(),
      opener: z.string().describe('Primer mensaje, máximo 40 palabras, sin promesas de precio.'),
    }),
  ),

  escalations: z.array(z.string()).describe('Motivos de escalamiento detectados, vacío si ninguno.'),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const DiagnosisMinimalSchema = z.object({
  identity_sentences: z.array(z.string()),
  competitors: z.array(z.object({ name: z.string(), promise: z.string() })),
  recommended_route: z.enum(['whatsapp', 'email', 'brand_content']),
  recommended_rationale: z.string(),
  angles: z.array(z.object({ name: z.string(), hypothesis: z.string(), opener: z.string() })),
});
export type DiagnosisMinimal = z.infer<typeof DiagnosisMinimalSchema>;

export function inflateDiagnosis(min: DiagnosisMinimal): Diagnosis {
  return {
    identity: {
      sentences: min.identity_sentences.map((text) => ({
        text,
        source_url: null,
        inferred: true,
      })),
      business_model: '',
    },
    position: {
      axis_x_label: 'Precio',
      axis_y_label: 'Especialización',
      you: { x: 50, y: 50, note: '' },
      competitors: min.competitors.map((c, i) => ({
        name: c.name,
        url: null,
        promise: c.promise,
        positioning: '',
        publishes_pricing: false,
        you_win_on: '',
        you_lose_on: '',
        x: 30 + i * 15,
        y: 40 + i * 10,
      })),
      summary: '',
    },
    brand: { clarity_score: 50, tone: '', strengths: [], gaps: [] },
    leaks: [],
    recommended_route: min.recommended_route,
    recommended_rationale: min.recommended_rationale,
    route_notes: { whatsapp: '', email: '', brand_content: '' },
    angles: min.angles.map((a) => ({
      name: a.name,
      hypothesis: a.hypothesis,
      target_segment: 'general',
      opener: a.opener,
    })),
    escalations: ['diagnóstico generado en modo degradado'],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COPY DE CAMPAÑA — el CMO redacta la secuencia (v2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El modelo escribe el TEXTO. No escribe la audiencia, ni el costo, ni el
 * resultado esperado: eso lo calcula lib/campaigns/math.ts y config/credits.ts
 * (ADR 0007). Si el copy falla, la campaña se propone igual con las plantillas
 * de respaldo — una propuesta con copy genérico se puede editar; una propuesta
 * que no existe no se puede aprobar.
 */
export const CampaignCopySchema = z.object({
  angle_name: z.string().describe('Nombre del ángulo, máximo 6 palabras.'),
  hypothesis: z.string().describe('Qué creemos que va a hacer que esta gente conteste.'),
  steps: z.array(
    z.object({
      step_index: z.number().describe('Empieza en 0 y sigue el orden de la secuencia dada.'),
      subject: z
        .string()
        .describe('Asunto en minúscula, máximo 7 palabras, sin signos de admiración.'),
      body: z
        .string()
        .describe(
          'Cuerpo del correo. Puede usar {{nombre}}, {{empresa}}, {{cargo}}, {{mi_nombre}}, {{mi_empresa}}. Sin firma: la pone el sistema.',
        ),
    }),
  ),
});
export type CampaignCopy = z.infer<typeof CampaignCopySchema>;

// ═══════════════════════════════════════════════════════════════════════════
// EL PRESIDENT REDACTA UNA PROPUESTA DEL FEED (v2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mismo principio: el President recibe las cifras YA CALCULADAS y solo las
 * redacta. Por eso no hay ningún campo numérico en este esquema. Si lo
 * hubiera, tendríamos un agente que razona sobre dinero inventando el monto de
 * su propia propuesta (§13.1).
 */
export const FeedProposalSchema = z.object({
  title: z.string().describe('Máximo 10 palabras. Concreto, sin adjetivos.'),
  body: z
    .string()
    .describe(
      'Dos o tres frases dirigidas al dueño, tuteando. Menciona las cifras exactas que te dieron, sin cambiarlas ni redondearlas.',
    ),
  rationale: z.string().describe('Una frase: por qué esto y por qué ahora.'),
  if_approved: z.string().describe('Qué pasa si aprueba, en una frase.'),
  if_rejected: z.string().describe('Qué pasa si no, en una frase.'),
});
export type FeedProposal = z.infer<typeof FeedProposalSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// RESPUESTA DE CORREO — el agente SALES decide qué hacer con un inbound (v2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extiende InboundClassification con la decisión operativa: ¿esto se agenda
 * solo, se contesta solo, o entra un humano? La acción `book` es la única que
 * el agente puede ejecutar sin aprobación previa, y solo porque agendar no
 * gasta dinero ni promete precio.
 */
export const EmailReplyDecisionSchema = z.object({
  intent: z.enum([
    'interested',
    'not_interested',
    'ask_price',
    'ask_info',
    'wants_meeting',
    'wrong_person',
    'out_of_office',
    'opt_out',
    'complaint',
    'legal',
    'other',
  ]),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  action: z.enum(['book', 'reply', 'escalate', 'suppress', 'ignore']),
  needs_human: z.boolean(),
  reason: z.string().describe('Por qué esa acción. Una frase.'),
  suggested_reply: z
    .string()
    .nullable()
    .describe('Solo si action es reply o book. Máximo 45 palabras. Nunca promete precio.'),
  /** Fecha y hora que el contacto propuso, si propuso alguna. El código valida
   *  que exista el cupo: el modelo solo la lee del texto. */
  proposed_time_iso: z.string().nullable(),
});
export type EmailReplyDecision = z.infer<typeof EmailReplyDecisionSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// MAPEO DE COLUMNAS — el asistente de carga de leads (§4.6)
// ═══════════════════════════════════════════════════════════════════════════

export const ColumnMappingSchema = z.object({
  mapping: z.object({
    full_name: z.string().nullable().describe('Nombre exacto de la columna, o null.'),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    company: z.string().nullable(),
    title: z.string().nullable(),
    last_interaction: z.string().nullable(),
  }),
  detected_country: z.string().nullable().describe('ISO de 2 letras para normalizar teléfonos.'),
  notes: z.string(),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// CLASIFICACIÓN DE INBOUND (agente SALES)
// ═══════════════════════════════════════════════════════════════════════════

export const InboundClassificationSchema = z.object({
  intent: z.enum([
    'interested',
    'not_interested',
    'ask_price',
    'ask_info',
    'wrong_person',
    'opt_out',
    'complaint',
    'legal',
    'other',
  ]),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  should_escalate: z.boolean(),
  escalation_reason: z.string().nullable(),
  suggested_reply: z.string().nullable(),
});
export type InboundClassification = z.infer<typeof InboundClassificationSchema>;
