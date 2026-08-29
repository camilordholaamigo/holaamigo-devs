import { describirFalloDeRed, type Entrante } from '@/lib/pruebas/callbell';
import { conOpciones, extraerInteractivo } from '@/lib/pruebas/interactivos';
import type { CanalRow } from '@/lib/pruebas/types';

/**
 * El segundo transporte: wzap (WzapChat).
 *
 * Mismo régimen asíncrono que Callbell —mandamos un HTTP, el negocio contesta
 * cuando quiere, la respuesta entra por un webhook minutos después— y por eso
 * comparte todo el aparato de `lib/pruebas/motor.ts`. Lo que cambia es el sobre.
 *
 * Proveedor: WzapChat. `POST https://api.wzap.chat/v1/messages`
 * Autenticación: cabecera `Token`, sin prefijo.
 *
 * Verificado contra la API real el 2026-08-25, no contra la documentación: los
 * artículos del help center piden sesión. Lo que sigue sale de tres llamadas
 * —`GET /devices`, y dos `POST /messages` con cuerpos inválidos a propósito— y
 * por eso cada afirmación de acá se puede reproducir.
 *
 * Ver docs/adr/0028-dos-transportes.md
 */

const WZAP_URL = 'https://api.wzap.chat/v1/messages';
const TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════════════════
// PRECHEQUEO DE ENTORNO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La llave, sin el `Token ` que el panel pega adelante.
 *
 * Misma defensa que `llaveCallbell()` y por el mismo incidente: el panel muestra
 * el secreto ya escrito como cabecera, se copia entero, y el header sale
 * `Token Token …`. La API contesta 401, que es indistinguible de una llave
 * vencida. Costó una tarde con Callbell; no vuelve a costar otra.
 */
export function llaveWzap(): string | null {
  const raw = process.env.WZAP_API_KEY?.trim();
  if (!raw) return null;
  return raw.replace(/^token\s+/i, '').trim() || null;
}

