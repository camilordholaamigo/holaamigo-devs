import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';

/**
 * Baja de la lista. Un clic, sin preguntas, sin "¿estás seguro?".
 *
 * Va a `suppressions`, que es GLOBAL y vale para todos los canales: quien se
 * da de baja del correo tampoco recibe WhatsApp. Usar la lista de supresión de
 * SendGrid habría sido más fácil y solo cubriría el correo, y solo mientras
 * sigamos con SendGrid.
 *
 * Acepta GET y POST: GET es el clic en el pie del correo, POST es el
 * `List-Unsubscribe-Post` de un clic que Gmail y Outlook ejecutan sin abrir el
 * navegador. Que un GET mute estado es incorrecto en general y correcto acá:
 * la alternativa es una pantalla intermedia que hace que la gente se rinda y
 * marque spam, que nos cuesta muchísimo más.
 */

export const runtime = 'nodejs';

async function suppress(messageId: string): Promise<{ ok: boolean; email: string | null }> {
  const { data: message } = await db()
    .from('messages')
    .select('id, organization_id, lead_id, to_address, campaign_id')
    .eq('id', messageId)
    .maybeSingle();

  if (!message?.to_address) return { ok: false, email: null };

  const email = message.to_address.toLowerCase();

  await db().from('suppressions').insert({
    organization_id: message.organization_id,
    email,
    reason: 'opt_out',
    source: 'link_baja',
  });

  if (message.lead_id) {
    await db().from('leads').update({ status: 'suppressed' }).eq('id', message.lead_id);
    // Los correos futuros de la secuencia se cancelan en el acto. Esperar al
    // despachador dejaría una ventana en la que sale un correo más a alguien
    // que acaba de pedir que no le escribamos.
    await db()
      .from('messages')
      .update({ status: 'skipped', error: 'se dio de baja' })
      .eq('lead_id', message.lead_id)
      .eq('status', 'scheduled');
  }

  return { ok: true, email };
}

export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const result = await suppress(messageId);

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Listo</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#fbfaf8;color:#12100e;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:420px;padding:32px;text-align:center">
    <p style="font-size:18px;font-weight:600;margin:0 0 8px">${
      result.ok ? 'Listo, no te escribimos más.' : 'Ese enlace ya no es válido.'
    }</p>
    <p style="font-size:14px;color:#7d766c;margin:0">${
      result.ok
        ? 'Sacamos tu correo de todas las listas, no solo de esta.'
        : 'Si sigues recibiendo correos, responde cualquiera de ellos y lo resolvemos.'
    }</p>
  </div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const result = await suppress(messageId);
  return NextResponse.json({ ok: result.ok });
}
