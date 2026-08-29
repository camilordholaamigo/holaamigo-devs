/**
 * Mensajes con opciones: encuestas, listas, botones.
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
 *
 * ADR 0028 dejó abierta una pregunta y dijo que solo se podía responder con
 * payloads reales: si el puente de wzap nos entrega la ESTRUCTURA de un mensaje
 * interactivo o si la aplana a texto. Ya hay payload real y la respuesta es peor
 * que «la aplana»:
 *
 *     "type": "poll", "body": null, "poll": { "name": "...", "options": [...] }
 *
 * El contenido NO está en `body`. `body` viene `null`. Y `parsearEntranteWzap`
 * exigía texto para devolver algo, así que un mensaje de opciones se descartaba
 * entero: la conversación quedaba esperando, el watchdog la cerraba por tiempo y
 * el negocio salía reportado como «no contestó». Una cifra falsa en el informe de
 * un cliente, que es exactamente lo que ADR 0025 existe para impedir.
 *
 * ── LA DECISIÓN: LAS OPCIONES SE RENDERIZAN AL TEXTO ───────────────────────
 *
 * `Mensaje` es `{role, text, timestamp}` y ADR 0026 dice que meterle metadata a
 * ese array «habría sido la muerte». Así que las opciones no se guardan aparte:
 * se escriben DENTRO del texto, numeradas.
 *
 *     ¿Qué te interesa?
 *     [1] Comprar
 *     [2] Arrendar
 *
 * Se gana todo de una vez y sin migración: la transcripción del admin las
 * muestra, el auditor determinístico las ve, el evaluador las cita, y el modelo
 * que redacta el turno siguiente puede elegir una — porque para contestar un menú
 * de WhatsApp hay que mandar el TEXTO de la opción, no su id (ver `elegirOpcion`).
 *
 * ── QUÉ ESTÁ VERIFICADO Y QUÉ NO ───────────────────────────────────────────
 *
 * Verificado contra la API real el 2026-08-29:
 *   · `poll` — payload real de una encuesta entrante. `{name, options[{id,name}]}`.
 *   · El enum de `type` de `GET /v1/chat/{device}/messages?type=…`, que es lo que
 *     dice qué formas pueden llegar: `interactive`, `template`, `list`,
 *     `list_response`, `buttons_response`, `poll`, `order`, `product`, `payment`.
 *   · El schema de `POST /v1/messages`, campo por campo, contra su validador
 *     OpenAPI: acepta `buttons[{id,text}]`, `list{title,description,button,footer,
 *     sections[{title,rows[{id,title,description}]}]}` y `poll{name,options,multiple}`.
 *
 * NO verificado: la forma exacta de un `list` o un `buttons` ENTRANTE — no hay
 * ninguno en las líneas de la cuenta todavía. Por eso, además de los lectores
 * específicos, hay un barrido genérico: la regla del subsistema es que perder un
 * entrante en silencio es el peor modo de fallo, y una opción que no se reconoce
 * es preferible verla mal formateada que no verla.
 *
 * Este módulo es PURO. No importa nada de servidor, no lee `process.env` y no
 * escribe. Se puede probar con un objeto literal.
 */

export interface OpcionInteractiva {
  /** El id que manda el proveedor. Null cuando la opción solo trae texto. */
  id: string | null;
  /** Lo que el usuario VE y lo que hay que escribir para elegirla. */
  texto: string;
  /** De dónde salió. Sirve para el log y para la pregunta de ADR 0028. */
  origen: string;
}

export interface Interactivo {
  /** El enunciado: la pregunta de la encuesta, el cuerpo de la lista. */
  texto: string | null;
  opciones: OpcionInteractiva[];
  /** `poll`, `list`, `buttons`, `interactive`, `template`… o null. */
  clase: string | null;
}

/** Contenedores que, según el enum de tipos de wzap, pueden traer opciones. */
const CONTENEDORES = [
  'poll',
  'list',
  'buttons',
  'interactive',
  'interactiveMessage',
  'template',
  'templateMessage',
  'buttonsMessage',
  'listMessage',
  'order',
  'product',
] as const;

/** Claves cuyo valor es el texto visible de una opción, en orden de preferencia. */
const TEXTO_DE_OPCION = ['title', 'text', 'name', 'label', 'displayText', 'description'];

/** Claves cuyo valor es el enunciado del mensaje, en orden de preferencia. */
const ENUNCIADO = ['name', 'title', 'description', 'text', 'body', 'caption', 'footer'];

