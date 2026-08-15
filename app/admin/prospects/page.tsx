import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SectionTitle, Empty } from '@/components/ui';
import { BAND_LABEL, type Band } from '@/lib/scoring';
import { formatMoney } from '@/lib/utils';
import { toCurrency } from '@/config/assumptions';

/**
 * §9.1 — la tabla de prospectos ordenada por banda.
 *
 * El orden no es cronológico: es por urgencia. ATTACK arriba, siempre, porque
 * el SLA es 30 minutos y un prospecto ATTACK enterrado bajo veinte AUTO es un
 * SLA incumplido esperando a pasar.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BAND_ORDER: Record<Band, number> = { attack: 0, assist: 1, auto: 2 };

export default async function ProspectsPage() {
  const { data: scores } = await db()
    .from('prospect_scores')
    .select('*')
    .order('total_score', { ascending: false })
    .limit(200);

  const orgIds = (scores ?? []).map((s) => s.organization_id);

  const [{ data: orgs }, { data: diagnostics }] = await Promise.all([
    orgIds.length
      ? db()
          .from('organizations')
          .select('id, name, domain, owner_email, industry, currency, lifecycle, created_at')
          .in('id', orgIds)
      : Promise.resolve({ data: [] as never[] }),
    orgIds.length
      ? db()
          .from('diagnostics')
          .select('organization_id, leaks, share_token, created_at')
          .in('organization_id', orgIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  interface DiagnosticRow {
    organization_id: string;
    leaks: unknown;
    share_token: string;
    created_at: string;
  }

  const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));
  const diagByOrg = new Map<string, DiagnosticRow>();
  for (const d of (diagnostics ?? []) as DiagnosticRow[]) {
    const existing = diagByOrg.get(d.organization_id);
    if (!existing || d.created_at > existing.created_at) diagByOrg.set(d.organization_id, d);
  }

  const rows = (scores ?? [])
    .map((score) => {
      const org = orgById.get(score.organization_id);
      const diagnostic = diagByOrg.get(score.organization_id);
      const leaks = Array.isArray(diagnostic?.leaks) ? diagnostic.leaks : [];
      const totalLeak = leaks.reduce(
        (sum: number, leak: { monthly_value_usd?: number }) => sum + Number(leak?.monthly_value_usd ?? 0),
        0,
      );
      return { score, org, diagnostic, totalLeak };
    })
    .filter((row) => row.org)
    .sort((a, b) => {
      const bandDiff = BAND_ORDER[a.score.band as Band] - BAND_ORDER[b.score.band as Band];
      return bandDiff !== 0 ? bandDiff : b.score.total_score - a.score.total_score;
    });

  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.score.band] = (acc[row.score.band] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-10">
      <SectionTitle
        eyebrow="§9.1"
        title="Prospectos"
        subtitle="PLG por defecto, humano por excepción. Los ATTACK van primero: SLA de 30 minutos."
      />

      <div className="flex flex-wrap gap-3">
        {(['attack', 'assist', 'auto'] as Band[]).map((band) => (
          <Card key={band} className="min-w-[150px] flex-1 px-5 py-4">
            <p className="tnum text-2xl font-semibold text-ink">{counts[band] ?? 0}</p>
            <p className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-faint">
              {BAND_LABEL[band].label}
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">
              {BAND_LABEL[band].action}
            </p>
          </Card>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Todavía no hay prospectos"
          hint="Aparecen apenas alguien termina el quiz y se genera su diagnóstico."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                <th className="px-5 py-3">Banda</th>
                <th className="px-5 py-3">Empresa</th>
                <th className="px-5 py-3">Contacto</th>
                <th className="px-5 py-3 text-right">Fit</th>
                <th className="px-5 py-3 text-right">Intent</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3 text-right">Fuga/mes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(({ score, org, totalLeak }) => (
                <tr key={score.organization_id} className="transition hover:bg-paper-sunken">
                  <td className="px-5 py-3.5">
                    <Badge tone={score.band === 'attack' ? 'leak' : score.band === 'assist' ? 'money' : 'muted'}>
                      {BAND_LABEL[score.band as Band].label}
                    </Badge>
                    {score.manual_band ? (
                      <span className="ml-1.5 text-[10px] uppercase text-ink-faint">manual</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3.5">
                    <Link
                      href={`/admin/prospects/${score.organization_id}`}
                      className="text-[14px] font-medium text-ink underline decoration-line-strong underline-offset-2 hover:text-money"
                    >
                      {org!.name ?? org!.domain}
                    </Link>
                    <span className="ml-2 text-[12px] text-ink-faint">{org!.domain}</span>
                  </td>
                  <td className="px-5 py-3.5 text-[13px] text-ink-soft">{org!.owner_email ?? '—'}</td>
                  <td className="tnum px-5 py-3.5 text-right text-[13px] text-ink-soft">
                    {score.fit_score}
                  </td>
                  <td className="tnum px-5 py-3.5 text-right text-[13px] text-ink-soft">
                    {score.intent_score}
                  </td>
                  <td className="tnum px-5 py-3.5 text-right text-[14px] font-semibold text-ink">
                    {score.total_score}
                  </td>
                  <td className="tnum px-5 py-3.5 text-right text-[13px] text-leak">
                    {totalLeak > 0
                      ? formatMoney(toCurrency(totalLeak, org!.currency ?? 'USD'), org!.currency ?? 'USD')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
