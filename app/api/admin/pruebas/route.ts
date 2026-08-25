import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { db, mustWrite } from '@/lib/supabase/admin';
import { faltaParaCanalesPedidos } from '@/lib/pruebas/transporte';
import { crearLote, objetivosDeOrganizaciones, type ObjetivoDeLote } from '@/lib/pruebas/lote';
import { cancelarVivasContra, cerrarPrueba, leerPrueba } from '@/lib/pruebas/motor';
import { evaluarPrueba } from '@/lib/pruebas/evaluador';
import { aE164 } from '@/lib/pruebas/numeros';

/**
 * POST /api/admin/pruebas — **la única forma de crear una prueba a mano.**
 *
 * Antes había dos endpoints que hacían casi lo mismo con palabras distintas: uno
 * para «una prueba» y otro para «una tanda». Nadie sabía cuál usar, y era la
 * mitad del problema que arregla ADR 0027. Ahora hay uno, y el producto
 * cartesiano decide qué sale:
 *
 *     números × líneas × guiones = conversaciones
 *
 * Con `1 × 1 × 1` es una conversación suelta y la respuesta trae `destino`
 * apuntando a su transcripción. Con más, apunta a la pantalla de la prueba.
 *
 * ── QUÉ SE MANDA ───────────────────────────────────────────────────────────
 *
 *   `aMedida`     el guion que escribió una persona. No necesita research, ni
 *                 organización, ni nada: sirve para probar cualquier número.
 *   `plantillas`  los moldes de fábrica, compilados contra el research de cada
 *                 organización. Es el camino del QA de clientes.
 *
 * ── A QUIÉN ────────────────────────────────────────────────────────────────
 *
 *   `numeros`          teléfonos escritos a mano.
 *   `organizationIds`  las líneas que ya conocemos de esas organizaciones,
 *                      sacadas de `smoke_targets`, donde el research las dejó
 *                      con su fuente. No inventa ninguna.
 *
 * El precheque del entorno pasa ANTES de crear nada. Un 400 que dice
 * `{ falta: { CALLBELL_API_KEY: true } }` ahorra horas comparado con una prueba
 * que se creó, quedó en `pending` y «no hizo nada».
 */

export const runtime = 'nodejs';
// Compilar un plan por (objetivo × guion) y arrancar las primeras dentro del
// ritmo. Con el presupuesto de 200 s de `avanzarLote` más la compilación, 300 s
// es el techo justo.
export const maxDuration = 300;

const Numero = z.object({
  telefono: z.string().trim().min(7).max(30),
  nombre: z.string().trim().max(120).nullish(),
  organizationId: z.string().uuid().nullish(),
});

/** El guion escrito a mano. Espeja `EntradaAMedida` de lib/pruebas/guion.ts. */
const AMedida = z.object({
  modo: z.enum(['conversar', 'guion']),
  negocio: z.string().trim().max(160),
  producto: z.string().trim().max(240).default(''),
  apertura: z.string().trim().max(700).default(''),
  objetivo: z.string().trim().max(700).default(''),
  preguntas: z.array(z.string().max(400)).max(12).default([]),
  guion: z.array(z.string().max(700)).max(12).default([]),
  contexto: z.string().max(4000).nullish(),
  instrucciones: z.string().max(1000).nullish(),
  persona: z
    .object({
      nombre: z.string().max(120),
      correo: z.string().max(160),
      telefono: z.string().max(40),
      ciudad: z.string().max(80),
      presupuesto: z.string().max(120),
    })
    .partial()
    .default({}),
  maxTurnos: z.number().int().min(2).max(40).default(10),
});

