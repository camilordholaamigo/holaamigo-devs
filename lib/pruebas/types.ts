/**
 * Los contratos del smoke tester. Empezá por acá.
 *
 * El smoke tester le escribe por WhatsApp al número publicado de un negocio,
 * como si fuéramos un cliente, deja que la conversación llegue hasta donde
 * llegue, y la califica. No hay mocks: es la línea real, por el canal real.
 *
 * Ver docs/wiki/23-smoke-tester.md
 */

// ═══════════════════════════════════════════════════════════════════════════
// LA CONVERSACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El formato canónico de la transcripción, y nada más adentro.
 *
 * El paquete del que viene esto sobrevivió tres rediseños sin cambiar este
 * array. Meterle metadata —el id del proveedor, el estado de entrega, la
 * herramienta que se usó— habría sido la muerte: cada consumidor tendría que
 * saber qué campos ignorar. Lo que no es texto y hora va en columnas.
 */
export interface Mensaje {
  /** `comprador` somos nosotros; `negocio` es la línea bajo prueba. */
  role: 'comprador' | 'negocio';
  text: string;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL TEST COMPILADO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Un hecho verificable sobre el negocio, sacado del research, con su fuente.
 *
 * Es la «verdad de referencia»: sin esto el evaluador puede juzgar tono y
 * completitud, pero no puede detectar una alucinación, porque no sabe cuál era
 * el dato correcto. Es el campo que más determina si la capa 3 sirve.
 */
export interface HechoDeReferencia {
  /** `precio`, `horario`, `cobertura`, `producto`, `promesa`, `contacto`… */
  clave: string;
  /** Lo que el sitio dice, textual siempre que se pueda. */
  valor: string;
  /** La URL donde lo leímos. Sin fuente, el hecho no entra (§13.4). */
  fuente: string | null;
}

/** Qué le vamos a preguntar y por qué. Lo que el research complementa. */
export interface Sonda {
  id: string;
  /** La pregunta, ya instanciada con el producto real del cliente. */
  pregunta: string;
  /** Para el admin y para el informe: por qué esta pregunta y no otra. */
  por_que: string;
  /**
   * De dónde salió. `plantilla` = venía en el molde; `research` = la agregó el
   * compilador porque lo encontró en el sitio (el evento que están vendiendo,
   * el precio publicado, la promesa de respuesta en 24 h); `admin` = la
   * escribió una persona en /admin/pruebas/nueva.
   *
   * `admin` no es un caso degradado de `research`: es la sonda con más contexto
   * de las tres, porque el que la escribió sabe qué está buscando. Lo que NO
   * trae es fuente verificable, y eso se ve en `cobertura`.
   */
  origen: 'plantilla' | 'research' | 'admin';
}

/**
 * Un criterio de calificación con su chequeo determinístico.
 *
 * `chequeo` es lo que hace que la capa 2 exista: la mayoría de los criterios
 * se pueden verificar con una regex sobre la transcripción, sin gastar un peso
 * en un modelo, y sin que el resultado cambie entre corridas. Cuando un
 * criterio no se puede chequear así, `chequeo` va en null y lo resuelve la
 * capa 3.
 */
export interface CriterioRubrica {
  id: string;
  dimension: string;
  criterio: string;
  /** Cuánto pesa dentro de la nota. Enteros pequeños; se normaliza al sumar. */
  peso: number;
  chequeo: ChequeoDeterministico | null;
}

export type ChequeoDeterministico =
  /** ¿Contestaron algo? */
  | { tipo: 'hubo_respuesta' }
  /** ¿Contestaron en menos de N segundos? */
  | { tipo: 'respondio_antes_de'; segundos: number }
  /** Alguna de estas cadenas aparece en lo que dijo el negocio. */
  | { tipo: 'menciona'; alguna_de: string[]; fuente: string | null }
  /** Ninguna de estas aparece. Sirve para marcas prohibidas y datos falsos. */
  | { tipo: 'no_menciona'; ninguna_de: string[]; fuente: string | null }
  /** Dijo una cifra de dinero. */
  | { tipo: 'dio_precio' }
  /** Propuso fecha, hora, cita, visita, llamada o cotización. */
  | { tipo: 'propuso_paso_siguiente' }
  /** Hizo al menos N preguntas. Distingue vender de despachar. */
  | { tipo: 'pregunto_al_menos'; cantidad: number };

/**
 * Quién escribe cada turno del comprador.
 *
 * `conversar`  el comprador sintético redacta contra el objetivo, turno a
 *              turno. Una llamada barata al modelo por turno. Es el que mide
 *              cómo venden.
 * `guion`      los mensajes ya están escritos en `plan.guion` y se mandan en
 *              orden, sin importar qué contesten. Cero llamadas a modelo. Es
 *              el que permite hacerle la MISMA pregunta a veinte negocios y
 *              comparar las veinte respuestas.
 *
 * Ver docs/adr/0027-la-prueba-a-medida-y-las-lineas.md
 */
export type ModoDePrueba = 'conversar' | 'guion';

/**
 * El modo de un plan, tolerando los planes escritos antes de ADR 0027.
 *
 * Se lee con esta función y nunca con `plan.modo` directo: las filas anteriores
 * a 0016 no tienen el campo, y un `undefined` colándose a un `switch` haría que
 * una conversación vieja deje de avanzar sin decir por qué.
 */
export function modoDelPlan(plan: Pick<PlanDePrueba, 'modo'>): ModoDePrueba {
  return plan.modo === 'guion' ? 'guion' : 'conversar';
}

/**
 * El test, ya compilado contra un negocio concreto.
 *
 * Es al smoke tester lo que el playbook es al agente de agendamiento: **datos,
 * no un prompt**. Se le puede mostrar al admin campo por campo, se puede
 * versionar, y se puede diffear contra el de la corrida anterior. Un prompt
 * generado no permite ninguna de las tres.
 */
export interface PlanDePrueba {
  template_id: string;
  /**
   * Opcional porque las filas escritas antes de ADR 0027 no lo tienen. No se
   * lee directo: se lee con `modoDelPlan()`.
   */
  modo?: ModoDePrueba;
  /**
   * Solo en modo `guion`: los mensajes, en orden. El primero ES `apertura`.
   *
   * Se guarda duplicado con `apertura` a propósito: `apertura` es el contrato
   * que el motor usa para arrancar cualquier prueba, y el guion es la lista
   * completa que se le muestra al operador. Derivar uno del otro obligaría a
   * todos los consumidores del plan a saber en qué modo está.
   */
  guion?: string[];
  /**
   * Lo que el equipo sabe del negocio, escrito a mano.
   *
   * Va al prompt del comprador para que sepa de qué está hablando, y NO a la
   * ficha: la ficha es lo que se puede citar con URL. Sin fuente no se puede
   * acusar a nadie de haber inventado un dato (§13.4).
   */
  contexto?: string | null;
  /** Cómo tiene que comportarse el comprador. Ajusta el tono, nunca los hechos. */
  instrucciones?: string | null;
  /** El nombre del negocio como lo vamos a nombrar en la conversación. */
  negocio: string;
  /** Lo que vende, en las palabras del sitio. Va en el mensaje de apertura. */
  producto: string;
  objetivo: string;
  persona: Persona;
  apertura: string;
  sondas: Sonda[];
  ficha: HechoDeReferencia[];
  rubrica: CriterioRubrica[];
  criterios_cierre: string[];
  max_turnos: number;
  /**
   * Qué tanto de este plan salió del sitio y qué tanto es el molde crudo.
   * Se muestra en el admin: una prueba compilada sobre un research fallido
   * mide otra cosa, y el que la lee tiene que saberlo.
   */
  cobertura: { con_fuente: number; total: number; porcentaje: number };
  /** `true` si el compilador corrió sin modelo o con esquema degradado. */
  degradado: boolean;
}

/** Identidad fija del comprador. Nunca cambia dentro de una conversación. */
export interface Persona {
  nombre: string;
  correo: string;
  telefono: string;
  ciudad: string;
  presupuesto?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS VEREDICTOS
// ═══════════════════════════════════════════════════════════════════════════

/** Salud técnica de la corrida. Si esto es `failed`, la culpa es nuestra. */
export type EstadoPrueba =
  | 'pending'
  | 'running'
  | 'completed'
  | 'timeout'
  | 'failed'
  | 'cancelled';

/** El veredicto de negocio. Separado de `estado` a propósito. */
export type CerroCon =
  | 'agendado'
  | 'cotizacion'
  | 'objetivo_cumplido'
  | 'incompleto'
  | 'sin_respuesta'
  /** El negocio pidió que no le escribamos más. Terminal y respetado. */
  | 'bloqueado';

/** Capa 2 · determinística. Cero llamadas a modelo, cero varianza. */
export interface Auditoria {
  score: number;
  /**
   * Cuántos criterios se pudieron verificar solos.
   *
   * Con esto en cero, `score` no significa nada y la interfaz tiene que decir
   * «no se pudo verificar» en vez de pintar un cero. Un cero se lee como «lo
   * hicieron pésimo» y lo que pasó fue que no pudimos leer su sitio.
   */
  verificables: number;
  criterios: Array<{
    id: string;
    criterio: string;
    dimension: string;
    peso: number;
    /** `null` cuando el criterio no tiene chequeo automático. */
    paso: boolean | null;
    detalle: string;
  }>;
  /** Incumplimientos objetivos: dijo algo que no puede decir, o no dijo lo que
   *  tenía que decir. No hay discusión posible sobre estos. */
  criticos: string[];
  /** Lo hizo distinto de lo pedido. El criterio pasa, pero hay que mirarlo. */
  advertencias: string[];
}

/** Capa 3 · con modelo. Sirve para comparar corridas, no como aprobado. */
export interface Evaluacion {
  score: number;
  exactitud: number;
  tono: number;
  completitud: number;
  proactividad: number;
  /** 100 = no inventó nada. */
  riesgo_alucinacion: number;
  /** Cita textual de cada dato inventado, contrastado contra la ficha. */
  alucinaciones: string[];
  errores: string[];
  /** Lo que hay que cambiar. Es la salida con más valor de las tres capas. */
  sugerencias: string[];
  resumen: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAS FILAS
// ═══════════════════════════════════════════════════════════════════════════

export interface CanalRow {
  id: string;
  label: string;
  provider: 'callbell';
  phone_e164: string;
  channel_uuid: string;
  template_uuid: string | null;
  activo: boolean;
  notas: string | null;
}

export interface PlantillaRow {
  id: string;
  nombre: string;
  descripcion: string;
  que_mide: string;
  objetivo: string;
  persona: Partial<Persona>;
  apertura: string;
  sondas: Array<{ id: string; pregunta: string; por_que: string }>;
  rubrica: Array<{ id: string; dimension: string; criterio: string; peso: number }>;
  criterios_cierre: string[];
  max_turnos: number;
  activo: boolean;
  es_semilla: boolean;
}

export interface TargetRow {
  id: string;
  organization_id: string | null;
  nombre: string | null;
  phone_e164: string;
  origen: 'research' | 'manual';
  source_url: string | null;
  confianza: number | null;
  ultima_prueba_at: string | null;
  bloqueado: boolean;
  bloqueado_motivo: string | null;
}

export interface PruebaRow {
  id: string;
  run_id: string;
  /** Null si la prueba se disparó suelta y no dentro de un lote. */
  batch_id: string | null;
  target_id: string;
  template_id: string;
  channel_id: string;
  organization_id: string | null;
  target_phone: string;
  plan: PlanDePrueba;
  conversation: Mensaje[];
  estado: EstadoPrueba;
  cerro_con: CerroCon | null;
  turno: number;
  max_turnos: number;
  turn_token: string | null;
  awaiting_reply: boolean;
  enviado_at: string | null;
  primera_respuesta_at: string | null;
  segundos_primera_respuesta: number | null;
  ultimo_entrante_at: string | null;
  auditoria: Auditoria | null;
  auditoria_score: number | null;
  evaluacion: Evaluacion | null;
  evaluacion_score: number | null;
  motivo_cierre: string | null;
  error: string | null;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES DE TIEMPO
// ═══════════════════════════════════════════════════════════════════════════
//
// Todas están calibradas para líneas humanas de negocios colombianos, que es
// un régimen MUY distinto al de un bot: un bot contesta en 3 segundos y manda
// ráfagas; una persona contesta en 4 minutos y manda un párrafo.
//
// Si algún día se prueban agentes automáticos, hay que volver a medirlas.
// La consulta para hacerlo está en docs/wiki/23-smoke-tester.md.

/** Silencio que hay que ver antes de dar por terminada la respuesta del otro
 *  lado. Una persona que escribe tres mensajes seguidos tarda ~15 s entre uno
 *  y otro; contestarle al primero produce una conversación ilegible. */
export const SILENCIO_MS = 20_000;

/** Techo duro del acumulado, por si el otro lado no para de escribir. */
export const SILENCIO_TOPE_MS = 90_000;

/** Un entrante que llega dentro de esta ventana después del último mensaje
 *  del negocio se considera parte de la MISMA respuesta, no de una nueva. */
export const VENTANA_RAFAGA_MS = 60_000;

/**
 * Sin respuesta durante esto, la prueba se cierra.
 *
 * 25 minutos y no 8 como el paquete original: allá el otro lado era un bot con
 * SLA de segundos. Acá el otro lado es una PyME, y cerrar a los 8 minutos
 * reportaría como «línea muerta» a un negocio que contesta en 12. El número
 * que le decimos al cliente tiene que poder defenderse.
 */
export const ESTANCADA_MS = 25 * 60_000;

/** Un run sin ninguna prueba viva y sin actividad hace esto es un zombi.
 *  Los zombis se cierran: envenenan la correlación de los que vienen después. */
export const ZOMBI_MS = 90 * 60_000;

/** Cuánto esperamos entre dos pruebas contra el MISMO número. Dos
 *  conversaciones simultáneas contra la misma línea se mezclan en el mismo
 *  hilo de WhatsApp y ninguna de las dos mide nada. */
export const ENTRE_PRUEBAS_MS = 90_000;
