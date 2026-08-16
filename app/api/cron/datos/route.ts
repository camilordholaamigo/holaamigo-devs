import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { db } from '@/lib/supabase/admin';
import { conHabilidad } from '@/lib/skills/registry';
import { sincronizar } from '@/lib/integrations/hubspot';
import { proponerLote, correrLote } from '@/lib/integrations/batches';

/**
 * GET /api/cron/datos — la ingesta y los lotes (P6).
 *
 * 15:00 UTC (10 a.m. Bogotá), después del trabajo de la CMO. Tres pasos:
 *
 *   1. Sincroniza las integraciones conectadas hacia `staging_contacts`.
 *   2. Propone el lote de análisis con el que conviene empezar.
 *   3. Corre los lotes que el cliente ya aprobó y pagó.
 *
 * El paso 1 pasa por `conHabilidad`: si el agente no tiene
 * `hubspot.read_contacts` disponible —porque el plan no llega, porque alguien
 * la apagó, o porque su nivel de capacidad no alcanza— **no falla en silencio**:
 * deja un pedido en nuestro admin diciendo qué quería hacer y por qué no pudo.
 *
 * Ese es el "intraer" funcionando de verdad, y no como una idea bonita en un
 * documento.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (env.cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
  }

  const { data: conectadas } = await db()
    .from('integrations')
    .select('organization_id, provider')
    .eq('provider', 'hubspot')
    .in('status', ['connected', 'syncing'])
    .limit(200);

  const reporte = {
    integraciones: (conectadas ?? []).length,
    contactos_traidos: 0,
    lotes_propuestos: 0,
    lotes_corridos: 0,
    contactos_promovidos: 0,
    habilidad_faltante: 0,
    fallidas: 0,
  };

  for (const conexion of conectadas ?? []) {
    const org = conexion.organization_id as string;
    try {
      const resultado = await conHabilidad(
        {
          organizationId: org,
          role: 'sales',
          skillId: 'hubspot.read_contacts',
          justification:
            'Necesito leer los contactos de HubSpot para poder segmentar la base y proponer ' +
            'a quién reactivar. Sin esto la integración está conectada y no sirve para nada.',
        },
        async () => sincronizar({ organizationId: org }),
      );

      if (resultado === null) {
        reporte.habilidad_faltante += 1;
        continue;
      }

      reporte.contactos_traidos += resultado.traidos;

      const cotizacion = await proponerLote({ organizationId: org });
      if (cotizacion.batchId && !cotizacion.saltado) reporte.lotes_propuestos += 1;
    } catch (err) {
      reporte.fallidas += 1;
      console.error(`[cron/datos] sync ${org}`, err);
    }
  }

  // Los lotes aprobados y pagados corren acá y no en el momento de aprobar: el
  // cliente aprueba desde el feed y esa petición tiene que contestar rápido.
  // Analizar 1.200 contactos no cabe en el tiempo de un clic.
  const { data: enCurso } = await db()
    .from('analysis_batches')
    .select('id, organization_id')
    .eq('status', 'running')
    .limit(20);

  for (const lote of enCurso ?? []) {
    try {
      const resultado = await correrLote(lote.id as string);
      reporte.lotes_corridos += 1;
      reporte.contactos_promovidos += resultado.promovidos;
    } catch (err) {
      reporte.fallidas += 1;
      console.error(`[cron/datos] lote ${lote.id}`, err);
    }
  }

  return NextResponse.json({ ok: true, ...reporte });
}
