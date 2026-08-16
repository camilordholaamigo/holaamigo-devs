import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { upsertProduct, productsFor } from '@/lib/commerce/catalog';
import { createAsset, assetsFor } from '@/lib/assets/links';

/**
 * Inventario y activos de cobro.
 *
 * POST crea o actualiza un producto, y —si el cliente todavía no tiene link de
 * pago— crea el activo de checkout con ese producto adentro. Sin eso, cargar un
 * producto no produce nada visible y el cliente no entiende para qué lo hizo.
 */

export const runtime = 'nodejs';

const Body = z.object({
  organizationId: z.string().uuid(),
  id: z.string().uuid().nullish(),
  sku: z.string().max(60).nullish(),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullish(),
  kind: z.enum(['ticket', 'course', 'service', 'subscription', 'physical', 'other']).nullish(),
  priceUsd: z.number().min(0).max(1_000_000),
  currency: z.string().length(3).nullish(),
  priceLocal: z.number().min(0).nullish(),
  inventory: z.number().int().min(0).max(1_000_000).nullish(),
  active: z.boolean().nullish(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (parsed.data.id && !(await belongsToOrg('products', parsed.data.id, parsed.data.organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  try {
    const product = await upsertProduct({
      organizationId: parsed.data.organizationId,
      id: parsed.data.id ?? null,
      sku: parsed.data.sku ?? null,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      kind: parsed.data.kind ?? 'other',
      priceUsd: parsed.data.priceUsd,
      currency: parsed.data.currency ?? 'USD',
      priceLocal: parsed.data.priceLocal ?? null,
      inventory: parsed.data.inventory ?? null,
      active: parsed.data.active ?? true,
    });

    // Primer producto: se crea el botón de pago para que el activo exista y el
    // agente tenga qué mandar.
    const existing = await assetsFor(parsed.data.organizationId, 'checkout');
    let checkout = existing.find((asset) => asset.status === 'active') ?? null;

    if (!checkout) {
      const { data: org } = await db()
        .from('organizations')
        .select('name, domain')
        .eq('id', parsed.data.organizationId)
        .maybeSingle();

      checkout = await createAsset({
        organizationId: parsed.data.organizationId,
        kind: 'checkout',
        name: `Pago rápido · ${org?.name ?? org?.domain ?? 'tu empresa'}`,
        headline: 'Completa tu compra en 30 segundos',
        slugBase: org?.name ?? org?.domain ?? 'pago',
        config: { product_ids: [product.id] },
      });
    }

    return NextResponse.json({ ok: true, product, checkout_slug: checkout.slug });
  } catch (err) {
    console.error('[productos] fallo', err);
    return NextResponse.json({ error: 'No pudimos guardar el producto.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? '';
  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  return NextResponse.json({ products: await productsFor(organizationId) });
}
