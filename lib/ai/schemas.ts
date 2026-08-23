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
  /**
   * Qué evidencia concreta haría cambiar esta recomendación (P3).
   *
   * Es el campo que convierte al agente en asesor y no en oráculo, y es donde
   * el cliente sabe exactamente qué aportar para mover el rumbo. Sin él, la
   * deliberación no se puede resolver — lo exige `holaamigo.deliberations`, no
   * el render.
   */
  what_would_change_my_mind: z
    .string()
    .describe(
      'Una frase concreta y verificable: qué dato, señal o hecho haría que esta ruta ' +
        'deje de ser la correcta. Nada de "más información".',
    ),
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
    // En modo degradado el modelo no lo produjo, y la deliberación no se puede
    // resolver sin esto. La frase de respaldo es genérica a propósito: dice qué
    // observar y admite que el diagnóstico salió corto, en vez de fingir una
    // condición precisa que nadie evaluó.
    what_would_change_my_mind:
      'El diagnóstico salió en modo degradado: si al conectar el canal la primera semana ' +
      'no produce respuestas, esta ruta se revisa antes de gastar más.',
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

// ═══════════════════════════════════════════════════════════════════════════
// EL CAPÍTULO (P3) — lo que el President escribe cada mañana
// ═══════════════════════════════════════════════════════════════════════════

export const ChapterSchema = z.object({
  titulo: z.string().describe('Cinco palabras o menos. Es el asunto del correo.'),
  body: z
    .string()
    .describe(
      'De 150 a 250 palabras, en prosa. Qué hizo la organización ayer, sobre qué discutió, ' +
        'qué decidió, qué cambió de opinión y qué necesita del humano hoy.',
    ),
  needs_from_human: z
    .array(z.string())
    .describe('Lo que hace falta del humano hoy, en frases cortas. Vacío si no hace falta nada.'),
});
export type Chapter = z.infer<typeof ChapterSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// LA CMO EXPANDIDA (P5)
// ═══════════════════════════════════════════════════════════════════════════

/** Un ángulo nuevo, cuando el anterior se quemó. */
export const NewAngleSchema = z.object({
  name: z.string().describe('Cinco palabras o menos. Es la etiqueta interna, no el asunto.'),
  hypothesis: z.string().describe('Qué creemos que le duele a este segmento y por qué este mensaje pega.'),
  target_segment: z.string(),
  opener: z.string().describe('Primer mensaje real: máximo 40 palabras, sin promesas de precio.'),
  por_que_distinto: z.string().describe('En qué se diferencia del ángulo que se quemó. Si no es distinto, no sirve.'),
});
export type NewAngle = z.infer<typeof NewAngleSchema>;

/** El borrador de un caso de estudio. Los números NO salen de acá. */
export const CaseStudyDraftSchema = z.object({
  titulo: z.string(),
  situacion: z.string().describe('Qué pasaba antes, en dos frases.'),
  que_hicimos: z.string(),
  resultado: z.string().describe('Usa SOLO las cifras del input. Ninguna otra.'),
  cita_sugerida: z.string().describe('Lo que el cliente podría decir. Va a pedirse su aprobación textual.'),
});
export type CaseStudyDraft = z.infer<typeof CaseStudyDraftSchema>;

/** Por qué importa un cambio en el sitio de un competidor. */
export const CompetitorImpactSchema = z.object({
  why_it_matters: z.string().describe('Dos frases. Qué significa para ESTE cliente y qué NO hay que hacer.'),
  severity: z.enum(['low', 'normal', 'high']),
});
export type CompetitorImpact = z.infer<typeof CompetitorImpactSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// PLAYBOOK — el lenguaje del agente de agendamiento (P7)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo ÚNICO que el modelo aporta al playbook: cómo se dicen las cosas.
 *
 * MIRÁ EL ESQUEMA Y CONTÁ LOS `z.number()`. Son cero, y no es casualidad: el
 * precio, la duración de la cita, la franja horaria y los topes los pone
 * `lib/playbook/compile.ts` desde el Brief y desde la configuración real del
 * agendador. Un modelo que puede escribir un número en el guion es un modelo
 * que algún día le va a decir a un contacto "cuesta 400 dólares" sin que nadie
 * lo haya autorizado.
 *
 * Es ADR 0007 llevado hasta su conclusión: la regla no es "revisá los números
 * que devuelve el modelo", es "no le dejes escribir ninguno".
 */
