/**
 * Acceso a variables de entorno con validación perezosa.
 *
 * Por qué perezosa y no un `z.object().parse()` al importar: el build de Next
 * evalúa módulos en tiempo de compilación, y en Vercel las env vars de runtime
 * no siempre están presentes durante el build. Validar al usar evita builds
 * rotos y da un error legible en la request que sí necesita la variable.
 *
 * Ver docs/wiki/09-operacion-y-runbook.md
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${name}. Revisa .env.local o \`vercel env pull\`.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get supabaseUrl() {
    return required('SUPABASE_URL');
  },
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get openaiApiKey() {
    return required('OPENAI_API_KEY');
  },
  get adminPassword() {
    return required('ADMIN_PASSWORD');
  },
  get adminSecret() {
    // Se usa para firmar la cookie de admin. Si no está, derivamos del
    // service role key: es secreto, estable y ya está presente.
    return optional('ADMIN_SESSION_SECRET') || required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get resendApiKey() {
    return optional('RESEND_API_KEY');
  },
  get emailFrom() {
    return optional('EMAIL_FROM', 'Hola Amigo <hola@holaamigo.co>');
  },
  get slackWebhookUrl() {
    return optional('SLACK_WEBHOOK_URL');
  },
  /** Envío de campañas. Separado de Resend a propósito: ver ADR 0008. */
  get sendgridApiKey() {
    return optional('SENDGRID_API_KEY');
  },
  /** Clave pública del Signed Event Webhook. Sin ella no verificamos firmas. */
  get sendgridWebhookPublicKey() {
    return optional('SENDGRID_WEBHOOK_PUBLIC_KEY');
  },
  /** Secreto en la URL de la Inbound Parse: es la única autenticación que
   *  ese webhook admite. Sin él, cualquiera inyecta respuestas falsas. */
  get sendgridInboundSecret() {
    return optional('SENDGRID_INBOUND_SECRET');
  },
  /** Dominio donde apunta la Inbound Parse de SendGrid. Las respuestas llegan
   *  a un alias nuestro, nunca al buzón real del cliente: si no, la respuesta
   *  se queda en su Gmail y el agente no se entera. */
  get inboundDomain() {
    return optional('EMAIL_INBOUND_DOMAIN', 'parse.holaamigo.co');
  },
  /** Instantly: fuente de listas y leads, no motor de envío. Ver ADR 0009. */
  get instantlyApiKey() {
    return optional('INSTANTLY_API_KEY');
  },
  get calcomUrl() {
    return optional('NEXT_PUBLIC_CALCOM_URL');
  },
  get cronSecret() {
    return optional('CRON_SECRET');
  },
  get siteUrl() {
    const explicit = process.env.NEXT_PUBLIC_SITE_URL;
    if (explicit) return explicit.replace(/\/$/, '');
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (vercel) return `https://${vercel}`;
    return 'http://localhost:3000';
  },
} as const;

/** ¿Está configurada la IA? Permite degradar la UI en vez de reventar. */
export function hasOpenAI(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function hasSupabase(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