export function faltaParaEnviarWzap(): Record<string, true> {
  const falta: Record<string, true> = {};
  if (!llaveWzap()) falta.WZAP_API_KEY = true;
  return falta;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENVIAR
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoEnvioWzap {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  pista: string | null;
}

/**
 * Cuántas opciones caben en botones antes de que haya que mandar una lista.
 *
 * WhatsApp admite hasta 3 botones; de ahí para arriba el formato es la lista
 * desplegable. El validador de wzap NO lo comprueba —acepta cuatro sin chistar—
 * así que el tope lo pone este código o lo pone WhatsApp descartando el mensaje.
 */
const MAX_BOTONES = 3;

/**
 * El sobre de opciones: botones si son pocas, lista si son muchas.
 *
 * El schema salió de enumerar `POST /v1/messages` campo por campo contra su
 * validador OpenAPI el 2026-08-29 (`additionalProperties: false` convierte cada
 * intento en una respuesta de sí o no). Acepta:
 *   buttons: [{ id, text }]
 *   list:    { title, description, button, footer,
 *              sections: [{ title, rows: [{ id, title, description }] }] }
 *   poll:    { name, options, multiple }
 */
function sobreDeOpciones(
  opciones: { texto: string; id?: string | null }[],
): Record<string, unknown> {
  if (opciones.length <= MAX_BOTONES) {
    return {
      buttons: opciones.map((o, i) => ({ id: o.id ?? String(i + 1), text: o.texto.slice(0, 20) })),
    };
  }
  return {
    list: {
      button: 'Ver opciones',
      sections: [
        {
          title: 'Opciones',
          rows: opciones.slice(0, 10).map((o, i) => ({
            id: o.id ?? String(i + 1),
            title: o.texto.slice(0, 24),
          })),
        },
      ],
    },
  };
}

/** Las opciones escritas en el texto, numeradas. El plan B de todo lo de arriba. */
function opcionesComoTexto(
  texto: string,
  opciones: { texto: string; id?: string | null }[],
): string {
  const lista = opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n');
  return `${texto}\n${lista}`;
}

export async function enviarPorWzap(spec: {
  canal: CanalRow;
  to: string;
  texto: string;
  opciones?: { texto: string; id?: string | null }[];
}): Promise<ResultadoEnvioWzap> {
  const llave = llaveWzap();
  if (!llave) {
    return {
      ok: false,
      messageId: null,
      error: 'falta WZAP_API_KEY',
      pista: 'Cargá WZAP_API_KEY en Vercel (Settings → Environment Variables) y volvé a desplegar.',
    };
  }

  // `device` NUNCA se omite, y esto no es defensa contra un error de tipos: la
  // misma llave de API ve todas las líneas de la cuenta, incluidas las de otros
  // negocios. Un POST sin `device` sale desde la que el proveedor elija, y el
  // modo de fallo es mandarle un mensaje de prueba a un prospecto desde la
  // línea de atención real de un cliente.
  const device = spec.canal.channel_uuid?.trim();
  if (!device) {
    return {
      ok: false,
      messageId: null,
      error: 'el canal de wzap no tiene device',
      pista:
        'Cargá el device (24 hex) de la línea en /admin/pruebas. Sin device, wzap elige la línea por su cuenta.',
    };
  }

  const opciones = spec.opciones ?? [];
  const conBotones = opciones.length > 0;

  const disparar = async (cuerpo: Record<string, unknown>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(WZAP_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          // Sin `Bearer`. wzap usa el esquema `Token: <llave>` a secas.
          token: llave,
          'content-type': 'application/json',
          'user-agent': 'HolaAmigoSmokeTester/1.0 (+https://holaamigo.co)',
        },
        body: JSON.stringify(cuerpo),
      });
      return { res, texto: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let { res, texto } = await disparar({
      phone: spec.to,
      message: spec.texto,
      device,
      ...(conBotones ? sobreDeOpciones(opciones) : {}),
    });

    // ── EL PLAN B ────────────────────────────────────────────────────────
    //
    // Si el mensaje llevaba opciones y wzap lo rechazó por el cuerpo, se
    // reintenta UNA vez como texto plano con las opciones numeradas.
    //
    // No es paciencia con un proveedor caprichoso: WhatsApp dejó de aceptar
    // botones nativos por conexiones no oficiales el 2023-05-10, así que un
    // rechazo acá es el resultado ESPERADO y no una anomalía. Lo que no se
    // puede permitir es que por eso no salga el mensaje: la conversación es la
    // medición, y perderla por un adorno la anula entera.
    if (!res.ok && conBotones && res.status >= 400 && res.status < 500) {
      console.warn(
        `[wzap] opciones rechazadas (${res.status}); reintento como texto numerado`,
        codigoDeError(texto) ?? '',
      );
      ({ res, texto } = await disparar({
        phone: spec.to,
        message: opcionesComoTexto(spec.texto, opciones),
        device,
      }));
    }

    if (!res.ok) {
      // wzap devuelve `{status, message, errorCode}`. El `errorCode` es lo que
      // hace que la pista sea accionable y no una lista de sospechosos: por eso
      // se extrae antes de armarla.
      const codigo = codigoDeError(texto);
      const sufijo = codigo ? ` ${codigo}` : '';
      return {
        ok: false,
        messageId: null,
        error: `wzap ${res.status}${sufijo}: ${texto.slice(0, 400)}`,
        pista: pistaWzap(res.status, codigo),
      };
    }

    let json: unknown = null;
    try {
      json = JSON.parse(texto);
    } catch {
      // Un 200 con cuerpo ilegible no es un fallo de envío: quedó en la cola.
      return { ok: true, messageId: null, error: null, pista: null };
    }

    return { ok: true, messageId: idDeMensaje(json), error: null, pista: null };
  } catch (err) {
    const detalle = describirFalloDeRed(err);
    return { ok: false, messageId: null, error: detalle.mensaje, pista: detalle.pista };
  }
}

function codigoDeError(cuerpo: string): string | null {
  try {
    const j = JSON.parse(cuerpo) as { errorCode?: unknown };
    return typeof j.errorCode === 'string' ? j.errorCode : null;
  } catch {
    return null;
  }
}

