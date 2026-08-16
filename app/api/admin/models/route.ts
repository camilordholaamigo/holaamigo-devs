import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { writeSetting, clearSetting } from '@/lib/settings';
import { MODELS_SETTING_KEY, sanitizeOverrides, STEP_NAMES } from '@/config/models';

/**
 * POST /api/admin/models — cambia el ruteo de modelos sin desplegar.
 *
 * Solo admin. Lo que llega se normaliza con `sanitizeOverrides` antes de
 * guardarse: la tabla `settings` es JSON libre y no se confía en su forma ni
 * aunque venga de nuestra propia pantalla.
 *
 * El cambio se siente en menos de 30 segundos (el TTL de caché de
 * `lib/settings.ts`) en todas las instancias. Ver ADR 0014.
 */

export const runtime = 'nodejs';

const StepOverride = z.object({
  models: z.array(z.string()).optional(),
  maxOutputTokens: z.number().optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  webSearch: z.boolean().optional(),
});

const Body = z.object({
  overrides: z.record(z.enum(STEP_NAMES as [string, ...string[]]), StepOverride),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Configuración inválida.' }, { status: 400 });
  }

  try {
    const clean = sanitizeOverrides(parsed.data.overrides);
    await writeSetting(MODELS_SETTING_KEY, clean, admin.user);
    return NextResponse.json({ ok: true, overrides: clean });
  } catch (err) {
    console.error('[admin/models] fallo', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'No se pudo guardar.' },
      { status: 500 },
    );
  }
}

/** DELETE — vuelve a los defaults del código (y a las env vars si las hay). */
export async function DELETE() {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  try {
    await clearSetting(MODELS_SETTING_KEY);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[admin/models] fallo al restaurar', err);
    return NextResponse.json({ error: 'No se pudo restaurar.' }, { status: 500 });
  }
}
