import { db } from '@/lib/supabase/admin';
import { SectionTitle, Empty, Card, Badge } from '@/components/ui';
import { AgentConfigForm, type AgentView } from '@/components/agent-config-form';
import { MailboxForm } from '@/components/mailbox-form';
import { InstantlyPanel } from '@/components/instantly-panel';
import { SetterPanel } from '@/components/setter-panel';
import { mailboxCapacity } from '@/lib/observability/summary';
import { listLeadLists, instantlyStatus } from '@/lib/integrations/instantly';
import { formatNumber } from '@/lib/utils';

/**
 * Agentes, bandejas e integraciones: todo lo configurable, en una pantalla.
 *
 * Están juntos porque son la misma decisión desde tres ángulos: cuánto puede
 * hacer el sistema solo, desde dónde lo hace, y con qué datos. Separarlos en
 * tres pestañas obligaría a saltar entre ellas para responder una sola
 * pregunta: "¿por qué no está saliendo nada?".
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agentes · Hola Amigo', robots: { index: false } };

export default async function AgentesPage({ params }: PageProps<'/consola/[orgId]/agentes'>) {
  const { orgId } = await params;

  const [{ data: agents }, mailboxes, integration] = await Promise.all([
    db()
      .from('agents')
      .select('role, status, autonomy, config, permissions, objective')
      .eq('organization_id', orgId)
      .order('role'),
    mailboxCapacity(orgId),
    instantlyStatus(orgId),
  ]);

  const connected = integration?.status === 'connected';
  const lists = connected ? await listLeadLists(orgId) : [];

  // El orden importa: primero quién decide, después quién ejecuta.
  const order: AgentView['role'][] = ['president', 'cmo', 'sales'];
  const sorted = ((agents ?? []) as unknown as AgentView[]).sort(
    (a, b) => order.indexOf(a.role) - order.indexOf(b.role),
  );

  return (
    <main className="mx-auto max-w-3xl space-y-14 px-6 py-12">
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Tu equipo"
          title="Los tres agentes"
          subtitle="Puedes ajustar cómo trabajan. No puedes ajustar lo que tienen prohibido: eso es contrato, y está impreso en cada tarjeta."
        />
        {sorted.length === 0 ? (
          <Empty
            title="Todavía no tienes agentes"
            hint="Se instancian solos cuando se genera tu diagnóstico."
          />
        ) : (
          <div className="space-y-4">
            {sorted.map((agent) => (
              <AgentConfigForm key={agent.role} agent={agent} orgId={orgId} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-6">
        <SectionTitle
          eyebrow="WhatsApp"
          title="Tu agente de agendamiento"
          subtitle="El guion con el que sale a conversar, dónde se caen las conversaciones, y la instrucción textual que lee antes de cada mensaje."
        />
        <SetterPanel orgId={orgId} />
      </section>

      <section className="space-y-6">
        <SectionTitle
          eyebrow="Correo"
          title="Tus bandejas"
          subtitle="Desde cuáles direcciones se envía y a cuáles llegan las respuestas. Repartir el volumen entre varias es lo que evita que se queme un dominio."
        />

        <MailboxForm orgId={orgId} />

        {mailboxes.length === 0 ? (
          <Empty
            title="Sin bandejas configuradas"
            hint="Sin al menos una, ninguna campaña puede arrancar."
          />
        ) : (
          <ul className="space-y-2">
            {mailboxes.map((mailbox) => (
              <Card as="li" key={mailbox.id} className="space-y-1.5 p-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[13.5px] font-medium text-ink">{mailbox.address}</span>
                  <Badge
                    tone={
                      mailbox.status === 'active'
                        ? 'money'
                        : mailbox.status === 'blocked' || mailbox.status === 'paused'
                          ? 'leak'
                          : 'muted'
                    }
                  >
                    {STATUS_LABEL[mailbox.status] ?? mailbox.status}
                  </Badge>
                </div>
                <p className="tnum text-[12.5px] text-ink-faint">
                  hoy {formatNumber(mailbox.sent_today)} de {formatNumber(mailbox.cap_today)} ·{' '}
                  quedan {formatNumber(mailbox.remaining_today)} · rebotes{' '}
                  {(Number(mailbox.bounce_rate) * 100).toFixed(1)}%
                </p>
                {mailbox.inbound_address ? (
                  <p className="text-[12px] text-ink-faint">
                    las respuestas llegan a{' '}
                    <code className="rounded bg-paper-sunken px-1.5 py-0.5">
                      {mailbox.inbound_address}
                    </code>
                  </p>
                ) : null}
              </Card>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-6">
        <SectionTitle
          eyebrow="Datos"
          title="De dónde salen los contactos"
          subtitle="Tu base propia se carga por archivo. Para prospección en frío conectamos tu cuenta de Instantly y traemos las listas."
        />
        <InstantlyPanel
          orgId={orgId}
          connected={connected}
          lists={lists}
          lastSync={integration?.last_sync_at ?? null}
          lastError={integration?.last_error ?? null}
        />
      </section>
    </main>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Esperando verificación',
  warming: 'Calentando',
  active: 'Activa',
  paused: 'En pausa',
  blocked: 'Bloqueada',
};
