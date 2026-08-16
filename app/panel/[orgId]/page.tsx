import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SectionTitle, Stat, Empty } from '@/components/ui';
import { formatNumber } from '@/lib/utils';

/**
 * Panel del cliente (§8.1 `panel/[orgId]`).
 *
 * Lo que ve el cliente después de cargar su base: sus tres agentes con el
 * contrato a la vista, qué está esperando decisión, y el estado de su base.
 *
 * Los contratos se muestran completos —incluida la lista de PROHIBIDO— a
 * propósito. Un agente que dice explícitamente lo que no va a hacer genera más
 * confianza que uno que solo promete. Es el mismo principio de la
 * transparencia de costos en las rutas.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tu panel · Hola Amigo', robots: { index: false } };

const ROLE_TITLE: Record<string, { title: string; subtitle: string }> = {
  president: { title: 'PRESIDENT', subtitle: 'El estratega. Razona sobre dinero, no toca dinero.' },
  cmo: { title: 'CMO', subtitle: 'La marca y el mensaje. Propone; no publica ni envía.' },
  sales: { title: 'SALES', subtitle: 'La ejecución. Solo dentro de lo aprobado.' },
};

const STATUS_LABEL: Record<string, { label: string; tone: 'money' | 'muted' | 'leak' }> = {
  active: { label: 'Activo', tone: 'money' },
  draft: { label: 'Esperando permiso', tone: 'muted' },
  paused: { label: 'En pausa', tone: 'muted' },
  degraded: { label: 'Degradado', tone: 'leak' },
};

export default async function PanelPage({ params }: PageProps<'/panel/[orgId]'>) {
  const { orgId } = await params;

  const { data: org } = await db()
    .from('organizations')
    .select('id, name, domain')
    .eq('id', orgId)
    .maybeSingle();

  if (!org) notFound();

  const [agents, approvals, leadStats, diagnostic, batches] = await Promise.all([
    db().from('agents').select('*').eq('organization_id', orgId).order('role'),
    db()
      .from('approvals')
      .select('id, kind, title, rationale, if_approved, severity, created_at')
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20),
    db().from('leads').select('temperature, status').eq('organization_id', orgId),
    db()
      .from('diagnostics')
      .select('share_token, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db()
      .from('lead_batches')
      .select('id, filename, valid_count, created_at, consent_basis')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const leads = leadStats.data ?? [];
  const byTemperature = leads.reduce<Record<string, number>>((acc, lead) => {
    const key = lead.temperature ?? 'cold';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="flex-1">
      <header className="border-b border-line bg-paper-raised">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-6">
          <div>
            <span className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight text-ink">
              <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
              Hola Amigo
            </span>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
              {org.name ?? org.domain}
            </h1>
          </div>
          <div className="flex flex-wrap gap-3">
            {diagnostic.data ? (
              <Link
                href={`/diagnostico/${diagnostic.data.share_token}`}
                className="rounded-xl border border-line-strong px-4 py-2.5 text-[13.5px] font-semibold text-ink transition hover:border-ink"
              >
                Ver mi diagnóstico
              </Link>
            ) : null}
            {/* La consola es donde se opera: campañas, bandeja, agenda. Este
                panel se queda como la foto del estado inicial. */}
            <Link
              href={`/consola/${orgId}`}
              className="rounded-xl bg-ink px-4 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright"
            >
              Abrir mi consola
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-16 px-6 py-12">
        {/* ── Base cargada ─────────────────────────────────────────────── */}
        <section className="space-y-6">
          <SectionTitle eyebrow="Tu base" title="Con qué estamos trabajando" />
          {leads.length === 0 ? (
            <Empty
              title="Todavía no has cargado contactos"
              hint="Sin base no hay reactivación, y la reactivación es lo que hace real la promesa de 24 horas."
            />
          ) : (
            <Card className="grid gap-6 p-6 sm:grid-cols-4">
              <Stat label="Total" value={formatNumber(leads.length)} tone="money" />
              <Stat label="Calientes" value={formatNumber(byTemperature.hot ?? 0)} hint="< 30 días" />
              <Stat label="Tibios" value={formatNumber(byTemperature.warm ?? 0)} hint="1 a 4 meses" />
              <Stat
                label="Fríos y dormidos"
                value={formatNumber((byTemperature.cold ?? 0) + (byTemperature.dead ?? 0))}
                hint="Más de 4 meses"
              />
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/leads/${orgId}`}
              className="rounded-xl bg-ink px-5 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright"
            >
              {leads.length === 0 ? 'Cargar mi base' : 'Cargar más contactos'}
            </Link>
          </div>

          {(batches.data ?? []).length > 0 ? (
            <ul className="space-y-1.5 text-[12.5px] text-ink-faint">
              {(batches.data ?? []).map((batch) => (
                <li key={batch.id} className="tnum">
                  {new Date(batch.created_at).toLocaleDateString('es-CO')} ·{' '}
                  {batch.filename ?? 'archivo'} · {formatNumber(batch.valid_count)} válidos ·
                  base legal: {batch.consent_basis.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ── La cola de decisiones ────────────────────────────────────── */}
        <section className="space-y-6">
          <SectionTitle
            eyebrow="Tu cola"
            title="Qué está esperando una decisión"
            subtitle="Los agentes proponen; tú decides. Nada sale sin que alguien lo apruebe."
          />
          {(approvals.data ?? []).length === 0 ? (
            <Empty title="Nada pendiente" hint="Cuando los agentes propongan algo, aparece acá." />
          ) : (
            <ul className="space-y-3">
              {(approvals.data ?? []).map((approval) => (
                <Card as="li" key={approval.id} className="space-y-2 p-5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="text-[15px] font-semibold tracking-tight text-ink">
                      {approval.title}
                    </h3>
                    {approval.severity === 'high' ? <Badge tone="leak">Urgente</Badge> : null}
                  </div>
                  {approval.rationale ? (
                    <p className="text-[13.5px] leading-relaxed text-ink-soft">
                      {approval.rationale}
                    </p>
                  ) : null}
                  {approval.if_approved ? (
                    <p className="text-[12.5px] text-ink-faint">
                      Si se aprueba: {approval.if_approved}
                    </p>
                  ) : null}
                </Card>
              ))}
            </ul>
          )}
        </section>

        {/* ── Los tres agentes ─────────────────────────────────────────── */}
        <section className="space-y-6">
          <SectionTitle
            eyebrow="Tu equipo"
            title="Tus tres agentes"
            subtitle="Cada uno es un contrato con objetivo, presupuesto, permisos y escalamiento. Lo que dice PROHIBIDO es tan vinculante como lo que dice PUEDE."
          />
          <div className="grid gap-4 lg:grid-cols-3">
            {(agents.data ?? []).map((agent) => {
              const permissions = agent.permissions as { can: string[]; cannot: string[] };
              const objective = agent.objective as { metric: string; target: string; deadline: string };
              const status = STATUS_LABEL[agent.status] ?? STATUS_LABEL.draft;
              return (
                <Card key={agent.id} className="space-y-4 p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-semibold tracking-[0.02em] text-ink">
                        {ROLE_TITLE[agent.role]?.title ?? agent.role}
                      </h3>
                      <p className="mt-1 text-[12.5px] leading-snug text-ink-faint">
                        {ROLE_TITLE[agent.role]?.subtitle}
                      </p>
                    </div>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>

                  <div className="space-y-1 border-t border-line pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                      Objetivo
                    </p>
                    <p className="text-[13.5px] leading-snug text-ink">
                      {objective?.target} · {objective?.metric}
                    </p>
                    <p className="text-[12px] text-ink-faint">{objective?.deadline}</p>
                  </div>

                  <div className="space-y-1.5 border-t border-line pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-leak">
                      Prohibido
                    </p>
                    <ul className="space-y-1">
                      {(permissions?.cannot ?? []).slice(0, 4).map((rule) => (
                        <li key={rule} className="flex gap-2 text-[12.5px] leading-snug text-ink-soft">
                          <span className="text-leak">·</span>
                          {rule}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
