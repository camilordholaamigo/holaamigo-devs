import Link from 'next/link';
import { pipeline, timeline, costoDeLaLinea } from '@/lib/crm/opportunities';
import { lotesDe } from '@/lib/integrations/batches';
import { resumenDeStaging } from '@/lib/integrations/hubspot';
import { SectionTitle, Card, Empty, Badge } from '@/components/ui';
import { formatMoney, formatNumber } from '@/lib/utils';

/**
 * El CRM.
 *
 * Dos vistas en una pantalla: el pipeline por etapa y —cuando se abre una
 * oportunidad— la línea de tiempo con actores intercalados.
 *
 * La línea de tiempo es lo único de esta pantalla que ningún otro CRM puede
 * pintar: cada paso dice si lo hizo un agente o una persona, qué decisión lo
 * originó y cuánto costó. "¿Cuánto nos costó perseguir a este?" se contesta
 * mirando, no exportando.
 *
 * Ver docs/wiki/20-integraciones-crm-y-habilidades.md
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'CRM · Hola Amigo', robots: { index: false } };

const ETAPA_LABEL: Record<string, string> = {
  nuevo: 'Nuevos',
  contactado: 'Contactados',
  interesado: 'Interesados',
  reunion: 'Con reunión',
  propuesta: 'Con propuesta',
  ganada: 'Ganadas',
  perdida: 'Perdidas',
};

const ACCION: Record<string, string> = {
  opportunity_created: 'abrió la oportunidad',
  angle_proposed: 'propuso el ángulo',
  email_sent: 'envió un correo',
  replied: 'respondió',
  qualified: 'calificó al contacto',
  booked: 'agendó la reunión',
  note: 'dejó una nota',
  stage_change: 'movió la etapa',
};

export default async function CrmPage({ params, searchParams }: PageProps<'/consola/[orgId]/crm'>) {
  const { orgId } = await params;
  const query = await searchParams;
  const abierta = typeof query.oportunidad === 'string' ? query.oportunidad : null;

  const [columnas, lotes, staging, linea] = await Promise.all([
    pipeline(orgId),
    lotesDe(orgId, 5),
    resumenDeStaging(orgId),
    abierta ? timeline({ opportunityId: abierta }) : Promise.resolve([]),
  ]);

  const conOportunidades = columnas.filter((c) => c.oportunidades.length > 0);
  const total = columnas
    .filter((c) => !['ganada', 'perdida'].includes(c.stage))
    .reduce((sum, c) => sum + c.valor_usd, 0);
  const ponderado = columnas
    .filter((c) => !['ganada', 'perdida'].includes(c.stage))
    .reduce((sum, c) => sum + c.valor_ponderado_usd, 0);

  const oportunidadAbierta = columnas
    .flatMap((c) => c.oportunidades)
    .find((o) => o.id === abierta);

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-6 py-12">
      <SectionTitle
        eyebrow="CRM"
        title="Tus oportunidades, y quién movió cada una"
        subtitle="Cada paso sabe si lo hizo un agente o una persona, qué decisión lo originó y cuánto costó. Eso es lo que ningún otro CRM te puede mostrar."
      />

      {/* ── Staging: lo que llegó y todavía no entra ────────────────────── */}
      {staging.total > 0 || lotes.length > 0 ? (
        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-[13px] font-semibold text-ink">
              {formatNumber(staging.total)} contactos importados esperando análisis
            </p>
            <p className="text-[12.5px] text-ink-faint">
              {formatNumber(staging.con_interaccion_reciente)} con interacción en los últimos 18 meses
            </p>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-faint">
            No entran a operación hasta que se analicen. Es a propósito: una base cruda que aparece
            como leads trabajables es la forma más rápida de escribirle a alguien a quien no debías.
          </p>
          {lotes.length > 0 ? (
            <ul className="space-y-1.5 border-t border-line pt-3">
              {lotes.map((lote) => (
                <li key={lote.id as string} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                  <Badge tone={lote.status === 'done' ? 'money' : 'muted'}>{String(lote.status)}</Badge>
                  <span className="text-ink-soft">
                    {formatNumber(Number(lote.contact_count))} contactos ·{' '}
                    {formatNumber(Number(lote.credits_quoted))} créditos
                  </span>
                  {lote.quote_reason ? (
                    <span className="text-[12px] text-ink-faint">{String(lote.quote_reason)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {/* ── Pipeline ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Pipeline abierto
          </h2>
          <p className="tnum text-[13px] text-ink-soft">
            {formatMoney(total)} en total ·{' '}
            <span className="text-money">{formatMoney(ponderado)} ponderado</span>
          </p>
        </div>

        {conOportunidades.length === 0 ? (
          <Empty
            title="Todavía no hay oportunidades"
            hint="Se abren solas cuando alguien contesta con interés. Cada una queda enganchada a la decisión de agente que la originó."
          />
        ) : (
          <div className="space-y-4">
            {conOportunidades.map((columna) => (
              <div key={columna.stage} className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[13px] font-semibold text-ink">
                    {ETAPA_LABEL[columna.stage] ?? columna.stage}
                  </h3>
                  <p className="tnum text-[12.5px] text-ink-faint">
                    {columna.oportunidades.length} · {formatMoney(columna.valor_usd)}
                  </p>
                </div>
                <ul className="space-y-1.5">
                  {columna.oportunidades.map((op) => (
                    <li key={op.id}>
                      <Link
                        href={`/consola/${orgId}/crm?oportunidad=${op.id}`}
                        className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-paper-raised px-4 py-2.5 transition hover:border-ink"
                      >
                        <span className="text-[13.5px] font-medium text-ink">{op.name}</span>
                        <span className="text-[12px] text-ink-faint">
                          {op.owner_type === 'agent' ? `agente · ${op.owner_ref}` : op.owner_ref}
                        </span>
                        <span className="tnum ml-auto text-[13px] text-ink-soft">
                          {op.value_usd === null ? '—' : formatMoney(Number(op.value_usd))}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── La línea de tiempo ──────────────────────────────────────────── */}
      {oportunidadAbierta ? (
        <section className="space-y-4 border-t border-line pt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">{oportunidadAbierta.name}</h2>
            <p className="tnum text-[13px] text-ink-faint">
              costó {formatMoney(costoDeLaLinea(linea))} en {linea.length} pasos
            </p>
          </div>

          {linea.length === 0 ? (
            <Empty title="Sin toques registrados todavía" />
          ) : (
            <ol className="space-y-3">
              {linea.map((paso) => (
                <li key={paso.id} className="flex gap-3">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      paso.actor_type === 'human' ? 'bg-money' : 'bg-line-strong'
                    }`}
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-[13.5px] text-ink">
                      <span
                        className={`font-semibold ${
                          paso.actor_type === 'human' ? 'text-money' : 'text-ink'
                        }`}
                      >
                        {paso.actor_ref}
                      </span>{' '}
                      {ACCION[paso.action] ?? paso.action}
                    </p>
                    {paso.decision_question ? (
                      <p className="text-[12px] text-ink-faint">
                        por la decisión: {paso.decision_question}
                      </p>
                    ) : null}
                    <p className="text-[12px] text-ink-faint">
                      {new Date(paso.occurred_at).toLocaleString('es-CO', {
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                      {paso.costo_usd ? ` · ${formatMoney(Number(paso.costo_usd))}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <Link
            href={`/consola/${orgId}/crm`}
            className="inline-block text-[13px] text-ink-faint underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            cerrar
          </Link>
        </section>
      ) : null}
    </main>
  );
}
