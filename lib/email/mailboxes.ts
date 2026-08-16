import { randomBytes } from 'node:crypto';
import { db, unwrap } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { registerSender } from '@/lib/email/sendgrid';

/**
 * Las bandejas del cliente.
 *
 * Un cliente no envía desde una dirección: envía desde varias, y esa es la
 * diferencia entre operar y quemarse. 500 envíos al día desde `hola@empresa.com`
 * es un dominio muerto en tres semanas. 500 repartidos entre seis buzones con
 * cap y calentamiento es una operación.
 *
 * Dos topes que el despachador NUNCA cruza:
 *   · `daily_cap` — el tope duro que puso el operador.
 *   · el cap de calentamiento — derivado de cuándo arrancó el buzón.
 * Se toma el menor de los dos. Una campaña aprobada no levanta ninguno: la
 * aprobación autoriza el gasto, no la imprudencia.
 *
 * Ver docs/wiki/10-correo-y-bandejas.md
 */

export interface Mailbox {
  id: string;
  organization_id: string;
  address: string;
  display_name: string | null;
  status: 'pending' | 'warming' | 'active' | 'paused' | 'blocked';
  purpose: 'outbound' | 'inbound' | 'both';
  daily_cap: number;
  warmup_started_at: string | null;
  reply_to: string | null;
  signature_html: string | null;
  inbound_address: string | null;
  sent_today: number;
  sent_today_date: string;
  last_sent_at: string | null;
  bounce_rate: number;
  complaint_rate: number;
  is_default: boolean;
}

/**
 * Rampa de calentamiento. Los números son deliberadamente lentos: 20 correos
 * el primer día y +30% diario. Los proveedores de "warmup automático" arrancan
 * en 50 y suben más rápido; también son los que generan los casos de dominios
 * quemados que después tenemos que explicar.
 */
const WARMUP_START = 20;
const WARMUP_GROWTH = 1.3;

export function warmupCapFor(mailbox: Pick<Mailbox, 'warmup_started_at' | 'daily_cap'>, now = new Date()): number {
  if (!mailbox.warmup_started_at) return mailbox.daily_cap;
  const days = Math.floor(
    (now.getTime() - new Date(mailbox.warmup_started_at).getTime()) / 86_400_000,
  );
  if (days < 0) return 0;
  const ramp = Math.floor(WARMUP_START * Math.pow(WARMUP_GROWTH, days));
  return Math.min(mailbox.daily_cap, ramp);
}

export function remainingToday(mailbox: Mailbox, now = new Date()): number {
  if (mailbox.status !== 'active' && mailbox.status !== 'warming') return 0;
  if (mailbox.purpose === 'inbound') return 0;
  const today = now.toISOString().slice(0, 10);
  const sent = mailbox.sent_today_date === today ? mailbox.sent_today : 0;
  return Math.max(0, warmupCapFor(mailbox, now) - sent);
}

export async function listMailboxes(organizationId: string): Promise<Mailbox[]> {
  const { data } = await db()
    .from('mailboxes')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at');
  return (data ?? []) as Mailbox[];
}

/** Capacidad total de envío de hoy. Es el número que el President necesita
 *  para no proponer un envío de 2.000 correos cuando caben 180. */
export async function capacityToday(
  organizationId: string,
  onlyIds: string[] = [],
): Promise<{ capacity: number; mailboxes: number }> {
  const all = await listMailboxes(organizationId);
  const usable = all.filter((m) => (onlyIds.length === 0 ? true : onlyIds.includes(m.id)));
  const capacity = usable.reduce((sum, m) => sum + remainingToday(m), 0);
  return { capacity, mailboxes: usable.filter((m) => remainingToday(m) > 0).length };
}

/**
 * Elige el buzón para el próximo envío: el que tenga capacidad y lleve más
 * tiempo sin enviar. Repartir parejo importa más que llenar un buzón antes de
 * pasar al siguiente — los patrones de envío en ráfaga son justo lo que los
 * filtros marcan.
 */
export async function pickMailbox(
  organizationId: string,
  onlyIds: string[] = [],
): Promise<Mailbox | null> {
  const all = await listMailboxes(organizationId);
  const candidates = all
    .filter((m) => (onlyIds.length === 0 ? true : onlyIds.includes(m.id)))
    .filter((m) => remainingToday(m) > 0)
    .sort((a, b) => {
      const aTime = a.last_sent_at ? new Date(a.last_sent_at).getTime() : 0;
      const bTime = b.last_sent_at ? new Date(b.last_sent_at).getTime() : 0;
      return aTime - bTime;
    });
  return candidates[0] ?? null;
}

