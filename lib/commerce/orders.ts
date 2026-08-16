import { db, unwrap } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { trackAssetEvent, type Asset } from '@/lib/assets/links';
import { reserveUnits, releaseUnits, type Product } from '@/lib/commerce/catalog';
import { bumpMetric } from '@/lib/campaigns/dispatch';
import { pushFeedItem } from '@/lib/feed/items';
import { alertSlack } from '@/lib/notify';

/**
 * Órdenes: la unidad económica que demuestra el valor (ADR 0010).
 *
 * ESTADO DE LOS PAGOS EN v1: placeholder explícito. La orden se crea, se
 * reserva el inventario, se calcula el fee y se atribuye a la campaña — pero
 * el cobro no ocurre: la orden queda `pending` y alguien la marca pagada a
 * mano. Ver ADR 0013.
 *
 * Por qué construir todo menos el cobro: porque la atribución es la parte
 * difícil y la que hay que tener corriendo ANTES de poder cobrar por resultado.
 * Cuando se conecte la pasarela, lo único que cambia es quién llama a
 * `markPaid` — un webhook en vez de una persona. Y para entonces ya vamos a
 * haber hecho el cobro a mano tres veces, que es la regla (§13.3).
 *
 * El `fee_pct` se CONGELA en la orden. Si mañana subimos el fee, lo ya vendido
 * no se reescribe: una factura que cambia hacia atrás es una demanda.
 */

export interface OrderItemInput {
  product_id: string;
  qty: number;
}

export interface OrderLine {
  product_id: string;
  sku: string;
  name: string;
  qty: number;
  unit_usd: number;
}

export interface CreateOrderArgs {
  asset: Asset;
  buyer: { name: string; email: string; phone?: string | null };
  items: OrderItemInput[];
  origin: { campaignId: string | null; leadId: string | null; messageId: string | null };
}

export interface CreateOrderResult {
  ok: boolean;
  error?: string;
  order?: {
    id: string;
    subtotal_usd: number;
    currency: string;
    status: string;
    lines: OrderLine[];
    /** v1: no hay URL de pasarela. Cuando la haya, va acá. */
    payment_url: string | null;
    payment_instructions: string;
  };
}

