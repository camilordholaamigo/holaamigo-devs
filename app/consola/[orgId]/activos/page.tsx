import { db } from '@/lib/supabase/admin';
import { SectionTitle, Empty, Card, Stat, Badge } from '@/components/ui';
import { CopyLink } from '@/components/copy-link';
import { ProductForm } from '@/components/product-form';
import { OrderActions } from '@/components/order-actions';
import { assetsFor, publicUrlFor } from '@/lib/assets/links';
import { productsFor, availableUnits } from '@/lib/commerce/catalog';
import { ordersFor, attributedRevenue } from '@/lib/commerce/orders';
import { formatMoney, formatNumber } from '@/lib/utils';

/**
 * Activos: los mini-productos de Hola Amigo que el cliente reparte.
 *
 * Dos por ahora —agendador y botón de pago— y cada uno con su link brandeado.
 * La pantalla existe para responder una sola pregunta: **cuánto ha generado
 * esto**. Por eso lo primero que se ve es el dinero atribuido y no la lista de
 * links.
 *
 * Los pagos están en placeholder (ADR 0013): la orden se registra, se reserva
 * el cupo y se calcula nuestro fee, pero el cobro es manual. Está dicho en
 * pantalla, no escondido.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Activos · Hola Amigo', robots: { index: false } };

export default async function ActivosPage({ params }: PageProps<'/consola/[orgId]/activos'>) {
  const { orgId } = await params;

  const [assets, products, orders, revenue, { data: events }] = await Promise.all([
    assetsFor(orgId),
    productsFor(orgId),
    ordersFor(orgId, 40),
    attributedRevenue(orgId),
    db()
      .from('asset_events')
      .select('asset_id, type')
      .eq('organization_id', orgId)
      .limit(5000),
  ]);

  const viewsByAsset = new Map<string, number>();
  const conversionsByAsset = new Map<string, number>();
  for (const event of events ?? []) {
    if (event.type === 'view') {
      viewsByAsset.set(event.asset_id, (viewsByAsset.get(event.asset_id) ?? 0) + 1);
    }
    if (event.type === 'converted') {
      conversionsByAsset.set(event.asset_id, (conversionsByAsset.get(event.asset_id) ?? 0) + 1);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12">
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Activos"
          title="Lo que te dimos para cobrar y agendar"
          subtitle="Links tuyos, con tu marca, que el agente reparte dentro de las conversaciones. Cada interacción queda registrada: por eso podemos decir qué generó cada uno."
        />

        <Card className="grid gap-6 p-6 sm:grid-cols-4">
          <Stat label="Ventas atribuidas" value={formatNumber(revenue.paid)} tone="money" />
          <Stat label="Cobrado" value={formatMoney(revenue.revenue_usd)} tone="money" />
          <Stat
            label="Pendiente de cobro"
            value={formatMoney(revenue.pending_usd)}
            hint="Órdenes registradas sin pago confirmado"
          />
          <Stat label="Fee Hola Amigo" value={formatMoney(revenue.fee_usd)} />
        </Card>

        {assets.length === 0 ? (
          <Empty
            title="Todavía no tienes activos"
            hint="El agendador se crea solo cuando arranca la primera campaña. El botón de pago, cuando cargas tu primer producto."
          />
        ) : (
          <ul className="space-y-3">
            {assets.map((asset) => (
              <Card as="li" key={asset.id} className="space-y-2.5 p-5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[14px] font-semibold text-ink">{asset.name}</span>
                  <Badge tone={asset.kind === 'checkout' ? 'money' : 'muted'}>
                    {asset.kind === 'checkout' ? 'Botón de pago' : 'Agendador'}
                  </Badge>
                  {asset.revenue_share_pct > 0 ? (
                    <span className="text-[12px] text-ink-faint">
                      fee {asset.revenue_share_pct}% de lo que genere
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <code className="rounded-lg bg-paper-sunken px-2.5 py-1.5 text-[12.5px] text-ink-soft">
                    {publicUrlFor(asset)}
                  </code>
                  <CopyLink url={publicUrlFor(asset)} />
                </div>
                <p className="tnum text-[12.5px] text-ink-faint">
                  {formatNumber(viewsByAsset.get(asset.id) ?? 0)} visitas ·{' '}
                  {formatNumber(conversionsByAsset.get(asset.id) ?? 0)}{' '}
                  {asset.kind === 'checkout' ? 'compras' : 'citas'}
                </p>
              </Card>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-6">
        <SectionTitle
          eyebrow="Inventario"
          title="Qué vendes"
          subtitle="Lo que cargues acá es lo que se puede comprar desde el botón de pago que el agente reparte."
        />

        <ProductForm orgId={orgId} />

        {products.length === 0 ? (
          <Empty
            title="Sin productos todavía"
            hint="Con uno basta para tener link de pago: una entrada, un curso, un servicio."
          />
        ) : (
          <ul className="space-y-2">
            {products.map((product) => {
              const left = availableUnits(product);
              return (
                <Card as="li" key={product.id} className="flex flex-wrap items-center gap-3 p-4">
                  <span className="text-[13.5px] font-medium text-ink">{product.name}</span>
                  <span className="tnum text-[13px] text-ink-soft">
                    {formatMoney(Number(product.price_usd), product.currency)}
                  </span>
                  <span className="text-[12.5px] text-ink-faint">
                    {left === null ? 'ilimitado' : `${formatNumber(left)} disponibles`}
                  </span>
                  {!product.active ? <Badge tone="muted">Inactivo</Badge> : null}
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-6">
        <SectionTitle
          eyebrow="Órdenes"
          title="Lo que se ha comprado por el link"
          subtitle="El cobro todavía es manual: registramos la orden, reservamos el cupo y calculamos el fee, pero la pasarela de pago no está conectada."
        />

        {orders.length === 0 ? (
          <Empty title="Sin órdenes" hint="La primera aparece acá apenas alguien compre desde el link." />
        ) : (
          <ul className="space-y-2">
            {orders.map((order) => {
              const buyer = (order.buyer ?? {}) as { name?: string; email?: string };
              const items = (order.items ?? []) as { name: string; qty: number }[];
              return (
                <Card as="li" key={order.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[13.5px] font-medium text-ink">
                      {buyer.name || buyer.email}
                    </span>
                    <Badge tone={order.status === 'paid' ? 'money' : 'muted'}>
                      {order.status === 'paid' ? 'Pagada' : 'Pendiente de cobro'}
                    </Badge>
                    <span className="tnum ml-auto text-[13px] font-semibold text-ink">
                      {formatMoney(Number(order.subtotal_usd), order.currency)}
                    </span>
                  </div>
                  <p className="text-[12.5px] text-ink-faint">
                    {items.map((item) => `${item.qty}× ${item.name}`).join(', ')} ·{' '}
                    {new Date(order.created_at).toLocaleDateString('es-CO')}
                    {order.campaign_id ? ' · vino de una campaña' : ''}
                  </p>
                  {order.status === 'pending' ? (
                    <OrderActions orderId={order.id} orgId={orgId} />
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
