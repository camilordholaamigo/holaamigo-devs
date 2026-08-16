import { db, mustWrite } from '@/lib/supabase/admin';

/**
 * Configuración que se cambia sin desplegar (ADR 0014).
 *
 * Precedencia, siempre en este orden: **tabla `settings` → variable de entorno
 * → default en código**. La tabla gana porque es la única de las tres que se
 * puede cambiar mientras un cliente está en la pantalla; el default en código
 * es el que garantiza que el producto arranque en un proyecto vacío.
 *
 * Caché de 30 segundos en memoria. El número no es arbitrario: una llamada de
 * IA dura entre 5 y 90 segundos, así que 30 s hace que el costo de leer la
 * configuración sea irrelevante frente a la llamada, y a la vez que un cambio
 * hecho en el admin se sienta inmediato (media pantalla de refresco). Sin
 * caché, cada paso de cada corrida agregaría un viaje a Postgres.
 *
 * La escritura invalida la caché del proceso que escribe. Los demás procesos —
 * Vercel corre varias instancias— se enteran cuando expira su TTL. Esperar
 * hasta 30 s a que un cambio de modelo se propague es aceptable; coordinar
 * invalidación entre instancias no lo es para lo que esto vale.
 */

const TTL_MS = 30_000;

interface CacheEntry {
  value: Record<string, unknown>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function readSetting(key: string): Promise<Record<string, unknown>> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value: Record<string, unknown> = {};
  try {
    const { data, error } = await db()
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    // Un error acá NO puede tumbar una corrida: si la tabla no existe todavía
    // (proyecto sin migrar) o Postgres está lento, el producto tiene que seguir
    // funcionando con los defaults del código. Por eso se registra y se sigue.
    if (error) {
      console.error(`[settings] no se pudo leer ${key}: ${error.message}`);
    } else if (data?.value && typeof data.value === 'object') {
      value = data.value as Record<string, unknown>;
    }
  } catch (err) {
    console.error(`[settings] no se pudo leer ${key}`, err);
  }

  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function writeSetting(
  key: string,
  value: Record<string, unknown>,
  updatedBy: string,
): Promise<void> {
  await mustWrite(
    db()
      .from('settings')
      .upsert(
        { key, value, updated_by: updatedBy, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      ),
    `settings.write:${key}`,
  );
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/** Borra el override y vuelve a env/default. */
export async function clearSetting(key: string): Promise<void> {
  await mustWrite(db().from('settings').delete().eq('key', key), `settings.clear:${key}`);
  cache.delete(key);
}

export async function settingUpdatedAt(key: string): Promise<{ at: string; by: string } | null> {
  const { data } = await db()
    .from('settings')
    .select('updated_at, updated_by')
    .eq('key', key)
    .maybeSingle();
  return data ? { at: data.updated_at, by: data.updated_by ?? 'admin' } : null;
}
