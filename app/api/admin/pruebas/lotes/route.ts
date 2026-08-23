import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { crearLote, objetivosDeOrganizaciones, type ObjetivoDeLote } from '@/lib/pruebas/lote';

/**
 * POST /api/admin/pruebas/lotes — arrancar una tanda.
 *
 * Dos formas de decir a quién:
 *
 *   `organizationIds`  · las líneas que ya conocemos de esas organizaciones,
 *                        sacadas de `smoke_targets`. Es el camino del QA: se
 *                        eligen treinta clientes de una lista, no se pegan
 *                        treinta teléfonos.
 *   `objetivos`        · teléfonos escritos a mano. Para lo que no está en la
 *                        base todavía.
 *
 * Se pueden combinar; se deduplica por número.
 *
 * El `proposito` no es una etiqueta: gobierna qué frenos aplican. Ver
 * `resolverObjetivos()` en lib/pruebas/lote.ts.
 */

export const runtime = 'nodejs';
// Compilar una prueba por (línea × plantilla) y arrancar las primeras dentro
// del ritmo. Con el presupuesto de 200 s de `avanzarLote` más la compilación,
// 300 s es el techo justo.
export const maxDuration = 300;

const Body = z
  .object({
    nombre: z.string().trim().min(2).max(120),
    proposito: z.enum(['qa', 'prospeccion']),
    plantillas: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
    organizationIds: z.array(z.string().uuid()).max(200).nullish(),
    objetivos: z
      .array(
        z.object({
          telefono: z.string().trim().min(7).max(30),
          nombre: z.string().trim().max(120).nullish(),
          organizationId: z.string().uuid().nullish(),
        }),
      )
      .max(200)
      .nullish(),
    maxConcurrentes: z.number().int().min(1).max(12),
    ritmoSegundos: z.number().int().min(0).max(3600),
    canalId: z.string().uuid().nullish(),
    notas: z.string().max(1000).nullish(),
  })
  .refine(
    (b) => (b.organizationIds?.length ?? 0) + (b.objetivos?.length ?? 0) > 0,
    { message: 'Hay que elegir al menos una organización o escribir un número.' },
  );

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Petición inválida' },
      { status: 400 },
    );
  }

  const d = parsed.data;

  const desdeOrgs = d.organizationIds?.length
    ? await objetivosDeOrganizaciones(d.organizationIds)
    : [];

  const aMano: ObjetivoDeLote[] = (d.objetivos ?? []).map((o) => ({
    organizationId: o.organizationId ?? null,
    telefono: o.telefono,
    nombre: o.nombre ?? null,
  }));

  const r = await crearLote({
    nombre: d.nombre,
    proposito: d.proposito,
    objetivos: [...desdeOrgs, ...aMano],
    plantillas: d.plantillas,
    maxConcurrentes: d.maxConcurrentes,
    ritmoSegundos: d.ritmoSegundos,
    canalId: d.canalId ?? null,
    creadoPor: admin.user,
    notas: d.notas ?? null,
  });

  if (r.error) {
    // Los omitidos van SIEMPRE, también cuando no arrancó nada. Un lote que
    // dice «no se pudo» sin decir por qué se cayó cada línea es un lote que
    // nadie vuelve a usar.
    return NextResponse.json({ error: r.error, omitidos: r.omitidos }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    loteId: r.loteId,
    pruebas: r.pruebas,
    omitidos: r.omitidos,
  });
}
