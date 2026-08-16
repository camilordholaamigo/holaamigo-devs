import { createPublicKey, createVerify, randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { db } from '@/lib/supabase/admin';

/**
 * SendGrid: el proveedor de envío y recepción de las campañas (ADR 0008).
 *
 * POR QUÉ SENDGRID Y NO RESEND PARA ESTO, si Resend ya estaba:
 * separación de reputación. El correo transaccional del producto (el
 * diagnóstico, las notificaciones) sigue por Resend; las campañas del cliente
 * van por SendGrid. Si una campaña genera quejas, el que se degrada es el pool
 * de campañas — no el correo que le avisa a alguien que su diagnóstico está
 * listo. Mezclarlos es el error clásico y no se nota hasta que ya pasó.
 *
 * Sin API key configurada esto NO revienta: registra el envío como `skipped` y
 * lo deja en el log. El producto tiene que correr de punta a punta en local sin
 * credenciales, igual que con Resend y Slack.
 */

const API = 'https://api.sendgrid.com/v3';

export interface SendArgs {
  organizationId: string;
  from: { email: string; name: string | null };
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  /** Para hilar la respuesta con el hilo. Si no viene, se genera. */
  messageIdHeader?: string;
  /** Cuando es un paso 2+ de la secuencia: enlaza con el correo anterior. */
  inReplyTo?: string | null;
  /** Vuelven en el webhook de eventos. Es toda nuestra atribución. */
  customArgs?: Record<string, string>;
  categories?: string[];
  /** Link de baja propio. Va en el header List-Unsubscribe y en el pie. */
  unsubscribeUrl?: string | null;
}

export interface SendResult {
  sent: boolean;
  /** El `X-Message-Id` de SendGrid: la llave para emparejar eventos. */
  externalId: string | null;
  /** Nuestro Message-ID RFC: la llave para emparejar respuestas. */
  messageIdHeader: string;
  reason?: string;
}

/**
 * La API key sale de `integrations` si el cliente conectó su propia cuenta;
 * si no, de la nuestra. Cliente con cuenta propia = su reputación, su factura,
 * su control. Es lo que hace que un cliente grande pueda entrar sin migrar todo.
 */
async function apiKeyFor(organizationId: string): Promise<string | null> {
  const { data } = await db()
    .from('integrations')
    .select('credentials, status')
    .eq('organization_id', organizationId)
    .eq('provider', 'sendgrid')
    .maybeSingle();

  const own = (data?.credentials as { api_key?: string } | null)?.api_key;
  if (data?.status === 'connected' && own) return own;
  return env.sendgridApiKey || null;
}

export function newMessageId(domain: string): string {
  return `<${randomUUID()}@${domain.replace(/^https?:\/\//, '')}>`;
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const messageIdHeader =
    args.messageIdHeader ?? newMessageId(args.from.email.split('@')[1] ?? 'holaamigo.co');

  const apiKey = await apiKeyFor(args.organizationId);
  if (!apiKey) {
    console.info(`[sendgrid] sin API key · no enviado a ${args.to} · ${args.subject}`);
    return { sent: false, externalId: null, messageIdHeader, reason: 'sin_credencial' };
  }

  const headers: Record<string, string> = { 'Message-ID': messageIdHeader };
  if (args.inReplyTo) {
    headers['In-Reply-To'] = args.inReplyTo;
    headers.References = args.inReplyTo;
  }
  if (args.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${args.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const body = {
    personalizations: [
      {
        to: [{ email: args.to, name: args.toName ?? undefined }],
        custom_args: args.customArgs ?? {},
      },
    ],
    from: { email: args.from.email, name: args.from.name ?? undefined },
    reply_to: args.replyTo ? { email: args.replyTo } : undefined,
    subject: args.subject,
    content: [
      { type: 'text/plain', value: args.text },
      { type: 'text/html', value: args.html },
    ],
    headers,
    categories: args.categories?.slice(0, 10),
    custom_args: args.customArgs ?? {},
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      // El pie de baja lo ponemos nosotros con nuestro propio link, porque la
      // baja tiene que entrar a `suppressions` de inmediato y no solo a la
      // lista de SendGrid. La supresión global es nuestra, no del proveedor.
      subscription_tracking: { enable: false },
    },
    mail_settings: { bypass_list_management: { enable: false } },
  };

  try {
    const res = await fetch(`${API}/mail/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[sendgrid] ${res.status} al enviar a ${args.to}: ${detail.slice(0, 400)}`);
      return {
        sent: false,
        externalId: null,
        messageIdHeader,
        reason: `http_${res.status}`,
      };
    }

    return {
      sent: true,
      externalId: res.headers.get('x-message-id'),
      messageIdHeader,
    };
  } catch (err) {
    console.error('[sendgrid] fallo de red', err);
    return { sent: false, externalId: null, messageIdHeader, reason: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK DE EVENTOS
// ═══════════════════════════════════════════════════════════════════════════

export interface SendGridEvent {
  event: string;
  email: string;
  sg_message_id?: string;
  timestamp?: number;
  reason?: string;
  type?: string;
  url?: string;
  // Nuestros custom_args vuelven en la raíz del evento.
  message_id?: string;
  campaign_id?: string;
  organization_id?: string;
  mailbox_id?: string;
}

/**
 * Verificación de firma del Signed Event Webhook (ECDSA sobre P-256).
 *
 * Sin esto, cualquiera que conozca la URL puede reportar rebotes falsos y
 * meterle contactos a la lista de supresión — o peor, marcar como entregado
 * algo que nunca salió. Si la clave pública no está configurada, devolvemos
 * false y la ruta decide: en producción rechaza, en local acepta.
 */
export function verifyEventSignature(args: {
  publicKeyBase64: string;
  payload: string;
  signature: string | null;
  timestamp: string | null;
}): boolean {
  if (!args.publicKeyBase64 || !args.signature || !args.timestamp) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(args.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const verifier = createVerify('sha256');
    verifier.update(args.timestamp + args.payload);
    verifier.end();
    return verifier.verify(key, Buffer.from(args.signature, 'base64'));
  } catch (err) {
    console.error('[sendgrid] no se pudo verificar la firma', err);
    return false;
  }
}

/** Evento de SendGrid → estado de nuestra tabla `messages`. */
export function statusForEvent(event: string): string | null {
  switch (event) {
    case 'processed':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'open':
      return 'read';
    case 'click':
      return 'clicked';
    case 'bounce':
    case 'blocked':
      return 'bounced';
    case 'dropped':
    case 'deferred':
      return 'failed';
    case 'spamreport':
      return 'failed';
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICACIÓN DE REMITENTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Registra la dirección como Sender Identity. SendGrid manda un correo de
 * confirmación al dueño de la dirección: por diseño, nosotros no podemos
 * autoverificar una dirección ajena. Eso es correcto y no lo vamos a evadir.
 *
 * §13.3 — nada se automatiza antes de hacerse tres veces a mano: para los
 * primeros clientes, autenticar el dominio (SPF/DKIM/DMARC) lo hacemos con
 * ellos en una llamada de 15 minutos. Esta función solo deja registrada la
 * intención y el estado.
 */
export async function registerSender(args: {
  organizationId: string;
  address: string;
  displayName: string;
  replyTo: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = await apiKeyFor(args.organizationId);
  if (!apiKey) return { ok: false, reason: 'sin_credencial' };

  try {
    const res = await fetch(`${API}/verified_senders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        nickname: `${args.displayName} · ${args.address}`,
        from_email: args.address,
        from_name: args.displayName,
        reply_to: args.replyTo,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: `http_${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}
