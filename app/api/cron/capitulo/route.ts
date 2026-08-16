import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { writeChapter, organizacionesConAgentes } from '@/lib/feed/chapter';

/**
 * GET /api/cron/capitulo — el capítulo de cada mañana (P3).
 *
 * 12:00 UTC = 7 a.m. en Bogotá. La hora está fija y en el cron, no configurable
 * por cliente: cuando sea configurable habrá que correr esto cada hora y filtrar
 * por zona horaria, y eso es trabajo que hoy no compra nada — todos nuestros
 * clientes están en el mismo huso.
 *
 * Es idempotente por día: `chapters_dia_key` no deja escribir dos capítulos del
 * mismo día, y `writeChapter` devuelve el que ya existía. Un reintento de Vercel
 * no duplica la serie.
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

  const orgs = await organizacionesConAgentes();
  const reporte = { organizaciones: orgs.length, escritos: 0, degradados: 0, saltados: 0, fallidos: 0 };

  for (const org of orgs) {
    try {
      const capitulo = await writeChapter(org);
      if (capitulo.saltado) reporte.saltados += 1;
      else {
        reporte.escritos += 1;
        if (capitulo.degradado) reporte.degradados += 1;
      }
    } catch (err) {
      // Una organización que falla no puede dejar sin capítulo a las demás.
      reporte.fallidos += 1;
      console.error(`[cron/capitulo] ${org}`, err);
    }
  }

  return NextResponse.json({ ok: true, ...reporte });
}
