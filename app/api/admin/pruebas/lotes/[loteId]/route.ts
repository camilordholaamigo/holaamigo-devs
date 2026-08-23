import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/admin';
import {
  avanzarLote,
  cerrarLoteSiTerminó,
  estadoDelLote,
  leerLote,
  pausarLote,
} from '@/lib/pruebas/lote';

/**
 * GET /api/admin/pruebas/lotes/[loteId] — el estado del lote, y su motor.
 *
 * Hace dos cosas, y la segunda es la que importa: **empuja la cola**. Mientras
 * alguien tiene la pantalla del lote abierta, este GET corre cada pocos
 * segundos y va arrancando lo que quepa dentro del tope. Es el mismo patrón
 * que el GET de estado de una prueba, y por la misma razón: en un plan donde
 * el cron corre una vez al día, la única cosa que corre con la frecuencia del
 * problema es la pantalla que alguien está mirando.
 *
 * El avance va en `after()` y no antes de responder. Con el ritmo por defecto
 * de 45 segundos, hacerlo en línea dejaría la pantalla esperando cada vez que
 * hay cupo libre — y el usuario leería eso como «se colgó».
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ loteId: string }> },
) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { loteId } = await params;

  const lote = await leerLote(loteId).catch(() => null);
  if (!lote) return NextResponse.json({ error: 'Lote no encontrado' }, { status: 404 });

  const estado = await estadoDelLote(loteId);

  const { data: pruebas } = await db()
    .from('smoke_probes')
    .select(
      `id, template_id, target_phone, estado, cerro_con, turno, max_turnos,
       segundos_primera_respuesta, auditoria_score, evaluacion_score, organization_id,
       enviado_at, error,
       smoke_targets ( nombre )`,
    )
    .eq('batch_id', loteId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (lote.estado === 'running') {
    after(async () => {
      try {
        await avanzarLote(loteId);
        await cerrarLoteSiTerminó(loteId);
      } catch (err) {
        console.error('[lote] el avance de fondo falló', err);
      }
    });
  }

  return NextResponse.json(
    { lote, estado, pruebas: pruebas ?? [] },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * PATCH — pausar, reanudar o cancelar.
 *
 * Cancelar mata lo que no arrancó y **deja terminar lo que ya está
 * conversando**. Cortar a mitad una conversación con un negocio real por una
 * decisión operativa nuestra es peor que gastar los tres mensajes que faltan:
 * del otro lado hay una persona que quedó hablando sola.
 */
const Accion = z.object({ accion: z.enum(['pausar', 'reanudar', 'cancelar']) });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ loteId: string }> },
) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { loteId } = await params;
  const parsed = Accion.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const mapa = {
    pausar: 'paused',
    reanudar: 'running',
    cancelar: 'cancelled',
  } as const;

  await pausarLote(loteId, mapa[parsed.data.accion]);

  if (parsed.data.accion === 'reanudar') {
    after(() => avanzarLote(loteId).catch(() => {}));
  }

  return NextResponse.json({ ok: true, estado: mapa[parsed.data.accion] });
}
