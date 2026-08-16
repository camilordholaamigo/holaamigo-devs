/**
 * Los playbooks de campaña.
 *
 * Una campaña en Hola Amigo no es "una lista de correos programados": es un
 * plan con cuatro partes que se escriben ANTES de enviar nada —
 *
 *   1. a quién le pegamos y por qué ese segmento,
 *   2. qué esperamos que pase, con números,
 *   3. cómo lo vamos a medir y cuándo lo miramos,
 *   4. qué cambiamos si no pasa.
 *
 * Sin la 4, una campaña que no funciona se queda corriendo hasta que alguien se
 * acuerda de mirarla. Por eso las reglas de iteración son parte del playbook y
 * no una buena intención del operador.
 *
 * Los benchmarks son CONSERVADORES y están anotados uno por uno. Igual que los
 * supuestos del diagnóstico (config/assumptions.ts): un número inflado que no
 * se cumple destruye más confianza que uno modesto que sí.
 *
 * Ver docs/wiki/11-campanas.md
 */

export type PlaybookKey = 'reactivacion' | 'rescate' | 'conquista' | 'lanzamiento';

/** Qué le pasa a un lead para entrar a esta campaña. Lo evalúa el código
 *  (lib/campaigns/segment.ts), no un modelo: la audiencia de un envío no
 *  puede depender de cómo un LLM interprete "los tibios". */
export interface SegmentRules {
  /** Temperaturas admitidas. Vacío = todas. */
  temperature: ('hot' | 'warm' | 'cold' | 'dead')[];
  /** Estados admitidos del lead. */
  status: string[];
  /** Días mínimos desde la última interacción. null = sin piso. */
  min_days_since_interaction: number | null;
  /** Días máximos desde la última interacción. null = sin techo. */
  max_days_since_interaction: number | null;
  /** Exige correo válido. Siempre true en correo; queda explícito. */
  requires_email: boolean;
}

export interface PlaybookStep {
  /** Día relativo al arranque. El paso 0 sale el día del lanzamiento. */
  day_offset: number;
  /** Para qué existe este paso. Va en la UI: el cliente ve la secuencia. */
  purpose: string;
  /** Guía de redacción para el CMO. No es el copy: es la restricción. */
  brief: string;
  /** Si el paso incluye el link del activo (agendador o checkout). */
  include_asset: boolean;
  /** Máximo de palabras. El correo largo no se lee y baja la entregabilidad. */
  max_words: number;
}

/**
 * Tasas esperadas. Cada una con su razón. Se usan para proyectar y, después,
 * para comparar contra lo real: la diferencia entre esperado y real es lo que
 * dispara la iteración.
 */
export interface Benchmarks {
  deliverability: number;
  open_rate: number;
  reply_rate: number;
  /** De los que responden, cuántos responden algo útil. */
  positive_share: number;
  /** De los positivos, cuántos agendan. */
  booking_from_positive: number;
  /** De los que agendan, cuántos cierran. */
  close_from_booking: number;
}

export interface MeasurementPoint {
  kpi: string;
  /** Cómo se calcula, en palabras del cliente. */
  formula: string;
  /** A cuántos días de arrancar se mira. */
  checkpoint_days: number;
}

export interface IterationRule {
  /** Condición evaluable por el código. */
  trigger: string;
  action: string;
  /** Si dispara, ¿la campaña se pausa sola? */
  auto_pause: boolean;
}

export interface Playbook {
  key: PlaybookKey;
  name: string;
  /** Una frase: qué es esta campaña. */
  promise: string;
  /** Por qué este segmento y no otro. */
  why_this_segment: string;
  segment: SegmentRules;
  /** Base legal que exige. Sin esto no se envía (PRD §10). */
  consent_required: 'existing_relationship' | 'opt_in' | 'legitimate_interest';
  /** Si exige calentar dominios antes de enviar. Gobierna la promesa de 24 h. */
  requires_warmup: boolean;
  /** Qué activo de Hola Amigo se promociona dentro del correo. */
  asset: 'scheduler' | 'checkout' | null;
  /** Si necesita algo del cliente antes de arrancar (video, foto, dato). */
  requires_human_input: { kind: string; ask: string } | null;
  steps: PlaybookStep[];
  benchmarks: Benchmarks;
  measurement: MeasurementPoint[];
  iteration: IterationRule[];
}