export const PlaybookLanguageSchema = z.object({
  lo_que_vendemos_aca: z
    .string()
    .describe(
      'Qué vende el agente en ESTA conversación. Es la cita, no el producto. Una frase que sirva para volver al carril cuando la charla se va a hablar del producto.',
    ),

  calificacion: z.object({
    preguntas: z.array(
      z.object({
        campo: z.enum(['encaje', 'momento', 'decisor', 'dolor']),
        pregunta: z.string().describe('Tal cual se envía por WhatsApp. UNA sola pregunta. Máximo 25 palabras.'),
        por_que: z.string().describe('Por qué esta pregunta importa en este negocio. Lo lee el cliente, no el contacto.'),
        descalifica_si: z.array(z.string()).describe('Respuestas que hacen que no valga la pena la cita.'),
      }),
    ),
    fuera_de_alcance: z.array(z.string()).describe('A quién NO le sirve esto. Sale del ICP.'),
  }),

  objeciones: z.array(
    z.object({
      objecion: z.string().describe('Como la escribe un contacto real por WhatsApp, no como la clasificaría un CRM.'),
      respuesta: z.string().describe('Máximo dos frases. Termina volviendo a la cita, siempre.'),
      source_url: z.string().nullable(),
      inferred: z.boolean(),
    }),
  ),

  faq: z.array(
    z.object({
      pregunta: z.string(),
      respuesta: z.string().describe('Máximo dos frases. Sin precios que no estén en el input.'),
      source_url: z.string().nullable(),
      inferred: z.boolean(),
    }),
  ),

  guion: z.object({
    apertura: z.string().describe('Primer mensaje en frío. DICE DE DÓNDE SALIÓ EL NÚMERO. Máximo 40 palabras.'),
    apertura_inbound: z.string().describe('Primer mensaje para quien escribió primero. No se presenta igual.'),
    puente_a_la_cita: z.string().describe('De "hablemos" a "agendemos". Máximo 30 palabras.'),
    oferta_de_horarios: z.string().describe('Cómo se ofrecen los horarios. Usa {{horarios}} donde van los cupos reales.'),
    confirmacion: z.string().describe('Resumen de la cita + cómo cancelar. Usa {{cita}} y {{link}}.'),
    seguimientos: z.array(z.string()).describe('Tres, de más a menos presión. El último da una salida limpia.'),
    cierre_cortes: z.string().describe('Cómo se cierra con quien no califica, sin quemar la marca.'),
  }),

  escalamiento: z.object({
    disparadores: z.array(z.string()).describe('Qué manda la conversación a un humano. Nunca vacío.'),
    mensaje_al_contacto: z.string().describe('Lo que el agente escribe al escalar. El contacto no se queda en silencio.'),
  }),

  que_pasa_en_la_cita: z.string().describe('Qué va a pasar en esos minutos. Lo preguntan siempre.'),
});
export type PlaybookLanguage = z.infer<typeof PlaybookLanguageSchema>;

/** Camino degradado: lo mínimo con lo que un setter puede trabajar. */
export const PlaybookLanguageMinimalSchema = z.object({
  lo_que_vendemos_aca: z.string(),
  preguntas: z.array(z.string()).describe('Preguntas de calificación, en orden.'),
  apertura: z.string(),
  puente_a_la_cita: z.string(),
});
export type PlaybookLanguageMinimal = z.infer<typeof PlaybookLanguageMinimalSchema>;

