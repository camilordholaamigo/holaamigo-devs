import { NextResponse } from 'next/server';
import { currentAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/admin';
import { canalActivo, canalesActivos, llaveCallbell } from '@/lib/pruebas/callbell';
import { enviarMensaje, faltaParaLineas } from '@/lib/pruebas/transporte';
import { llaveWzap } from '@/lib/pruebas/wzap';
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
 * ida y vuelta; con esto es una pantalla que dice «falta WZAP_API_KEY».
 *
 * POST manda un mensaje de prueba a un número. Es el paso 2 del manual de
 * puesta en marcha y no se debe seguir hasta que funcione: la mitad de los
 * problemas de configuración viven ahí —llave vencida, canal mal escrito,
 * teléfono mal formado— y salen todos en dos segundos.
 *
 * Con dos proveedores (ADR 0028) dice además POR CUÁL salió: `desde` y
 * `proveedor` en la respuesta del POST. Es el dato que evita la media hora de
 * mirar el panel equivocado.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const lineas = await canalesActivos();
  // Qué falta para las líneas que están prendidas, no para el sistema entero:
  // una WZAP_API_KEY ausente no es un problema si no hay ninguna línea de wzap.
  const falta = faltaParaLineas(lineas);
  const canal = lineas[0] ?? null;
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
      WZAP_API_KEY: Boolean(llaveWzap()),
      // Mismo error, otro proveedor: el panel muestra el secreto ya escrito como
      // cabecera y se copia entero. Con el prefijo pegado la variable «está» y
      // la API contesta 401, indistinguible de una llave vencida.
      WZAP_API_KEY_traia_token: /^token\s/i.test(process.env.WZAP_API_KEY?.trim() ?? ''),
      WZAP_WEBHOOK_SECRET: Boolean(process.env.WZAP_WEBHOOK_SECRET),
      CALLBELL_API_KEY: Boolean(llaveCallbell()),
      // Se dice aparte porque es el error más caro de este subsistema: con el
      // prefijo pegado la variable «está» y Callbell contesta 401.
      CALLBELL_API_KEY_traia_bearer: /^bearer\s/i.test(process.env.CALLBELL_API_KEY?.trim() ?? ''),
      CALLBELL_WEBHOOK_SECRET: Boolean(process.env.CALLBELL_WEBHOOK_SECRET),
      OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
      CRON_SECRET: Boolean(env.cronSecret),
      falta,
    },
    // Dos entradas, una por proveedor. Están las dos porque el que lee esto
    // suele estar buscando por qué NO llegó una respuesta, y la mitad de las
    // veces la causa es que configuró el webhook de un proveedor en la URL del
    // otro. Sin secreto la ruta acepta en desarrollo y rechaza en producción: se
    // dice explícitamente porque «el webhook devuelve 401 y nadie sabe por qué»
    // es indistinguible de un problema de red.
    webhooks: {
      wzap: {
        url: `${env.siteUrl}/api/webhooks/wzap`,
        // wzap admite cabecera secreta por webhook, que es lo preferido: las
        // URLs quedan en los logs de todo el camino, las cabeceras no.
        cabecera: process.env.WZAP_WEBHOOK_SECRET
          ? 'x-webhook-secret: <WZAP_WEBHOOK_SECRET>'
          : null,
        evento: 'message:in:new',
        protegido: Boolean(process.env.WZAP_WEBHOOK_SECRET),
      },
      callbell: {
        url: `${env.siteUrl}/api/webhooks/callbell${
          process.env.CALLBELL_WEBHOOK_SECRET ? '?k=<CALLBELL_WEBHOOK_SECRET>' : ''
        }`,
        protegido: Boolean(process.env.CALLBELL_WEBHOOK_SECRET),
      },
    },
    canal: canal
      ? {
          label: canal.label,
          proveedor: canal.provider,
          telefono: canal.phone_e164,
          // En wzap esta columna guarda el `device`.
          channel_uuid: canal.channel_uuid,
          prioridad: canal.prioridad,
          abre_con_plantilla: Boolean(canal.template_uuid),
        }
      : null,
    // Todas las activas y en orden de preferencia: cuál es «la primera» es
    // justamente lo que se viene a verificar acá.
    lineas: lineas.map((l) => ({
      label: l.label,
      proveedor: l.provider,
      telefono: l.phone_e164,
      prioridad: l.prioridad,
    })),
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
      proveedor: canal.provider,
      linea: canal.label,
      hacia: e164,
    },
    { status: r.ok ? 200 : 502 },
  );
}
