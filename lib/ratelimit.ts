import { db } from '@/lib/supabase/admin';

/**
 * Rate limit por IP y por dominio (PRD §10 — costo del research por visitante
 * anónimo). Ventana fija en Postgres.
 *
 * Por qué Postgres y no Redis/Upstash: el research cuesta ~USD 0,60. A ese
 * precio, el rate limit no necesita precisión de milisegundos ni escala de
 * millones — necesita existir y ser auditable. Una tabla nos da las dos cosas
 * sin un servicio más que provisionar. Si el volumen lo justifica después, se
 * cambia por Upstash del Marketplace sin tocar los llamadores.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = new Date();

  try {
    const { data: existing } = await db()
      .from('rate_limits')
      .select('count, window_start')
      .eq('bucket', bucket)
      .maybeSingle();

    const windowStart = existing ? new Date(existing.window_start) : now;
    const elapsed = (now.getTime() - windowStart.getTime()) / 1000;

    if (!existing || elapsed >= windowSeconds) {
      await db()
        .from('rate_limits')
        .upsert({ bucket, count: 1, window_start: now.toISOString() }, { onConflict: 'bucket' });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(windowSeconds - elapsed),
      };
    }

    await db()
      .from('rate_limits')
      .update({ count: existing.count + 1 })
      .eq('bucket', bucket);

    return { allowed: true, remaining: limit - existing.count - 1, retryAfterSeconds: 0 };
  } catch (err) {
    // Si el rate limit no se puede evaluar, dejamos pasar. Preferimos gastar
    // un research de más que rechazar a un cliente real por un error nuestro.
    console.error('[ratelimit] fallo, dejando pasar', err);
    return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  }
}

/** Topes de v1. Generosos: el abuso real se ve en el costo, no en el volumen. */
export const LIMITS = {
  /** Intakes por IP. Una persona probando 3 negocios distintos es legítima. */
  intakePerIp: { limit: 5, windowSeconds: 60 * 60 },
  /** Intakes por dominio: evita que refresquen la landing 40 veces. */
  intakePerDomain: { limit: 3, windowSeconds: 60 * 60 * 24 },
  /** Cargas de leads por organización. */
  uploadPerOrg: { limit: 20, windowSeconds: 60 * 60 },
} as const;
