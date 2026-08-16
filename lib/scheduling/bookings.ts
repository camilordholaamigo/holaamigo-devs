import { db, unwrap } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { trackAssetEvent, type Asset } from '@/lib/assets/links';
import {
  availableSlots,
  formatSlotRange,
  isSlotValid,
  type Busy,
  type SchedulerConfig,
} from '@/lib/scheduling/slots';
import { alertSlack } from '@/lib/notify';
import { pushFeedItem } from '@/lib/feed/items';

/**
 * Agendamientos: la parte de servidor del agendador.
 *
 * La validación del horario se hace ACÁ otra vez, aunque el navegador ya haya
 * filtrado. La lista que vio el que agenda puede tener dos minutos de vieja y
 * alguien más pudo tomar el cupo; el índice único sobre (asset_id, starts_at)
 * es la última red, pero un 409 de base de datos es una mala experiencia y
 * este chequeo lo evita casi siempre.
 */

export function schedulerConfigOf(asset: Asset): SchedulerConfig {
  const c = asset.config as Partial<SchedulerConfig>;
  return {
    duration_min: c.duration_min ?? 30,
    buffer_min: c.buffer_min ?? 15,
    timezone: c.timezone ?? 'America/Bogota',
    working_days: c.working_days ?? [1, 2, 3, 4, 5],
    start_hour: c.start_hour ?? 9,
    end_hour: c.end_hour ?? 17,
    min_notice_hours: c.min_notice_hours ?? 4,
    max_days_ahead: c.max_days_ahead ?? 21,
  };
}

export async function busyFor(assetId: string): Promise<Busy[]> {
  const { data } = await db()
    .from('bookings')
    .select('starts_at, ends_at')
    .eq('asset_id', assetId)
    .in('status', ['booked', 'rescheduled'])
    .gte('starts_at', new Date(Date.now() - 86_400_000).toISOString());
  return (data ?? []) as Busy[];
}

export async function slotsFor(asset: Asset, viewerTimezone?: string) {
  const config = schedulerConfigOf(asset);
  const busy = await busyFor(asset.id);
  return { config, days: availableSlots({ config, busy, viewerTimezone }) };
}

export interface BookingInput {
  asset: Asset;
  start: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  notes?: string | null;
  answers?: Record<string, unknown>;
  source?: 'link' | 'reply' | 'manual' | 'whatsapp';
  leadId?: string | null;
  campaignId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
}

export interface BookingResult {
  ok: boolean;
  error?: string;
  booking?: {
    id: string;
    starts_at: string;
    ends_at: string;
    timezone: string;
    manage_token: string;
    human_label: string;
  };
}

