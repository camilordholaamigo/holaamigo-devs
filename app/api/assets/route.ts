import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { createAsset, assetsFor, publicUrlFor } from '@/lib/assets/links';

/**
 * Los activos brandeados del cliente: agendador y checkout (ADR 0010).
 *
 * POST crea uno; PATCH ajusta su configuración (horarios, duración, qué
 * productos muestra). El `slug` no se puede cambiar después: es lo que ya está
 * dentro de correos enviados, y romperlo convierte cada link repartido en un
 * 404 y cada venta futura en una venta sin atribución.
 */

export const runtime = 'nodejs';

const CreateBody = z.object({
  organizationId: z.string().uuid(),
  kind: z.enum(['scheduler', 'checkout']),
  name: z.string().min(1).max(160),
  headline: z.string().max(200).nullish(),
  description: z.string().max(1000).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
  revenueSharePct: z.number().min(0).max(50).nullish(),
});

export async function POST(request: Request) {
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  try {
    const asset = await createAsset({
      organizationId: parsed.data.organizationId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      headline: parsed.data.headline ?? null,
      description: parsed.data.description ?? null,
      config: parsed.data.config ?? {},
      revenueSharePct: parsed.data.revenueSharePct ?? undefined,
    });

    return NextResponse.json({ ok: true, asset: { ...asset, url: publicUrlFor(asset) } });
  } catch (err) {
    console.error('[assets] fallo al crear', err);
    return NextResponse.json({ error: 'No pudimos crear el activo.' }, { status: 500 });
  }
}

const PatchBody = z.object({
  organizationId: z.string().uuid(),
  id: z.string().uuid(),
  name: z.string().max(160).nullish(),
  headline: z.string().max(200).nullish(),
  description: z.string().max(1000).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
  status: z.enum(['draft', 'active', 'paused']).nullish(),
});

export async function PATCH(request: Request) {
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!(await belongsToOrg('assets', parsed.data.id, parsed.data.organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  const { data: current } = await db()
    .from('assets')
    .select('config')
    .eq('id', parsed.data.id)
    .maybeSingle();

  const patch: Record<string, unknown> = {};
  if (parsed.data.name) patch.name = parsed.data.name;
  if (parsed.data.headline !== undefined && parsed.data.headline !== null) {
    patch.headline = parsed.data.headline;
  }
  if (parsed.data.description !== undefined && parsed.data.description !== null) {
    patch.description = parsed.data.description;
  }
  if (parsed.data.status) patch.status = parsed.data.status;
  if (parsed.data.config) {
    // Merge, no reemplazo: el formulario de horarios manda solo lo suyo y no
    // tiene por qué conocer el resto de la configuración.
    patch.config = { ...((current?.config ?? {}) as object), ...parsed.data.config };
  }

  const { error } = await db().from('assets').update(patch).eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: 'No pudimos guardar.' }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function GET(request: Request) {
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? '';
  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const assets = await assetsFor(organizationId);
  return NextResponse.json({
    assets: assets.map((asset) => ({ ...asset, url: publicUrlFor(asset) })),
  });
}
