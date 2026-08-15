import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { track } from '@/lib/events';
import { refreshScore } from '@/lib/scoring';
import { Card, Badge, SectionTitle, SourceMark } from '@/components/ui';
import { MoneyPanel } from '@/components/money-panel';
import { PositionMatrix, type Point } from '@/components/position-matrix';
import { formatMoney, formatNumber, dateInDays } from '@/lib/utils';
import { toCurrency } from '@/config/assumptions';
import type { Assumptions } from '@/config/assumptions';
import type { Leak } from '@/lib/diagnostic/math';
import { env } from '@/lib/env';

/**
 * El diagnóstico (PRD §7). Enlace permanente y público por share_token.
 *
 * Reglas de presentación que vienen del PRD y no se negocian:
 *  · Se revela por secciones con animación de entrada, no todo de golpe.
 *  · Cada afirmación sobre su negocio lleva fuente (URL) o marca de inferido.
 *  · La sección de fugas va con número en pesos, no con adjetivos.
 *
 * Es público a propósito: el cliente lo comparte con su socio y con su equipo,
 * y ese reenvío es nuestro mejor canal de distribución. El token de 64
 * caracteres es lo que lo protege de ser enumerable.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/diagnostico/[shareToken]'>) {
  const { shareToken } = await params;
  const { data } = await db()
    .from('diagnostics')
    .select('organization_id')
    .eq('share_token', shareToken)
    .maybeSingle();

  if (!data) return { title: 'Diagnóstico · Hola Amigo' };

  const { data: org } = await db()
    .from('organizations')
    .select('name, domain')
    .eq('id', data.organization_id)
    .maybeSingle();

  return {
    title: `Diagnóstico de ${org?.name ?? org?.domain ?? 'tu negocio'} · Hola Amigo`,
    robots: { index: false, follow: false },
  };
}

export default async function DiagnosticPage({ params }: PageProps<'/diagnostico/[shareToken]'>) {
  const { shareToken } = await params;

  const { data: diagnostic } = await db()
    .from('diagnostics')
    .select('*')
    .eq('share_token', shareToken)
    .maybeSingle();

  if (!diagnostic) notFound();

  const [{ data: org }, { data: recommendations }, { data: score }] = await Promise.all([
    db()
      .from('organizations')
      .select('id, name, domain, website_url, currency, industry')
      .eq('id', diagnostic.organization_id)
      .single(),
    db()
      .from('recommendations')
      .select('*')
      .eq('diagnostic_id', diagnostic.id)
      .order('rank'),
    db()
      .from('prospect_scores')
      .select('band')
      .eq('organization_id', diagnostic.organization_id)
      .maybeSingle(),
  ]);

  await track('diagnostic_viewed', {
    organizationId: diagnostic.organization_id,
    sessionId: diagnostic.session_id,
    props: { share_token: shareToken },
  });
  await refreshScore(diagnostic.organization_id);

  const currency = org?.currency ?? 'USD';
  const assumptions = diagnostic.assumptions as Assumptions;
  const leaks = (diagnostic.leaks ?? []) as Leak[];
  const identity = diagnostic.identity as {
    sentences: { text: string; source_url: string | null; inferred: boolean }[];
    business_model: string;
  } | null;
  const competitorsData = diagnostic.competitors as {
    list: CompetitorRow[];
    summary: string;
  } | null;
  const position = diagnostic.market_position as {
    axis_x_label: string;
    axis_y_label: string;
    you: { x: number; y: number; note: string };
  } | null;

  const competitors = competitorsData?.list ?? [];
  const points: Point[] = [
    ...competitors.map((c) => ({ name: c.name, x: c.x ?? 50, y: c.y ?? 50 })),
    {
      name: org?.name ?? org?.domain ?? 'Tú',
      x: position?.you?.x ?? 50,
      y: position?.you?.y ?? 50,
      isYou: true,
    },
  ];

  const recommended = recommendations?.find((r) => r.is_recommended) ?? recommendations?.[0];
  const band = (score?.band ?? 'auto') as 'auto' | 'assist' | 'attack';

  return (
    <main className="flex-1">
      {/* ── Cabecera ───────────────────────────────────────────────────── */}
      <header className="border-b border-line bg-paper-raised">
        <div className="mx-auto max-w-4xl px-6 py-10 sm:py-14">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-ink">
              <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
              Hola Amigo
            </span>
            {diagnostic.research_quality === 'full' ? (
              <Badge tone="money">Análisis completo</Badge>
            ) : (
              <Badge tone="muted">Análisis parcial</Badge>
            )}
          </div>

          <h1 className="mt-6 text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            Diagnóstico de {org?.name ?? org?.domain}
          </h1>
          <p className="mt-2 text-[14px] text-ink-faint">
            {org?.website_url} · generado el{' '}
            {new Date(diagnostic.created_at).toLocaleDateString('es-CO', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>

          {diagnostic.research_quality !== 'full' ? (
            <p className="mt-5 rounded-xl border border-line bg-paper-sunken px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
              Tu sitio no se dejó leer del todo, así que este diagnóstico tiene menos secciones y
              más marcas de <em>inferido</em>. Los números siguen siendo válidos: salen de tus
              respuestas, no del crawl.
            </p>
          ) : null}
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-20 px-6 py-16 sm:py-20">
        {/* ── §7.1 QUIÉN ERES ──────────────────────────────────────────── */}
        <section className="reveal space-y-8" style={{ '--i': 0 } as React.CSSProperties}>
          <SectionTitle
            eyebrow="Sección 1"
            title="Quién eres"
            subtitle="Lo que entendimos de tu negocio leyendo tu sitio. Si algo está mal, es la señal más útil que nos puedes dar."
          />
          <Card className="divide-y divide-line">
            {(identity?.sentences ?? []).map((sentence, index) => (
              <p key={index} className="px-6 py-5 text-[16px] leading-relaxed text-ink sm:px-8">
                {sentence.text}
                <SourceMark url={sentence.source_url} inferred={sentence.inferred} />
              </p>
            ))}
            {identity?.business_model ? (
              <p className="px-6 py-4 text-[13px] text-ink-faint sm:px-8">
                Modelo de negocio: {identity.business_model}
              </p>
            ) : null}
          </Card>
        </section>

        {/* ── §7.2 TU POSICIÓN ─────────────────────────────────────────── */}
        <section className="reveal space-y-8" style={{ '--i': 1 } as React.CSSProperties}>
          <SectionTitle
            eyebrow="Sección 2"
            title="Tu posición"
            subtitle={
              competitorsData?.summary ||
              'Contra quién compites de verdad, y en qué eje ganas o pierdes.'
            }
          />

          {competitors.length > 0 ? (
            <>
              <Card className="p-4 sm:p-6">
                <PositionMatrix
                  axisX={position?.axis_x_label ?? 'Precio'}
                  axisY={position?.axis_y_label ?? 'Especialización'}
                  points={points}
                />
                {position?.you?.note ? (
                  <p className="mt-2 border-t border-line pt-4 text-[13.5px] leading-relaxed text-ink-soft">
                    {position.you.note}
                  </p>
                ) : null}
              </Card>

              <div className="grid gap-4 sm:grid-cols-2">
                {competitors.map((competitor) => (
                  <Card key={competitor.name} className="space-y-3 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-[15px] font-semibold tracking-tight text-ink">
                        {competitor.name}
                        <SourceMark url={competitor.url} inferred={!competitor.url} />
                      </h3>
                      {competitor.publishes_pricing ? (
                        <Badge tone="muted">Publica precios</Badge>
                      ) : null}
                    </div>
                    {competitor.promise ? (
                      <p className="text-[13.5px] leading-relaxed text-ink-soft">
                        “{competitor.promise}”
                      </p>
                    ) : null}
                    <dl className="space-y-1.5 border-t border-line pt-3 text-[13px]">
                      {competitor.you_win_on ? (
                        <div className="flex gap-2">
                          <dt className="shrink-0 font-semibold text-money">Ganas en</dt>
                          <dd className="text-ink-soft">{competitor.you_win_on}</dd>
                        </div>
                      ) : null}
                      {competitor.you_lose_on ? (
                        <div className="flex gap-2">
                          <dt className="shrink-0 font-semibold text-leak">Pierdes en</dt>
                          <dd className="text-ink-soft">{competitor.you_lose_on}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </Card>
                ))}
              </div>
            </>
          ) : (
            <Card className="px-6 py-8">
              <p className="text-[14px] leading-relaxed text-ink-soft">
                No encontramos competidores identificables desde tu sitio. Eso puede significar dos
                cosas: que tu categoría no tiene nombre todavía, o que tu sitio no dice con
                suficiente claridad en qué mercado juegas. Las dos son conversaciones que vale la
                pena tener.
              </p>
            </Card>
          )}
        </section>

        {/* ── §7.3 y §7.4 — cliente, para recálculo en vivo ────────────── */}
        <MoneyPanel
          shareToken={shareToken}
          initialAssumptions={assumptions}
          initialLeaks={leaks}
          currency={currency}
          languageChannelDetected={leaks.some((l) => l.key === 'language_channel')}
        />

        {/* ── §7.5 LAS 3 RUTAS ─────────────────────────────────────────── */}
        <section className="reveal space-y-8" style={{ '--i': 4 } as React.CSSProperties}>
          <SectionTitle
            eyebrow="Sección 5"
            title="Las tres rutas"
            subtitle="Costos separados en infraestructura y fee, con fechas reales calculadas desde hoy. La que el President recomienda va resaltada."
          />

          <div className="space-y-5">
            {(recommendations ?? []).map((route) => (
              <Card
                key={route.route}
                className={
                  route.is_recommended
                    ? 'border-money/40 ring-1 ring-money/20'
                    : undefined
                }
              >
                <div className="space-y-5 p-6 sm:p-8">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="text-xl font-semibold tracking-tight text-ink">
                          {ROUTE_LABEL[route.route as RouteKey]}
                        </h3>
                        {route.is_recommended ? <Badge tone="money">Recomendada</Badge> : null}
                      </div>
                      {route.rationale ? (
                        <p className="max-w-xl text-[14.5px] leading-relaxed text-ink-soft">
                          {route.rationale}
                        </p>
                      ) : null}
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="tnum text-2xl font-semibold tracking-tight text-ink">
                        {formatMoney(
                          toCurrency(Number(route.cost_infra_usd) + Number(route.cost_fee_usd), currency),
                          currency,
                        )}
                        <span className="ml-1 text-[13px] font-normal text-ink-faint">/mes</span>
                      </p>
                      <p className="tnum mt-1 text-[12px] leading-relaxed text-ink-faint">
                        {formatMoney(toCurrency(Number(route.cost_infra_usd), currency), currency)} de
                        infraestructura
                        <br />
                        {formatMoney(toCurrency(Number(route.cost_fee_usd), currency), currency)} de fee
                      </p>
                    </div>
                  </div>

                  {/* Roadmap con fechas reales */}
                  <ol className="grid gap-3 border-t border-line pt-5 sm:grid-cols-2">
                    {((route.roadmap ?? []) as RoadmapItem[]).map((milestone, index) => (
                      <li key={index} className="flex gap-3">
                        <span className="tnum mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-[11px] font-semibold text-ink-faint">
                          {index + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13.5px] font-medium leading-snug text-ink">
                            {milestone.milestone}
                          </span>
                          <span className="tnum block text-[12px] text-ink-faint">
                            {dateInDays(milestone.eta_days)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>

                  {(route.prerequisites as string[])?.length ? (
                    <div className="border-t border-line pt-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                        Prerequisitos
                      </p>
                      <ul className="mt-2 space-y-1">
                        {(route.prerequisites as string[]).map((prerequisite) => (
                          <li key={prerequisite} className="flex gap-2 text-[13px] text-ink-soft">
                            <span className="text-ink-faint">·</span>
                            {prerequisite}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </section>

        {/* ── §7.6 EL SIGUIENTE PASO ───────────────────────────────────── */}
        <section className="reveal" style={{ '--i': 5 } as React.CSSProperties}>
          <Card className="overflow-hidden border-ink/10">
            <div className="space-y-6 bg-ink px-6 py-10 text-paper sm:px-10 sm:py-12">
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-paper/60">
                  El siguiente paso
                </p>
                <h2 className="max-w-2xl text-2xl font-semibold leading-snug tracking-tight sm:text-3xl">
                  {band === 'attack'
                    ? 'Tu caso merece 20 minutos de conversación, no un formulario.'
                    : recommended?.route === 'brand_content'
                      ? 'Antes de automatizar, hay que arreglar qué dices. Eso empieza con una conversación.'
                      : 'Conecta un canal, o carga tu base y empieza a tener leads mañana.'}
                </h2>
                <p className="max-w-xl text-[14.5px] leading-relaxed text-paper/70">
                  {recommended?.route === 'brand_content'
                    ? 'La ruta de marca no tiene botón de autoservicio, y es a propósito: el trabajo empieza entendiendo tu mercado, no configurando software.'
                    : `Tus tres agentes ya están instanciados con objetivo, presupuesto y permisos. Lo único que falta es tu permiso para que trabajen. Meta: ${formatNumber(assumptions.goal_customers_90d)} clientes nuevos en ${assumptions.weeks_available} semanas.`}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                {band === 'attack' || recommended?.route === 'brand_content' ? (
                  <>
                    <a
                      href={env.calcomUrl || `mailto:hola@holaamigo.co?subject=Diagnóstico de ${org?.name ?? org?.domain}`}
                      className="rounded-xl bg-paper px-6 py-3.5 text-[15px] font-semibold text-ink transition hover:bg-money-soft"
                    >
                      Agendar 20 minutos
                    </a>
                    <Link
                      href={`/conectar/${diagnostic.session_id}`}
                      className="rounded-xl border border-paper/25 px-6 py-3.5 text-[15px] font-semibold text-paper transition hover:bg-paper/10"
                    >
                      Prefiero arrancar solo
                    </Link>
                  </>
                ) : (
                  <>
                    <Link
                      href={`/conectar/${diagnostic.session_id}`}
                      className="rounded-xl bg-paper px-6 py-3.5 text-[15px] font-semibold text-ink transition hover:bg-money-soft"
                    >
                      Conectar mi canal
                    </Link>
                    <Link
                      href={`/leads/${diagnostic.organization_id}`}
                      className="rounded-xl border border-paper/25 px-6 py-3.5 text-[15px] font-semibold text-paper transition hover:bg-paper/10"
                    >
                      Cargar mi base primero
                    </Link>
                  </>
                )}
              </div>
            </div>
          </Card>
        </section>

        <p className="border-t border-line pt-8 text-[12px] leading-relaxed text-ink-faint">
          Este enlace es permanente. Guárdalo o compártelo con tu equipo. Los supuestos que
          cambies quedan guardados aquí.
        </p>
      </div>
    </main>
  );
}

type RouteKey = 'whatsapp' | 'email' | 'brand_content';

const ROUTE_LABEL: Record<RouteKey, string> = {
  whatsapp: 'Ruta A · WhatsApp',
  email: 'Ruta B · Correo',
  brand_content: 'Ruta C · Marca y contenido',
};

interface CompetitorRow {
  name: string;
  url: string | null;
  promise: string;
  positioning: string;
  publishes_pricing: boolean;
  you_win_on: string;
  you_lose_on: string;
  x: number;
  y: number;
}

interface RoadmapItem {
  milestone: string;
  eta_days: number;
  owner: string;
}
