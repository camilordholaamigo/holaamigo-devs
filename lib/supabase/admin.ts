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
export function unwrap<T>(
  result: { data: T; error: { message: string } | null },
  context: string,
): NonNullable<T> {
  if (result.error) {
    throw new Error(`[db:${context}] ${result.error.message}`);
  }
  if (result.data === null || result.data === undefined) {
    throw new Error(`[db:${context}] sin datos`);
  }
  return result.data as NonNullable<T>;
}
