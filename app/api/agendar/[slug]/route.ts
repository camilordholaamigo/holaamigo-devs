import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assetBySlug, trackAssetEvent, originFromSearchParams } from '@/lib/assets/links';
import { slotsFor, createBooking } from '@/lib/scheduling/bookings';
import { isValidEmail } from '@/lib/utils';

/**
 * El agendador, cara pública. Sin autenticación: es un link que se manda por
 * correo a gente que no tiene cuenta con nosotros.
 *
 * Por eso lo único que se acepta es: leer horarios y crear UNA cita. No se
 * puede leer la agenda existente, ni los datos de otros, ni nada de la
 * organización más allá del nombre del activo. Un link público que filtre la
 * agenda del cliente sería un incidente.
 */

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const asset = await assetBySlug(slug);

  if (!asset || asset.kind !== 'scheduler' || asset.status !== 'active') {
    return NextResponse.json({ error: 'Ese enlace no está disponible.' }, { status: 404 });
  }

  const url = new URL(request.url);
  const viewerTimezone = url.searchParams.get('tz') ?? undefined;
  const { config, days } = await slotsFor(asset, viewerTimezone);

  return NextResponse.json({
    asset: { name: asset.name, headline: asset.headline, description: asset.description },
    duration_min: config.duration_min,
    timezone: config.timezone,
    days,
  });
}

const Body = z.object({
  name: z.string().min(1).max(120),
  email: z.string().max(254),
  phone: z.string().max(40).nullish(),
  start: z.string(),
  notes: z.string().max(1000).nullish(),
});

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const asset = await assetBySlug(slug);

  if (!asset || asset.kind !== 'scheduler' || asset.status !== 'active') {
    return NextResponse.json({ error: 'Ese enlace no está disponible.' }, { status: 404 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Faltan datos para agendar.' }, { status: 400 });
  }
  if (!isValidEmail(parsed.data.email)) {
    return NextResponse.json({ error: 'Ese correo no parece válido.' }, { status: 400 });
  }

  const origin = originFromSearchParams(new URL(request.url).searchParams);

  const result = await createBooking({
    asset,
    start: parsed.data.start,
    contactName: parsed.data.name,
    contactEmail: parsed.data.email,
    contactPhone: parsed.data.phone ?? null,
    notes: parsed.data.notes ?? null,
    source: 'link',
    campaignId: origin.campaignId,
    leadId: origin.leadId,
    messageId: origin.messageId,
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

  return NextResponse.json({ ok: true, booking: result.booking });
}
