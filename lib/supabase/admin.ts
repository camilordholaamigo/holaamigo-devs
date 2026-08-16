import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

/**
 * Cliente de servicio, apuntado al schema `holaamigo`.
 *
 * Este es el ÚNICO cliente de Supabase de la app. No hay cliente de navegador:
 * todo lo que el usuario ve pasa por un Server Component o una ruta de API.
 * Consecuencia: RLS está en deny-by-default y no hay superficie pública.
 * Ver docs/adr/0003-rls-deny-by-default.md
 *
 * NUNCA importar este módulo desde un archivo con "use client".
 */

function build() {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    // Todo el producto vive en `holaamigo`, no en `public`. El schema por
    // defecto del cliente es lo que hace que ningún `.from('leads')` toque
    // por accidente la tabla `leads` de Rentmies.
    db: { schema: 'holaamigo' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'holaamigo' } },
  });
}

/** El tipo se deriva del cliente construido: no hay tipos generados de la
 *  base todavía, y escribir el genérico a mano se desincroniza en una semana. */
type Db = ReturnType<typeof build>;

let cached: Db | null = null;

export function db(): Db {
  if (!cached) cached = build();
  return cached;
}

/**
 * Lanza con contexto si la query falló o vino vacía. Evita repetir
 * `if (error) throw error; if (!data) throw ...` cincuenta veces, y —más
 * importante— le quita el `| null` al tipo, así que el llamador no tiene que
 * encadenar `?.` sobre algo que ya sabemos que existe.
 */
/**
 * Traduce los errores de configuración de Supabase que no se explican solos.
 *
 * Existe por una tarde perdida: `Invalid schema: holaamigo` es lo que devuelve
 * PostgREST cuando el schema no está en su lista de expuestos. Las tablas
 * existen, los permisos están bien, el service_role es correcto — y todo falla.
 * El mensaje crudo no dice qué hacer, y en la app se ve como "algo se rompió".
 *
 * Cualquier error que no reconozcamos vuelve tal cual: inventar diagnósticos
 * sería peor que no dar ninguno.
 */
export function explainDbError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);

  if (/invalid schema|PGRST106/i.test(message)) {
    return `${message} → El schema \`holaamigo\` no está expuesto en la API de Supabase. Project Settings → API → Exposed schemas, agregar \`holaamigo\`. Ver supabase/migrations/0004_exponer_api.sql`;
  }

  if (/relation .* does not exist|PGRST205|42P01/i.test(message)) {
    return `${message} → Falta correr las migraciones. Ejecuta supabase/migrations/*.sql en orden desde el SQL Editor.`;
  }

  if (/permission denied|42501/i.test(message)) {
    return `${message} → El rol no tiene permisos sobre el schema. El bloque de grants está al final de 0001_init.sql.`;
  }

  if (/JWT|invalid api key|401/i.test(message)) {
    return `${message} → SUPABASE_SERVICE_ROLE_KEY inválida o de otro proyecto.`;
  }

  return message;
}

export function unwrap<T>(
  result: { data: T; error: { message: string } | null },
  context: string,
): NonNullable<T> {
  if (result.error) {
    throw new Error(`[db:${context}] ${explainDbError(result.error.message)}`);
  }
  if (result.data === null || result.data === undefined) {
    throw new Error(`[db:${context}] sin datos`);
  }
  return result.data as NonNullable<T>;
}

/**
 * Escritura que no se puede perder en silencio.
 *
 * Existe por el bug que dejó el quiz muerto una semana. `supabase-js` NO lanza:
 * devuelve `{ error }`. Un `await db().from('x').insert(...)` sin destructurar
 * el error compila, corre, no imprime nada y no escribe nada. La ruta devolvía
 * 200 con la misma pregunta y la pantalla se quedaba quieta sin un solo mensaje
 * de error, ni en la UI ni en los logs.
 *
 * Toda escritura del camino del producto pasa por acá. Si falla, lanza con el
 * contexto y con la traducción de `explainDbError`, la ruta devuelve 500 y el
 * usuario ve que algo pasó. Un fallo ruidoso se arregla en una hora; uno
 * silencioso cuesta una semana.
 */
export async function mustWrite<T>(
  query: PromiseLike<{ data: T; error: { message: string } | null }>,
  context: string,
): Promise<T> {
  const result = await query;
  if (result.error) {
    throw new Error(`[db:${context}] ${explainDbError(result.error.message)}`);
  }
  return result.data;
}

/**
 * Escritura que sí puede perderse: telemetría, logs, contadores.
 *
 * La diferencia con `mustWrite` es una decisión de producto, no de estilo. Un
 * evento de PLG perdido es un dato menos; una excepción en ese mismo punto es
 * una venta menos. Lo que NO se acepta es la tercera opción que teníamos antes:
 * perderlo sin dejar rastro.
 */
export async function tryWrite(
  query: PromiseLike<{ error: { message: string } | null }>,
  context: string,
): Promise<boolean> {
  try {
    const { error } = await query;
    if (error) {
      console.error(`[db:${context}] ${explainDbError(error.message)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[db:${context}] ${explainDbError(err)}`);
    return false;
  }
}
