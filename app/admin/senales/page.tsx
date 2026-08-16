import { senalesParaAdmin } from '@/lib/cmo/upsell';
import { SectionTitle, Card, Badge, Empty } from '@/components/ui';
import { SignalActions } from '@/components/signal-actions';
import { formatMoney } from '@/lib/utils';

/**
 * Las señales de upsell, en NUESTRO admin.
 *
 * Esta pantalla es la disciplina de P5 hecha interfaz. La CMO detecta
 * restricciones en la cuenta del cliente —responden y no cierran, el copy se
 * alejó de la marca, la base es más grande que la capacidad— y las deja acá.
 * **Ninguna llega al cliente sin que alguien nuestro la mire.**
 *
 * No es prudencia excesiva: un agente que le ofrece servicios al cliente sin
 * filtro destruye la confianza que hace que el resto del producto funcione. Y
 * esa confianza es lo único que no se puede reconstruir con una migración.
 *
 * La escalera se ve en la pantalla porque se ve en la base: el salto a
 * `proposed_client` está protegido por un `check` constraint.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Señales · Admin', robots: { index: false } };

const RESTRICCION: Record<string, string> = {
  volume: 'Volumen',
  conversion: 'Conversión',
  brand: 'Marca',
  proof: 'Prueba',
  positioning: 'Posicionamiento',
  capacity: 'Capacidad',
  operation: 'Operación',
};

const SERVICIO: Record<string, string> = {
  agency_brand: 'Agencia · marca',
  agency_content: 'Agencia · contenido',
  agency_reposition: 'Agencia · reposicionamiento',
  media_play: 'Media play',
  fdo: 'Operador dedicado',
  credits: 'Créditos',
};

const ESTADO: Record<string, { label: string; tone: 'neutral' | 'money' | 'leak' | 'muted' }> = {
  detected: { label: 'Detectada', tone: 'muted' },
  proposed_internal: { label: 'Revisada por nosotros', tone: 'neutral' },
  proposed_client: { label: 'Ofrecida al cliente', tone: 'money' },
  won: { label: 'Vendida', tone: 'money' },
  lost: { label: 'Perdida', tone: 'leak' },
  dismissed: { label: 'Descartada', tone: 'muted' },
};

export default async function SenalesPage() {
  const senales = await senalesParaAdmin({ limit: 100 });

  const vivas = senales.filter((s) =>
    ['detected', 'proposed_internal', 'proposed_client'].includes(s.status as string),
  );
  const cerradas = senales.filter((s) => !vivas.includes(s));

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-6 py-10">
      <SectionTitle
        eyebrow="Señales de upsell"
        title="Lo que la CMO detectó y todavía no sabe el cliente"
        subtitle="Cada señal es una restricción medida en la cuenta, con su evidencia. Nada de esto llega al cliente hasta que alguien de acá lo apruebe — y eso no es una costumbre, es un check en la base."
      />

      {vivas.length === 0 ? (
        <Empty
          title="Nada detectado"
          hint="La CMO revisa las cuentas los lunes. Si una cuenta no tiene restricciones medibles, no inventa una señal."
        />
      ) : (
        <ul className="space-y-3">
          {vivas.map((senal) => {
            const org = senal.organizations as { name: string | null; domain: string | null } | null;
            const estado = ESTADO[senal.status as string] ?? ESTADO.detected;
            const evidencia = Object.entries((senal.evidence ?? {}) as Record<string, unknown>).filter(
              ([, v]) => typeof v !== 'object',
            );

            return (
              <Card as="li" key={senal.id} className="space-y-3 p-5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge tone={estado.tone}>{estado.label}</Badge>
                  <span className="text-[13px] font-semibold text-ink">
                    {org?.name ?? org?.domain ?? 'organización'}
                  </span>
                  <span className="text-[12px] text-ink-faint">
                    {RESTRICCION[senal.constraint_type as string] ?? senal.constraint_type} ·{' '}
                    {SERVICIO[senal.proposed_service as string] ?? senal.proposed_service}
                  </span>
                  <span className="ml-auto tnum text-[13px] font-semibold text-money">
                    {senal.estimated_value_usd ? formatMoney(Number(senal.estimated_value_usd)) : '—'}
                  </span>
                </div>

                <p className="text-[14px] leading-relaxed text-ink-soft">{senal.signal as string}</p>

                {evidencia.length > 0 ? (
                  <dl className="grid gap-x-6 gap-y-1 border-t border-line pt-3 sm:grid-cols-3">
                    {evidencia.map(([clave, valor]) => (
                      <div key={clave} className="flex items-baseline justify-between gap-2">
                        <dt className="text-[12px] text-ink-faint">{clave.replace(/_/g, ' ')}</dt>
                        <dd className="tnum text-[12.5px] text-ink">{String(valor)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {senal.internal_note ? (
                  <p className="text-[12.5px] text-ink-faint">
                    Nota interna: {senal.internal_note as string}
                    {senal.internal_approved_by ? ` — ${senal.internal_approved_by as string}` : ''}
                  </p>
                ) : null}

                <div className="border-t border-line pt-3">
                  <SignalActions signalId={senal.id as string} status={senal.status as string} />
                </div>
              </Card>
            );
          })}
        </ul>
      )}

      {cerradas.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Cerradas
          </h2>
          <ul className="space-y-1.5">
            {cerradas.map((senal) => (
              <li key={senal.id} className="text-[13px] text-ink-faint">
                {ESTADO[senal.status as string]?.label ?? senal.status} · {senal.signal as string}
                {senal.internal_note ? ` — ${senal.internal_note as string}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
