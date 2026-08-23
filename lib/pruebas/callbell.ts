import { db, unwrap } from '@/lib/supabase/admin';
import type { CanalRow } from '@/lib/pruebas/types';

/**
 * El transporte: cómo le hablamos a la línea bajo prueba.
 *
 * Es la pieza más chica del smoke tester y la que más define el diseño. Es
 * **asíncrona**: mandamos un HTTP a Callbell, Callbell lo pone en cola, el
 * negocio contesta cuando quiere, y la respuesta llega minutos después por un
 * webhook. Nadie espera a nadie. Todo el aparato de `lib/pruebas/motor.ts`
 * —el token de turno, el acumulado de ráfagas, los watchdogs— existe solo para
 * sobrevivir a eso.
 *
 * Proveedor: Callbell. `POST https://api.callbell.eu/v1/messages/send`
 * Documentación: https://docs.callbell.eu/es/api/reference/messages_api/post_send_messages
 */

const CALLBELL_URL = 'https://api.callbell.eu/v1/messages/send';
const TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════════════════
// PRECHEQUEO DE ENTORNO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Qué falta para poder mandar un mensaje.
 *
 * Se llama ANTES de crear la prueba, no adentro del trabajo de fondo. Un 400
 * con `{ falta: { CALLBELL_API_KEY: true } }` ahorra horas comparado con una
 * prueba que se creó, quedó en `pending` y «no hizo nada».
 */
/**
 * La llave, sin el `Bearer ` que viene pegado adelante.
 *
 * El panel de Callbell muestra el token ya escrito como cabecera —
 * `Bearer EmbeccJyn…`— y así es como se copia. Si ese valor entra tal cual a la
 * variable, el header sale `Bearer Bearer …` y Callbell contesta
 * `401 {"error":"not authorized"}`, que es indistinguible de una llave vencida.
 * Costó una tarde el 2026-08-23.
 *
 * Se normaliza acá y no en el header porque `faltaParaEnviar()` tiene que
 * responder sobre la MISMA cadena que se va a mandar: una variable que solo
 * contiene `Bearer ` es una variable que falta, y el precheque tiene que
 * decirlo antes de crear la prueba y no después del 401.
 */
export function llaveCallbell(): string | null {
  const raw = process.env.CALLBELL_API_KEY?.trim();
  if (!raw) return null;
  return raw.replace(/^bearer\s+/i, '').trim() || null;
}

export function faltaParaEnviar(): Record<string, true> {
  const falta: Record<string, true> = {};
  if (!llaveCallbell()) falta.CALLBELL_API_KEY = true;
  return falta;
}

