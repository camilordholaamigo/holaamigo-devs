import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { markPaid } from '@/lib/commerce/orders';

/**
 * PATCH /api/orders/[id] — marcar una orden como pagada.
 *
 * v1: lo hace una persona desde la consola cuando confirma el pago por su
 * medio actual (transferencia, link de la pasarela que ya usa el cliente,
 * efectivo). Es exactamente el paso manual que el ADR 0013 dice que hay que
 * hacer tres veces antes de automatizarlo.
 *
 * Cuando conectemos la pasarela, el webhook llama a la misma función con la
 * misma firma. Esta ruta se queda para las ventas cobradas por fuera.
 */

export const runtime = 'nodejs';

const Body = z.object({
  organizationId: z.string().uuid(),
  action: z.literal('mark_paid'),
  externalId: z.string().max(120).nullish(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!(await belongsToOrg('orders', id, parsed.data.organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  const result = await markPaid({
    orderId: id,
    externalId: parsed.data.externalId ?? null,
    by: actor.kind === 'admin' ? `admin:${actor.user}` : 'cliente',
  });

  if (!result.ok) {
    return NextResponse.json({ error: 'Esa orden ya no estaba pendiente.' }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
