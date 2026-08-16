import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { balance } from '@/lib/credits';
import { openCount } from '@/lib/feed/items';
import { openDeliberations } from '@/lib/deliberation/room';
import { formatNumber } from '@/lib/utils';

/**
 * La consola del cliente.
 *
 * Siete pestañas y ni una más. El orden no es alfabético ni por importancia
 * técnica: es el orden en el que alguien que abre esto a las 8 de la mañana
 * necesita las cosas. Primero qué hay que decidir (feed), después qué está
 * corriendo (campañas), después quién contestó (bandeja).
 *
 * La observabilidad va al final a propósito. Es consulta, no trabajo — el
 * mismo principio §13.6 por el que la cola de decisiones va primero y los
 * gráficos van últimos.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

const NAV = [
  { segment: '', label: 'Feed' },
  // La Sala va segunda y no al final aunque sea lectura: es lo que explica lo
  // que aparece en el feed. Un cliente que no entiende de dónde salió una
  // propuesta no la aprueba, y la respuesta está a un clic de distancia.
  { segment: 'sala', label: 'La Sala' },
  { segment: 'campanas', label: 'Campañas' },
  { segment: 'marca', label: 'Marca' },
  { segment: 'crm', label: 'CRM' },
  { segment: 'bandeja', label: 'Bandeja' },
  { segment: 'agenda', label: 'Agenda' },
  { segment: 'activos', label: 'Activos' },
  { segment: 'agentes', label: 'Agentes' },
  { segment: 'observabilidad', label: 'Números' },
  { segment: 'libro', label: 'Libro' },
];

export default async function ConsolaLayout({
  children,
  params,
}: LayoutProps<'/consola/[orgId]'>) {
  const { orgId } = await params;

  const { data: org } = await db()
    .from('organizations')
    .select('id, name, domain')
    .eq('id', orgId)
    .maybeSingle();

  if (!org) notFound();

  const [credits, pending, discusiones, { count: waiting }] = await Promise.all([
    balance(orgId),
    openCount(orgId),
    openDeliberations(orgId),
    db()
      .from('email_threads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('needs_human', true),
  ]);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
          <Link href={`/consola/${orgId}`} className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            <span className="text-[13px] font-semibold tracking-tight text-ink">
              {org.name ?? org.domain}
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-5">
            {NAV.map((item) => {
              const href = item.segment ? `/consola/${orgId}/${item.segment}` : `/consola/${orgId}`;
              const badge =
                item.segment === ''
                  ? pending
                  : item.segment === 'sala'
                    ? discusiones
                    : item.segment === 'bandeja'
                      ? (waiting ?? 0)
                      : 0;
              return (
                <Link
                  key={item.label}
                  href={href}
                  className="text-[13.5px] font-medium text-ink-soft transition hover:text-ink"
                >
                  {item.label}
                  {badge > 0 ? (
                    <span className="tnum ml-1.5 rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-paper">
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Créditos
            </span>
            <span
              className={`tnum text-[14px] font-semibold ${credits <= 0 ? 'text-leak' : 'text-ink'}`}
            >
              {formatNumber(credits)}
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1">{children}</div>
    </div>
  );
}
