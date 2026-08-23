import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { db, mustWrite } from '@/lib/supabase/admin';
import { faltaParaEnviar } from '@/lib/pruebas/callbell';
import { lanzarDesdeAdmin } from '@/lib/pruebas/lanzar';
import { cancelarVivasContra, cerrarPrueba, leerPrueba } from '@/lib/pruebas/motor';
import { evaluarPrueba } from '@/lib/pruebas/evaluador';

/**
 * POST /api/admin/pruebas — crear una prueba a mano.
 *
 * El camino que no necesita diagnóstico: se elige el tipo de prueba, se escribe
 * el número y el nombre al que se apunta, y sale. Es lo que se usa para probar
 * la línea de un prospecto que llegó por otro lado, o para volver a medir a un
 * cliente después de haberle cambiado algo.
 *
 * Si además se pasa `organizationId`, la prueba se compila con el research de
 * esa organización y mide exactitud contra su sitio. Sin él, mide atención:
 * si contestan, en cuánto, y si proponen un paso siguiente. La diferencia se
 * ve en `cobertura` y se muestra en la pantalla sin adornos.
 *
 * El precheque del entorno pasa ANTES de crear nada. Un 400 que dice
 * `{ falta: { CALLBELL_API_KEY: true } }` ahorra horas comparado con una
 * prueba que se creó y «no hizo nada».
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const Crear = z.object({
  telefono: z.string().trim().min(7).max(30),
  nombre: z.string().trim().max(120).nullish(),
  plantillas: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
  organizationId: z.string().uuid().nullish(),
  canalId: z.string().uuid().nullish(),
  contexto: z.string().max(4000).nullish(),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Crear.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });
  }

  const falta = faltaParaEnviar();
  if (Object.keys(falta).length > 0) {
    return NextResponse.json(
      {
        error: `Falta configurar ${Object.keys(falta).join(', ')} en Vercel.`,
        falta,
      },
      { status: 400 },
    );
  }

  const r = await lanzarDesdeAdmin({
    organizationId: parsed.data.organizationId ?? null,
    telefono: parsed.data.telefono,
    nombre: parsed.data.nombre ?? null,
    plantillas: parsed.data.plantillas,
    canalId: parsed.data.canalId ?? null,
    contextoManual: parsed.data.contexto ?? null,
  });

  if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
  if (!r.runId) {
    return NextResponse.json({ error: r.motivo ?? 'no se pudo crear' }, { status: 400 });
  }

  return NextResponse.json({ ok: true, runId: r.runId, pruebas: r.pruebas });
}

/**
 * PATCH /api/admin/pruebas — cancelar, recalificar, o desbloquear un número.
 *
 * Cancelar existe porque una prueba corre veinte minutos y el botón de parar es
 * parte de la versión 1, no del backlog.
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
    await cancelarVivasContra(prueba.target_phone);
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
