import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { abrirConversacion, conversacionPorId, responder, abrirConMensaje } from '@/lib/whatsapp/setter';
import { checkRateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/utils';

/**
 * POST /api/agent/chat — el banco de pruebas.
 *
 * El cliente habla con su propio agente antes de que exista un número de
 * WhatsApp. Es la pantalla que convierte "te armamos un agente" en algo que se
 * entiende: leer un guion no convence a nadie, hablarle sí.
 *
 * Corre por el MISMO runtime que las conversaciones reales, con
 * `channel = 'simulador'`. Lo único que cambia es que las herramientas que
 * tocan a terceros —reservar, suprimir, escalar— no escriben hacia afuera. Ver
 * `lib/whatsapp/setter.ts`.
 *
 * Límite por IP porque la ruta no tiene sesión: es la misma superficie pública
 * que el quiz, y cada turno cuesta tokens.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({
  organizationId: z.string().uuid(),
  conversationId: z.string().uuid().nullish(),
  mensaje: z.string().max(2000).nullish(),
  /** `true` para que el agente abra él, como haría en frío. */
  abrir: z.boolean().nullish(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  const { organizationId, conversationId, mensaje, abrir } = parsed.data;

  const ip = clientIp(request.headers);
  const limite = await checkRateLimit(`setter:${ip ?? organizationId}`, 40, 3600);
  if (!limite.allowed) {
    return NextResponse.json(
      { error: 'Muchos mensajes seguidos. Espera un minuto y sigue probando.' },
      { status: 429 },
    );
  }

  try {
    const conversacion = conversationId
      ? await conversacionPorId(conversationId)
      : await abrirConversacion({ organizationId, channel: 'simulador' });

    if (!conversacion) {
      return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 });
    }

    // La conversación de prueba de una organización no se puede leer desde
    // otra: el `organizationId` del cuerpo tiene que coincidir con el de la
    // fila. Sin esta línea, un UUID de conversación filtrado deja leer la
    // transcripción de otro cliente.
    if (conversacion.organization_id !== organizationId) {
      return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 });
    }

    if (abrir) {
      const apertura = await abrirConMensaje({ organizationId, conversation: conversacion });
      return NextResponse.json({
        ok: true,
        conversationId: conversacion.id,
        mensaje: apertura,
        stage: 'apertura',
        status: 'open',
        herramientas: [],
      });
    }

    if (!mensaje?.trim()) {
      return NextResponse.json({ error: 'Escribe algo' }, { status: 400 });
    }

    if (conversacion.status !== 'open') {
      return NextResponse.json({
        ok: true,
        conversationId: conversacion.id,
        cerrada: true,
        status: conversacion.status,
        mensaje: mensajeDeCierre(conversacion.status),
      });
    }

    const turno = await responder({
      conversation: conversacion,
      mensajeDelContacto: mensaje.trim(),
    });

    return NextResponse.json({
      ok: true,
      conversationId: turno.conversationId,
      mensaje: turno.mensaje,
      stage: turno.stage,
      status: turno.status,
      intencion: turno.intencion,
      qualification: turno.qualification,
      // Se le muestran al cliente en la interfaz: es la diferencia entre "el
      // agente dijo que hay cupo el jueves" y "el agente consultó tu agenda".
      herramientas: turno.herramientas,
      costUsd: turno.costUsd,
    });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : 'error desconocido';
    console.error('[agent/chat] falló', err);

    // El caso más probable y el único con una salida clara para el usuario.
    if (mensaje.includes('sin playbook') || mensaje.includes('playbook vigente')) {
      return NextResponse.json(
        { error: 'Todavía no armamos tu agente.', next: `/conectar` },
        { status: 409 },
      );
    }

    return NextResponse.json({ error: 'El agente no pudo contestar. Inténtalo otra vez.' }, { status: 500 });
  }
}

/** GET — la transcripción, para recargar la página sin perder el hilo. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversationId');
  const organizationId = url.searchParams.get('organizationId');

  if (!conversationId || !organizationId) {
    return NextResponse.json({ error: 'Faltan parámetros' }, { status: 400 });
  }

  const { data } = await db()
    .from('conversation_turns')
    .select('turn, role, body, tool_calls, stage')
    .eq('conversation_id', conversationId)
    .eq('organization_id', organizationId)
    .order('turn', { ascending: true })
    .order('created_at', { ascending: true });

  return NextResponse.json({ ok: true, turnos: data ?? [] });
}

function mensajeDeCierre(status: string): string {
  if (status === 'booked') return 'La conversación cerró con una cita agendada. Empieza otra para probar de nuevo.';
  if (status === 'escalated') return 'El agente escaló a un humano. Empieza otra conversación para seguir probando.';
  if (status === 'opted_out') return 'El contacto pidió no ser contactado y el agente obedeció. Empieza otra.';
  return 'Esta conversación ya cerró. Empieza otra.';
}