/**
 * El setter clasificando su propio turno.
 *
 * `stage` y `qualification` no se le piden al modelo por prolijidad: son lo que
 * alimenta `holaamigo.embudo_del_setter()`. Un embudo cuyo escalón lo deduce
 * una expresión regular sobre el texto del mensaje es un embudo que miente el
 * día que alguien reescribe el guion.
 */
export const SetterTurnSchema = z.object({
  mensaje: z.string().describe('Lo que se le envía al contacto. Máximo 45 palabras. UNA pregunta.'),
  stage: z.enum([
    'apertura',
    'descubrimiento',
    'calificacion',
    'objecion',
    'oferta_de_cita',
    'agendamiento',
    'confirmado',
    'cerrado',
  ]),
  descubierto: z.object({
    encaje: z.string().nullable(),
    momento: z.string().nullable(),
    decisor: z.string().nullable(),
    dolor: z.string().nullable(),
  }),
  intencion: z.enum([
    'interested',
    'question',
    'objection',
    'not_now',
    'not_interested',
    'opt_out',
    'complaint',
    'legal',
    'ask_price',
    'other',
  ]),
  debe_escalar: z.boolean(),
  motivo_de_escalamiento: z.string().nullable(),
});
export type SetterTurn = z.infer<typeof SetterTurnSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// SMOKE TESTER — probarle la línea al cliente antes de venderle nada
//
// Los tres esquemas de acá comparten una restricción que no es estilística:
// NO TIENEN UN SOLO `z.number()`. Ni el compilador de la prueba, ni el
// comprador sintético, ni el evaluador devuelven una cifra.
//
// El compilador y el comprador porque lo que escriben sale por WhatsApp a un
// negocio real sin ninguna pantalla intermedia donde un humano lo lea — el
// mismo argumento de ADR 0024.
//
// El evaluador porque su salida la lee el CLIENTE en su diagnóstico, y ninguna
// cifra que el cliente lee sale de un modelo (ADR 0007). Se le piden juicios
// cualitativos —«bien», «regular»— y el código los convierte a la escala 0-100
// con una tabla fija. Pedirle un 78 sería falsa precisión: el mismo texto le
// saca 74 y 79 en dos corridas, y ese ruido llegaría al cliente como si fuera
// medición. Ver docs/adr/0025-el-smoke-tester-como-evidencia.md
// ═══════════════════════════════════════════════════════════════════════════

/** Los cinco escalones. El código los mapea a números; el modelo solo elige. */
export const JuicioSchema = z.enum(['excelente', 'bien', 'regular', 'mal', 'pesimo']);
export type Juicio = z.infer<typeof JuicioSchema>;

/**
 * Lo que el modelo aporta al armar una prueba: LENGUAJE.
 *
 * Los hechos —qué precio está publicado, qué producto vende, en qué ciudad
 * atiende— los pone el código leyendo el research. Acá solo se pide cómo se
 * pregunta, con qué palabras, para que suene a una persona escribiendo por
 * WhatsApp y no a un cuestionario.
 */
