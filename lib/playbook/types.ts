/**
 * La forma del playbook: el manual de operación del agente de agendamiento.
 *
 * REGLA QUE GOBIERNA ESTE ARCHIVO, y es la razón de que exista separado del
 * compilador: **ningún campo numérico de este objeto lo escribe un modelo.**
 * El precio, la duración de la cita, la franja horaria, los topes y las fechas
 * salen del Brief, de los supuestos y de la configuración del agendador — o
 * sea, de `lib/diagnostic/math.ts` y de `lib/assets/links.ts`. El modelo aporta
 * lenguaje: cómo se pregunta, cómo se responde una objeción, cómo se abre.
 *
 * Es ADR 0007 aplicado a un objeto nuevo. La consecuencia práctica es que el
 * esquema Zod que va a OpenAI (`PlaybookLanguageSchema`) NO TIENE ni un solo
 * `z.number()`, y eso se puede verificar leyéndolo.
 *
 * Este archivo tampoco importa nada de servidor: la consola lo usa para
 * renderizar el editor del playbook en el navegador.
 *
 * Ver docs/adr/0024-el-agente-se-compila-del-diagnostico.md
 */

/**
 * De dónde salió cada cosa que el agente va a decir.
 *
 * No es metadato de lujo: es lo que convierte el onboarding en "confirmá estas
 * tres cosas" en vez de "llená esta ficha". Lo que tiene `fuente` se da por
 * bueno; lo que está `inferido` se le muestra al cliente para que lo confirme
 * con un tap. Sin esto tendríamos que preguntarlo todo, que es exactamente el
 * proceso de semanas que estamos matando.
 */
export interface Procedencia {
  /** URL del sitio del cliente de donde salió. `null` = no hay fuente. */
  fuente: string | null;
  /** `true` cuando lo dedujimos. Con `fuente` no nula, esto es siempre false. */
  inferido: boolean;
}

export interface Producto {
  nombre: string;
  /** Qué es, en una frase que un contacto entienda por WhatsApp. */
  descripcion: string;
  /** Para quién es. Ayuda al agente a no ofrecer lo que no encaja. */
  para_quien: string;
  procedencia: Procedencia;
}

export interface Oferta {
  /** Qué vende la empresa, en una frase. Va en el primer mensaje. */
  resumen: string;
  productos: Producto[];
  /**
   * QUÉ VENDEMOS EN ESTA CONVERSACIÓN, que no es lo mismo que qué vende la
   * empresa: el setter vende **la cita**. Esta frase es la que el agente usa
   * para volver al carril cuando la conversación se va a hablar del producto.
   */
  lo_que_vendemos_aca: string;
  /** Precios: SIEMPRE del código, nunca del modelo. */
  precio: {
    /** Rango declarado por el cliente en el quiz. Es el único que se puede decir. */
    ticket_promedio_usd: number;
    banda_declarada: string | null;
    /** Precios públicos que el research vio textualmente en el sitio. */
    publicos: string[];
    /** Qué contesta el agente cuando le preguntan el precio. */
    politica: 'decir_rango' | 'derivar_a_la_cita';
  };
}

export interface PreguntaDeCalificacion {
  /** Uno de los cuatro ejes. Más de cuatro y el contacto se cae. */
  campo: 'encaje' | 'momento' | 'decisor' | 'dolor';
  /** La pregunta, tal cual se envía. Una sola pregunta por mensaje. */
  pregunta: string;
  /** Por qué importa. Va en el editor del cliente, no en el prompt. */
  por_que: string;
  /** Respuestas que descalifican. Si cae acá, el agente cierra con cortesía. */
  descalifica_si: string[];
}

export interface Calificacion {
  preguntas: PreguntaDeCalificacion[];
  /**
   * Cuántas de las cuatro hay que tener antes de proponer horario.
   * Lo pone el código, no el modelo: es un número.
   */
  minimo_para_agendar: number;
  /** A quién NO le vendemos. Sale del ICP del diagnóstico. */
  fuera_de_alcance: string[];
}

export interface Objecion {
  /** La objeción como la dice un contacto real, no como la clasificaría un CRM. */
  objecion: string;
  /** Cómo se responde. Máximo dos frases y termina volviendo a la cita. */
  respuesta: string;
  procedencia: Procedencia;
}

export interface PreguntaFrecuente {
  pregunta: string;
  respuesta: string;
  procedencia: Procedencia;
}

/** Todo numérico: sale de la configuración real del agendador. */
export interface Agendamiento {
  /** Slug del activo `scheduler`. El link real que el agente reparte. */
  asset_slug: string | null;
  url: string | null;
  duracion_min: number;
  zona_horaria: string;
  dias_habiles: number[];
  hora_inicio: number;
  hora_fin: number;
  anticipacion_min_horas: number;
  /** Qué pasa en la cita. El contacto pregunta esto siempre. */
  que_pasa_en_la_cita: string;
  /** Quién atiende. Un nombre convierte más que "un asesor". */
  quien_atiende: string | null;
  /** Presencial, Meet, llamada. */
  modalidad: string;
  /** Cuántos horarios concretos se ofrecen de una. Dos: tres ya es un menú. */
  opciones_por_mensaje: number;
}

