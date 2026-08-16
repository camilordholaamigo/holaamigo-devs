import { db } from '@/lib/supabase/admin';
import { SectionTitle, Empty } from '@/components/ui';
import { ThreadCard, type ThreadView } from '@/components/thread-card';

/**
 * La bandeja: las conversaciones, no los correos sueltos.
 *
 * Primero las que necesitan a un humano. El resto abajo, porque el agente ya
 * las está manejando y mirarlas es opcional — pero tienen que estar visibles:
 * un agente que contesta en tu nombre y no te deja leer lo que dijo es un
 * agente en el que no se puede confiar.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bandeja · Hola Amigo', robots: { index: false } };

export default async function BandejaPage({ params }: PageProps<'/consola/[orgId]/bandeja'>) {
  const { orgId } = await params;

  const { data: threads } = await db()
    .from('email_threads')
    .select(
      'id, contact_email, subject, snippet, status, intent, needs_human, human_reason, last_direction, last_message_at, campaign_id',
    )
    .eq('organization_id', orgId)
    .order('needs_human', { ascending: false })
    .order('last_message_at', { ascending: false })
    .limit(80);

  const rows = threads ?? [];
  const campaignIds = [...new Set(rows.map((row) => row.campaign_id).filter(Boolean))] as string[];
  const threadIds = rows.map((row) => row.id);

  const [{ data: campaigns }, { data: inbound }] = await Promise.all([
    campaignIds.length > 0
      ? db().from('campaigns').select('id, name').in('id', campaignIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
    threadIds.length > 0
      ? db()
          .from('messages')
          .select('thread_id, body, classification, direction, created_at')
          .in('thread_id', threadIds)
          .eq('direction', 'in')
          .order('created_at', { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as { thread_id: string; body: string | null; classification: unknown }[] }),
  ]);

  const names = new Map((campaigns ?? []).map((row) => [row.id, row.name ?? '']));

  // El último inbound de cada hilo, con el borrador que sugirió el agente.
  const lastInbound = new Map<string, { body: string | null; suggested: string | null }>();
  for (const message of inbound ?? []) {
    if (!message.thread_id || lastInbound.has(message.thread_id)) continue;
    const classification = (message.classification ?? {}) as { suggested_reply?: string | null };
    lastInbound.set(message.thread_id, {
      body: message.body,
      suggested: classification.suggested_reply ?? null,
    });
  }

  const views: ThreadView[] = rows.map((row) => ({
    id: row.id,
    contact_email: row.contact_email,
    subject: row.subject,
    snippet: row.snippet,
    status: row.status,
    intent: row.intent,
    needs_human: row.needs_human,
    human_reason: row.human_reason,
    last_direction: row.last_direction,
    last_message_at: row.last_message_at,
    campaign_name: row.campaign_id ? (names.get(row.campaign_id) ?? null) : null,
    suggested_reply: lastInbound.get(row.id)?.suggested ?? null,
    last_inbound: lastInbound.get(row.id)?.body ?? null,
  }));

  const waiting = views.filter((view) => view.needs_human);
  const rest = views.filter((view) => !view.needs_human);

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12">
      <section className="space-y-6">
        <SectionTitle
          eyebrow="Bandeja"
          title={waiting.length > 0 ? 'Estas te necesitan' : 'Nada esperando respuesta'}
          subtitle="El agente contesta lo que puede contestar sin comprometer nada. Precio, quejas y cualquier cosa que no entienda del todo te la pasa a ti."
        />
        {waiting.length === 0 ? (
          <Empty
            title="Todo contestado"
            hint="Cuando llegue una respuesta que el agente no deba manejar solo, aparece acá y te avisamos."
          />
        ) : (
          <ul className="space-y-3">
            {waiting.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} orgId={orgId} />
            ))}
          </ul>
        )}
      </section>

      {rest.length > 0 ? (
        <section className="space-y-6">
          <SectionTitle
            eyebrow="El resto"
            title="Conversaciones en curso"
            subtitle="Lo que el agente ya está manejando. Puedes entrar a cualquiera en cualquier momento."
          />
          <ul className="space-y-3">
            {rest.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} orgId={orgId} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
