import { randomBytes } from 'node:crypto';
import { db, unwrap } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { slugify } from '@/lib/utils';

/**
 * Los activos de Hola Amigo (ADR 0010).
 *
 * La idea: además de mandar correos, le entregamos al cliente mini-herramientas
 * suyas —un agendador y un botón de pago— que viven en un link brandeado y que
 * el agente reparte dentro de las conversaciones.
 *
 * Por qué esto importa más de lo que parece: un correo genera "una respuesta".
 * Un link con evento registrado genera **una unidad económica atribuible**. Sin
 * el activo, "te conseguimos 100 ventas" es una afirmación; con el activo, es
 * una consulta SQL. Todo el modelo de cobro por resultado depende de que la
 * conversión pase por una superficie nuestra.
 *
 * Ver docs/wiki/12-activos-agenda-y-checkout.md
 */

export type AssetKind = 'scheduler' | 'checkout';

export interface Asset {
  id: string;
  organization_id: string;
  kind: AssetKind;
  slug: string;
  name: string;
  headline: string | null;
  description: string | null;
  config: Record<string, unknown>;
  status: 'draft' | 'active' | 'paused';
  revenue_share_pct: number;
}

/** Configuración por defecto del agendador. Todo editable después. */
export const DEFAULT_SCHEDULER_CONFIG = {
  duration_min: 30,
  buffer_min: 15,
  timezone: 'America/Bogota',
  /** 1 = lunes … 5 = viernes. Sábado y domingo apagados por defecto. */
  working_days: [1, 2, 3, 4, 5],
  start_hour: 9,
  end_hour: 17,
  /** Con cuánta anticipación mínima se puede agendar. Nadie quiere una cita
   *  que le cae en 20 minutos. */
  min_notice_hours: 4,
  max_days_ahead: 21,
  location: 'Google Meet',
  confirm_message: 'Listo. Te llega la invitación al correo.',
} as const;

export const DEFAULT_CHECKOUT_CONFIG = {
  product_ids: [] as string[],
  allow_quantity: true,
  collect_phone: true,
  success_message: 'Gracias. Te llega la confirmación al correo.',
  /** v1 sin pasarela: la orden queda `pending` y alguien cobra a mano.
   *  Ver ADR 0013. */
  payment_provider: 'placeholder',
} as const;

export function publicUrlFor(asset: Pick<Asset, 'kind' | 'slug'>): string {
  const path = asset.kind === 'scheduler' ? 'agendar' : 'pagar';
  return `${env.siteUrl}/${path}/${asset.slug}`;
}

/**
 * El link que va DENTRO de un correo. Lleva de dónde viene, y eso es lo que
 * después sostiene la atribución. Sin estos parámetros, una venta hecha desde
 * el link es una venta de origen desconocido.
 */
export function trackedUrlFor(
  asset: Pick<Asset, 'kind' | 'slug'>,
  origin: { campaignId?: string | null; leadId?: string | null; messageId?: string | null },
): string {
  const url = new URL(publicUrlFor(asset));
  if (origin.campaignId) url.searchParams.set('c', origin.campaignId);
  if (origin.leadId) url.searchParams.set('l', origin.leadId);
  if (origin.messageId) url.searchParams.set('m', origin.messageId);
  return url.toString();
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || 'holaamigo';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${randomBytes(2).toString('hex')}`;
    const { data } = await db().from('assets').select('id').eq('slug', candidate).maybeSingle();
    if (!data) return candidate;
  }
  return `${root}-${randomBytes(4).toString('hex')}`;
}

export async function createAsset(args: {
  organizationId: string;
  kind: AssetKind;
  name: string;
  headline?: string | null;
  description?: string | null;
  slugBase?: string;
  config?: Record<string, unknown>;
  revenueSharePct?: number;
}): Promise<Asset> {
  const slug = await uniqueSlug(args.slugBase ?? args.name);
  const config =
    args.kind === 'scheduler'
      ? { ...DEFAULT_SCHEDULER_CONFIG, ...(args.config ?? {}) }
      : { ...DEFAULT_CHECKOUT_CONFIG, ...(args.config ?? {}) };

  return unwrap(
    await db()
      .from('assets')
      .insert({
        organization_id: args.organizationId,
        kind: args.kind,
        slug,
        name: args.name,
        headline: args.headline ?? null,
        description: args.description ?? null,
        config,
        status: 'active',
        // El agendador no cobra fee: es el activo que demuestra que esto
        // funciona. El checkout sí, porque ahí hay plata que no existía.
        revenue_share_pct: args.revenueSharePct ?? (args.kind === 'checkout' ? 10 : 0),
      })
      .select('*')
      .single(),
    'assets.create',
  ) as Asset;
}

export async function assetBySlug(slug: string): Promise<Asset | null> {
  const { data } = await db()
    .from('assets')
    .select('*')
    .eq('slug', slug.toLowerCase())
    .maybeSingle();
  return (data as Asset | null) ?? null;
}

export async function assetsFor(organizationId: string, kind?: AssetKind): Promise<Asset[]> {
  let query = db().from('assets').select('*').eq('organization_id', organizationId);
  if (kind) query = query.eq('kind', kind);
  const { data } = await query.order('created_at', { ascending: false });
  return (data ?? []) as Asset[];
}

/** El activo por defecto de un tipo. Si no existe, lo crea: el agente nunca
 *  debe quedarse sin link que mandar por un problema de provisión. */
export async function ensureAsset(args: {
  organizationId: string;
  kind: AssetKind;
  companyName: string;
}): Promise<Asset> {
  const existing = await assetsFor(args.organizationId, args.kind);
  const active = existing.find((a) => a.status === 'active');
  if (active) return active;

  return createAsset({
    organizationId: args.organizationId,
    kind: args.kind,
    name:
      args.kind === 'scheduler'
        ? `Agenda con ${args.companyName}`
        : `Pago rápido · ${args.companyName}`,
    headline:
      args.kind === 'scheduler'
        ? 'Escoge el horario que te sirva'
        : 'Completa tu compra en 30 segundos',
    slugBase: args.companyName,
  });
}

/** Nunca lanza: perder un evento de tracking es un dato menos; tumbar la
 *  página del agendador por un insert fallido es una cita menos. */
export async function trackAssetEvent(args: {
  assetId: string;
  organizationId: string;
  type: 'view' | 'start' | 'submit' | 'converted' | 'abandoned';
  leadId?: string | null;
  campaignId?: string | null;
  messageId?: string | null;
  props?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db().from('asset_events').insert({
      asset_id: args.assetId,
      organization_id: args.organizationId,
      type: args.type,
      lead_id: args.leadId ?? null,
      campaign_id: args.campaignId ?? null,
      message_id: args.messageId ?? null,
      props: args.props ?? {},
    });
  } catch (err) {
    console.error('[assets] no se pudo registrar el evento', err);
  }
}

/** Lee los parámetros de atribución de la URL del activo. */
export function originFromSearchParams(params: URLSearchParams): {
  campaignId: string | null;
  leadId: string | null;
  messageId: string | null;
} {
  const uuid = (value: string | null) =>
    value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  return {
    campaignId: uuid(params.get('c')),
    leadId: uuid(params.get('l')),
    messageId: uuid(params.get('m')),
  };
}
