import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { assetBySlug, trackAssetEvent, originFromSearchParams } from '@/lib/assets/links';
import { BookingWidget } from '@/components/booking-widget';

/**
 * El agendador público (ADR 0010).
 *
 * Marca del CLIENTE arriba, "con Hola Amigo" chiquito abajo. El activo es
 * suyo: si el link se sintiera nuestro, no lo pondría en su firma ni en su
 * bio, y el activo solo produce valor si él lo reparte además del agente.
 *
 * La visita se registra en `asset_events` para poder calcular la tasa de
 * conversión del link. Sin el numerador y el denominador, "el agendador
 * funciona" es una opinión.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/agendar/[slug]'>) {
  const { slug } = await params;
  const asset = await assetBySlug(slug);
  return {
    title: asset?.name ?? 'Agendar',
    robots: { index: false, follow: false },
  };
}

export default async function AgendarPage({ params, searchParams }: PageProps<'/agendar/[slug]'>) {
  const { slug } = await params;
  const query = await searchParams;

  const asset = await assetBySlug(slug);
  if (!asset || asset.kind !== 'scheduler' || asset.status !== 'active') notFound();

  const { data: org } = await db()
    .from('organizations')
    .select('name, domain')
    .eq('id', asset.organization_id)
    .maybeSingle();

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

      <BookingWidget slug={slug} search={search.toString()} />

      <p className="mt-10 text-center text-[11.5px] text-ink-faint">
        Agenda con Hola Amigo
      </p>
    </main>
  );
}
