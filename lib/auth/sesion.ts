/**
 * Qué hacer, del lado del navegador, cuando el admin contesta 401.
 *
 * Este archivo existe por un incidente concreto y barato de arreglar. La cookie
 * de admin dura 12 horas (`lib/auth/admin.ts`). Cuando vence, el layout de
 * /admin redirige al login **en la siguiente carga de página** — pero una
 * pantalla que ya está abierta no se recarga sola. El formulario sigue ahí, el
 * operador le da a «Crear» y el `fetch` recibe `401 {"error":"No autorizado"}`.
 *
 * Los formularios muestran `json.error` tal cual, así que en pantalla se leía
 * **«No autorizado»** y nada más. Dos palabras que describen perfectamente lo
 * que pasó y no le sirven a nadie: parecen un permiso que falta, o el gobierno
 * de capacidades frenando la prueba (ADR 0018), o el proveedor rechazando la
 * llave. Es ninguna de las tres — es que hay que volver a entrar.
 *
 * La corrección tiene dos mitades y la segunda importa más que la primera:
 *
 *   1. El mensaje dice qué pasó y qué hacer.
 *   2. Dice que se entre **en otra pestaña**. Navegar al login desde acá se
 *      lleva por delante el estado del formulario, y el formulario de una
 *      prueba a medida son tres pasos de texto escrito a mano. Perderlo por una
 *      cookie vencida es exactamente el tipo de castigo que hace que una
 *      herramienta interna deje de usarse.
 *
 * Client-safe a propósito: no importa nada de `node:`, ni de Supabase, ni de
 * `next/headers`. Lo consumen componentes con `'use client'`.
 */

export const RUTA_DE_ENTRADA = '/admin-login';

/**
 * El único texto de sesión vencida de todo el admin.
 *
 * Es una constante y no una cadena escrita en cada `catch` porque los
 * componentes la comparan por identidad para decidir si pintan además el enlace
 * de entrar. Dos copias con una coma de diferencia romperían esa comparación sin
 * dar error en ninguna parte.
 */
export const SESION_VENCIDA =
  'Tu sesión de admin venció — dura 12 horas. Entrá de nuevo en otra pestaña y volvé a darle acá: no perdés nada de lo que escribiste.';

/**
 * El texto que se le muestra a una persona a partir de una respuesta fallida.
 *
 * Un 401 de cualquier ruta bajo `/api/admin` significa una sola cosa: no hay
 * cookie válida. Ninguna de esas rutas usa 401 para otra cosa —los frenos de
 * gobierno devuelven 400 con su motivo, y los del proveedor 502— así que el
 * mapeo es exacto y no una heurística.
 */
export function errorDeRespuesta(
  res: Response,
  json: { error?: unknown } | null,
  porDefecto: string,
): string {
  if (res.status === 401) return SESION_VENCIDA;
  return typeof json?.error === 'string' && json.error ? json.error : porDefecto;
}

/**
 * El link para volver a entrar, con la vuelta a donde estabas.
 *
 * Se calcula en el navegador porque es el único lado que sabe en qué pantalla
 * está el operador: un layout de servidor en el App Router no recibe el
 * pathname, y fabricarlo desde una cabecera sería adivinar.
 *
 * Devuelve la ruta pelada si no hay `window` (render en servidor del árbol
 * cliente): el login sin `next` cae en /admin/prospects, que es el
 * comportamiento de siempre.
 */
export function entradaConVuelta(): string {
  if (typeof window === 'undefined') return RUTA_DE_ENTRADA;
  const aqui = `${window.location.pathname}${window.location.search}`;
  return `${RUTA_DE_ENTRADA}?next=${encodeURIComponent(aqui)}`;
}

/**
 * Sanea el `?next=` antes de mandar a nadie ahí.
 *
 * Solo rutas locales. `//evil.com` es una URL protocolo-relativa y el navegador
 * la trata como absoluta: sin este chequeo, el login del admin sería un redirect
 * abierto — le pegás el parámetro a la URL, se la mandás a alguien del equipo, y
 * después de entrar aterriza en un sitio ajeno con la cookie recién puesta.
 */
export function destinoSeguro(next: unknown, porDefecto = '/admin/prospects'): string {
  if (typeof next !== 'string' || !next) return porDefecto;
  if (!next.startsWith('/') || next.startsWith('//')) return porDefecto;
  return next;
}