const Crear = z
  .object({
    nombre: z.string().trim().max(140).nullish(),
    proposito: z.enum(['qa', 'prospeccion']).default('prospeccion'),
    numeros: z.array(Numero).max(200).default([]),
    organizationIds: z.array(z.string().uuid()).max(200).nullish(),
    canales: z.array(z.string().uuid()).min(1).max(8),
    aMedida: AMedida.nullish(),
    plantillas: z.array(z.string().trim().min(1).max(60)).max(6).nullish(),
    maxConcurrentes: z.number().int().min(1).max(12).default(3),
    ritmoSegundos: z.number().int().min(0).max(3600).default(45),
    notas: z.string().max(1000).nullish(),
  })
  .refine((b) => b.numeros.length + (b.organizationIds?.length ?? 0) > 0, {
    message: 'Escribí al menos un número, o elegí una organización.',
  })
  .refine((b) => Boolean(b.aMedida) || (b.plantillas?.length ?? 0) > 0, {
    message: 'Elegí un molde de prueba, o escribí un guion.',
  });

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Crear.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Petición inválida' },
      { status: 400 },
    );
  }

  const falta = await faltaParaCanalesPedidos(parsed.data.canales);
  if (Object.keys(falta).length > 0) {
    return NextResponse.json(
      { error: `Falta configurar ${Object.keys(falta).join(', ')} en Vercel.`, falta },
      { status: 400 },
    );
  }

  const d = parsed.data;

  const desdeOrgs = d.organizationIds?.length
    ? await objetivosDeOrganizaciones(d.organizationIds)
    : [];

  const aMano: ObjetivoDeLote[] = d.numeros.map((o) => ({
    organizationId: o.organizationId ?? null,
    telefono: o.telefono,
    nombre: o.nombre ?? null,
  }));

  const objetivos = [...desdeOrgs, ...aMano];

  const r = await crearLote({
    nombre: d.nombre?.trim() || nombrePorDefecto(d.aMedida?.negocio ?? null, objetivos.length),
    proposito: d.proposito,
    objetivos,
    canales: d.canales,
    plantillas: d.plantillas ?? null,
    // `.nullish()` de zod deja `undefined` en la mesa y `EntradaAMedida` pide
    // `string | null`. Se normaliza acá y no allá: el tipo del plan es el
    // contrato, y aflojarlo para que entre una forma del parser sería empezar a
    // deber `?? null` en cada consumidor.
    aMedida: d.aMedida
      ? {
          ...d.aMedida,
          contexto: d.aMedida.contexto ?? null,
          instrucciones: d.aMedida.instrucciones ?? null,
        }
      : null,
    maxConcurrentes: d.maxConcurrentes,
    ritmoSegundos: d.ritmoSegundos,
    creadoPor: admin.user,
    notas: d.notas ?? null,
  });

  if (r.error) {
    // Los omitidos van SIEMPRE, también cuando no arrancó nada. Una prueba que
    // dice «no se pudo» sin decir por qué se cayó cada línea es una prueba que
    // nadie vuelve a usar.
    return NextResponse.json({ error: r.error, omitidos: r.omitidos }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    loteId: r.loteId,
    pruebas: r.pruebas,
    conversaciones: r.conversaciones,
    omitidos: r.omitidos,
    // Con una sola conversación se cae en la transcripción. Es la decisión 6 de
    // ADR 0027: si la herramienta no te deja ver lo que acaba de hacer, no la
    // volvés a abrir.
    destino:
      r.conversaciones.length === 1
        ? `/admin/pruebas/${r.conversaciones[0]}`
        : `/admin/pruebas/lotes/${r.loteId}`,
  });
}

function nombrePorDefecto(negocio: string | null, cuantos: number): string {
  const quien = (negocio ?? '').trim();
  if (quien) return quien.slice(0, 120);
  return cuantos === 1 ? 'Prueba de una línea' : `Prueba de ${cuantos} líneas`;
}