/**
 * Claves cuyo valor es una COLECCIÓN de opciones, no una opción.
 *
 * Se usa para dos cosas opuestas y por eso está acá arriba: para saber por dónde
 * bajar, y para saber qué nodo NO es elegible aunque tenga título.
 */
const CONTIENEN_OPCIONES = ['sections', 'rows', 'options', 'buttons', 'items', 'values', 'list'];

const MAX_OPCIONES = 24;
const MAX_TEXTO_OPCION = 160;

// ═══════════════════════════════════════════════════════════════════════════
// EXTRAER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Saca enunciado y opciones de `data` (el nodo interno del sobre de wzap).
 *
 * Nunca lanza y nunca devuelve null: sin nada que sacar devuelve la forma vacía,
 * que es lo que hace que un mensaje de texto normal siga el camino de siempre sin
 * un solo `if` extra en el llamador.
 */
export function extraerInteractivo(data: unknown): Interactivo {
  const vacio: Interactivo = { texto: null, opciones: [], clase: null };
  if (!data || typeof data !== 'object') return vacio;

  const obj = data as Record<string, unknown>;
  const tipo = typeof obj.type === 'string' ? obj.type : null;

  // El contenedor se busca por el nombre del tipo primero —en el payload real de
  // la encuesta, `type: "poll"` y la estructura está en la clave `poll`— y esa
  // simetría se repite en el schema de envío, así que es la apuesta correcta.
  const candidatos = [
    ...(tipo && tipo in obj ? [tipo] : []),
    ...CONTENEDORES.filter((c) => c !== tipo && c in obj),
  ];

  for (const clave of candidatos) {
    const nodo = obj[clave];
    if (nodo == null) continue;

    const opciones = opcionesDe(nodo, clave);
    const texto = enunciadoDe(nodo) ?? textoPlano(obj);

    if (opciones.length > 0 || texto) {
      return { texto, opciones, clase: clave };
    }
  }

  // Barrido genérico: ninguna clave conocida sirvió, pero el mensaje puede traer
  // igual una lista de opciones en una forma que no vimos nunca. Vale la pena:
  // un `buttons` entrante no está verificado contra un payload real todavía.
  const sueltas = opcionesDe(obj, 'generico');
  if (sueltas.length > 0) {
    return { texto: textoPlano(obj), opciones: sueltas, clase: tipo ?? 'generico' };
  }

  return vacio;
}

/**
 * Recolecta opciones de cualquier profundidad razonable.
 *
 * Busca arrays cuyos elementos parezcan opciones: o strings sueltos, o objetos
 * con una clave de texto conocida. El tope de profundidad y de cantidad no es
 * paranoia genérica — el payload de wzap trae el contacto entero, con sus
 * campañas y sus idiomas, y sin tope una lista de países entra como «opciones».
 */
function opcionesDe(nodo: unknown, origen: string): OpcionInteractiva[] {
  const salida: OpcionInteractiva[] = [];
  const vistas = new Set<string>();

  const agregar = (id: string | null, texto: string) => {
    const limpio = texto.trim().slice(0, MAX_TEXTO_OPCION);
    if (!limpio || vistas.has(limpio.toLowerCase())) return;
    vistas.add(limpio.toLowerCase());
    salida.push({ id, texto: limpio, origen });
  };

  const visitar = (n: unknown, profundidad: number): void => {
    if (profundidad > 4 || salida.length >= MAX_OPCIONES || !n || typeof n !== 'object') return;

    if (Array.isArray(n)) {
      for (const item of n) {
        if (salida.length >= MAX_OPCIONES) return;
        if (typeof item === 'string') {
          agregar(null, item);
          continue;
        }
        if (item && typeof item === 'object') {
          const fila = item as Record<string, unknown>;

          // Un nodo que CONTIENE opciones no es una opción, aunque tenga
          // `title`. Una sección de lista es exactamente eso: `{title:
          // 'Opciones', rows: [...]}`. Sin esta guarda se agregaba el título de
          // la sección como si fuera elegible y nunca se bajaba a las filas —
          // o sea, el menú entero se perdía y quedaba su encabezado.
          if (CONTIENEN_OPCIONES.some((c) => c in fila)) {
            visitar(item, profundidad + 1);
            continue;
          }

          const texto = primerTexto(fila, TEXTO_DE_OPCION);
          if (texto) {
            agregar(idDe(fila), texto);
            // Una fila que ya dio su texto no se sigue abriendo: adentro tiene
            // `votes`, `count` y demás contabilidad que no son opciones.
            continue;
          }
          visitar(item, profundidad + 1);
        }
      }
      return;
    }

    // Un objeto: solo se baja por las claves que pueden contener opciones. Bajar
    // por todas mete el contacto, el chat y sus etiquetas.
    const obj = n as Record<string, unknown>;
    for (const clave of CONTIENEN_OPCIONES) {
      if (clave in obj) visitar(obj[clave], profundidad + 1);
    }
  };

  visitar(nodo, 0);
  return salida;
}