export function hayTransporte(): boolean {
  return Object.keys(faltaParaEnviar()).length === 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CANAL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Desde qué número escribimos.
 *
 * Vive en una tabla y no en variables de entorno porque el número y su
 * identificador de canal los cambia alguien del equipo comercial desde
 * /admin/pruebas, sin desplegar. La llave de la API sí es una variable: eso es
 * un secreto, esto es un dato de operación (ADR 0014).
 */
export async function canalActivo(canalId?: string | null): Promise<CanalRow | null> {
  let q = db()
    .from('smoke_channels')
    .select('id, label, provider, phone_e164, channel_uuid, template_uuid, activo, notas')
    .eq('activo', true);

  if (canalId) q = q.eq('id', canalId);

  const { data } = await q.order('created_at', { ascending: true }).limit(1);
  return (data?.[0] as CanalRow | undefined) ?? null;
}

/**
 * Todas nuestras líneas activas, en orden de creación.
 *
 * Varias líneas es la unidad de escala del smoke tester (ADR 0027): tres de
 * nuestros números escribiéndole al mismo negocio es la única forma de ver si su
 * agente les contesta igual a tres clientes a la vez. `canalActivo()` sigue
 * existiendo para el camino automático del diagnóstico, que usa una sola —la
 * primera— y no tiene por qué elegir.
 */
export async function canalesActivos(): Promise<CanalRow[]> {
  const { data } = await db()
    .from('smoke_channels')
    .select('id, label, provider, phone_e164, channel_uuid, template_uuid, activo, notas')
    .eq('activo', true)
    .order('created_at', { ascending: true });
  return (data ?? []) as CanalRow[];
}

export async function canalPorId(canalId: string): Promise<CanalRow> {
  return unwrap(
    await db()
      .from('smoke_channels')
      .select('id, label, provider, phone_e164, channel_uuid, template_uuid, activo, notas')
      .eq('id', canalId)
      .single(),
    'smoke_channels.get',
  ) as CanalRow;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENVIAR
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoEnvio {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  /** Pista accionable, no el error crudo. Va al admin y al log. */
  pista: string | null;
}

export interface EnvioSpec {
  canal: CanalRow;
  /** Destino en E.164 con el `+`. */
  to: string;
  texto: string;
  /**
   * Abrir con plantilla en vez de texto libre.
   *
   * Solo hace falta si el canal es WhatsApp Business API oficial: ahí el
   * primer mensaje a un número con el que no hay conversación abierta tiene
   * que ser una plantilla aprobada por Meta. Con una línea conectada por QR
   * —que es la que usamos hoy— esto queda en null y se abre con texto libre.
   */
  usarPlantilla?: boolean;
}

export async function enviarMensaje(spec: EnvioSpec): Promise<ResultadoEnvio> {
  const falta = faltaParaEnviar();
  if (Object.keys(falta).length > 0) {
    const nombres = Object.keys(falta).join(', ');
    return {
      ok: false,
      messageId: null,
      error: `falta ${nombres}`,
      pista: `Cargá ${nombres} en Vercel (Settings → Environment Variables) y volvé a desplegar.`,
    };
  }

  const cuerpo: Record<string, unknown> = {
    to: spec.to,
    // En Callbell `from` es el tipo de canal, no el número. El número sale del
    // `channel_uuid`. Confundirlos devuelve un 422 que no explica cuál de los
    // dos está mal.
    from: 'whatsapp',
    type: 'text',
    channel_uuid: spec.canal.channel_uuid,
    content: { text: spec.texto },
  };

  if (spec.usarPlantilla && spec.canal.template_uuid) {
    cuerpo.template_uuid = spec.canal.template_uuid;
    cuerpo.optin_contact = true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(CALLBELL_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${llaveCallbell()}`,
        'content-type': 'application/json',
        // Algunos hosts rechazan peticiones sin User-Agent y el error que
        // devuelven no lo dice. Cuesta una línea.
        'user-agent': 'HolaAmigoSmokeTester/1.0 (+https://holaamigo.co)',
      },
      body: JSON.stringify(cuerpo),
    });

    const texto = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        messageId: null,
        error: `callbell ${res.status}: ${texto.slice(0, 400)}`,
        pista: pistaPorEstado(res.status),
      };
    }

    let json: unknown = null;
    try {
      json = JSON.parse(texto);
    } catch {
      // Un 200 con cuerpo ilegible es raro pero no es un fallo de envío: el
      // mensaje se encoló. Se registra sin id y se sigue.
      return { ok: true, messageId: null, error: null, pista: null };
    }

    const uuid = (json as { message?: { uuid?: string } })?.message?.uuid ?? null;
    return { ok: true, messageId: uuid, error: null, pista: null };
  } catch (err) {
    const detalle = describirFalloDeRed(err);
    return {
      ok: false,
      messageId: null,
      error: detalle.mensaje,
      pista: detalle.pista,
    };
  } finally {
    clearTimeout(timer);
  }
}

function pistaPorEstado(status: number): string {
  if (status === 401 || status === 403) {
    return 'Callbell rechazó la llave. Revisá CALLBELL_API_KEY en Vercel — y acordate de que el despliegue que corre tiene la variable del momento en que se construyó: si la acabás de cambiar, hay que redesplegar.';
  }
  if (status === 404) {
    return 'Callbell no encontró el canal. Revisá el channel_uuid en /admin/pruebas.';
  }
  if (status === 422) {
    return 'Callbell rechazó el cuerpo: casi siempre es el número mal formado (tiene que ir en E.164 con +) o un channel_uuid que no existe.';
  }
  if (status === 429) return 'Callbell está limitando el ritmo. Espaciá las pruebas.';
  if (status >= 500) return 'Callbell tuvo un error. El watchdog reintenta la prueba.';
  return 'Revisá el cuerpo de la petición contra la documentación de Callbell.';
}

/**
 * Desempaca `err.cause`.
 *
 * El `fetch` nativo de Node envuelve todos los errores de red en un `TypeError`
 * genérico cuyo mensaje es, literalmente, «fetch failed». La causa real
 * —ENOTFOUND, ECONNREFUSED, un certificado vencido— vive en `err.cause`, y sin
 * desempacarla un incidente de DNS y uno de firewall se ven exactamente igual.
 */
export function describirFalloDeRed(err: unknown): { mensaje: string; pista: string } {
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      mensaje: 'timeout: Callbell no respondió en 15 s',
      pista: 'Callbell está lento o inalcanzable. El watchdog reintenta.',
    };
  }

  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as Error & { cause?: { code?: string; message?: string } })?.cause;

  if (!cause?.code) return { mensaje: base, pista: 'Error de red sin causa identificable.' };

  const mensaje = `${base} (${cause.code}${cause.message ? `: ${cause.message}` : ''})`;

  if (cause.code === 'ENOTFOUND') {
    return { mensaje, pista: 'El DNS no resuelve api.callbell.eu desde el runtime.' };
  }
  if (cause.code === 'ECONNREFUSED' || cause.code === 'ECONNRESET') {
    return { mensaje, pista: 'Callbell rechazó o cortó la conexión.' };
  }
  return { mensaje, pista: `Error de red: ${cause.code}.` };
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSEAR LO QUE ENTRA
// ═══════════════════════════════════════════════════════════════════════════

export interface Entrante {
  /**
   * TODOS los números que aparecen en el payload.
   *
   * No uno: todos. La documentación de Callbell muestra, para un mensaje
   * recibido, `to` y `contact.phoneNumber` con el número del contacto y `from`
   * con el nuestro — o sea al revés de lo que dice la intuición. Y este webhook
   * además recibe reenvíos desde otra aplicación, que puede reordenarlos.
   *
   * En vez de apostar a un campo, se juntan todos y se prueba cada uno contra
   * las conversaciones que esperan respuesta. La que matchee, matcheó.
   */
  candidatos: string[];
  /**
   * El canal del proveedor por el que entró, si el payload lo dice.
   *
   * Es lo que desambigua cuando dos de NUESTRAS líneas tienen una conversación
   * viva contra el mismo negocio: son dos hilos distintos y el mensaje pertenece
   * a uno solo. Cuando no viene, el otro camino es nuestro propio número, que
   * para un entrante también aparece en `candidatos`. Y cuando no viene ninguno
   * de los dos, se desambigua a ciegas y queda escrito en el log (ADR 0027).
   */
  canalUuid: string | null;
  texto: string;
  /** `sent` es eco de lo que mandamos nosotros y hay que ignorarlo. */
  direccion: 'entrante' | 'saliente';
  nombre: string | null;
  proveedorId: string | null;
  recibidoAt: string;
}

const CAMPOS_DE_TEXTO = [
  'text',
  'body',
  'caption',
  'message',
  'content',
  'mensaje',
  'texto',
  'value',
];
const CAMPOS_DE_TELEFONO = [
  'from',
  'to',
  'phone',
  'phonenumber',
  'phone_number',
  'telefono',
  'numero',
  'number',
  'msisdn',
  'wa_id',
  'contact',
];

/**
 * Extractor recursivo de texto.
 *
 * Existe porque los proveedores de WhatsApp anidan el texto en lugares
 * distintos según el tipo de mensaje —`text`, `text.body`, `template.body`,
 * `content.text`— y la documentación no los lista todos. Profundidad 4 cubre
 * todo lo que apareció en producción sin volverse una búsqueda ciega.
 */
function extraerTexto(nodo: unknown, profundidad = 0): string {
  if (profundidad > 4 || nodo == null) return '';
  if (typeof nodo === 'string') return nodo.trim();
  if (typeof nodo === 'number') return String(nodo);
  if (Array.isArray(nodo)) {
    for (const item of nodo) {
      const found = extraerTexto(item, profundidad + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof nodo !== 'object') return '';

  const obj = nodo as Record<string, unknown>;
  for (const campo of CAMPOS_DE_TEXTO) {
    const valor = obj[campo];
    if (typeof valor === 'string' && valor.trim()) return valor.trim();
  }
  for (const campo of CAMPOS_DE_TEXTO) {
    if (campo in obj) {
      const found = extraerTexto(obj[campo], profundidad + 1);
      if (found) return found;
    }
  }
  return '';
}

/** Junta cualquier cosa que parezca un teléfono, en cualquier nivel. */
function juntarTelefonos(nodo: unknown, out: Set<string>, profundidad = 0): void {
  if (profundidad > 4 || nodo == null) return;
  if (Array.isArray(nodo)) {
    for (const item of nodo) juntarTelefonos(item, out, profundidad + 1);
    return;
  }
  if (typeof nodo !== 'object') return;

  const obj = nodo as Record<string, unknown>;
  for (const [clave, valor] of Object.entries(obj)) {
    const esCampoDeTelefono = CAMPOS_DE_TELEFONO.includes(clave.toLowerCase());
    if (esCampoDeTelefono && (typeof valor === 'string' || typeof valor === 'number')) {
      const digitos = String(valor).replace(/[^\d]/g, '');
      if (digitos.length >= 7 && digitos.length <= 15) out.add(digitos);
    }
    if (typeof valor === 'object') juntarTelefonos(valor, out, profundidad + 1);
  }
}

/**
 * Parsea el evento entrante. Devuelve null si no hay nada aprovechable.
 *
 * Tolerante a propósito: además del envoltorio nativo de Callbell
 * (`{event, payload}`), este webhook recibe reenvíos desde otra aplicación del
 * equipo, que manda su propia forma. Un parser estricto perdería esos mensajes
 * en silencio, que es el peor modo de fallo posible acá — sin el entrante la
 * conversación se cuelga y el número queda reportado como «no contestó».
 */
export function parsearEntrante(raw: unknown): Entrante | null {
  if (!raw || typeof raw !== 'object') return null;

  const sobre = raw as Record<string, unknown>;
  const payload =
    (sobre.payload as Record<string, unknown> | undefined) ??
    (sobre.data as Record<string, unknown> | undefined) ??
    sobre;

  const texto = extraerTexto(payload);
  if (!texto) return null;

  const candidatos = new Set<string>();
  juntarTelefonos(payload, candidatos);
  if (candidatos.size === 0) return null;

  const status = String(payload.status ?? sobre.status ?? '').toLowerCase();
  // Ausencia de `status` se toma como entrante: la aplicación que reenvía solo
  // nos manda lo que llega. Tratarlo como saliente descartaría todo.
  const direccion = status === 'sent' || status === 'enqueued' ? 'saliente' : 'entrante';

  const contacto = payload.contact as Record<string, unknown> | undefined;
  const nombre =
    typeof contacto?.name === 'string'
      ? contacto.name
      : typeof payload.name === 'string'
        ? payload.name
        : null;

  const proveedorId =
    typeof payload.uuid === 'string'
      ? payload.uuid
      : typeof sobre.uuid === 'string'
        ? sobre.uuid
        : null;

  return {
    candidatos: [...candidatos],
    canalUuid: extraerCanal(payload) ?? extraerCanal(sobre),
    texto: texto.slice(0, 4_000),
    direccion,
    nombre,
    proveedorId,
    recibidoAt: new Date().toISOString(),
  };
}

/**
 * Busca el identificador de canal del proveedor.
 *
 * En Callbell es `channel_uuid`; la aplicación que reenvía manda `channelUuid` o
 * un objeto `channel` con su `uuid` adentro. Se aceptan las tres formas y se
 * devuelve null sin drama si no hay ninguna: la desambiguación tiene otro camino
 * y no puede depender de que el proveedor no cambie nunca el nombre del campo.
 */
function extraerCanal(nodo: unknown, profundidad = 0): string | null {
  if (profundidad > 3 || !nodo || typeof nodo !== 'object') return null;
  const obj = nodo as Record<string, unknown>;

  for (const clave of ['channel_uuid', 'channelUuid', 'channel_id', 'channelId']) {
    const v = obj[clave];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  const canal = obj.channel;
  if (typeof canal === 'string' && canal.trim()) return canal.trim();
  if (canal && typeof canal === 'object') {
    const uuid = (canal as Record<string, unknown>).uuid;
    if (typeof uuid === 'string' && uuid.trim()) return uuid.trim();
  }

  for (const valor of Object.values(obj)) {
    if (valor && typeof valor === 'object') {
      const found = extraerCanal(valor, profundidad + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resume la FORMA del payload sin volcar su contenido.
 *
 * Se loguea SIEMPRE, antes de intentar parsear. Cuesta nada y es lo único que
 * queda cuando el proveedor cambia el formato sin avisar. El día que un
 * mensaje no aparezca en ninguna conversación, esta línea dice si llegó.
 */
export function resumirPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return { tipo: typeof raw };
  const obj = raw as Record<string, unknown>;
  const payload = (obj.payload ?? obj.data ?? obj) as Record<string, unknown>;
  return {
    claves_sobre: Object.keys(obj).slice(0, 12),
    claves_payload: typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
    event: typeof obj.event === 'string' ? obj.event : null,
    status: payload?.status ?? null,
    canal: extraerCanal(payload) ?? extraerCanal(obj),
  };
}
