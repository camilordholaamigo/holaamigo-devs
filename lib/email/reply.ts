import { db } from '@/lib/supabase/admin';
import { sendEmail, newMessageId } from '@/lib/email/sendgrid';
import { renderEmail } from '@/lib/email/render';
import { debit } from '@/lib/credits';

/**
 * Responder un hilo desde la consola.
 *
 * El correo sale desde la MISMA bandeja que envió el original y con el
 * `In-Reply-To` del hilo. Podríamos abrir un `mailto:` y dejar que el cliente
 * conteste desde su Gmail —es más fácil de construir— pero entonces la
 * respuesta sale por fuera del sistema: no queda en el hilo, no cuenta para la
 * métrica de la campaña, y la siguiente respuesta del contacto llega a su Gmail
 * en vez de a nuestra Inbound Parse. La conversación se parte en dos y el
 * agente deja de saber qué pasó.
 */

export async function replyToThread(args: {
  threadId: string;
  organizationId: string;
  body: string;
  by: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: thread } = await db()
    .from('email_threads')
    .select('id, organization_id, mailbox_id, lead_id, campaign_id, subject, contact_email, root_message_id')
    .eq('id', args.threadId)
    .eq('organization_id', args.organizationId)
    .maybeSingle();

  if (!thread?.contact_email) return { ok: false, error: 'Hilo no encontrado.' };

  const { data: mailbox } = await db()
    .from('mailboxes')
    .select('*')
    .eq('id', thread.mailbox_id ?? '')
    .maybeSingle();

  if (!mailbox) return { ok: false, error: 'La bandeja de ese hilo ya no existe.' };

  const { data: org } = await db()
    .from('organizations')
    .select('name, domain')
    .eq('id', args.organizationId)
    .maybeSingle();

  const rendered = renderEmail(args.body, {
    lead: { full_name: null, email: thread.contact_email, company: null, title: null },
    sender: {
      name: mailbox.display_name ?? org?.name ?? 'el equipo',
      company: org?.name ?? org?.domain ?? '',
      signatureHtml: mailbox.signature_html,
    },
    assetUrl: null,
    assetLabel: null,
    // Una respuesta a alguien que escribió primero no lleva pie de baja: es
    // correspondencia, no campaña.
    unsubscribeUrl: null,
  });

  const subject = thread.subject ? `Re: ${thread.subject.replace(/^Re:\s*/i, '')}` : 'Re:';

  const result = await sendEmail({
    organizationId: args.organizationId,
    from: { email: mailbox.address, name: mailbox.display_name },
    to: thread.contact_email,
    subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: mailbox.reply_to ?? mailbox.inbound_address,
    messageIdHeader: newMessageId(mailbox.address.split('@')[1] ?? 'holaamigo.co'),
    inReplyTo: thread.root_message_id,
    customArgs: {
      organization_id: args.organizationId,
      mailbox_id: mailbox.id,
      ...(thread.campaign_id ? { campaign_id: thread.campaign_id } : {}),
    },
  });

  await db().from('messages').insert({
    organization_id: args.organizationId,
    campaign_id: thread.campaign_id,
    lead_id: thread.lead_id,
    thread_id: thread.id,
    mailbox_id: mailbox.id,
    channel: 'email',
    direction: 'out',
    status: result.sent ? 'sent' : 'failed',
    subject,
    from_address: mailbox.address,
    to_address: thread.contact_email,
    body: rendered.text,
    external_id: result.externalId,
    sent_at: new Date().toISOString(),
    error: result.sent ? null : (result.reason ?? 'fallo de envío'),
    credits: result.sent
      ? await debit({
          organizationId: args.organizationId,
          action: 'email_reply',
          referenceTable: 'email_threads',
          referenceId: thread.id,
          note: `respuesta manual de ${args.by}`,
        })
      : 0,
  });

  await db()
    .from('email_threads')
    .update({
      needs_human: false,
      human_reason: null,
      handled_at: new Date().toISOString(),
      handled_by: args.by,
      last_direction: 'out',
      last_message_at: new Date().toISOString(),
      snippet: rendered.text.slice(0, 160),
    })
    .eq('id', thread.id);

  return result.sent ? { ok: true } : { ok: false, error: result.reason ?? 'No se pudo enviar.' };
}

export async function markThreadHandled(args: {
  threadId: string;
  organizationId: string;
  by: string;
  status?: 'open' | 'won' | 'lost' | 'closed';
}): Promise<{ ok: boolean }> {
  const { error } = await db()
    .from('email_threads')
    .update({
      needs_human: false,
      human_reason: null,
      handled_at: new Date().toISOString(),
      handled_by: args.by,
      ...(args.status ? { status: args.status } : {}),
    })
    .eq('id', args.threadId)
    .eq('organization_id', args.organizationId);

  return { ok: !error };
}
