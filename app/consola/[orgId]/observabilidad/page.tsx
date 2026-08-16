import { SectionTitle, Empty, Card, Stat, Badge } from '@/components/ui';
import { observabilityFor } from '@/lib/observability/summary';
import { creditsToUsd } from '@/config/credits';
import { formatMoney, formatNumber } from '@/lib/utils';

/**
 * Los números.
 *
 * Cuatro bloques y cuatro preguntas, en este orden:
 *   1. ¿Qué va a pasar y por qué?
 *   2. ¿Se está pareciendo a lo que dijimos?
 *   3. ¿Algo se está rompiendo?
 *   4. ¿En qué se está yendo la plata?
 *
 * Lo que NO hay: aperturas por hora, mapas de calor, gráficas de tendencia. Una
 * métrica que no cambia una decisión es ruido, y el ruido acá tiene un costo
 * concreto: el operador deja de mirar la pantalla.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Números · Hola Amigo', robots: { index: false } };

export default async function ObservabilidadPage({
  params,
}: PageProps<'/consola/[orgId]/observabilidad'>) {
  const { orgId } = await params;
  const { scheduled, campaigns, health, spend } = await observabilityFor(orgId);

  return (
    <main className="mx-auto max-w-4xl space-y-14 px-6 py-12">
      {/* ── 1 · Qué va a pasar ───────────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Programado"
          title="Qué va a pasar y por qué"
          subtitle="Cada cosa agendada dice para qué existe y con qué métrica se va a juzgar. Si algo no tiene las dos, no debería estar programado."
        />
        {scheduled.length === 0 ? (
          <Empty title="Nada programado" hint="Aparece acá apenas apruebes una campaña." />
        ) : (
          <ul className="space-y-2">
            {scheduled.map((action) => (
              <Card as="li" key={action.id} className="space-y-1 p-4">
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="text-[13.5px] font-medium text-ink">{action.title}</span>
                  <span className="tnum ml-auto text-[12.5px] text-ink-faint">
                    {new Date(action.run_at).toLocaleString('es-CO', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="text-[12.5px] leading-snug text-ink-soft">Por qué: {action.why}</p>
                <p className="text-[12.5px] leading-snug text-ink-faint">
                  Cómo se mide: {action.how_measured}
                </p>
              </Card>
            ))}
          </ul>
        )}
      </section>

      {/* ── 2 · Esperado vs real ─────────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Campañas"
          title="Lo que dijimos contra lo que pasó"
          subtitle="La diferencia entre estas dos columnas es lo que dispara cada iteración."
        />
        {campaigns.length === 0 ? (
          <Empty title="Sin campañas corriendo" />
        ) : (
          <div className="space-y-3">
            {campaigns.map((campaign) => {
              const gap = campaign.reply_rate_actual - campaign.reply_rate_expected;
              const started = campaign.actual.sent > 0;
              return (
                <Card key={campaign.id} className="space-y-3 p-5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[14px] font-semibold text-ink">{campaign.name}</span>
                    <Badge tone={campaign.status === 'active' ? 'money' : 'muted'}>
                      {campaign.status}
                    </Badge>
                    {campaign.next_checkpoint ? (
                      <span className="ml-auto text-[12px] text-ink-faint">
                        próxima revisión: {campaign.next_checkpoint.kpi} el{' '}
                        {campaign.next_checkpoint.date}
                      </span>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
                    <Stat label="Enviados" value={formatNumber(campaign.actual.sent)} />
                    <Stat label="Entregados" value={formatNumber(campaign.actual.delivered)} />
                    <Stat
                      label="Respuestas"
                      value={`${formatNumber(campaign.actual.replied)} / ${formatNumber(campaign.expected.replies)}`}
                      hint="real / esperado"
                    />
                    <Stat
                      label="Citas"
                      value={`${formatNumber(campaign.actual.booked)} / ${formatNumber(campaign.expected.bookings)}`}
                      hint="real / esperado"
                      tone="money"
                    />
                    <Stat
                      label="Tasa de respuesta"
                      value={started ? `${campaign.reply_rate_actual}%` : '—'}
                      hint={`esperada ${campaign.reply_rate_expected}%`}
                      tone={started && gap < -1 ? 'leak' : 'neutral'}
                    />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 3 · Qué se puede estar rompiendo ─────────────────────────────── */}
      <section className="space-y-6">
        <SectionTitle eyebrow="Salud" title="Qué se puede estar rompiendo" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <Stat
              label="Conversaciones esperándote"
              value={formatNumber(health.threads_waiting)}
              tone={health.threads_waiting > 0 ? 'leak' : 'neutral'}
            />
          </Card>
          <Card className="p-5">
            <Stat
              label="Corridas fallidas · 7 días"
              value={formatNumber(health.agent_failures_7d)}
              tone={health.agent_failures_7d > 0 ? 'leak' : 'neutral'}
            />
          </Card>
          <Card className="p-5">
            <Stat
              label="Corridas degradadas · 7 días"
              value={formatNumber(health.degraded_runs_7d)}
              hint="Salidas que el modelo no logró al primer intento"
            />
          </Card>
        </div>

        {health.mailboxes.length > 0 ? (
          <Card className="space-y-2 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Bandejas
            </p>
            <ul className="space-y-1">
              {health.mailboxes.map((mailbox) => (
                <li key={mailbox.address} className="tnum text-[12.5px] text-ink-soft">
                  {mailbox.address} · {mailbox.status} · hoy {mailbox.used_today}/{mailbox.cap_today}{' '}
                  · rebotes {(mailbox.bounce_rate * 100).toFixed(1)}% · quejas{' '}
                  {(mailbox.complaint_rate * 100).toFixed(2)}%
                </li>
              ))}
            </ul>
            <p className="text-[12px] leading-snug text-ink-faint">
              Un buzón se pausa solo por encima de 5% de rebotes o 0,3% de quejas. El umbral de
              quejas parece absurdamente bajo y no lo es: Gmail empieza a filtrar justo ahí.
            </p>
          </Card>
        ) : null}
      </section>

      {/* ── 4 · La plata ─────────────────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionTitle eyebrow="Consumo" title="En qué se está yendo" />
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-5">
            <Stat
              label="Créditos"
              value={formatNumber(spend.credits_balance)}
              hint={`≈ ${formatMoney(creditsToUsd(spend.credits_balance))}`}
              tone={spend.credits_balance <= 0 ? 'leak' : 'neutral'}
            />
          </Card>
          <Card className="p-5">
            <Stat
              label="Costo de IA · 30 días"
              value={formatMoney(spend.ai_cost_usd_30d)}
              hint="Lo que nos cuesta a nosotros correr los agentes"
            />
          </Card>
          <Card className="p-5">
            <Stat
              label="Ventas atribuidas"
              value={formatMoney(spend.attributed.revenue_usd)}
              tone="money"
              hint={`${spend.attributed.paid} órdenes pagadas`}
            />
          </Card>
          <Card className="p-5">
            <Stat label="Fee generado" value={formatMoney(spend.attributed.fee_usd)} />
          </Card>
        </div>

        {spend.by_kind.length > 0 ? (
          <Card className="space-y-1.5 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Créditos gastados · 30 días
            </p>
            <ul className="space-y-1">
              {spend.by_kind.map((row) => (
                <li key={row.kind} className="flex items-baseline justify-between gap-3">
                  <span className="text-[12.5px] text-ink-soft">{KIND_LABEL[row.kind] ?? row.kind}</span>
                  <span className="tnum text-[13px] font-medium text-ink">
                    {formatNumber(row.credits)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </section>
    </main>
  );
}

const KIND_LABEL: Record<string, string> = {
  email_send: 'Correos enviados',
  email_reply: 'Respuestas',
  whatsapp_conversation: 'Conversaciones de WhatsApp',
  ai_research: 'Investigación',
  ai_diagnosis: 'Diagnóstico',
  ai_campaign_plan: 'Planes de campaña',
  ai_classify: 'Clasificación de respuestas',
};