export async function createOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
  if (args.items.length === 0) return { ok: false, error: 'No seleccionaste nada.' };

  const ids = args.items.map((i) => i.product_id);
  const { data: products } = await db()
    .from('products')
    .select('*')
    .eq('organization_id', args.asset.organization_id)
    .in('id', ids);

  const byId = new Map((products ?? []).map((p) => [p.id, p as Product]));

  const lines: OrderLine[] = [];
  for (const item of args.items) {
    const product = byId.get(item.product_id);
    if (!product || !product.active) {
      return { ok: false, error: 'Uno de los productos ya no está disponible.' };
    }
    const qty = Math.max(1, Math.min(99, Math.floor(item.qty)));
    lines.push({
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      qty,
      unit_usd: Number(product.price_usd),
    });
  }

  const reservation = await reserveUnits(lines.map((l) => ({ product_id: l.product_id, qty: l.qty })));
  if (!reservation.ok) return { ok: false, error: reservation.error };

  const subtotal = lines.reduce((sum, line) => sum + line.unit_usd * line.qty, 0);
  const feePct = Number(args.asset.revenue_share_pct ?? 0);
  const feeUsd = Math.round(subtotal * (feePct / 100) * 100) / 100;
  const currency = (products ?? [])[0]?.currency ?? 'USD';

  try {
    const order = unwrap(
      await db()
        .from('orders')
        .insert({
          organization_id: args.asset.organization_id,
          asset_id: args.asset.id,
          lead_id: args.origin.leadId,
          campaign_id: args.origin.campaignId,
          message_id: args.origin.messageId,
          buyer: args.buyer,
          items: lines,
          subtotal_usd: subtotal,
          currency,
          status: 'pending',
          provider: 'placeholder',
          fee_pct: feePct,
          fee_usd: feeUsd,
          attribution: {
            // La evidencia de por qué esta venta es atribuible a nosotros. Es
            // lo que se le muestra al cliente cuando facturemos el fee.
            source: 'asset_checkout',
            asset_slug: args.asset.slug,
            campaign_id: args.origin.campaignId,
            message_id: args.origin.messageId,
            captured_at: new Date().toISOString(),
          },
        })
        .select('id')
        .single(),
      'orders.create',
    ) as { id: string };

    await trackAssetEvent({
      assetId: args.asset.id,
      organizationId: args.asset.organization_id,
      type: 'converted',
      leadId: args.origin.leadId,
      campaignId: args.origin.campaignId,
      messageId: args.origin.messageId,
      props: { order_id: order.id, subtotal_usd: subtotal },
    });

    if (args.origin.campaignId) {
      await bumpMetric(
        { id: args.origin.campaignId, organization_id: args.asset.organization_id },
        { orders: 1, revenue_usd: subtotal },
      );
    }

    await Promise.all([
      pushFeedItem({
        organizationId: args.asset.organization_id,
        kind: 'win',
        role: 'sales',
        title: `Venta por el link: ${args.buyer.name || args.buyer.email}`,
        body: `${lines.map((l) => `${l.qty}× ${l.name}`).join(', ')} · ${money(subtotal, currency)}. Queda pendiente de cobro: todavía no hay pasarela conectada.`,
        evidence: {
          comprador: args.buyer.email,
          total: subtotal,
          moneda: currency,
          fee_holaamigo: feeUsd,
          campana_id: args.origin.campaignId,
        },
        requires: 'nothing',
        payload: { order_id: order.id },
        campaignId: args.origin.campaignId,
      }),
      alertSlack({
        title: `Venta atribuida · ${money(subtotal, currency)}`,
        lines: [
          args.buyer.email,
          lines.map((l) => `${l.qty}× ${l.name}`).join(', '),
          `Fee Hola Amigo: ${money(feeUsd, currency)} (${feePct}%)`,
        ],
        url: `${env.siteUrl}/consola/${args.asset.organization_id}/activos`,
      }),
    ]);

    return {
      ok: true,
      order: {
        id: order.id,
        subtotal_usd: subtotal,
        currency,
        status: 'pending',
        lines,
        payment_url: null,
        payment_instructions:
          'Tu pedido quedó registrado. El equipo te escribe en minutos con el link de pago.',
      },
    };
  } catch (err) {
    // Si la orden no se pudo guardar, el inventario reservado se devuelve. Un
    // cupo bloqueado por una orden que no existe es la peor clase de bug: no
    // se ve hasta que alguien reclama que el evento dice "agotado".
    await releaseUnits(lines.map((l) => ({ product_id: l.product_id, qty: l.qty })));
    console.error('[orders] no se pudo crear la orden', err);
    return { ok: false, error: 'No pudimos registrar tu pedido. Intenta de nuevo.' };
  }
}

/** v1: lo llama una persona desde la consola. v2: lo llamará el webhook de la
 *  pasarela. La firma no cambia. */
export async function markPaid(args: {
  orderId: string;
  externalId?: string | null;
  by: string;
}): Promise<{ ok: boolean }> {
  const { data } = await db()
    .from('orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      external_id: args.externalId ?? null,
      attribution: { confirmed_by: args.by, confirmed_at: new Date().toISOString() },
    })
    .eq('id', args.orderId)
    .eq('status', 'pending')
    .select('id, organization_id, lead_id')
    .maybeSingle();

  if (data?.lead_id) {
    await db().from('leads').update({ status: 'qualified' }).eq('id', data.lead_id);
  }

  return { ok: Boolean(data) };
}

export async function ordersFor(organizationId: string, limit = 100) {
  const { data } = await db()
    .from('orders')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Lo que llevamos generado y lo que nos corresponde. Es el número que
 *  sostiene la conversación de "sacamos el 10% de lo que generamos". */
export async function attributedRevenue(organizationId: string): Promise<{
  orders: number;
  paid: number;
  revenue_usd: number;
  fee_usd: number;
  pending_usd: number;
}> {
  const { data } = await db()
    .from('orders')
    .select('status, subtotal_usd, fee_usd')
    .eq('organization_id', organizationId)
    .limit(10_000);

  const rows = data ?? [];
  const paid = rows.filter((r) => r.status === 'paid');

  return {
    orders: rows.length,
    paid: paid.length,
    revenue_usd: paid.reduce((sum, r) => sum + Number(r.subtotal_usd ?? 0), 0),
    fee_usd: paid.reduce((sum, r) => sum + Number(r.fee_usd ?? 0), 0),
    pending_usd: rows
      .filter((r) => r.status === 'pending')
      .reduce((sum, r) => sum + Number(r.subtotal_usd ?? 0), 0),
  };
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