/** El id que devuelve wzap al aceptar el mensaje. Tolerante a dónde lo ponga. */
function idDeMensaje(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.id === 'string') return obj.id;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data.id === 'string') return data.id;
  if (Array.isArray(obj.data)) {
    const primero = obj.data[0] as { id?: unknown } | undefined;
    if (primero && typeof primero.id === 'string') return primero.id;
  }
  return null;
}

export function pistaWzap(status: number, codigo: string | null): string {
  if (codigo === 'phone:invalid') {
    return 'El número no está en E.164. wzap lo exige con «+», con indicativo y sin espacios.';
  }
  if (codigo === 'device:invalid' || codigo === 'device:notfound') {
    return 'El device no existe en la cuenta de wzap. Revisá el campo device de la línea en /admin/pruebas contra GET /v1/devices.';
  }
  if (status === 401 || status === 403) {
    return 'wzap rechazó la llave. Revisá WZAP_API_KEY en Vercel — y acordate de que el despliegue que corre tiene la variable del momento en que se construyó: si la acabás de cambiar, hay que redesplegar.';
  }
  if (status === 400) {
    return 'wzap rechazó el cuerpo. Casi siempre es el teléfono mal formado o un device que no existe.';
  }
  if (status === 402) {
    return 'La cuenta de wzap no tiene cupo para mandar. Revisá el plan y la cola del device.';
  }
  if (status === 404) return 'wzap no encontró el recurso. Revisá el device de la línea.';
  if (status === 429) {
    return 'wzap está limitando el ritmo. Espaciá las pruebas (ritmo_segundos del lote).';
  }
  if (status >= 500) return 'wzap tuvo un error. El watchdog reintenta la prueba.';
  return 'Revisá el cuerpo de la petición contra la API de wzap.';
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSEAR LO QUE ENTRA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El sobre de wzap: `{event: 'message:in:new', device, data: {...}}`.
 *
 * A diferencia del de Callbell, este trae la dirección en el NOMBRE DEL EVENTO,
 * y eso elimina la peor adivinanza del otro parser: allá «entrante» se deduce de
 * la ausencia de `status`, acá se lee de `message:in:new` contra
 * `message:out:new`. Si algún día se registra el evento de salida por error, los
 * ecos se descartan solos en vez de contaminar la transcripción.
 *
 * Devuelve null si no hay nada aprovechable, y el llamador cae al parser
 * genérico de Callbell. Eso no es indecisión: la forma exacta de este payload no
 * está verificada contra un mensaje real todavía —el help center pide sesión— y
 * perder un entrante en silencio es el peor modo de fallo de todo el subsistema:
 * sin él la conversación se cuelga y el negocio queda reportado como «no
 * contestó», que es una cifra falsa en el informe de un cliente.
 */
export function parsearEntranteWzap(raw: unknown): Entrante | null {
  if (!raw || typeof raw !== 'object') return null;

  const sobre = raw as Record<string, unknown>;
  const evento = typeof sobre.event === 'string' ? sobre.event : '';
  const data = (sobre.data as Record<string, unknown> | undefined) ?? sobre;
  const chat = data.chat as Record<string, unknown> | undefined;
  const contacto = data.contact as Record<string, unknown> | undefined;

  // El enunciado y las opciones de un mensaje interactivo, si lo es.
  //
  // Va ANTES del texto plano y no después, y ése es el arreglo: en el payload
  // real de una encuesta `body` viene `null` y todo el contenido está en
  // `poll.name` + `poll.options[]`. Con el orden al revés el mensaje se
  // descartaba entero y la conversación quedaba colgada esperando una
  // respuesta que ya había llegado. Ver lib/pruebas/interactivos.ts.
  const interactivo = extraerInteractivo(data);

  const plano = primerString(data.body, data.text, data.caption, sobre.body);
  const texto = conOpciones(interactivo.texto ?? plano, interactivo.opciones);
  if (!texto) return null;

  const candidatos = new Set<string>();
  for (const valor of [
    data.fromNumber,
    data.toNumber,
    data.from,
    data.to,
    data.phone,
    chat?.fromNumber,
    contacto?.phone,
  ]) {
    const digitos = String(valor ?? '').replace(/[^\d]/g, '');
    if (digitos.length >= 7 && digitos.length <= 15) candidatos.add(digitos);
  }
  if (candidatos.size === 0) return null;

  const flujo = String(data.flow ?? '').toLowerCase();
  const direccion: Entrante['direccion'] =
    evento.includes(':out:') || flujo === 'outbound' ? 'saliente' : 'entrante';

  return {
    candidatos: [...candidatos],
    // El `device` de wzap es lo que en `smoke_channels` se guarda como
    // `channel_uuid`. La correlación por línea (lib/pruebas/webhook.ts) compara
    // contra esa columna sin saber de qué proveedor viene, y así sigue.
    canalUuid: deviceDe(sobre) ?? deviceDe(data),
    texto: texto.slice(0, 4_000),
    opciones: interactivo.opciones,
    claseInteractiva: interactivo.clase,
    direccion,
    nombre: primerString(chat?.name, contacto?.name, data.fromName),
    proveedorId: primerString(data.id, sobre.id),
    recibidoAt: new Date().toISOString(),
  };
}

function primerString(...valores: unknown[]): string | null {
  for (const v of valores) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function deviceDe(nodo: unknown): string | null {
  if (!nodo || typeof nodo !== 'object') return null;
  const obj = nodo as Record<string, unknown>;
  const d = obj.device;
  if (typeof d === 'string' && d.trim()) return d.trim();
  if (d && typeof d === 'object') {
    const id = (d as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

/** Resume la FORMA del payload sin volcar su contenido. Se loguea SIEMPRE. */
export function resumirPayloadWzap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return { tipo: typeof raw };
  const obj = raw as Record<string, unknown>;
  const data = (obj.data ?? obj) as Record<string, unknown>;
  return {
    event: typeof obj.event === 'string' ? obj.event : null,
    claves_sobre: Object.keys(obj).slice(0, 12),
    claves_data: data && typeof data === 'object' ? Object.keys(data).slice(0, 24) : [],
    tipo_mensaje: data?.type ?? null,
    flow: data?.flow ?? null,
    device: deviceDe(obj) ?? deviceDe(data),
    // `botones` dice qué claves OLIERON a interactivo; `opciones` dice cuántas
    // se pudieron leer de verdad. Las dos, y no una: si huele a menú y salen
    // cero opciones, el lector no entendió esa forma y hay que mirar el payload.
    // Con una sola cifra ese caso es invisible.
    botones: pistasDeBotones(raw),
    opciones: extraerInteractivo(data).opciones.length,
  };
}

/**
 * Qué claves del payload huelen a mensaje interactivo.
 *
 * No clasifica nada y no escribe nada: solo deja en el log si el puente de wzap
 * nos entrega la ESTRUCTURA de un mensaje con botones o si la aplana a texto.
 * Es la pregunta que abrió este trabajo, y la única forma honesta de responderla
 * es con payloads reales: un menú de WhatsApp que llega como texto plano y uno
 * que llega con sus opciones adentro se ven idénticos en la transcripción.
 *
 * Cuando haya datos, qué hacer con esto va en otro PR y en su propio ADR.
 */
export function pistasDeBotones(raw: unknown): string[] {
  const encontradas = new Set<string>();
  const sospechosas = [
    'buttons',
    'buttonsMessage',
    'buttonsResponse',
    'buttonReply',
    'templateButtons',
    'interactive',
    'interactiveMessage',
    'list',
    'listMessage',
    'listResponse',
    'sections',
    'poll',
    'pollCreation',
  ];

  const visitar = (nodo: unknown, profundidad: number): void => {
    if (profundidad > 5 || !nodo || typeof nodo !== 'object') return;
    if (Array.isArray(nodo)) {
      for (const item of nodo) visitar(item, profundidad + 1);
      return;
    }
    for (const [clave, valor] of Object.entries(nodo as Record<string, unknown>)) {
      if (sospechosas.includes(clave) && valor != null) encontradas.add(clave);
      visitar(valor, profundidad + 1);
    }
  };

  visitar(raw, 0);
  return [...encontradas];
}
