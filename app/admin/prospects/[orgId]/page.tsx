import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SectionTitle, Stat, Empty } from '@/components/ui';
import { BAND_LABEL, type Band } from '@/lib/scoring';
import { BandOverride } from '@/components/band-override';
import { formatMoney, formatNumber } from '@/lib/utils';
import { toCurrency } from '@/config/assumptions';

/**
 * §9.2 — la ficha 360 del prospecto.
 *
 * Todo en una pantalla: timeline · respuestas del quiz · diagnóstico entregado
 * · fugas calculadas · corridas de agentes con costo · leads cargados ·
 * aprobaciones pendientes · override de banda.
 *
 * El costo de IA va arriba y visible. Si un prospecto AUTO nos costó USD 3 en
 * research, eso es una decisión de producto que hay que ver, no un número
 * enterrado en una tabla de logs.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ProspectDetail({ params }: PageProps<'/admin/prospects/[orgId]'>) {
  const { orgId } = await params;

  const { data: org } = await db()
    .from('organizations')
    .select('*')
    .eq('id', orgId)
    .maybeSingle();

  if (!org) notFound();

  const [score, sessions, diagnostic, runs, leads, approvals, events, brief, agents] =
    await Promise.all([
      db().from('prospect_scores').select('*').eq('organization_id', orgId).maybeSingle(),
      db()
        .from('intake_sessions')
        .select('id, contact_name, contact_email, status, created_at, completed_at, utm, referrer')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false }),
      db()
        .from('diagnostics')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db()
        .from('agent_runs')
        .select('id, role, step, model, tokens_in, tokens_out, cost_usd, duration_ms, status, error, created_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(40),
      db().from('leads').select('temperature, status').eq('organization_id', orgId),
      db()
        .from('approvals')
        .select('id, kind, title, rationale, severity, status, created_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(20),
      db()
        .from('plg_events')
        .select('event, props, created_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(60),
      db()
        .from('briefs')
        .select('version, content, created_at')
        .eq('organization_id', orgId)
        .eq('is_current', true)
        .maybeSingle(),
      db().from('agents').select('role, status, health_score, health_reasons').eq('organization_id', orgId),
    ]);

  const sessionIds = (sessions.data ?? []).map((s) => s.id);
  const { data: answers } = sessionIds.length
    ? await db()
        .from('quiz_responses')
        .select('question_id, slot, answer, answered_at')
        .in('session_id', sessionIds)
        .order('answered_at')
    : { data: [] as never[] };

  const currency = org.currency ?? 'USD';
  const band = (score.data?.band ?? 'auto') as Band;
  const totalCost = (runs.data ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  const leaks = Array.isArray(diagnostic.data?.leaks) ? diagnostic.data.leaks : [];
  const totalLeak = leaks.reduce(
    (sum: number, l: { monthly_value_usd?: number }) => sum + Number(l?.monthly_value_usd ?? 0),
    0,
  );

  return (
    <div className="mx-auto max-w-7xl space-y-12 px-6 py-10">
      {/* ── Cabecera ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="space-y-2">
          <Link href="/admin/prospects" className="text-[12.5px] text-ink-faint hover:text-ink">
            ← Prospectos
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">
            {org.name ?? org.domain}
          </h1>
          <p className="text-[13.5px] text-ink-faint">
            <a href={org.website_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {org.website_url}
            </a>
            {' · '}
            {org.owner_email ?? 'sin correo'}
            {org.industry ? ` · ${org.industry}` : ''}
            {org.country ? ` · ${org.country}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={band === 'attack' ? 'leak' : band === 'assist' ? 'money' : 'muted'}>
            {BAND_LABEL[band].label} · {score.data?.total_score ?? 0}
          </Badge>
          {diagnostic.data ? (
            <Link
              href={`/diagnostico/${diagnostic.data.share_token}`}
              className="rounded-lg border border-line-strong px-3.5 py-2 text-[13px] font-medium text-ink transition hover:border-ink"
            >
              Ver diagnóstico
            </Link>
          ) : null}
          <Link
            href={`/panel/${orgId}`}
            className="rounded-lg border border-line-strong px-3.5 py-2 text-[13px] font-medium text-ink transition hover:border-ink"
          >
            Ver su panel
          </Link>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5">
          <Stat
            label="Fuga calculada"
            value={totalLeak > 0 ? formatMoney(toCurrency(totalLeak, currency), currency) : '—'}
            tone="leak"
            hint="mensual"
          />
        </Card>
        <Card className="p-5">
          <Stat
            label="Costo de IA"
            value={`USD ${totalCost.toFixed(2)}`}
            tone={totalCost > 1.2 ? 'leak' : 'money'}
            hint={`${runs.data?.length ?? 0} corridas · meta <USD 1,20`}
          />
        </Card>
        <Card className="p-5">
          <Stat label="Contactos cargados" value={formatNumber(leads.data?.length ?? 0)} />
        </Card>
        <Card className="p-5">
          <Stat
            label="Fit / Intent"
            value={`${score.data?.fit_score ?? 0} / ${score.data?.intent_score ?? 0}`}
            hint="máximo 60 / 40"
          />
        </Card>
      </div>

      {/* ── Override de banda (§9.1) ─────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle
          eyebrow="§9.1"
          title="Banda y override"
          subtitle="Cualquier admin puede subir de banda con una nota obligatoria. Queda en plg_events."
        />
        <Card className="space-y-4 p-6">
          <div className="flex flex-wrap gap-2">
            {(score.data?.reasons ?? []).map((reason: { label: string; points: number }, i: number) => (
              <span
                key={`${reason.label}-${i}`}
                className="rounded-full bg-paper-sunken px-3 py-1 text-[12px] text-ink-soft"
              >
                {reason.label} <span className="tnum font-semibold text-ink">+{reason.points}</span>
              </span>
            ))}
          </div>
          {score.data?.manual_note ? (
            <p className="rounded-lg bg-paper-sunken px-4 py-3 text-[13px] text-ink-soft">
              Override de {score.data.manual_by}: {score.data.manual_note}
            </p>
          ) : null}
          <BandOverride organizationId={orgId} current={band} />
        </Card>
      </section>

      {/* ── Respuestas del quiz ──────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle eyebrow="Quiz" title="Qué respondió" />
        {(answers ?? []).length === 0 ? (
          <Empty title="Sin respuestas todavía" />
        ) : (
          <Card className="divide-y divide-line">
            {(answers ?? []).map((row, index) => (
              <div key={index} className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3">
                <p className="w-44 shrink-0 text-[12.5px] font-medium text-ink-faint">
                  {row.question_id ?? row.slot}
                </p>
                <p className="min-w-0 flex-1 text-[13.5px] text-ink">
                  {typeof row.answer === 'string' ? row.answer : JSON.stringify(row.answer)}
                </p>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* ── Brief vigente ────────────────────────────────────────────── */}
      {brief.data ? (
        <section className="space-y-4">
          <SectionTitle
            eyebrow="§13.2"
            title={`Brief vivo · versión ${brief.data.version}`}
            subtitle="El único objeto de contexto. Los agentes leen esto, no prompts propios."
          />
          <Card className="overflow-x-auto p-5">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-soft">
              {JSON.stringify(brief.data.content, null, 2)}
            </pre>
          </Card>
        </section>
      ) : null}

      {/* ── Corridas de agentes ──────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle eyebrow="Costos" title="Corridas de agentes" />
        {(runs.data ?? []).length === 0 ? (
          <Empty title="Sin corridas" />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                  <th className="px-5 py-3">Cuándo</th>
                  <th className="px-5 py-3">Rol · paso</th>
                  <th className="px-5 py-3">Modelo</th>
                  <th className="px-5 py-3 text-right">Tokens</th>
                  <th className="px-5 py-3 text-right">Costo</th>
                  <th className="px-5 py-3 text-right">ms</th>
                  <th className="px-5 py-3">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(runs.data ?? []).map((run) => (
                  <tr key={run.id}>
                    <td className="tnum px-5 py-3 text-[12.5px] text-ink-faint">
                      {new Date(run.created_at).toLocaleString('es-CO', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-5 py-3 text-[13px] text-ink">
                      {run.role ?? '—'} · {run.step ?? '—'}
                    </td>
                    <td className="px-5 py-3 font-mono text-[12px] text-ink-soft">{run.model}</td>
                    <td className="tnum px-5 py-3 text-right text-[12.5px] text-ink-soft">
                      {formatNumber((run.tokens_in ?? 0) + (run.tokens_out ?? 0))}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[12.5px] text-ink">
                      ${Number(run.cost_usd ?? 0).toFixed(4)}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[12.5px] text-ink-faint">
                      {run.duration_ms ?? '—'}
                    </td>
                    <td className="px-5 py-3">
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
      </section>

      {/* ── Timeline ─────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle eyebrow="§9.2" title="Timeline" />
        {(events.data ?? []).length === 0 ? (
          <Empty title="Sin eventos" />
        ) : (
          <Card className="divide-y divide-line">
            {(events.data ?? []).map((event, index) => (
              <div key={index} className="flex flex-wrap items-baseline gap-x-4 px-5 py-2.5">
                <p className="tnum w-32 shrink-0 text-[12px] text-ink-faint">
                  {new Date(event.created_at).toLocaleString('es-CO', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                <p className="text-[13px] font-medium text-ink">{event.event}</p>
                <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-faint">
                  {JSON.stringify(event.props)}
                </p>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* ── Aprobaciones y agentes ───────────────────────────────────── */}
      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <SectionTitle eyebrow="Cola" title="Aprobaciones" />
          {(approvals.data ?? []).length === 0 ? (
            <Empty title="Nada en cola" />
          ) : (
            <Card className="divide-y divide-line">
              {(approvals.data ?? []).map((approval) => (
                <div key={approval.id} className="space-y-1 px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <p className="text-[13.5px] font-medium text-ink">{approval.title}</p>
                    <Badge tone={approval.status === 'pending' ? 'muted' : 'money'}>
                      {approval.status}
                    </Badge>
                  </div>
                  {approval.rationale ? (
                    <p className="text-[12.5px] text-ink-faint">{approval.rationale}</p>
                  ) : null}
                </div>
              ))}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <SectionTitle eyebrow="§9.4" title="Salud de agentes" />
          {(agents.data ?? []).length === 0 ? (
            <Empty title="Sin agentes instanciados" />
          ) : (
            <Card className="divide-y divide-line">
              {(agents.data ?? []).map((agent) => (
                <div key={agent.role} className="flex items-center justify-between gap-4 px-5 py-3.5">
                  <div>
                    <p className="text-[13.5px] font-semibold uppercase tracking-wide text-ink">
                      {agent.role}
                    </p>
                    {(agent.health_reasons as string[])?.length ? (
                      <p className="text-[12px] text-leak">
                        {(agent.health_reasons as string[]).join(' · ')}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <p className="tnum text-[14px] font-semibold text-ink">
                      {Number(agent.health_score).toFixed(2)}
                    </p>
                    <p className="text-[11.5px] text-ink-faint">{agent.status}</p>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </section>
    </div>
  );
}
