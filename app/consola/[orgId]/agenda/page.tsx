import { db } from '@/lib/supabase/admin';
import { SectionTitle, Empty, Card, Badge } from '@/components/ui';
import { CopyLink } from '@/components/copy-link';
import { assetsFor, publicUrlFor } from '@/lib/assets/links';
import { formatSlotRange } from '@/lib/scheduling/slots';
import { isoInDays } from '@/lib/utils';

/**
 * La agenda: lo que el agendador produjo.
 *
 * Cada cita dice de dónde salió —link, respuesta de correo, WhatsApp— porque
 * esa columna es la que responde "¿esto lo trajeron ustedes?". Es la misma
 * lógica de la atribución de las ventas: sin origen, un agendamiento es una
 * cita más; con origen, es un resultado.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agenda · Hola Amigo', robots: { index: false } };

const SOURCE_LABEL: Record<string, string> = {
  link: 'Link del agendador',
  reply: 'Respuesta de correo (el agente la cerró)',
  manual: 'Cargada a mano',
  whatsapp: 'WhatsApp',
};

const STATUS_LABEL: Record<string, string> = {
  booked: 'Confirmada',
  rescheduled: 'Reprogramada',
  cancelled: 'Cancelada',
  completed: 'Hecha',
  no_show: 'No llegó',
};

export default async function AgendaPage({ params }: PageProps<'/consola/[orgId]/agenda'>) {
  const { orgId } = await params;

  // Dos consultas en vez de una y un filtro en memoria: el corte por fecha lo
  // hace Postgres, que además evita traerse el historial completo para
  // descartarlo acá.
  const FIELDS =
    'id, contact_name, contact_email, contact_phone, starts_at, ends_at, timezone, status, source, notes, campaign_id';
  const now = isoInDays(0);

  const [{ data: next }, { data: previous }, schedulers] = await Promise.all([
    db()
      .from('bookings')
      .select(FIELDS)
      .eq('organization_id', orgId)
      .in('status', ['booked', 'rescheduled'])
      .gte('starts_at', now)
      .order('starts_at')
      .limit(50),
    db()
      .from('bookings')
      .select(FIELDS)
      .eq('organization_id', orgId)
      .lt('starts_at', now)
      .order('starts_at', { ascending: false })
      .limit(50),
    assetsFor(orgId, 'scheduler'),
  ]);

  const upcoming = next ?? [];
  const past = previous ?? [];

  const scheduler = schedulers.find((asset) => asset.status === 'active') ?? schedulers[0] ?? null;

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12">
      {scheduler ? (
        <Card className="space-y-3 p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Tu agendador
          </p>
          <p className="text-[15px] font-semibold tracking-tight text-ink">{scheduler.name}</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-lg bg-paper-sunken px-2.5 py-1.5 text-[12.5px] text-ink-soft">
              {publicUrlFor(scheduler)}
            </code>
            <CopyLink url={publicUrlFor(scheduler)} />
          </div>
          <p className="text-[12.5px] leading-snug text-ink-faint">
            El agente lo manda dentro de los correos, pero el link es tuyo: úsalo en tu firma, en tu
            bio y en WhatsApp. Cada cita que entre por ahí queda atribuida.
          </p>
        </Card>
      ) : null}

      <section className="space-y-6">
        <SectionTitle eyebrow="Agenda" title="Lo que viene" />
        {upcoming.length === 0 ? (
          <Empty
            title="Sin citas próximas"
            hint="Cuando alguien agende desde el link o el agente cierre una desde una respuesta, aparece acá."
          />
        ) : (
          <ul className="space-y-3">
            {upcoming.map((booking) => (
              <Card as="li" key={booking.id} className="space-y-1.5 p-5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[14px] font-semibold text-ink">
                    {booking.contact_name || booking.contact_email}
                  </span>
                  <Badge tone="money">{STATUS_LABEL[booking.status] ?? booking.status}</Badge>
                </div>
                <p className="tnum text-[13.5px] text-ink-soft">
                  {formatSlotRange(booking.starts_at, booking.ends_at, booking.timezone)}
                </p>
                <p className="text-[12.5px] text-ink-faint">
                  {booking.contact_email}
                  {booking.contact_phone ? ` · ${booking.contact_phone}` : ''} ·{' '}
                  {SOURCE_LABEL[booking.source] ?? booking.source}
                </p>
                {booking.notes ? (
                  <p className="text-[12.5px] leading-snug text-ink-faint">{booking.notes}</p>
                ) : null}
              </Card>
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 ? (
        <section className="space-y-6">
          <SectionTitle eyebrow="Historial" title="Citas pasadas" />
          <ul className="space-y-1.5">
            {past.map((booking) => (
              <li key={booking.id} className="tnum text-[12.5px] text-ink-faint">
                {new Date(booking.starts_at).toLocaleDateString('es-CO', {
                  day: 'numeric',
                  month: 'short',
                })}{' '}
                · {booking.contact_name || booking.contact_email} ·{' '}
                {STATUS_LABEL[booking.status] ?? booking.status}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
