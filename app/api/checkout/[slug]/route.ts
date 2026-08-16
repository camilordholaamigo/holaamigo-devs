import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assetBySlug, trackAssetEvent, originFromSearchParams } from '@/lib/assets/links';
import { productsFor, availableUnits } from '@/lib/commerce/catalog';
import { createOrder } from '@/lib/commerce/orders';
import { isValidEmail } from '@/lib/utils';

/**
 * El checkout, cara pública. PAGOS EN PLACEHOLDER (ADR 0013).
 *
 * Lo que SÍ hace hoy: valida inventario, reserva unidades, crea la orden,
 * calcula nuestro fee y deja la atribución completa —campaña, correo, contacto—
 * para poder decir después "estas ventas salieron de acá" con una consulta y
 * no con una promesa.
 *
 * Lo que NO hace: cobrar. La orden queda `pending` y el equipo del cliente
 * manda el link de pago. Cuando se conecte la pasarela, lo único que cambia es
 * quién llama a `markPaid`. Y para entonces ya lo habremos hecho a mano tres
 * veces, que es la regla (§13.3).
 */

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const asset = await assetBySlug(slug);

  if (!asset || asset.kind !== 'checkout' || asset.status !== 'active') {
    return NextResponse.json({ error: 'Ese enlace no está disponible.' }, { status: 404 });
  }

  const config = asset.config as { product_ids?: string[]; collect_phone?: boolean };
  const all = await productsFor(asset.organization_id, true);
  const selected =
    (config.product_ids ?? []).length > 0
      ? all.filter((product) => config.product_ids!.includes(product.id))
      : all;

  return NextResponse.json({
    asset: { name: asset.name, headline: asset.headline, description: asset.description },
    collect_phone: config.collect_phone ?? true,
    products: selected.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      price_usd: Number(product.price_usd),
      currency: product.currency,
      available: availableUnits(product),
    })),
  });
}

const Body = z.object({
  name: z.string().min(1).max(120),
  email: z.string().max(254),
  phone: z.string().max(40).nullish(),
  items: z
    .array(z.object({ product_id: z.string().uuid(), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(20),
});

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const asset = await assetBySlug(slug);

  if (!asset || asset.kind !== 'checkout' || asset.status !== 'active') {
    return NextResponse.json({ error: 'Ese enlace no está disponible.' }, { status: 404 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Faltan datos.' }, { status: 400 });
  if (!isValidEmail(parsed.data.email)) {
    return NextResponse.json({ error: 'Ese correo no parece válido.' }, { status: 400 });
  }

  const origin = originFromSearchParams(new URL(request.url).searchParams);

  const result = await createOrder({
    asset,
    buyer: {
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase().trim(),
      phone: parsed.data.phone ?? null,
    },
    items: parsed.data.items,
    origin,
  });

  if (!result.ok) {
    await trackAssetEvent({
      assetId: asset.id,
      organizationId: asset.organization_id,
      type: 'abandoned',
      campaignId: origin.campaignId,
      props: { reason: result.error },
    });
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, order: result.order });
}
