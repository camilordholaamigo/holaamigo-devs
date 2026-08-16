import { pedidosPendientes, catalogoDeHabilidades } from '@/lib/skills/registry';
import { SectionTitle, Card, Badge, Empty } from '@/components/ui';
import { SkillRequestActions } from '@/components/skill-request-actions';

/**
 * El "intraer", en pantalla.
 *
 * Los agentes empujan capacidades hacia sí mismos: cuando uno se topa con un
 * muro, deja constancia de qué necesitaba y **de qué decisión quedó bloqueada**.
 * Esa segunda parte es la que hace la tarjeta útil — un pedido sin la decisión
 * que frenó es una lista de deseos; con ella es evidencia de producto.
 *
 * Ese loop es lo que hace que el sistema crezca solo, y también lo que hace que
 * no crezca solo del todo: los agentes piden, nosotros decidimos cuáles
 * existen.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Habilidades · Admin', robots: { index: false } };

const RIESGO: Record<string, { label: string; tone: 'neutral' | 'money' | 'leak' | 'muted' }> = {
  read: { label: 'lectura', tone: 'muted' },
  write: { label: 'escritura', tone: 'muted' },
  external_comms: { label: 'habla con terceros', tone: 'neutral' },
  spend: { label: 'gasta plata', tone: 'leak' },
  irreversible: { label: 'irreversible', tone: 'leak' },
};

export default async function HabilidadesPage() {
  const [pedidos, catalogo] = await Promise.all([pedidosPendientes(), catalogoDeHabilidades()]);

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-6 py-10">
      <SectionTitle
        eyebrow="Habilidades"
        title="Lo que los agentes piden, y lo que pueden usar"
        subtitle="Cuando un agente se topa con un muro deja su pedido con la decisión que quedó bloqueada. Nosotros decidimos qué herramientas existen."
      />

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Pedidos pendientes
        </h2>

        {pedidos.length === 0 ? (
          <Empty
            title="Ningún agente pidió nada"
            hint="Es una buena señal o una mala: o tienen lo que necesitan, o no están intentando lo suficiente."
          />
        ) : (
          <ul className="space-y-3">
            {pedidos.map((pedido) => {
              const org = pedido.organizations as { name: string | null; domain: string | null } | null;
              const decision = pedido.decisions as { question: string; kind: string } | null;

              return (
                <Card as="li" key={pedido.id as string} className="space-y-3 p-5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Badge tone="neutral">{String(pedido.agent_role ?? 'agente')}</Badge>
                    <span className="text-[13px] font-semibold text-ink">
                      {org?.name ?? org?.domain ?? 'organización'}
                    </span>
                    <span className="text-[12.5px] text-ink-faint">
                      pide {String(pedido.skill_id ?? pedido.requested_capability)}
                    </span>
                  </div>

                  <p className="text-[14px] leading-relaxed text-ink-soft">
                    {String(pedido.justification)}
                  </p>

                  {decision ? (
                    <p className="border-l-2 border-line-strong pl-3 text-[13px] text-ink-faint">
                      Quedó bloqueada esta decisión: <span className="text-ink">{decision.question}</span>
                    </p>
                  ) : (
                    <p className="text-[12.5px] text-ink-faint">
                      Sin decisión bloqueada enlazada — vale menos: no sabemos qué se dejó de hacer.
                    </p>
                  )}

                  <div className="border-t border-line pt-3">
                    <SkillRequestActions
                      requestId={pedido.id as string}
                      skillId={(pedido.skill_id as string | null) ?? null}
                      organizationId={(pedido.organization_id as string | null) ?? null}
                      role={String(pedido.agent_role ?? 'sales')}
                    />
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          El catálogo
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {['Habilidad', 'Proveedor', 'Riesgo', 'Nivel mínimo', 'Plan', 'Estado'].map((h) => (
                  <th
                    key={h}
                    className="py-2 pr-4 text-[11px] font-semibold uppercase tracking-wider text-ink-faint"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catalogo.map((skill) => {
                const riesgo = RIESGO[skill.risk_class as string] ?? RIESGO.read;
                return (
                  <tr key={skill.id as string} className="border-b border-line">
                    <td className="py-2 pr-4 text-ink">
                      {String(skill.display_name)}
                      <span className="block text-[11.5px] text-ink-faint">{String(skill.id)}</span>
                    </td>
                    <td className="py-2 pr-4 text-ink-soft">{String(skill.provider)}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={riesgo.tone}>{riesgo.label}</Badge>
                    </td>
                    <td className="tnum py-2 pr-4 text-ink-soft">L{String(skill.min_grant_level)}</td>
                    <td className="py-2 pr-4 text-ink-soft">{String(skill.min_plan)}</td>
                    <td className="py-2 pr-4 text-ink-faint">{String(skill.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          Las de clase <strong>gasta plata</strong> e <strong>irreversible</strong> no se pueden
          encender desde acá: exigen un operador y un sobre con límites, y eso lo hace cumplir un
          trigger en la base. Sin tope no es un permiso, es una firma en blanco.
        </p>
      </section>
    </main>
  );
}
