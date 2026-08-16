import { db, unwrap } from '@/lib/supabase/admin';
import { slugify } from '@/lib/utils';

/**
 * Inventario del cliente.
 *
 * Base para los checkouts (ADR 0010). Deliberadamente mínimo: nombre, precio,
 * inventario y poco más. No es un catálogo de e-commerce y no queremos que lo
 * sea — el cliente ya tiene dónde vender. Lo que no tiene es una forma de
 * cobrar DENTRO de la conversación que el agente está teniendo, y eso es lo
 * único que estas tablas necesitan resolver.
 *
 * `inventory` en null significa ilimitado (un curso, un servicio). Un número
 * significa cupos de verdad (las entradas de un evento), y el checkout deja de
 * aceptar órdenes cuando se acaban.
 */

export interface Product {
  id: string;
  organization_id: string;
  sku: string;
  name: string;
  description: string | null;
  kind: 'ticket' | 'course' | 'service' | 'subscription' | 'physical' | 'other';
  price_usd: number;
  currency: string;
  price_local: number | null;
  inventory: number | null;
  sold: number;
  active: boolean;
  image_url: string | null;
}

export async function productsFor(
  organizationId: string,
  onlyActive = false,
): Promise<Product[]> {
  let query = db().from('products').select('*').eq('organization_id', organizationId);
  if (onlyActive) query = query.eq('active', true);
  const { data } = await query.order('created_at', { ascending: false });
  return (data ?? []) as Product[];
}

export async function upsertProduct(args: {
  organizationId: string;
  id?: string | null;
  sku?: string | null;
  name: string;
  description?: string | null;
  kind?: Product['kind'];
  priceUsd: number;
  currency?: string;
  priceLocal?: number | null;
  inventory?: number | null;
  active?: boolean;
  imageUrl?: string | null;
}): Promise<Product> {
  const payload = {
    organization_id: args.organizationId,
    // El SKU se guarda siempre en minúsculas. El índice único es plano
    // —`(organization_id, sku)`— porque un índice sobre `lower(sku)` no sirve
    // como árbitro de un ON CONFLICT: la creación de productos fallaba con
    // 42P10. La normalización acá es lo que mantiene la protección que daba el
    // `lower()`. Ver supabase/migrations/0005 y docs/adr/0015.
    sku: (args.sku?.trim() || slugify(args.name) || `sku-${Date.now()}`).toLowerCase(),
    name: args.name.trim(),
    description: args.description ?? null,
    kind: args.kind ?? 'other',
    price_usd: args.priceUsd,
    currency: args.currency ?? 'USD',
    price_local: args.priceLocal ?? null,
    inventory: args.inventory ?? null,
    active: args.active ?? true,
    image_url: args.imageUrl ?? null,
  };

  if (args.id) {
    return unwrap(
      await db().from('products').update(payload).eq('id', args.id).select('*').single(),
      'products.update',
    ) as Product;
  }

  return unwrap(
    await db()
      .from('products')
      .upsert(payload, { onConflict: 'organization_id,sku' })
      .select('*')
      .single(),
    'products.create',
  ) as Product;
}

export function availableUnits(product: Product): number | null {
  if (product.inventory === null) return null;
  return Math.max(0, product.inventory - product.sold);
}

/**
 * Reserva unidades al crear la orden, no al pagarla.
 *
 * Si reserváramos al pagar, dos personas podrían comprar la última entrada
 * mientras la primera todavía está en la pasarela. Reservar antes puede dejar
 * cupos bloqueados por órdenes que nunca se pagan — el barrido de órdenes
 * vencidas los libera. Es el error más barato de los dos.
 */
export async function reserveUnits(
  items: { product_id: string; qty: number }[],
): Promise<{ ok: boolean; error?: string }> {
  for (const item of items) {
    const { data: product } = await db()
      .from('products')
      .select('id, name, inventory, sold, active')
      .eq('id', item.product_id)
      .maybeSingle();

    if (!product || !product.active) {
      return { ok: false, error: 'Uno de los productos ya no está disponible.' };
    }
    if (product.inventory !== null) {
      const left = product.inventory - product.sold;
      if (left < item.qty) {
        return {
          ok: false,
          error:
            left <= 0
              ? `Se agotó "${product.name}".`
              : `Solo quedan ${left} de "${product.name}".`,
        };
      }
    }
    await db()
      .from('products')
      .update({ sold: product.sold + item.qty })
      .eq('id', product.id);
  }
  return { ok: true };
}

export async function releaseUnits(items: { product_id: string; qty: number }[]): Promise<void> {
  for (const item of items) {
    const { data: product } = await db()
      .from('products')
      .select('id, sold')
      .eq('id', item.product_id)
      .maybeSingle();
    if (!product) continue;
    await db()
      .from('products')
      .update({ sold: Math.max(0, product.sold - item.qty) })
      .eq('id', product.id);
  }
}