export async function createBooking(input: BookingInput): Promise<BookingResult> {
  const config = schedulerConfigOf(input.asset);
  const busy = await busyFor(input.asset.id);

  const validity = isSlotValid({ config, busy, start: input.start });
  if (!validity.ok) return { ok: false, error: validity.reason };

  const start = new Date(input.start);
  const end = new Date(start.getTime() + config.duration_min * 60_000);

  // Si el que agenda ya está en la base como lead, lo enlazamos. Si no, lo
  // creamos: una persona que agendó una llamada ES un lead, y dejarlo fuera de
  // la base porque llegó por un link en vez de por un CSV es perder el hilo.
  const leadId = input.leadId ?? (await upsertLeadFromBooking(input));

  let inserted;
  try {
    inserted = unwrap(
      await db()
        .from('bookings')
        .insert({
          organization_id: input.asset.organization_id,
          asset_id: input.asset.id,
          lead_id: leadId,
          campaign_id: input.campaignId ?? null,
          thread_id: input.threadId ?? null,
          contact_name: input.contactName,
          contact_email: input.contactEmail.toLowerCase().trim(),
          contact_phone: input.contactPhone ?? null,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          timezone: config.timezone,
          source: input.source ?? 'link',
          notes: input.notes ?? null,
          answers: input.answers ?? {},
        })
        .select('id, starts_at, ends_at, timezone, manage_token')
        .single(),
      'bookings.create',
    ) as {
      id: string;
      starts_at: string;
      ends_at: string;
      timezone: string;
      manage_token: string;
    };
  } catch (err) {
    // El índice único es la red final contra dos personas tomando el mismo
    // cupo en el mismo segundo.
    if (String(err).includes('duplicate key')) {
      return { ok: false, error: 'Alguien acaba de tomar ese horario. Escoge otro.' };
    }
    throw err;
  }

  const humanLabel = formatSlotRange(inserted.starts_at, inserted.ends_at, config.timezone);

  await Promise.all([
    trackAssetEvent({
      assetId: input.asset.id,
      organizationId: input.asset.organization_id,
      type: 'converted',
      leadId,
      campaignId: input.campaignId ?? null,
      messageId: input.messageId ?? null,
      props: { booking_id: inserted.id, starts_at: inserted.starts_at },
    }),
    leadId
      ? db().from('leads').update({ status: 'booked' }).eq('id', leadId)
      : Promise.resolve(),
    // Una cita agendada es la mejor noticia del día del cliente. Va al feed
    // como `win`, no como alerta: no requiere que haga nada.
    pushFeedItem({
      organizationId: input.asset.organization_id,
      kind: 'win',
      role: 'sales',
      title: `Cita agendada: ${input.contactName || input.contactEmail}`,
      body: `${humanLabel}. Llegó por ${sourceLabel(input.source ?? 'link')}.`,
      evidence: {
        contacto: input.contactEmail,
        cuando: humanLabel,
        origen: input.source ?? 'link',
        campana_id: input.campaignId ?? null,
      },
      requires: 'nothing',
      payload: { booking_id: inserted.id },
    }),
    alertSlack({
      title: `Cita agendada · ${input.contactName || input.contactEmail}`,
      lines: [humanLabel, `Activo: ${input.asset.name}`],
      url: `${env.siteUrl}/consola/${input.asset.organization_id}/agenda`,
    }),
  ]);

  return {
    ok: true,
    booking: { ...inserted, human_label: humanLabel },
  };
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'reply':
      return 'una respuesta de correo que el agente cerró solo';
    case 'manual':
      return 'carga manual';
    case 'whatsapp':
      return 'WhatsApp';
    default:
      return 'el link del agendador';
  }
}

async function upsertLeadFromBooking(input: BookingInput): Promise<string | null> {
  const email = input.contactEmail.toLowerCase().trim();
  const { data: existing } = await db()
    .from('leads')
    .select('id')
    .eq('organization_id', input.asset.organization_id)
    .eq('email', email)
    .maybeSingle();

  if (existing) return existing.id;

  const { data } = await db()
    .from('leads')
    .insert({
      organization_id: input.asset.organization_id,
      full_name: input.contactName || null,
      email,
      phone_e164: input.contactPhone ?? null,
      temperature: 'hot',
      status: 'booked',
      source: 'asset_scheduler',
      last_interaction_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  return data?.id ?? null;
}

export async function cancelBooking(
  manageToken: string,
  reason: string | null,
): Promise<{ ok: boolean }> {
  const { data } = await db()
    .from('bookings')
    .update({ status: 'cancelled', cancelled_reason: reason })
    .eq('manage_token', manageToken)
    .select('id, organization_id')
    .maybeSingle();

  return { ok: Boolean(data) };
}

/**
 * Archivo .ics para que la cita entre al calendario del que agenda. Lo
 * generamos a mano: son 15 líneas de texto y traer una librería para esto es
 * una dependencia que hay que mantener para siempre.
 */
export function buildIcs(args: {
  uid: string;
  start: string;
  end: string;
  summary: string;
  description: string;
  organizerEmail: string;
  attendeeEmail: string;
  location: string;
}): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hola Amigo//Agendador//ES',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${args.uid}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(args.start)}`,
    `DTEND:${stamp(args.end)}`,
    `SUMMARY:${escapeIcs(args.summary)}`,
    `DESCRIPTION:${escapeIcs(args.description)}`,
    `LOCATION:${escapeIcs(args.location)}`,
    `ORGANIZER:mailto:${args.organizerEmail}`,
    `ATTENDEE;RSVP=TRUE:mailto:${args.attendeeEmail}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function escapeIcs(value: string): string {
  return value.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}
