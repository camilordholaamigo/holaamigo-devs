import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SectionTitle, Empty } from '@/components/ui';
import { DETECTORS } from '@/lib/agents/health';

/**
 * §9.4 — salud de agentes y sus contratos.
 *
 * Un agente no se cae, se degrada. Esta pantalla existe para ver la
 * degradación antes de que se convierta en 400 mensajes malos ya enviados.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const { data: agents } = await db()
    .from('agents')
    .select('*')
    .order('health_score', { ascending: true })
    .limit(200);

  const orgIds = [...new Set((agents ?? []).map((a) => a.organization_id))];
  const { data: orgs } = orgIds.length
    ? await db().from('organizations').select('id, name, domain').in('id', orgIds)
    : { data: [] as never[] };

  const orgById = new Map((orgs ?? []).map((o) => [o.id, o.name ?? o.domain]));
  const degraded = (agents ?? []).filter((a) => a.status === 'degraded');

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <SectionTitle
        eyebrow="§9.4"
        title="Salud de agentes"
        subtitle="Cualquier detector en rojo pasa el agente a degradado y dispara alerta."
      />

      <Card className="p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Detectores activos
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {DETECTORS.map((detector) => (
            <li key={detector.key} className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-ink-soft">{detector.label}</span>
              <span className="tnum shrink-0 text-[12px] text-ink-faint">
                −{detector.weight.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {degraded.length > 0 ? (
        <Card className="border-leak/30 bg-leak-soft p-5">
          <p className="text-[13.5px] font-semibold text-leak">
            {degraded.length} agente{degraded.length > 1 ? 's' : ''} degradado
            {degraded.length > 1 ? 's' : ''} ahora mismo.
          </p>
        </Card>
      ) : null}

      {(agents ?? []).length === 0 ? (
        <Empty title="Todavía no hay agentes instanciados" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                <th className="px-5 py-3">Empresa</th>
                <th className="px-5 py-3">Rol</th>
                <th className="px-5 py-3">Estado</th>
                <th className="px-5 py-3 text-right">Salud</th>
                <th className="px-5 py-3">Por qué</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(agents ?? []).map((agent) => (
                <tr key={agent.id}>
                  <td className="px-5 py-3.5">
                    <Link
                      href={`/admin/prospects/${agent.organization_id}`}
                      className="text-[13.5px] text-ink underline decoration-line-strong underline-offset-2 hover:text-money"
                    >
                      {orgById.get(agent.organization_id) ?? agent.organization_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-[13px] font-semibold uppercase tracking-wide text-ink">
                    {agent.role}
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge
                      tone={
                        agent.status === 'degraded'
                          ? 'leak'
                          : agent.status === 'active'
                            ? 'money'
                            : 'muted'
                      }
                    >
                      {agent.status}
                    </Badge>
                  </td>
                  <td className="tnum px-5 py-3.5 text-right text-[13.5px] font-semibold text-ink">
                    {Number(agent.health_score).toFixed(2)}
                  </td>
                  <td className="px-5 py-3.5 text-[12.5px] text-ink-faint">
                    {(agent.health_reasons as string[])?.join(' · ') || '—'}
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