export const PLAYBOOKS: Record<PlaybookKey, Playbook> = {
  // ═════════════════════════════════════════════════════════════════════════
  // 1 · REACTIVACIÓN — la campaña que hace real la promesa de 24 horas
  // ═════════════════════════════════════════════════════════════════════════
  reactivacion: {
    key: 'reactivacion',
    name: 'Reactivación de base dormida',
    promise:
      'Volver a hablarle a la gente que ya levantó la mano contigo y nunca volvió a saber de ti.',
    why_this_segment:
      'Ya te conocen, ya dieron su dato y ya mostraron intención. Es la audiencia más barata de convertir que vas a tener, y es la única con la que podemos arrancar en 24 horas: sale de tu propio dominio, con relación previa, sin calentar nada.',
    segment: {
      temperature: ['cold', 'dead'],
      status: ['new', 'contacted', 'lost'],
      min_days_since_interaction: 90,
      max_days_since_interaction: null,
      requires_email: true,
    },
    consent_required: 'existing_relationship',
    requires_warmup: false,
    asset: 'scheduler',
    requires_human_input: null,
    steps: [
      {
        day_offset: 0,
        purpose: 'Reconocer el silencio y dar una razón concreta para volver',
        brief:
          'Nombra cuándo fue el último contacto. Una sola pregunta al final. Prohibido "espero que estés bien" y prohibido pedir disculpas por escribir.',
        include_asset: false,
        max_words: 90,
      },
      {
        day_offset: 3,
        purpose: 'Dar la prueba: qué cambió desde entonces',
        brief:
          'Un hecho verificable: producto nuevo, precio nuevo, caso de un cliente parecido. Con cifra si la hay.',
        include_asset: true,
        max_words: 110,
      },
      {
        day_offset: 8,
        purpose: 'Cierre honesto: la puerta se queda abierta o se cierra',
        brief:
          'Ofrecer salir de la lista de forma explícita. La gente que se queda después de esto es la que vale.',
        include_asset: true,
        max_words: 70,
      },
    ],
    // Meta-análisis de campañas de reactivación con relación previa. El 6% de
    // respuesta es alto para correo pero bajo para reactivación: la mayoría de
    // los benchmarks públicos reporta 8–12% y los publica quien queda bien.
    benchmarks: {
      deliverability: 0.96,
      open_rate: 0.42,
      reply_rate: 0.06,
      positive_share: 0.35,
      booking_from_positive: 0.45,
      close_from_booking: 0.25,
    },
    measurement: [
      {
        kpi: 'Tasa de respuesta',
        formula: 'respuestas ÷ correos entregados',
        checkpoint_days: 4,
      },
      {
        kpi: 'Respuestas positivas',
        formula: 'respuestas con intención de compra o pregunta real ÷ respuestas',
        checkpoint_days: 7,
      },
      {
        kpi: 'Citas agendadas',
        formula: 'agendamientos desde el link ÷ correos entregados',
        checkpoint_days: 10,
      },
      {
        kpi: 'Costo por cita',
        formula: 'créditos gastados ÷ citas agendadas',
        checkpoint_days: 14,
      },
    ],
    iteration: [
      {
        trigger: 'tasa de rebote > 3% en los primeros 200 envíos',
        action:
          'Pausar. La base está sucia: se valida antes de seguir o se quema el dominio.',
        auto_pause: true,
      },
      {
        trigger: 'tasa de respuesta < 2% al día 4',
        action:
          'El ángulo no está pegando. El CMO reescribe el paso 1 con otro ángulo y se relanza a la mitad no contactada.',
        auto_pause: false,
      },
      {
        trigger: 'respuestas positivas > 8%',
        action:
          'Subir el volumen diario y ampliar el segmento a los contactos de 60 días en vez de 90.',
        auto_pause: false,
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  // 2 · RESCATE — los que hablaron contigo y se cayeron antes de cerrar
  // ═════════════════════════════════════════════════════════════════════════
  rescate: {
    key: 'rescate',
    name: 'Rescate de conversaciones sin cierre',
    promise:
      'Recuperar a los que ya hablaron con tu equipo y se quedaron a mitad del camino.',
    why_this_segment:
      'La mayoría de los equipos se rinde en el segundo intento y la venta suele estar en el quinto. Esta gente no dijo que no: dejó de contestar. Es la audiencia más caliente que existe y la que más rápido paga.',
    segment: {
      temperature: ['hot', 'warm'],
      status: ['contacted', 'replied', 'qualified'],
      min_days_since_interaction: 14,
      max_days_since_interaction: 120,
      requires_email: true,
    },
    consent_required: 'existing_relationship',
    requires_warmup: false,
    asset: 'scheduler',
    requires_human_input: null,
    steps: [
      {
        day_offset: 0,
        purpose: 'Retomar exactamente donde quedó, sin recapitular todo',
        brief:
          'Una línea de contexto de la conversación anterior y una pregunta cerrada de sí o no.',
        include_asset: true,
        max_words: 60,
      },
      {
        day_offset: 2,
        purpose: 'Quitar la fricción que probablemente lo frenó',
        brief:
          'Nombrar la objeción más común de este segmento y desarmarla con un hecho, no con adjetivos.',
        include_asset: true,
        max_words: 90,
      },
      {
        day_offset: 6,
        purpose: 'Ofrecer la salida fácil',
        brief:
          '"¿Lo dejamos para más adelante o lo cerramos esta semana?". Dos opciones, ninguna es insistir.',
        include_asset: true,
        max_words: 50,
      },
      {
        day_offset: 12,
        purpose: 'Cierre del ciclo',
        brief: 'Último toque. Explícito en que es el último. Sin drama.',
        include_asset: false,
        max_words: 45,
      },
    ],
    benchmarks: {
      deliverability: 0.97,
      open_rate: 0.55,
      reply_rate: 0.12,
      positive_share: 0.45,
      booking_from_positive: 0.55,
      close_from_booking: 0.3,
    },
    measurement: [
      { kpi: 'Tasa de respuesta', formula: 'respuestas ÷ entregados', checkpoint_days: 3 },
      { kpi: 'Citas agendadas', formula: 'agendamientos ÷ contactos del segmento', checkpoint_days: 7 },
      { kpi: 'Cierres atribuidos', formula: 'órdenes o ventas marcadas ÷ citas', checkpoint_days: 21 },
    ],
    iteration: [
      {
        trigger: 'tasa de respuesta < 5% al día 3',
        action:
          'El contexto que estamos usando no es reconocible. Se enriquece con el historial real de la conversación antes de seguir.',
        auto_pause: false,
      },
      {
        trigger: 'más de 2 quejas de spam',
        action: 'Pausa inmediata y revisión humana. Este segmento no debería generar quejas.',
        auto_pause: true,
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  // 3 · CONQUISTA — frío, con la honestidad técnica por delante (PRD §4.6)
  // ═════════════════════════════════════════════════════════════════════════
  conquista: {
    key: 'conquista',
    name: 'Conquista de segmento nuevo',
    promise:
      'Abrir un segmento donde todavía no te conocen, con infraestructura propia y calentada.',
    why_this_segment:
      'Es el crecimiento que no depende de tu base actual. También es el más lento: sin dos o tres semanas de calentamiento de dominios, el envío en frío quema la reputación y no se recupera. Preferimos decírtelo acá que en la llamada de reclamo.',
    segment: {
      temperature: ['cold'],
      status: ['new'],
      min_days_since_interaction: null,
      max_days_since_interaction: null,
      requires_email: true,
    },
    consent_required: 'legitimate_interest',
    requires_warmup: true,
    asset: 'scheduler',
    requires_human_input: null,
    steps: [
      {
        day_offset: 0,
        purpose: 'Ganar el derecho a la segunda frase',
        brief:
          'Una observación específica del negocio de él. Si no tenemos nada específico que decir, este correo no se envía.',
        include_asset: false,
        max_words: 70,
      },
      {
        day_offset: 4,
        purpose: 'Prueba con un caso del mismo sector',
        brief: 'Un caso con cifra y nombre de sector. Sin logos que no podamos usar.',
        include_asset: true,
        max_words: 90,
      },
      {
        day_offset: 9,
        purpose: 'Pedir la reunión de forma directa',
        brief: '15 minutos, con el link. Sin "¿tendrías 5 minutos para una llamada rápida?".',
        include_asset: true,
        max_words: 55,
      },
      {
        day_offset: 16,
        purpose: 'Romper el patrón o soltar',
        brief: 'Otro ángulo distinto al de los tres anteriores. Si no responde, se archiva.',
        include_asset: false,
        max_words: 60,
      },
    ],
    // Frío hace todo peor: menos entrega, menos apertura, mucha menos respuesta.
    benchmarks: {
      deliverability: 0.88,
      open_rate: 0.34,
      reply_rate: 0.02,
      positive_share: 0.25,
      booking_from_positive: 0.4,
      close_from_booking: 0.2,
    },
    measurement: [
      { kpi: 'Entregabilidad', formula: 'entregados ÷ enviados', checkpoint_days: 2 },
      { kpi: 'Tasa de respuesta', formula: 'respuestas ÷ entregados', checkpoint_days: 7 },
      { kpi: 'Costo por reunión', formula: 'créditos ÷ reuniones agendadas', checkpoint_days: 21 },
    ],
    iteration: [
      {
        trigger: 'entregabilidad < 90%',
        action: 'Pausa. Se revisa DNS, se baja el volumen por buzón y se recalienta.',
        auto_pause: true,
      },
      {
        trigger: 'tasa de respuesta < 1% después de 300 envíos',
        action:
          'El segmento o el ángulo están mal. El CMO propone dos ángulos nuevos y se prueba a 100 contactos cada uno antes de volver a volumen.',
        auto_pause: false,
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  // 4 · LANZAMIENTO — el pilar de marca dentro del motor (PRD §4.4 ruta C)
  // ═════════════════════════════════════════════════════════════════════════
  lanzamiento: {
    key: 'lanzamiento',
    name: 'Lanzamiento y awareness',
    promise:
      'Contarle a toda tu base algo nuevo — feature, evento, temporada — y medir quién levantó la mano.',
    why_this_segment:
      'No busca cerrar en el correo: busca que la gente que ya te conoce sepa que existe esto y se identifique sola. La conversión llega después, sobre los que reaccionaron.',
    segment: {
      temperature: ['hot', 'warm', 'cold'],
      status: ['new', 'contacted', 'replied', 'qualified', 'booked'],
      min_days_since_interaction: null,
      max_days_since_interaction: null,
      requires_email: true,
    },
    consent_required: 'opt_in',
    requires_warmup: false,
    asset: 'checkout',
    // Esta es la campaña que le pide algo al humano. El President lo pregunta
    // en el feed, no lo asume: un lanzamiento sin la cara del fundador rinde
    // menos y no lo podemos producir solos.
    requires_human_input: {
      kind: 'video',
      ask: 'Grabar 40 segundos en vertical contando qué es esto y para quién. Nosotros lo editamos, le ponemos subtítulos y lo publicamos.',
    },
    steps: [
      {
        day_offset: 0,
        purpose: 'El anuncio',
        brief: 'Qué es, para quién es, y qué hacer si te interesa. Tres bloques, nada más.',
        include_asset: true,
        max_words: 120,
      },
      {
        day_offset: 5,
        purpose: 'Recordatorio solo a los que abrieron y no actuaron',
        brief: 'Un ángulo distinto del mismo anuncio. Nunca reenviar el mismo correo.',
        include_asset: true,
        max_words: 80,
      },
    ],
    benchmarks: {
      deliverability: 0.96,
      open_rate: 0.45,
      reply_rate: 0.03,
      positive_share: 0.4,
      booking_from_positive: 0.3,
      close_from_booking: 0.22,
    },
    measurement: [
      { kpi: 'Apertura', formula: 'aperturas únicas ÷ entregados', checkpoint_days: 2 },
      { kpi: 'Clics al activo', formula: 'clics al link de Hola Amigo ÷ entregados', checkpoint_days: 4 },
      { kpi: 'Ventas atribuidas', formula: 'órdenes pagadas con origen en esta campaña', checkpoint_days: 14 },
    ],
    iteration: [
      {
        trigger: 'apertura < 25%',
        action: 'El asunto no funciona. Se prueban dos asuntos nuevos sobre el 20% no enviado.',
        auto_pause: false,
      },
      {
        trigger: 'clics > 8%',
        action:
          'Hay demanda real. Se propone una campaña de conversión solo sobre los que hicieron clic.',
        auto_pause: false,
      },
    ],
  },
};

/**
 * Qué tres campañas se le proponen a ESTE cliente.
 *
 * Es una función pura y determinista a propósito: dos clientes con el mismo
 * diagnóstico reciben la misma propuesta, y podemos explicar por qué salió
 * cada una. Si esto lo eligiera un modelo, "¿por qué me propusiste conquista?"
 * no tendría respuesta.
 */
export function selectPlaybooks(input: {
  dormantContacts: number;
  warmContacts: number;
  coldContacts: number;
  recommendedRoute: 'whatsapp' | 'email' | 'brand_content';
  brandClarityScore: number;
  hasProducts: boolean;
}): PlaybookKey[] {
  const picked: PlaybookKey[] = [];

  if (input.dormantContacts >= 50) picked.push('reactivacion');
  if (input.warmContacts >= 15) picked.push('rescate');

  // Marca confusa o ruta C: automatizar mensajes sobre una promesa poco clara
  // solo escala la confusión (PRD §7.5). Primero se dice algo, después se dice
  // más veces.
  const brandFirst = input.recommendedRoute === 'brand_content' || input.brandClarityScore < 55;
  if (brandFirst || input.hasProducts) picked.push('lanzamiento');
  if (input.coldContacts >= 100 || input.recommendedRoute === 'email') picked.push('conquista');

  // Relleno determinista para siempre entregar tres.
  for (const fallback of ['reactivacion', 'rescate', 'lanzamiento', 'conquista'] as PlaybookKey[]) {
    if (picked.length >= 3) break;
    if (!picked.includes(fallback)) picked.push(fallback);
  }

  return picked.slice(0, 3);
}
