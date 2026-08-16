import { db } from '@/lib/supabase/admin';
import { SectionTitle, Empty } from '@/components/ui';
import { CampaignCard, type CampaignView } from '@/components/campaign-card';
import { ProposeCampaigns } from '@/components/propose-campaigns';
import { audienceSnapshot } from '@/lib/campaigns/segment';

/**
 * Campañas: las tres propuestas y lo que está corriendo.
 *
 * Arriba lo que espera decisión. Es la misma jerarquía del feed y por la misma
 * razón: lo que hay que decidir va primero, lo que ya está andando va después.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Campañas · Hola Amigo', robots: { index: false } };

export default async function CampanasPage({ params }: PageProps<'/consola/[orgId]/campanas'>) {
  const { orgId } = await params;

  const [{ data: campaigns }, snapshot] = await Promise.all([
    db()
      .from('campaigns')
      .select(
        'id, name, playbook, status, objective, hypothesis, segment_name, audience_size, credits_estimate, paused_reason, scheduled_for, sequence, expected, measurement, iteration',
      )
      .eq('organization_id', orgId)
      .neq('status', 'rejected')
      .order('created_at', { ascending: false })
      .limit(20),
    audienceSnapshot(orgId),
  ]);

  const rows = (campaigns ?? []) as unknown as CampaignView[];

  // Lo real de cada campaña, para poder comparar contra lo esperado en la misma
  // tarjeta. Sin la comparación, "esperábamos 40 respuestas" es una frase
  // bonita que nadie vuelve a mirar.
  const ids = rows.map((row) => row.id);
  const actuals = new Map<string, { sent: number; delivered: number; replied: number; booked: number }>();

  if (ids.length > 0) {
    const { data: metrics } = await db()
      .from('campaign_metrics')
      .select('campaign_id, sent, delivered, replied, booked')
      .in('campaign_id', ids);

    for (const metric of metrics ?? []) {
      const current = actuals.get(metric.campaign_id) ?? { sent: 0, delivered: 0, replied: 0, booked: 0 };
      actuals.set(metric.campaign_id, {
        sent: current.sent + Number(metric.sent ?? 0),
        delivered: current.delivered + Number(metric.delivered ?? 0),
        replied: current.replied + Number(metric.replied ?? 0),
        booked: current.booked + Number(metric.booked ?? 0),
      });
    }
  }

  const withActuals = rows.map((row) => ({ ...row, actual: actuals.get(row.id) ?? null }));
  const pending = withActuals.filter((row) => ['proposed', 'draft'].includes(row.status));
  const running = withActuals.filter((row) => !['proposed', 'draft'].includes(row.status));

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12">
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Campañas"
          title="Cómo vamos a atacar tu base"
          subtitle="Cada una trae a quién le pega, qué esperamos que pase, cómo lo vamos a medir y qué cambiamos si no funciona. Nada sale sin que lo apruebes."
        />

        {pending.length === 0 ? (
          <div className="space-y-4">
            <Empty
              title="No hay campañas esperando decisión"
              hint={`Tu base tiene ${snapshot.withEmail} contactos con correo: ${snapshot.hot + snapshot.warm} calientes o tibios y ${snapshot.cold + snapshot.dead} dormidos.`}
            />
            <ProposeCampaigns orgId={orgId} />
          </div>
        ) : (
          <ul className="space-y-4">
            {pending.map((campaign) => (
              <CampaignCard key={campaign.id} campaign={campaign} orgId={orgId} />
            ))}
          </ul>
        )}
      </section>

      {running.length > 0 ? (
        <section className="space-y-6">
          <SectionTitle eyebrow="En marcha" title="Lo que está corriendo" />
          <ul className="space-y-4">
            {running.map((campaign) => (
              <CampaignCard key={campaign.id} campaign={campaign} orgId={orgId} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