export async function recordSend(mailboxId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db()
    .from('mailboxes')
    .select('sent_today, sent_today_date')
    .eq('id', mailboxId)
    .maybeSingle();

  const sameDay = data?.sent_today_date === today;
  await db()
    .from('mailboxes')
    .update({
      sent_today: sameDay ? (data?.sent_today ?? 0) + 1 : 1,
      sent_today_date: today,
      last_sent_at: new Date().toISOString(),
    })
    .eq('id', mailboxId);
}

/**
 * Dirección de recepción. Las respuestas no llegan al buzón real del cliente:
 * llegan a un alias nuestro en el dominio de la Inbound Parse, y de ahí al
 * hilo. Si el `reply_to` fuera el correo real, la respuesta se quedaría en la
 * bandeja de Gmail del cliente y el agente nunca se enteraría — que es
 * exactamente el problema que este módulo existe para resolver.
 */
export function buildInboundAddress(address: string): string {
  const local = address.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
  const token = randomBytes(4).toString('hex');
  return `${local}-${token}@${env.inboundDomain}`;
}

export async function createMailbox(args: {
  organizationId: string;
  address: string;
  displayName: string;
  dailyCap?: number;
  purpose?: 'outbound' | 'inbound' | 'both';
  signatureHtml?: string | null;
  startWarmup?: boolean;
}): Promise<Mailbox> {
  const inbound = buildInboundAddress(args.address);

  const existing = await listMailboxes(args.organizationId);
  const row = unwrap(
    await db()
      .from('mailboxes')
      .upsert(
        {
          organization_id: args.organizationId,
          // Minúsculas siempre: el índice único es plano `(organization_id,
          // address)` porque el de `lower(address)` no podía usarse como
          // árbitro del upsert. Ver supabase/migrations/0005.
          address: args.address.toLowerCase().trim(),
          display_name: args.displayName,
          purpose: args.purpose ?? 'both',
          daily_cap: args.dailyCap ?? 40,
          // Arranca en `warming` si pidió calentamiento; si no, `pending` hasta
          // que SendGrid confirme el remitente. Nunca `active` de una: enviar
          // desde una dirección sin verificar es un rebote garantizado.
          status: args.startWarmup ? 'warming' : 'pending',
          warmup_started_at: args.startWarmup ? new Date().toISOString() : null,
          inbound_address: inbound,
          reply_to: inbound,
          signature_html: args.signatureHtml ?? null,
          is_default: existing.length === 0,
        },
        { onConflict: 'organization_id,address' },
      )
      .select('*')
      .single(),
    'mailboxes.create',
  ) as Mailbox;

  const registration = await registerSender({
    organizationId: args.organizationId,
    address: row.address,
    displayName: args.displayName,
    replyTo: inbound,
  });

  if (!registration.ok) {
    await db()
      .from('mailboxes')
      .update({ domain_auth: { registration_error: registration.reason ?? 'desconocido' } })
      .eq('id', row.id);
  }

  return row;
}

export async function mailboxByInbound(address: string): Promise<Mailbox | null> {
  const { data } = await db()
    .from('mailboxes')
    .select('*')
    .eq('inbound_address', address.toLowerCase())
    .maybeSingle();
  return (data as Mailbox | null) ?? null;
}

/**
 * Salud de la bandeja: rebotes y quejas sobre los últimos envíos. Un buzón con
 * >5% de rebote o >0,3% de quejas se pausa solo. El umbral de quejas parece
 * absurdamente bajo y no lo es: Gmail empieza a filtrar a partir de 0,3%.
 */
export async function refreshMailboxHealth(mailboxId: string): Promise<void> {
  const { data } = await db()
    .from('messages')
    .select('status')
    .eq('mailbox_id', mailboxId)
    .eq('direction', 'out')
    .order('created_at', { ascending: false })
    .limit(500);

  const rows = data ?? [];
  if (rows.length < 50) return; // muy pocos datos para concluir nada

  const bounced = rows.filter((r) => r.status === 'bounced').length;
  const complaints = rows.filter((r) => r.status === 'failed').length;
  const bounceRate = bounced / rows.length;
  const complaintRate = complaints / rows.length;

  const shouldPause = bounceRate > 0.05 || complaintRate > 0.003;

  await db()
    .from('mailboxes')
    .update({
      bounce_rate: Math.round(bounceRate * 10_000) / 10_000,
      complaint_rate: Math.round(complaintRate * 10_000) / 10_000,
      ...(shouldPause ? { status: 'paused' } : {}),
    })
    .eq('id', mailboxId);
}