/**
 * GET /api/admin/pruebas?telefono=… — lo que hay que saber ANTES de escribir.
 *
 * Contesta tres cosas sobre un número: si está bloqueado, cuándo fue la última
 * vez que le escribimos, y si ya lo conocemos con nombre y organización.
 *
 * Existe porque el camino manual no tiene enfriamiento (ADR 0027, decisión 5) y
 * la contrapartida acordada es que el operador VEA que le escribimos hace doce
 * minutos antes de volver a hacerlo. Un freno que decide una persona informada
 * es mejor que un freno automático que la deja sin poder retestear al cliente
 * al que le acaba de cambiar el prompt.
 */
export async function GET(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const crudo = new URL(request.url).searchParams.get('telefono') ?? '';
  const e164 = aE164(crudo, 'CO');
  if (!e164) {
    return NextResponse.json({ conocido: false, e164: null }, { headers: sinCache });
  }

  const { data } = await db()
    .from('smoke_targets')
    .select('nombre, organization_id, ultima_prueba_at, bloqueado, bloqueado_motivo, source_url')
    .eq('phone_e164', e164)
    .maybeSingle();

  return NextResponse.json(
    {
      conocido: Boolean(data),
      e164,
      nombre: data?.nombre ?? null,
      organizationId: data?.organization_id ?? null,
      ultimaPruebaAt: data?.ultima_prueba_at ?? null,
      bloqueado: Boolean(data?.bloqueado),
      bloqueadoMotivo: data?.bloqueado_motivo ?? null,
      fuente: data?.source_url ?? null,
    },
    { headers: sinCache },
  );
}

const sinCache = { 'cache-control': 'no-store' } as const;

/**
 * PATCH /api/admin/pruebas — cancelar, recalificar, o desbloquear un número.
 *
 * Cancelar existe porque una conversación corre veinte minutos y el botón de
 * parar es parte de la versión 1, no del backlog.
 */
const Accion = z.object({
  accion: z.enum(['cancelar', 'reevaluar', 'desbloquear']),
  pruebaId: z.string().uuid().nullish(),
  targetId: z.string().uuid().nullish(),
});

export async function PATCH(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Accion.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });
  }

  const { accion, pruebaId, targetId } = parsed.data;

  if (accion === 'cancelar') {
    if (!pruebaId) return NextResponse.json({ error: 'falta pruebaId' }, { status: 400 });
    const prueba = await leerPrueba(pruebaId);
    // `null` y no `prueba.channel_id`: cancelar a mano desde el admin quiere
    // decir «parale a todo lo que le estemos escribiendo a este señor», no
    // «parale solo desde esta línea».
    await cancelarVivasContra(prueba.target_phone, null);
    await cerrarPrueba(pruebaId, {
      estado: 'cancelled',
      cerroCon: null,
      motivo: `Cancelada a mano por ${admin.user}.`,
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  if (accion === 'reevaluar') {
    if (!pruebaId) return NextResponse.json({ error: 'falta pruebaId' }, { status: 400 });
    // Se borra la evaluación anterior: `evaluarPrueba` es idempotente y
    // devuelve la que ya está si existe.
    await mustWrite(
      db()
        .from('smoke_probes')
        .update({ evaluacion: null, evaluacion_score: null })
        .eq('id', pruebaId),
      'smoke_probes.reevaluar',
    );
    after(() => evaluarPrueba(pruebaId).catch(() => {}));
    return NextResponse.json({ ok: true, encolado: true });
  }

  // Desbloquear. Es el único camino de vuelta de un número que pidió no ser
  // contactado, y pasa por una persona a propósito: nada automático puede
  // revertir esa decisión.
  if (!targetId) return NextResponse.json({ error: 'falta targetId' }, { status: 400 });
  await mustWrite(
    db()
      .from('smoke_targets')
      .update({
        bloqueado: false,
        bloqueado_motivo: `Desbloqueado por ${admin.user} el ${new Date().toISOString().slice(0, 10)}`,
      })
      .eq('id', targetId),
    'smoke_targets.desbloquear',
  );
  return NextResponse.json({ ok: true });
}