function idDe(fila: Record<string, unknown>): string | null {
  for (const clave of ['id', 'rowId', 'buttonId', 'selectedId']) {
    const v = fila[clave];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function primerTexto(fila: Record<string, unknown>, claves: string[]): string | null {
  for (const clave of claves) {
    const v = fila[clave];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function enunciadoDe(nodo: unknown): string | null {
  if (typeof nodo === 'string') return nodo.trim() || null;
  if (!nodo || typeof nodo !== 'object' || Array.isArray(nodo)) return null;
  return primerTexto(nodo as Record<string, unknown>, ENUNCIADO);
}

function textoPlano(obj: Record<string, unknown>): string | null {
  return primerTexto(obj, ['body', 'text', 'caption']);
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERIZAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El texto que se guarda en la transcripción, con las opciones numeradas.
 *
 * La numeración empieza en 1 y es la que el modelo puede citar. El id del
 * proveedor NO se escribe: no sirve para contestar (ver `elegirOpcion`) y en la
 * transcripción que lee un cliente es ruido.
 */
export function conOpciones(texto: string | null, opciones: OpcionInteractiva[]): string {
  const base = (texto ?? '').trim();
  if (opciones.length === 0) return base;

  const lista = opciones.map((o, i) => `[${i + 1}] ${o.texto}`).join('\n');
  return base ? `${base}\n${lista}` : lista;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTESTAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cómo se «aprieta» un botón: se escribe su texto.
 *
 * Y no hay alternativa. El schema de `POST /v1/messages` se enumeró campo por
 * campo contra su validador (2026-08-29) y **no existe** ningún campo para
 * responder una opción: no hay `replyTo`, ni `quoted`, ni `selectedId`, ni
 * `payload`. Se puede MANDAR un menú, no se puede CONTESTAR uno como tal.
 *
 * En la práctica alcanza, y no por suerte: un bot que ofrece botones casi siempre
 * acepta también el texto de la opción, porque tiene que tolerar a la gente que
 * escribe en vez de tocar. Si alguno no lo acepta, eso mismo es un hallazgo del
 * informe —«el menú no admite respuesta escrita»— y no un fallo nuestro.
 *
 * Devuelve el texto exacto de la opción que el modelo eligió, aceptando que la
 * haya nombrado por número (`2`, `[2]`, `opción 2`) o por texto aproximado. Si no
 * matchea ninguna, devuelve lo que el modelo escribió, tal cual: forzar una
 * opción que nadie eligió es peor que mandar una frase libre.
 */
export function elegirOpcion(respuesta: string, opciones: OpcionInteractiva[]): string {
  const dicho = respuesta.trim();
  if (opciones.length === 0 || !dicho) return dicho;

  const numero = dicho.match(/^\D{0,10}?(\d{1,2})\b/);
  if (numero) {
    const i = Number(numero[1]) - 1;
    if (i >= 0 && i < opciones.length) return opciones[i].texto;
  }

  const normal = normalizar(dicho);
  const exacta = opciones.find((o) => normalizar(o.texto) === normal);
  if (exacta) return exacta.texto;

  // Contención: el modelo escribió «quiero arrendar» y la opción es «Arrendar».
  const contenida = opciones.find((o) => {
    const n = normalizar(o.texto);
    return n.length >= 4 && (normal.includes(n) || n.includes(normal));
  });
  return contenida ? contenida.texto : dicho;
}

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Las opciones de vuelta, leídas del texto donde `conOpciones()` las escribió.
 *
 * Existe para no guardarlas. `Mensaje` es `{role, text, timestamp}` y ese array
 * no lleva metadata (ADR 0026), así que cuando llega el turno de contestar el
 * menú ya no hay ninguna estructura: hay una transcripción. Esto la vuelve a
 * leer, que es más barato que una columna nueva y no puede desincronizarse del
 * texto — porque ES el texto.
 */
export function opcionesDelTexto(texto: string): OpcionInteractiva[] {
  const salida: OpcionInteractiva[] = [];
  for (const linea of texto.split('\n')) {
    const m = linea.match(/^\s*\[(\d{1,2})\]\s+(.+?)\s*$/);
    if (m) salida.push({ id: null, texto: m[2], origen: 'transcripcion' });
  }
  return salida;
}
