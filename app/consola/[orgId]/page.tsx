import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { feedFor } from '@/lib/feed/items';
import { SectionTitle, Empty, Card, Stat } from '@/components/ui';
import { FeedCard, type FeedCardItem } from '@/components/feed-card';
import { formatNumber, isoInDays } from '@/lib/utils';

/**
 * El feed: la pantalla donde el President le habla al dueño.
 *
 * Arriba lo que espera decisión, abajo lo que ya pasó. Esa separación es todo
 * el diseño de la pantalla: el trabajo del día está en la primera lista y se
 * termina cuando queda vacía. Si mezcláramos resúmenes con propuestas, el
 * operador tendría que leer todo para encontrar las tres cosas que le tocan.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tu feed · Hola Amigo', robots: { index: false } };

export default async function FeedPage({ params }: PageProps<'/consola/[orgId]'>) {
  const { orgId } = await params;

  const [items, { count: sent7d }, { count: bookings }, { count: threads }] = await Promise.all([
    feedFor(orgId, { limit: 60 }),
    db()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('direction', 'out')
      .gte('sent_at', isoInDays(-7)),
    db()
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .in('status', ['booked', 'rescheduled']),
    db()
      .from('email_threads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('needs_human', true),
  ]);

  const open = items.filter((item) => item.status === 'open' && item.requires !== 'nothing');
  const rest = items.filter((item) => !open.includes(item));

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12">
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Tu feed"
          title={open.length > 0 ? 'Esto necesita que decidas' : 'Nada esperando por ti'}
          subtitle="Los agentes proponen y ejecutan dentro de lo aprobado. Lo que aparece acá es lo que no van a hacer sin tu permiso."
        />

        {open.length === 0 ? (
          <Empty
            title="Todo al día"
            hint="Cuando el President tenga algo que proponerte o el agente necesite que entres a una conversación, aparece acá."
          />
        ) : (
          <ul className="space-y-3">
            {open.map((item) => (
              <FeedCard key={item.id} orgId={orgId} item={item as unknown as FeedCardItem} />
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <Stat label="Correos · 7 días" value={formatNumber(sent7d ?? 0)} />
        </Card>
        <Card className="p-5">
          <Stat label="Citas agendadas" value={formatNumber(bookings ?? 0)} tone="money" />
        </Card>
        <Card className="p-5">
          <Stat
            label="Conversaciones que te esperan"
            value={formatNumber(threads ?? 0)}
            tone={threads && threads > 0 ? 'leak' : 'neutral'}
          />
        </Card>
      </section>

      <section className="space-y-6">
        <SectionTitle eyebrow="Historial" title="Lo que ha ido pasando" />
        {rest.length === 0 ? (
          <Empty
            title="Todavía no hay historia"
            hint="Cuando arranque la primera campaña, acá queda el registro de cada día: qué salió, quién contestó y qué se decidió."
          />
        ) : (
          <ul className="space-y-3">
            {rest.slice(0, 25).map((item) => (
              <FeedCard key={item.id} orgId={orgId} item={item as unknown as FeedCardItem} />
            ))}
          </ul>
        )}
      </section>

      <p className="text-[12.5px] text-ink-faint">
        ¿Todavía no tienes campañas?{' '}
        <Link href={`/consola/${orgId}/campanas`} className="underline decoration-line-strong">
          Míralas acá
        </Link>
        .
      </p>
    </main>
  );
}
