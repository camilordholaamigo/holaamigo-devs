import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { assetBySlug, trackAssetEvent, originFromSearchParams } from '@/lib/assets/links';
import { productsFor, availableUnits } from '@/lib/commerce/catalog';
import { CheckoutWidget, type CheckoutProduct } from '@/components/checkout-widget';

/**
 * El checkout público (ADR 0010, pagos en placeholder según ADR 0013).
 *
 * Igual que el agendador: marca del cliente arriba, nuestra firma chiquita
 * abajo. Y la misma razón para registrar la visita — sin visitas no hay tasa
 * de conversión, y sin tasa de conversión no se puede mejorar el activo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/pagar/[slug]'>) {
  const { slug } = await params;
  const asset = await assetBySlug(slug);
  return { title: asset?.name ?? 'Pagar', robots: { index: false, follow: false } };
}

export default async function PagarPage({ params, searchParams }: PageProps<'/pagar/[slug]'>) {
  const { slug } = await params;
  const query = await searchParams;

  const asset = await assetBySlug(slug);
  if (!asset || asset.kind !== 'checkout' || asset.status !== 'active') notFound();

  const config = asset.config as { product_ids?: string[]; collect_phone?: boolean };

  const [{ data: org }, all] = await Promise.all([
    db()
      .from('organizations')
      .select('name, domain')
      .eq('id', asset.organization_id)
      .maybeSingle(),
    productsFor(asset.organization_id, true),
  ]);

  const selected =
    (config.product_ids ?? []).length > 0
      ? all.filter((product) => config.product_ids!.includes(product.id))
      : all;

  const products: CheckoutProduct[] = selected.map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    price_usd: Number(product.price_usd),
    currency: product.currency,
    available: availableUnits(product),
  }));

  const search = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value] as [string, string]] : [],
    ),
  );
  const origin = originFromSearchParams(search);

  await trackAssetEvent({
    assetId: asset.id,
    organizationId: asset.organization_id,
    type: 'view',
    leadId: origin.leadId,
    campaignId: origin.campaignId,
    messageId: origin.messageId,
  });

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <header className="mb-8 space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          {org?.name ?? org?.domain}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          {asset.headline ?? asset.name}
        </h1>
        {asset.description ? (
          <p className="text-[15px] leading-relaxed text-ink-soft">{asset.description}</p>
        ) : null}
      </header>

      {products.length === 0 ? (
        <p className="text-[14px] text-ink-faint">
          No hay nada disponible en este momento.
        </p>
      ) : (
        <CheckoutWidget
          slug={slug}
          search={search.toString()}
          products={products}
          collectPhone={config.collect_phone ?? true}
        />
      )}

      <p className="mt-10 text-center text-[11.5px] text-ink-faint">Pagos con Hola Amigo</p>
    </main>
  );
}
