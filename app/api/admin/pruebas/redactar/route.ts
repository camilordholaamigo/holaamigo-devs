import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { runStructured } from '@/lib/ai/client';
import {
  PruebaLenguajeSchema,
  PruebaLenguajeMinimalSchema,
  inflarPruebaLenguaje,
} from '@/lib/ai/schemas';
import { PRUEBA_REDACTAR_SYSTEM } from '@/config/prompts';
import { hasOpenAI } from '@/lib/env';
import { aperturaSugerida, objetivoSugerido, MAX_SONDAS } from '@/lib/pruebas/guion';

/**
 * POST /api/admin/pruebas/redactar — el borrador, no la prueba.
 *
 * Convierte «clínica estética en Bogotá, quiero saber si abren el lunes y cuánto
 * cuesta el tratamiento de manchas» en un saludo, un objetivo y tres preguntas.
 *
 * **Devuelve texto para un formulario, no una prueba.** Lo que se manda por
 * WhatsApp es lo que quedó escrito en los campos después de que una persona los
 * leyó — eso es la frontera de ADR 0024 y la razón de que el plan sean datos y
 * no un prompt: se puede ver campo por campo, versionar y diffear.
 *
 * Nunca falla hacia afuera. Sin llave, o si el modelo se cae, devuelve las
 * sugerencias determinísticas de `guion.ts` y un `degradado: true` que la
 * pantalla muestra sin adornos. Un botón de ayuda que rompe el formulario cuando
 * falla es peor que no tener el botón.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  negocio: z.string().trim().max(160).default(''),
  producto: z.string().trim().max(240).default(''),
  /** Lo que el operador escribió a las apuradas. Es el input que más pesa. */
  brief: z.string().trim().max(4000).default(''),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });
  }

  const { negocio, producto, brief } = parsed.data;

  if (!negocio && !brief) {
    return NextResponse.json(
      { error: 'Escribí al menos el nombre del negocio o un par de líneas de contexto.' },
      { status: 400 },
    );
  }

  const deReserva = {
    apertura: aperturaSugerida(negocio, producto),
    objetivo: objetivoSugerido(producto),
    preguntas: [] as string[],
    degradado: true,
  };

  if (!hasOpenAI()) {
    return NextResponse.json({ ...deReserva, motivo: 'falta OPENAI_API_KEY' });
  }

  try {
    const r = await runStructured({
      step: 'prueba',
      schemaName: 'prueba_lenguaje',
      schema: PruebaLenguajeSchema,
      system: PRUEBA_REDACTAR_SYSTEM,
      input: armarInput(negocio, producto, brief),
      organizationId: null,
      role: 'cmo',
      trigger: 'smoke_test',
      degradeTo: {
        schema: PruebaLenguajeMinimalSchema,
        schemaName: 'prueba_lenguaje_minimo',
        inflate: inflarPruebaLenguaje,
      },
    });

    return NextResponse.json({
      apertura: r.data.apertura.trim() || deReserva.apertura,
      objetivo: r.data.objetivo.trim() || deReserva.objetivo,
      preguntas: r.data.sondas
        .slice(0, MAX_SONDAS)
        .map((s) => s.pregunta.trim())
        .filter(Boolean),
      degradado: r.degraded,
    });
  } catch (err) {
    console.error('[pruebas] el borrador falló, se devuelven las sugerencias', err);
    return NextResponse.json({
      ...deReserva,
      motivo: err instanceof Error ? err.message.slice(0, 200) : 'el modelo no respondió',
    });
  }
}

function armarInput(negocio: string, producto: string, brief: string): string {
  return [
    negocio ? `NEGOCIO: ${negocio}` : '',
    producto ? `QUÉ VENDE: ${producto}` : '',
    '',
    'LO QUE ESCRIBIÓ EL EQUIPO (esto manda sobre todo lo demás):',
    brief || '(nada — armá una prueba genérica de atención al cliente)',
  ]
    .filter((l) => l !== '')
    .join('\n')
    .slice(0, 8_000);
}
