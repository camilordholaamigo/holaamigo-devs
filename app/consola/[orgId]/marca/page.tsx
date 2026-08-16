import { currentPositioning, auditarCopyActivo } from '@/lib/cmo/positioning';
import { evaluarSaturacion, anglesFor } from '@/lib/cmo/angles';
import { cambiosRecientes } from '@/lib/cmo/competitors';
import { casosDe } from '@/lib/cmo/proof';
import { senalesDelCliente } from '@/lib/cmo/upsell';
import { SectionTitle, Card, Empty, Badge } from '@/components/ui';

/**
 * La pantalla de la CMO.
 *
 * Cinco bloques, y el orden es el de una conversación real sobre la marca:
 * qué decimos ser → qué está saliendo (y si se aleja) → qué está funcionando →
 * qué hizo la competencia → qué prueba tenemos.
 *
 * Lo que NO está acá: las señales de upsell. Esas viven en nuestro admin hasta
 * que un humano nuestro las aprueba, y solo entonces aparecen — al final, sin
 * énfasis, con la evidencia visible. Un producto que le vende al cliente desde
 * su propia pantalla de trabajo deja de ser su herramienta.
 *
 * Ver docs/wiki/19-la-cmo-expandida.md
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marca · Hola Amigo', robots: { index: false } };

export default async function MarcaPage({ params }: PageProps<'/consola/[orgId]/marca'>) {
  const { orgId } = await params;

  const [posicionamiento, deriva, saturacion, angulos, cambios, casos, ofertas] = await Promise.all([
    currentPositioning(orgId),
    auditarCopyActivo(orgId),
    evaluarSaturacion(orgId),
    anglesFor(orgId, 20),
    cambiosRecientes(orgId, 8),
    casosDe(orgId, 8),
    senalesDelCliente(orgId),
  ]);

  const activos = angulos.filter((a) => ['proposed', 'approved'].includes(a.status as string));
  const porId = new Map(saturacion.map((s) => [s.angle_id, s]));

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12">
      <SectionTitle
        eyebrow="Marca"
        title="Qué decís ser, y qué estás diciendo"
        subtitle="La CMO mantiene el posicionamiento como un documento vivo y compara contra él lo que sale de verdad. Cuando se alejan, avisa."
      />

      {/* ── Posicionamiento ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          El posicionamiento vigente
        </h2>
        {posicionamiento ? (
          <Card className="space-y-4 p-6">
            <p className="prosa text-[16px] leading-relaxed text-ink">{posicionamiento.statement}</p>
            <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Lo que sí decimos
                </p>
                <ul className="mt-1.5 space-y-1">
                  {posicionamiento.differentiators.map((d) => (
                    <li key={d} className="text-[13.5px] text-ink-soft">
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Lo que nunca decimos
                </p>
                <ul className="mt-1.5 space-y-1">
                  {posicionamiento.forbidden_claims.map((d) => (
                    <li key={d} className="text-[13.5px] text-ink-soft">
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="text-[12px] text-ink-faint">
              Versión {posicionamiento.version} · escrita por {posicionamiento.created_by}
            </p>
          </Card>
        ) : (
          <Empty
            title="Todavía no hay posicionamiento declarado"
            hint="Sin él no se puede medir si el copy se aleja: la CMO no tiene contra qué comparar."
          />
        )}
      </section>

      {/* ── Deriva ──────────────────────────────────────────────────────── */}
      {deriva.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            El copy se está alejando
          </h2>
          <ul className="space-y-2">
            {deriva.map((hallazgo) => (
              <Card as="li" key={`${hallazgo.campaign_id}-${hallazgo.paso}`} className="space-y-2 p-5">
                <p className="text-[13px] font-semibold text-ink">
                  {hallazgo.campaign} · paso {hallazgo.paso}
                </p>
                {hallazgo.viola.length > 0 ? (
                  <p className="text-[13px] text-leak">
                    Usa {hallazgo.viola.map((v) => `«${v}»`).join(', ')}, que está en la lista de lo
                    que la marca nunca dice.
                  </p>
                ) : (
                  <p className="text-[13px] text-ink-soft">
                    No menciona ninguno de tus diferenciadores
                    {hallazgo.cobertura !== null
                      ? ` (cobertura ${Math.round(hallazgo.cobertura * 100)}%)`
                      : ''}
                    .
                  </p>
                )}
                <p className="text-[12.5px] italic text-ink-faint">“{hallazgo.extracto}…”</p>
              </Card>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── Ángulos ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Los ángulos y cómo van
        </h2>
        {activos.length === 0 ? (
          <Empty title="Sin ángulos activos" />
        ) : (
          <ul className="space-y-2">
            {activos.map((angulo) => {
              const stats = porId.get(angulo.id as string);
              return (
                <Card as="li" key={angulo.id as string} className="space-y-1.5 p-5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[14px] font-semibold text-ink">{angulo.name as string}</span>
                    {stats?.saturado ? <Badge tone="leak">Se quemó</Badge> : null}
                    {angulo.status === 'proposed' ? <Badge tone="muted">Esperando tu visto bueno</Badge> : null}
                    {stats ? (
                      <span className="ml-auto tnum text-[12.5px] text-ink-faint">
                        {pct(stats.tasa_previa)} → {pct(stats.tasa_reciente)} · {stats.enviados_recientes} envíos
                      </span>
                    ) : (
                      <span className="ml-auto text-[12px] text-ink-faint">sin envíos todavía</span>
                    )}
                  </div>
                  {angulo.hypothesis ? (
                    <p className="text-[13px] text-ink-soft">{angulo.hypothesis as string}</p>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Competencia ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Lo que movió la competencia
        </h2>
        {cambios.length === 0 ? (
          <Empty
            title="Nada cambió"
            hint="La CMO revisa los sitios de tus competidores cada lunes. Si no cambió nada, no te escribe."
          />
        ) : (
          <ul className="space-y-2">
            {cambios.map((cambio) => (
              <Card as="li" key={cambio.id as string} className="space-y-1.5 p-5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[14px] font-semibold text-ink">{cambio.competitor as string}</span>
                  <span className="text-[12px] text-ink-faint">{cambio.section as string}</span>
                  <span className="ml-auto text-[12px] text-ink-faint">
                    {new Date(cambio.detected_at as string).toLocaleDateString('es-CO', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </div>
                <p className="text-[13.5px] leading-relaxed text-ink-soft">
                  {cambio.why_it_matters as string}
                </p>
              </Card>
            ))}
          </ul>
        )}
      </section>

      {/* ── Prueba social ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Tu prueba social
        </h2>
        {casos.length === 0 ? (
          <Empty
            title="Todavía no hay casos"
            hint="Cuando cierres un negocio grande, la CMO redacta el caso con los números reales y te pide una sola cosa: permiso de tu cliente para publicarlo."
          />
        ) : (
          <ul className="space-y-2">
            {casos.map((caso) => (
              <Card as="li" key={caso.id as string} className="space-y-1 p-5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[14px] font-semibold text-ink">
                    {(caso.draft as { titulo?: string })?.titulo ?? 'Borrador en camino'}
                  </span>
                  <Badge tone={caso.status === 'approved' || caso.status === 'published' ? 'money' : 'muted'}>
                    {estadoDeCaso(caso.status as string)}
                  </Badge>
                </div>
                <p className="text-[13px] text-ink-soft">
                  {(caso.draft as { resultado?: string })?.resultado ?? ''}
                </p>
              </Card>
            ))}
          </ul>
        )}
      </section>

      {/* ── Lo que ofrecemos, si un humano nuestro lo aprobó ────────────── */}
      {ofertas.length > 0 ? (
        <section className="space-y-3 border-t border-line pt-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Algo que vimos y podríamos ayudarte a resolver
          </h2>
          {ofertas.map((oferta) => (
            <Card as="div" key={oferta.id as string} className="space-y-2 p-5">
              <p className="text-[14px] text-ink">{oferta.signal as string}</p>
              <p className="text-[12.5px] text-ink-faint">
                Lo detectamos mirando tus números, y lo revisó alguien de nuestro equipo antes de
                mostrártelo. Si no te interesa, decinos y no volvemos a proponerlo.
              </p>
            </Card>
          ))}
        </section>
      ) : null}
    </main>
  );
}

function pct(valor: number | null): string {
  if (valor === null || valor === undefined) return '—';
  return `${Math.round(Number(valor) * 1000) / 10}%`;
}

function estadoDeCaso(status: string): string {
  const nombres: Record<string, string> = {
    detected: 'Detectado',
    drafted: 'Borrador listo',
    awaiting_client: 'Esperando a tu cliente',
    approved: 'Aprobado',
    published: 'Publicado',
    rejected: 'Descartado',
  };
  return nombres[status] ?? status;
}
