import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import { InboundClassificationSchema } from '@/lib/ai/schemas';
import { INBOUND_CLASSIFY_SYSTEM } from '@/config/prompts';
import { agentIdFor } from '@/lib/agents/contracts';

/**
 * Webhook de WhatsApp Cloud API.
 *
 * ALCANCE v1: recibe, verifica la firma, guarda el mensaje entrante, lo
 * clasifica con el agente SALES y — si toca — suprime al contacto o escala a
 * la cola de decisiones. NO responde automáticamente todavía: responder exige
 * una plantilla aprobada y un ángulo aprobado, y eso lo decide un humano en la
 * cola hasta que hayamos hecho el ciclo tres veces a mano (§13.3).
 *
 * GET = verificación del webhook de Meta (hub.challenge).
 * POST = eventos.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return NextResponse.json({ error: 'verificación fallida' }, { status: 403 });
}

function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  // Sin secreto configurado no podemos verificar. En producción eso es un
  // rechazo: un webhook sin firma verificada es una entrada abierta.
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!header?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const raw = await request.text();

  if (!verifySignature(raw, request.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'firma inválida' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'json inválido' }, { status: 400 });
  }

  try {
    for (const message of extractMessages(body)) {
      await handleInbound(message);
    }
  } catch (err) {
    // Meta reintenta ante error. Registramos y devolvemos 200 para no entrar
    // en un bucle de reintentos por un mensaje que igual no vamos a procesar.
    console.error('[webhook/whatsapp] fallo procesando', err);
  }

  return NextResponse.json({ received: true });
}

interface InboundMessage {
  from: string;
  text: string;
  externalId: string;
  timestamp: string;
}

function extractMessages(body: unknown): InboundMessage[] {
  const payload = body as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            from?: string;
            id?: string;
            timestamp?: string;
            text?: { body?: string };
            button?: { text?: string };
          }>;
        };
      }>;
    }>;
  };

  const out: InboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        const text = message.text?.body ?? message.button?.text ?? '';
        if (!message.from || !text) continue;
        out.push({
          from: message.from.startsWith('+') ? message.from : `+${message.from}`,
          text,
          externalId: message.id ?? '',
          timestamp: message.timestamp ?? String(Date.now() / 1000),
        });
      }
    }
  }
  return out;
}

async function handleInbound(message: InboundMessage): Promise<void> {
  const { data: lead } = await db()
    .from('leads')
    .select('id, organization_id, full_name, status')
    .eq('phone_e164', message.from)
    .limit(1)
    .maybeSingle();

  if (!lead) {
    console.info(`[webhook/whatsapp] mensaje de ${message.from} sin lead asociado`);
    return;
  }

  await db().from('messages').insert({
    lead_id: lead.id,
    channel: 'whatsapp',
    direction: 'in',
    body: message.text,
    status: 'delivered',
    external_id: message.externalId,
    sent_at: new Date(Number(message.timestamp) * 1000).toISOString(),
  });

  const salesId = await agentIdFor(lead.organization_id, 'sales');

  let classification;
  try {
    const result = await runStructured({
      step: 'classify',
      schemaName: 'inbound_classification',
      schema: InboundClassificationSchema,
      system: INBOUND_CLASSIFY_SYSTEM,
      input: `Mensaje entrante de ${lead.full_name ?? message.from}:\n"${message.text}"`,
      organizationId: lead.organization_id,
      agentId: salesId,
      role: 'sales',
      trigger: 'inbound',
    });
    classification = result.data;
  } catch (err) {
    console.error('[webhook/whatsapp] clasificación fallida, escalando', err);
    await escalate(lead.organization_id, salesId, lead.id, message.text, 'no se pudo clasificar');
    return;
  }

  // Opt-out: supresión inmediata y global. Sin excepciones, sin preguntar.
  if (classification.intent === 'opt_out') {
    await db().from('suppressions').insert({
      organization_id: lead.organization_id,
      phone_e164: message.from,
      reason: 'opt_out',
      source: 'whatsapp_inbound',
    });
    await db().from('leads').update({ status: 'suppressed' }).eq('id', lead.id);
    return;
  }

  await db()
    .from('leads')
    .update({
      status: classification.intent === 'interested' ? 'qualified' : 'replied',
      enrichment: { last_intent: classification.intent, last_sentiment: classification.sentiment },
    })
    .eq('id', lead.id);

  if (classification.should_escalate) {
    await escalate(
      lead.organization_id,
      salesId,
      lead.id,
      message.text,
      classification.escalation_reason ?? classification.intent,
    );
  }
}

async function escalate(
  organizationId: string,
  agentId: string | null,
  leadId: string,
  text: string,
  reason: string,
): Promise<void> {
  await db().from('approvals').insert({
    organization_id: organizationId,
    agent_id: agentId,
    kind: 'escalation',
    title: 'SALES escaló una respuesta entrante',
    rationale: reason,
    if_approved: 'Un humano toma la conversación desde el mismo hilo.',
    if_rejected: 'El lead queda marcado y sin respuesta automática.',
    payload: { lead_id: leadId, message: text.slice(0, 1000), channel: 'whatsapp' },
    severity: 'high',
  });
}
