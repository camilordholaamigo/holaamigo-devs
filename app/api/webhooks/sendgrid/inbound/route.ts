import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { handleInbound } from '@/lib/email/inbound';

/**
 * POST /api/webhooks/sendgrid/inbound — las respuestas.
 *
 * SendGrid Inbound Parse manda `multipart/form-data` con los campos del correo.
 * No firma la petición: la única autenticación posible es un secreto en la URL,
 * así que la ruta se configura como
 *   https://.../api/webhooks/sendgrid/inbound?k=SENDGRID_INBOUND_SECRET
 *
 * Es débil y lo sabemos. Lo que lo hace aceptable: sin el secreto no se
 * procesa nada, y lo peor que logra alguien con el secreto es inyectar una
 * respuesta falsa en un hilo — molesto, no destructivo, y visible en la bandeja.
 * Cuando haya volumen se pone un proxy que valide el origen.
 *
 * Devolvemos 200 incluso cuando falla el procesamiento: si respondemos error,
 * SendGrid reintenta el mismo correo durante 72 horas y termina duplicando
 * respuestas en el hilo.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: Request) {
  const secret = new URL(request.url).searchParams.get('k');
  if (env.sendgridInboundSecret && secret !== env.sendgridInboundSecret) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error('[inbound] cuerpo ilegible', err);
    return NextResponse.json({ received: true, handled: false });
  }

  const value = (key: string): string => {
    const raw = form.get(key);
    return typeof raw === 'string' ? raw : '';
  };

  const spamScore = Number(value('spam_score'));

  try {
    const result = await handleInbound({
      to: value('to') || value('envelope'),
      from: value('from'),
      fromName: extractName(value('from')),
      subject: value('subject'),
      // `text` puede venir vacío en correos solo-HTML. En ese caso mandamos el
      // HTML crudo: el clasificador prefiere HTML sucio a nada.
      text: value('text') || stripTags(value('html')),
      html: value('html') || null,
      headers: value('headers'),
      spamScore: Number.isFinite(spamScore) ? spamScore : null,
    });

    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    console.error('[inbound] fallo al procesar', err);
    return NextResponse.json({ received: true, handled: false });
  }
}

function extractName(from: string): string | null {
  const match = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return match?.[1]?.trim() || null;
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
