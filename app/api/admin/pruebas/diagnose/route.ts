import { NextResponse } from 'next/server';
import { currentAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/admin';
import { canalActivo, enviarMensaje, faltaParaEnviar } from '@/lib/pruebas/callbell';
import { configDePruebas } from '@/lib/pruebas/lanzar';
import { aE164 } from '@/lib/pruebas/numeros';
import { env } from '@/lib/env';

/**
 * GET /api/admin/pruebas/diagnose — «¿por qué no salió el mensaje?»
 *
 * Es el endpoint que se paga solo la primera vez que se usa. Dice qué
 * variables están presentes (BOOLEANOS, nunca sus valores), qué canal está
 * activo, cuál fue la última prueba y con qué error murió.
 *
 * Existe porque el que descubre que algo no anda casi nunca es el que tiene
 * acceso a los logs de Vercel. Sin esto, «no llegó el mensaje» es una hora de
 * ida y vuelta; con esto es una pantalla que dice «falta CALLBELL_API_KEY».
 *
 * POST manda un mensaje de prueba a un número. Es el paso 2 del manual de
 * puesta en marcha y no se debe seguir hasta que funcione: la mitad de los
 * problemas de configuración viven ahí —llave vencida, canal mal escrito,
 * teléfono mal formado— y salen todos en dos segundos.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const falta = faltaParaEnviar();
  const canal = await canalActivo();
  const config = await configDePruebas();

  const { data: ultimas } = await db()
    .from('smoke_probes')
    .select(
      'id, template_id, target_phone, estado, cerro_con, segundos_primera_respuesta, error, created_at, finished_at',
    )
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: bloqueados } = await db()
    .from('smoke_targets')
    .select('phone_e164, bloqueado_motivo')
    .eq('bloqueado', true)
    .limit(20);

  return NextResponse.json({
    entorno: {
      CALLBELL_API_KEY: Boolean(process.env.CALLBELL_API_KEY),
      CALLBELL_WEBHOOK_SECRET: Boolean(process.env.CALLBELL_WEBHOOK_SECRET),
      OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
      CRON_SECRET: Boolean(env.cronSecret),
      falta,
    },
    webhook: {
      url: `${env.siteUrl}/api/webhooks/callbell${
        process.env.CALLBELL_WEBHOOK_SECRET ? '?k=<CALLBELL_WEBHOOK_SECRET>' : ''
      }`,
      // Sin secreto la ruta acepta en desarrollo y rechaza en producción. Se
      // dice explícitamente porque el modo de fallo —«el webhook devuelve 401
      // y nadie sabe por qué»— es indistinguible de un problema de red.
      protegido: Boolean(process.env.CALLBELL_WEBHOOK_SECRET),
    },
    canal: canal
      ? {
          label: canal.label,
          telefono: canal.phone_e164,
          channel_uuid: canal.channel_uuid,
          abre_con_plantilla: Boolean(canal.template_uuid),
        }
      : null,
    config,
    ultimas_pruebas: ultimas ?? [],
    numeros_bloqueados: bloqueados ?? [],
  });
}

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    telefono?: string;
    texto?: string;
    canalId?: string;
  } | null;

  const e164 = aE164(String(body?.telefono ?? ''), 'CO');
  if (!e164) return NextResponse.json({ error: 'Número inválido' }, { status: 400 });

  const canal = await canalActivo(body?.canalId ?? null);
  if (!canal) return NextResponse.json({ error: 'No hay canal activo' }, { status: 400 });

  const r = await enviarMensaje({
    canal,
    to: e164,
    texto: body?.texto?.trim() || 'Hola, mensaje de prueba del sistema.',
  });

  return NextResponse.json(
    {
      ok: r.ok,
      messageId: r.messageId,
      error: r.error,
      pista: r.pista,
      desde: canal.phone_e164,
      hacia: e164,
    },
    { status: r.ok ? 200 : 502 },
  );
}
