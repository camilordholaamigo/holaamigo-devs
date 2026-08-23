import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/admin';
import { despublicar, generarInforme, informePorId } from '@/lib/pruebas/informe';
import { sendInformeEmail } from '@/lib/notify';
import { env } from '@/lib/env';
import { isoDaysAgo } from '@/lib/utils';

/**
 * POST /api/admin/pruebas/informes — armar el informe de una organización.
 *
 * Se puede pedir para una organización suelta o para todas las de un lote. Lo
 * segundo es el caso real: se corre la tanda de treinta clientes y después se
 * generan los treinta informes de una.
 *
 * El informe queda `publicado: true` con su `share_token`. Publicado no
 * significa enviado — significa que el enlace funciona. Enviarlo es otra
 * acción, y es de una persona.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const Generar = z.object({
  organizationId: z.string().uuid().nullish(),
  loteId: z.string().uuid().nullish(),
  dias: z.number().int().min(1).max(365).nullish(),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Generar.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const { organizationId, loteId } = parsed.data;
  const desde = isoDaysAgo(parsed.data.dias ?? 30);

  let orgIds: string[] = [];

  if (organizationId) {
    orgIds = [organizationId];
  } else if (loteId) {
    const { data } = await db()
      .from('smoke_probes')
      .select('organization_id')
      .eq('batch_id', loteId)
      .not('organization_id', 'is', null);
    orgIds = [...new Set((data ?? []).map((p) => p.organization_id as string))];
  } else {
    return NextResponse.json({ error: 'Falta organizationId o loteId' }, { status: 400 });
  }

  const hechos: Array<{ organizationId: string; informeId: string; url: string }> = [];
  const vacios: string[] = [];

  for (const org of orgIds) {
    try {
      const informe = await generarInforme({ organizationId: org, desde, batchId: loteId ?? null });
      if (informe) {
        hechos.push({
          organizationId: org,
          informeId: informe.id,
          url: `${env.siteUrl}/informe/${informe.share_token}`,
        });
      } else {
        // Sin conversaciones no hay informe, y eso NO es un error: es una
        // organización cuyo lote no llegó a correr. Se devuelve aparte para
        // que la pantalla lo distinga de un fallo.
        vacios.push(org);
      }
    } catch (err) {
      console.error(`[informe] falló para ${org}`, err);
      vacios.push(org);
    }
  }

  return NextResponse.json({ ok: true, generados: hechos.length, informes: hechos, vacios });
}

/**
 * PATCH — despublicar, o mandar el borrador de correo.
 *
 * El envío pasa por acá y no por el generador a propósito. Es la misma
 * disciplina de `/admin/senales` (ADR 0021): el sistema detecta y redacta,
 * una persona decide qué sale. Un correo automático diciéndole a un prospecto
 * que su equipo contesta mal es exactamente el tipo de mensaje que hay que
 * leer antes de mandar.
 */
const Accion = z.object({
  informeId: z.string().uuid(),
  accion: z.enum(['despublicar', 'enviar']),
  para: z.string().trim().max(254).nullish(),
});

export async function PATCH(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Accion.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  if (parsed.data.accion === 'despublicar') {
    await despublicar(parsed.data.informeId);
    return NextResponse.json({ ok: true, publicado: false });
  }

  const informe = await informePorId(parsed.data.informeId);
  if (!informe.correo?.asunto || !informe.correo?.cuerpo) {
    return NextResponse.json(
      { error: 'Este informe no tiene borrador de correo. Regeneralo con la llave de OpenAI cargada.' },
      { status: 400 },
    );
  }

  const { data: org } = await db()
    .from('organizations')
    .select('owner_email, name, domain')
    .eq('id', informe.organization_id)
    .maybeSingle();

  const para = parsed.data.para?.trim() || org?.owner_email;
  if (!para) {
    return NextResponse.json(
      { error: 'No hay a quién mandarlo: esta organización no tiene correo y no se pasó uno.' },
      { status: 400 },
    );
  }

  const url = `${env.siteUrl}/informe/${informe.share_token}`;

  // El enlace sale del cuerpo y va al botón: el modelo escribe `{{link}}` en
  // medio de una frase, y una URL cruda dentro de un párrafo es una de las
  // señales que más pesan en los filtros de spam.
  const cuerpo = informe.correo.cuerpo
    .replaceAll('{{link}}', '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const r = await sendInformeEmail({
    to: para,
    company: org?.name ?? org?.domain ?? 'tu negocio',
    subject: informe.correo.asunto,
    body: cuerpo,
    url,
  });

  if (!r.sent) {
    return NextResponse.json(
      {
        error:
          r.reason === 'sin_credencial'
            ? 'Falta RESEND_API_KEY. El informe existe y el enlace funciona: se puede mandar a mano.'
            : (r.reason ?? 'No se pudo enviar'),
        url,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, enviado_a: para, url });
}