export interface Guion {
  /**
   * El primer mensaje. Incluye SIEMPRE de dónde salió el número: en Colombia
   * lo exige la Ley 1581 de 2012 y, además, es lo que desarma la objeción más
   * común de WhatsApp frío antes de que aparezca.
   */
  apertura: string;
  /** Variante para quien escribió primero. No se presenta igual. */
  apertura_inbound: string;
  /** El puente de "hablemos" a "agendemos". Es donde se pierden las citas. */
  puente_a_la_cita: string;
  /** Cómo se ofrecen los horarios. El código inyecta los horarios reales. */
  oferta_de_horarios: string;
  /** Confirmación: resumen + cómo cancelar. Baja el no-show. */
  confirmacion: string;
  /** Tres seguimientos, de más a menos presión. El tercero da una salida. */
  seguimientos: string[];
  /** Cómo se cierra con quien no califica, sin quemar la marca. */
  cierre_cortes: string;
}

export interface Escalamiento {
  /** Qué manda la conversación a un humano. Nunca puede quedar vacío. */
  disparadores: string[];
  /** Lo que el agente escribe al escalar. El contacto no se queda en silencio. */
  mensaje_al_contacto: string;
  /** Minutos que tiene el humano. Sale del contrato de SALES. */
  sla_minutos: number;
}

export interface Tono {
  descripcion: string;
  /** Palabras y promesas que la marca nunca dice. Del Brief. */
  prohibidas: string[];
  /** Un mensaje del cliente que sí funcionó. Del quiz. Vale más que un adjetivo. */
  ejemplo_del_cliente: string | null;
  /** Tuteo o usted. En Colombia B2B no es lo mismo y se nota. */
  tratamiento: 'tu' | 'usted';
  emojis: 'ninguno' | 'uno_maximo';
}

/** Lo que se le muestra al cliente: qué sostuvimos y qué le toca confirmar. */
export interface Cobertura {
  /** Campos con fuente verificable. */
  con_fuente: number;
  /** Campos que dedujimos y que el cliente debería confirmar. */
  inferidos: number;
  /** Campos que no pudimos llenar con nada. */
  faltantes: string[];
  /** 0 a 100. Es un número: lo calcula el código. */
  porcentaje: number;
  /** La lista concreta de "confirmá esto", ordenada por lo que más importa. */
  a_confirmar: Array<{
    ruta: string;
    etiqueta: string;
    valor: string;
    por_que_importa: string;
  }>;
}

export interface Playbook {
  id: string;
  organization_id: string;
  version: number;
  vertical: 'appointment_setting' | 'recuperacion' | 'soporte';
  channel: 'whatsapp' | 'email' | 'simulador';
  status: 'draft' | 'active' | 'retired';
  source: 'compilado' | 'editado' | 'operador';
  oferta: Oferta;
  calificacion: Calificacion;
  objeciones: Objecion[];
  faq: PreguntaFrecuente[];
  agendamiento: Agendamiento;
  guion: Guion;
  escalamiento: Escalamiento;
  prohibiciones: string[];
  tono: Tono;
  cobertura: Cobertura;
  compiled_from: Record<string, unknown>;
}

/**
 * Las objeciones que SIEMPRE tienen que existir, las haya propuesto el modelo
 * o no.
 *
 * Las dos primeras no son opcionales en Colombia: "¿de dónde sacaste mi
 * número?" es la primera respuesta del 30% de los contactos en frío, y no
 * tenerla escrita significa que el agente improvisa una respuesta sobre
 * tratamiento de datos personales. Eso es exactamente lo que no queremos que
 * improvise.
 */
export const OBJECIONES_OBLIGATORIAS = [
  '¿De dónde sacaste mi número?',
  '¿Esto es un bot?',
  'Mándame información por acá / no quiero reunión',
  '¿Cuánto cuesta?',
  'Ahora no tengo tiempo',
] as const;

/** Los cuatro ejes de calificación de un setter. Ni tres ni cinco. */
export const EJES_DE_CALIFICACION = ['encaje', 'momento', 'decisor', 'dolor'] as const;

export type EjeDeCalificacion = (typeof EJES_DE_CALIFICACION)[number];

export const ETIQUETA_DEL_EJE: Record<EjeDeCalificacion, string> = {
  encaje: 'Encaje · ¿es del tipo de negocio al que le sirve esto?',
  momento: 'Momento · ¿lo necesita ahora o dentro de un año?',
  decisor: 'Decisor · ¿decide él o hay que sumar a alguien?',
  dolor: 'Dolor · ¿qué quiere arreglar, concretamente?',
};

/** Cuenta cuántos campos del playbook tienen fuente y cuántos se infirieron. */
export function medirCobertura(
  partes: Array<{ ruta: string; etiqueta: string; valor: string; por_que: string; procedencia: Procedencia }>,
): Cobertura {
  const conFuente = partes.filter((p) => p.procedencia.fuente && !p.procedencia.inferido);
  const inferidos = partes.filter((p) => p.procedencia.inferido || !p.procedencia.fuente);

  return {
    con_fuente: conFuente.length,
    inferidos: inferidos.length,
    faltantes: partes.filter((p) => !p.valor.trim()).map((p) => p.ruta),
    porcentaje: partes.length === 0 ? 0 : Math.round((conFuente.length / partes.length) * 100),
    // Se muestran como máximo seis. Una lista de "confirmá estas 19 cosas" es
    // un formulario con otro nombre, y el formulario es justo lo que estamos
    // borrando del onboarding.
    a_confirmar: inferidos.slice(0, 6).map((p) => ({
      ruta: p.ruta,
      etiqueta: p.etiqueta,
      valor: p.valor,
      por_que_importa: p.por_que,
    })),
  };
}
