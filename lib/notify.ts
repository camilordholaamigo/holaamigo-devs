import { Resend } from 'resend';
import { env } from '@/lib/env';

/**
 * Salidas al mundo: correo al cliente y alerta a Slack.
 *
 * Ambas degradan a un log si la credencial no está configurada. Decisión
 * deliberada: el producto tiene que correr de punta a punta sin Resend y sin
 * Slack. Que falte una notificación no puede impedir que alguien termine su
 * diagnóstico. Ver docs/wiki/09-operacion-y-runbook.md
 */

let resend: Resend | null = null;

function client(): Resend | null {
  if (!env.resendApiKey) return null;
  if (!resend) resend = new Resend(env.resendApiKey);
  return resend;
}

export async function sendDiagnosticEmail(args: {
  to: string;
  name: string | null;
  company: string;
  shareToken: string;
  topLeakLabel: string | null;
}): Promise<{ sent: boolean; reason?: string }> {
  const url = `${env.siteUrl}/diagnostico/${args.shareToken}`;
  const greeting = args.name ? `Hola ${args.name.split(' ')[0]}` : 'Hola';

  const c = client();
  if (!c) {
    console.info(`[email] RESEND_API_KEY ausente. Diagnóstico de ${args.company}: ${url}`);
    return { sent: false, reason: 'sin_credencial' };
  }

  const subject = args.topLeakLabel
    ? `${args.company}: ${args.topLeakLabel}`
    : `Tu diagnóstico de ${args.company} está listo`;

  const html = `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#111827;line-height:1.6">
  <p style="font-size:16px">${greeting},</p>
  <p style="font-size:16px">Tu diagnóstico de <strong>${escapeHtml(args.company)}</strong> ya está listo.
  Adentro está tu posición frente a la competencia, dónde se te está cayendo la plata con el número al lado,
  y las tres rutas con costos y fechas.</p>
  <p style="margin:28px 0">
    <a href="${url}" style="background:#111827;color:#fff;padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Ver mi diagnóstico</a>
  </p>
  <p style="font-size:14px;color:#6b7280">El enlace es permanente. Guárdalo o compártelo con tu equipo.</p>
  <p style="font-size:14px;color:#6b7280">— El equipo de Hola Amigo</p>
</div>`.trim();

  try {
    await c.emails.send({
      from: env.emailFrom,
      to: args.to,
      subject,
      html,
      text: `${greeting}, tu diagnóstico de ${args.company} está listo: ${url}`,
    });
    return { sent: true };
  } catch (err) {
    console.error('[email] fallo al enviar', err);
    return { sent: false, reason: String(err) };
  }
}

export async function alertSlack(args: {
  title: string;
  lines: string[];
  url?: string;
  urgent?: boolean;
}): Promise<boolean> {
  if (!env.slackWebhookUrl) {
    console.info(`[slack] ${args.title} · ${args.lines.join(' · ')} ${args.url ?? ''}`);
    return false;
  }

  const prefix = args.urgent ? ':rotating_light: ' : '';
  const body = {
    text: `${prefix}${args.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${prefix}*${args.title}*\n${args.lines.join('\n')}` },
      },
      ...(args.url
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Abrir ficha' },
                  url: args.url,
                },
              ],
            },
          ]
        : []),
    ],
  };

  try {
    const res = await fetch(env.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.error('[slack] fallo al enviar', err);
    return false;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
