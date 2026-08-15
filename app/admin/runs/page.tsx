import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, SectionTitle, Stat, Empty } from '@/components/ui';
import { formatNumber } from '@/lib/utils';
import { COST_ALERT_USD_PER_DIAGNOSTIC } from '@/config/models';

/**
 * §8.1 `admin/runs` — log de corridas y costos.
 *
 * La métrica que se vigila aquí es una sola: costo de IA por diagnóstico
 * (<USD 1,20, PRD §11). Si se pasa, o el research está buscando de más o el
 * ruteo de modelos está mandando trabajo barato a un modelo caro.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [{ data: runs }, { count: diagnostics }] = await Promise.all([
    db()
      .from('agent_runs')
      .select('id, organization_id, role, step, model, tokens_in, tokens_out, cost_usd, duration_ms, status, error, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(300),
    db()
      .from('diagnostics')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since),
  ]);

  const list = runs ?? [];
  const totalCost = list.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  const totalTokens = list.reduce((sum, r) => sum + (r.tokens_in ?? 0) + (r.tokens_out ?? 0), 0);
  const failed = list.filter((r) => r.status === 'failed').length;
  const costPerDiagnostic = diagnostics ? totalCost / diagnostics : 0;

  const byStep = list.reduce<Record<string, { runs: number; cost: number }>>((acc, run) => {
    const key = run.step ?? 'sin paso';
    acc[key] = acc[key] ?? { runs: 0, cost: 0 };
    acc[key].runs += 1;
    acc[key].cost += Number(run.cost_usd ?? 0);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-10">
      <SectionTitle
        eyebrow="Últimos 7 días"
        title="Corridas y costos"
        subtitle={`Meta: menos de USD ${COST_ALERT_USD_PER_DIAGNOSTIC.toFixed(2)} de IA por diagnóstico.`}
      />

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5">
          <Stat label="Costo total" value={`USD ${totalCost.toFixed(2)}`} />
        </Card>
        <Card className="p-5">
          <Stat
            label="Costo por diagnóstico"
            value={`USD ${costPerDiagnostic.toFixed(2)}`}
            tone={costPerDiagnostic > COST_ALERT_USD_PER_DIAGNOSTIC ? 'leak' : 'money'}
            hint={`${diagnostics ?? 0} diagnósticos`}
          />
        </Card>
        <Card className="p-5">
          <Stat label="Tokens" value={formatNumber(totalTokens)} />
        </Card>
        <Card className="p-5">
          <Stat
            label="Corridas fallidas"
            value={`${failed} / ${list.length}`}
            tone={failed > 0 ? 'leak' : 'money'}
          />
        </Card>
      </div>

      <Card className="p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Costo por paso
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {Object.entries(byStep)
            .sort((a, b) => b[1].cost - a[1].cost)
            .map(([step, stats]) => (
              <li key={step} className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-ink-soft">
                  {step} <span className="tnum text-ink-faint">×{stats.runs}</span>
                </span>
                <span className="tnum shrink-0 text-[13px] font-semibold text-ink">
                  ${stats.cost.toFixed(3)}
                </span>
              </li>
            ))}
        </ul>
      </Card>

      {list.length === 0 ? (
        <Empty title="Sin corridas en los últimos 7 días" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                <th className="px-5 py-3">Cuándo</th>
                <th className="px-5 py-3">Empresa</th>
                <th className="px-5 py-3">Rol · paso</th>
                <th className="px-5 py-3">Modelo</th>
                <th className="px-5 py-3 text-right">In</th>
                <th className="px-5 py-3 text-right">Out</th>
                <th className="px-5 py-3 text-right">Costo</th>
                <th className="px-5 py-3">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.slice(0, 150).map((run) => (
                <tr key={run.id} className={run.status === 'failed' ? 'bg-leak-soft/40' : undefined}>
                  <td className="tnum px-5 py-2.5 text-[12px] text-ink-faint">
                    {new Date(run.created_at).toLocaleString('es-CO', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-5 py-2.5 text-[12.5px]">
                    {run.organization_id ? (
                      <Link
                        href={`/admin/prospects/${run.organization_id}`}
                        className="text-ink underline decoration-line-strong underline-offset-2 hover:text-money"
                      >
                        {run.organization_id.slice(0, 8)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-[12.5px] text-ink">
                    {run.role ?? '—'} · {run.step ?? '—'}
                  </td>
                  <td className="px-5 py-2.5 font-mono text-[11.5px] text-ink-soft">{run.model}</td>
                  <td className="tnum px-5 py-2.5 text-right text-[12px] text-ink-faint">
                    {formatNumber(run.tokens_in ?? 0)}
                  </td>
                  <td className="tnum px-5 py-2.5 text-right text-[12px] text-ink-faint">
                    {formatNumber(run.tokens_out ?? 0)}
                  </td>
                  <td className="tnum px-5 py-2.5 text-right text-[12px] text-ink">
                    ${Number(run.cost_usd ?? 0).toFixed(4)}
                  </td>
                  <td className="px-5 py-2.5">
                    <span
                      className={`text-[12px] font-semibold ${
                        run.status === 'ok'
                          ? 'text-money'
                          : run.status === 'failed'
                            ? 'text-leak'
                            : 'text-ink-faint'
                      }`}
                      title={run.error ?? undefined}
                    >
                      {run.status}
                    </span>
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
