/**
 * Render de un correo de campaña.
 *
 * DECISIÓN DE DISEÑO QUE PARECE PEREZA Y NO LO ES: el correo va en HTML casi
 * plano. Sin tablas, sin banner, sin botón de 300px, sin logo arriba. Un correo
 * comercial que parece newsletter se filtra a Promociones y se responde mucho
 * menos que uno que parece escrito por una persona. El correo bonito es para
 * el transaccional (lib/notify.ts); este es para que le contesten.
 *
 * Lo único que sí lleva estructura es el pie: firma, quién envía y el link de
 * baja. El link de baja es NUESTRO, no el de SendGrid, porque la baja tiene que
 * entrar a `suppressions` en el mismo segundo y valer para todos los canales.
 */

export interface RenderContext {
  /** Datos del contacto para las variables. */
  lead: {
    full_name: string | null;
    email: string | null;
    company: string | null;
    title: string | null;
  };
  /** Quién firma. */
  sender: { name: string; company: string; signatureHtml: string | null };
  /** El link del activo de Hola Amigo (agendador o checkout), ya trackeado. */
  assetUrl: string | null;
  assetLabel: string | null;
  unsubscribeUrl: string | null;
}

/** Variables admitidas en el copy del CMO. Cualquier otra queda literal, a
 *  propósito: es preferible que se vea `{{sector}}` en una prueba a que salga
 *  un correo con un hueco silencioso. */
export function fillVariables(template: string, ctx: RenderContext): string {
  const firstName = ctx.lead.full_name?.trim().split(/\s+/)[0] ?? '';
  const values: Record<string, string> = {
    nombre: firstName,
    nombre_completo: ctx.lead.full_name ?? '',
    empresa: ctx.lead.company ?? '',
    cargo: ctx.lead.title ?? '',
    mi_nombre: ctx.sender.name,
    mi_empresa: ctx.sender.company,
  };

  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

/**
 * Un saludo con el nombre vacío ("Hola ,") es peor que no saludar. Cuando no
 * tenemos nombre, colapsamos el saludo en vez de mandar el hueco.
 */
function cleanup(text: string): string {
  return text
    .replace(/Hola\s*,/g, 'Hola,')
    .replace(/\s+,/g, ',')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export function renderEmail(bodyTemplate: string, ctx: RenderContext): RenderedEmail {
  const body = cleanup(fillVariables(bodyTemplate, ctx));
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const linkBlock =
    ctx.assetUrl && ctx.assetLabel
      ? `<p style="margin:16px 0"><a href="${escapeAttr(ctx.assetUrl)}" style="color:#14503f">${escapeHtml(ctx.assetLabel)}</a></p>`
      : '';

  const signature = ctx.sender.signatureHtml
    ? `<div style="margin-top:20px">${ctx.sender.signatureHtml}</div>`
    : `<p style="margin:20px 0 0">${escapeHtml(ctx.sender.name)}<br>${escapeHtml(ctx.sender.company)}</p>`;

  const unsubscribe = ctx.unsubscribeUrl
    ? `<p style="margin:28px 0 0;font-size:12px;color:#8a8a8a">Si no quieres recibir más correos, <a href="${escapeAttr(ctx.unsubscribeUrl)}" style="color:#8a8a8a">dilo acá</a> y no te volvemos a escribir.</p>`
    : '';

  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px">',
    ...paragraphs.map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`),
    linkBlock,
    signature,
    unsubscribe,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');

  const text = [
    body,
    ctx.assetUrl ? `\n${ctx.assetLabel ?? 'Agenda acá'}: ${ctx.assetUrl}` : '',
    `\n${ctx.sender.name}\n${ctx.sender.company}`,
    ctx.unsubscribeUrl ? `\nPara no recibir más correos: ${ctx.unsubscribeUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { html, text };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/'/g, '&#39;');
}
