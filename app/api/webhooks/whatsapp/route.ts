import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, tryWrite } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import { InboundClassificationSchema } from '@/lib/ai/schemas';
import { INBOUND_CLASSIFY_SYSTEM } from '@/config/prompts';
import { agentIdFor } from '@/lib/agents/contracts';
import { playbookVigente } from '@/lib/playbook/store';
import { abrirConversacion, responder } from '@/lib/whatsapp/setter';

/**
 * Webhook de WhatsApp Cloud API.
 *
 * DOS CAMINOS, y cuál se toma depende de si la organización tiene playbook.
 *
 *   CON PLAYBOOK (P7) → el agente de agendamiento contesta. Es el camino
 *   normal desde que existe el compilador: hay un guion que el cliente revisó,
 *   una agenda real que consultar y una escalera de capacidades que gobierna
 *   qué puede hacer. `outreach.reply` tiene techo de plataforma L5 justamente
 *   porque contestarle a quien te escribió primero es lo menos riesgoso que
 *   hace un agente — y lo que más se nota si no pasa.
 *
 *   SIN PLAYBOOK → el camino de v1: clasificar, suprimir si pidió salir,
 *   escalar si toca, y no contestar. Sigue existiendo porque una organización
 *   que cargó su base y nunca armó el agente igual puede recibir un mensaje, y
 *   ese mensaje no se puede perder.
 *
 * Lo que NO cambió: la supresión es inmediata y global en los dos caminos.
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
    .select('id, organization_id, full_name, email, status')
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

  // ── Camino nuevo: el agente de agendamiento contesta ─────────────────────
  //
  // Un lead suprimido no recibe respuesta automática aunque escriba: pidió que
  // no le escribiéramos, y "pero él escribió primero" es exactamente el
  // razonamiento con el que se rompe una supresión. Su mensaje ya quedó
  // guardado arriba y un humano lo va a ver en la bandeja.
  const playbook = lead.status === 'suppressed' ? null : await playbookVigente(lead.organization_id);
  if (playbook) {
    try {
      const conversacion = await abrirConversacion({
        organizationId: lead.organization_id,
        leadId: lead.id,
        channel: 'whatsapp',
      });

      const turno = await responder({
        conversation: conversacion,
        mensajeDelContacto: message.text,
        contacto: {
          nombre: lead.full_name,
          email: lead.email,
          telefono: message.from,
        },
      });

      // El turno queda registrado por el runtime; acá solo se ENVÍA. Separar
      // las dos cosas es lo que hace que un fallo de la API de Meta no borre
      // la conversación: el mensaje ya existe, se puede reintentar.
      await enviarWhatsapp({ leadId: lead.id, to: message.from, body: turno.mensaje });
      return;
    } catch (err) {
      // El agente no pudo contestar. Se escala en vez de dejar al contacto en
      // silencio: un mensaje sin responder es peor que uno respondido por un
      // humano tarde.
      console.error('[webhook/whatsapp] el setter falló, escalando', err);
      await escalate(
        lead.organization_id,
        salesId,
        lead.id,
        message.text,
        'el agente de agendamiento no pudo contestar',
      );
      return;
    }
  }

  // ── Camino v1: sin playbook, se clasifica y no se contesta ───────────────
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

/**
 * El envío real por la Cloud API de Meta.
 *
 * Registra el mensaje en `messages` SIEMPRE, con su estado — incluso cuando
 * falla. Un `failed` con su error se puede reintentar y se puede contar; un
 * envío que no dejó fila es un mensaje que nadie sabe que se perdió.
 *
 * Sin credenciales configuradas no lanza: deja la fila en `queued` y sigue. Es
 * el estado real de un cliente cuyo número todavía está en revisión de Meta, y
 * es exactamente lo que queremos poder ver en la consola.
 */
async function enviarWhatsapp(args: {
  leadId: string;
  to: string;
  body: string;
}): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneId) {
    await tryWrite(
      db().from('messages').insert({
        lead_id: args.leadId,
        channel: 'whatsapp',
        direction: 'out',
        body: args.body,
        status: 'queued',
        error: 'sin WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID configurados',
      }),
      'messages.whatsapp_queued',
    );
    return;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: args.to.replace(/^\+/, ''),
        type: 'text',
        text: { body: args.body },
      }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };

    await tryWrite(
      db().from('messages').insert({
        lead_id: args.leadId,
        channel: 'whatsapp',
        direction: 'out',
        body: args.body,
        status: response.ok ? 'sent' : 'failed',
        external_id: data.messages?.[0]?.id ?? null,
        sent_at: response.ok ? new Date().toISOString() : null,
        error: response.ok ? null : (data.error?.message ?? `HTTP ${response.status}`),
      }),
      'messages.whatsapp_out',
    );
  } catch (err) {
    await tryWrite(
      db().from('messages').insert({
        lead_id: args.leadId,
        channel: 'whatsapp',
        direction: 'out',
        body: args.body,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }),
      'messages.whatsapp_failed',
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