export const PruebaLenguajeSchema = z.object({
  apertura: z
    .string()
    .describe(
      'El primer mensaje que le llega al negocio. Como lo escribiría un cliente real por WhatsApp: dos frases máximo, sin markdown, sin viñetas, sin presentarse formalmente. NUNCA menciona que es una prueba.',
    ),
  objetivo: z
    .string()
    .describe(
      'A dónde tiene que llegar esta conversación, en una frase, ya instanciada con lo que este negocio vende.',
    ),
  sondas: z
    .array(
      z.object({
        id: z.string().describe('Slug corto y estable: precio, cobertura, evento, horario…'),
        pregunta: z
          .string()
          .describe(
            'La pregunta tal cual se manda por WhatsApp. UNA sola pregunta, máximo 20 palabras, en español coloquial del país del negocio.',
          ),
        por_que: z
          .string()
          .describe(
            'Por qué esta pregunta le sirve a ESTE negocio. Lo lee el dueño en su diagnóstico, no el que contesta.',
          ),
        del_research: z
          .boolean()
          .describe(
            'true si la pregunta salió de algo concreto que dice el sitio (un evento, una promoción, una promesa de respuesta). false si es una pregunta genérica del molde.',
          ),
      }),
    )
    .describe('Entre tres y seis. Ordenadas como las haría una persona, no como un formulario.'),
  criterios_cierre: z
    .array(z.string())
    .describe('Cuándo el comprador da la conversación por terminada. Frases cortas.'),
});
export type PruebaLenguaje = z.infer<typeof PruebaLenguajeSchema>;

/** Camino degradado: lo mínimo con lo que se puede correr una prueba. */
export const PruebaLenguajeMinimalSchema = z.object({
  apertura: z.string(),
  preguntas: z.array(z.string()),
});

export function inflarPruebaLenguaje(
  min: z.infer<typeof PruebaLenguajeMinimalSchema>,
): PruebaLenguaje {
  return {
    apertura: min.apertura,
    objetivo: 'Obtener respuesta a las preguntas y llegar a un paso siguiente concreto.',
    sondas: min.preguntas.slice(0, 6).map((pregunta, i) => ({
      id: `sonda_${i + 1}`,
      pregunta,
      por_que: 'Pregunta del molde: el research no alcanzó para especializarla.',
      del_research: false,
    })),
    criterios_cierre: ['Contestaron lo que se preguntó', 'La conversación empezó a dar vueltas'],
  };
}

/**
 * Un turno del comprador sintético.
 *
 * `motivo` no decide nada: se guarda y es lo que después explica por qué la
 * conversación tomó el rumbo que tomó. Vale su peso en oro depurando.
 */
export const CompradorTurnoSchema = z.object({
  mensaje: z
    .string()
    .describe('Lo que se manda por WhatsApp, tal cual. Sin markdown, sin viñetas, sin comillas.'),
  terminar: z.boolean().describe('true si el objetivo ya se cumplió o la charla da vueltas.'),
  motivo: z.string().describe('Por qué sigue, o por qué termina. Una frase.'),
});
export type CompradorTurno = z.infer<typeof CompradorTurnoSchema>;

/**
 * La evaluación de una conversación cerrada.
 *
 * Cinco juicios cualitativos y tres listas. Las listas son lo que de verdad se
 * lee: una alucinación citada textualmente es accionable, un 82 no.
 */
export const EvaluacionPruebaSchema = z.object({
  exactitud: JuicioSchema.describe('¿Lo que dijo coincide con la ficha de verdad del sitio?'),
  tono: JuicioSchema.describe('¿Profesional y apropiado para el mercado?'),
  completitud: JuicioSchema.describe('¿Contestó cada pregunta entera, o esquivó?'),
  proactividad: JuicioSchema.describe('¿Ofreció algo relevante sin que se lo pidieran?'),
  ausencia_de_invenciones: JuicioSchema.describe(
    'excelente = no inventó nada. pesimo = casi todo lo que dijo no está en la ficha.',
  ),
  alucinaciones: z
    .array(z.string())
    .describe('CITA TEXTUAL de cada dato que dijo y que contradice la ficha o no está en ella.'),
  errores: z.array(z.string()).describe('Problemas concretos, en una frase cada uno.'),
  sugerencias: z
    .array(z.string())
    .describe('Qué cambiaría el resultado. Dirigidas al dueño del negocio, no a nosotros.'),
  resumen: z
    .string()
    .describe(
      'Dos frases para el dueño del negocio, en segunda persona. Sin cifras: las cifras las pone el código.',
    ),
});
export type EvaluacionPrueba = z.infer<typeof EvaluacionPruebaSchema>;
