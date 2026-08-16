import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { respondFeedItem } from '@/lib/feed/items';
import { db } from '@/lib/supabase/admin';

/**
 * POST /api/feed/batch — aprobar en lote.
 *
 * Solo para tarjetas de severidad baja o normal, y el filtro está acá y no en
 * la pantalla. Una decisión de severidad alta —lanzar una campaña que va a
 * gastar créditos, mover presupuesto— tiene que costar un clic propio. Si se
 * pudieran aprobar diez de una, el primer día que alguien lo hace sin leer,
 * todo el modelo de "el humano decide" se volvió teatro.
 *
 * Rechazar en lote NO existe, y es a propósito: rechazar exige nota, y una
 * nota compartida por diez rechazos distintos no enseña nada.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({
  organizationId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(20),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const { organizationId, ids } = parsed.data;

  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { data: items } = await db()
    .from('feed_items')
    .select('id, severity, status')
    .eq('organization_id', organizationId)
    .in('id', ids);

  const aprobables = (items ?? []).filter((i) => i.status === 'open' && i.severity !== 'high');
  const rechazadas = (items ?? []).filter((i) => i.severity === 'high').length;

  const resultados: Array<{ id: string; ok: boolean; effect?: string; error?: string }> = [];

  for (const item of aprobables) {
    if (!(await belongsToOrg('feed_items', item.id, organizationId))) continue;
    const result = await respondFeedItem(item.id, {
      decision: 'approved',
      by: actor.kind === 'admin' ? `admin:${actor.user}` : 'cliente',
    });
    resultados.push({ id: item.id, ok: result.ok, effect: result.effect, error: result.error });
  }

  return NextResponse.json({
    ok: true,
    aprobadas: resultados.filter((r) => r.ok).length,
    fallidas: resultados.filter((r) => !r.ok).length,
    // Se dice explícito en vez de ignorarlas en silencio: el cliente marcó diez
    // y aprobó ocho, y tiene que saber cuáles quedaron y por qué.
    excluidas_por_severidad: rechazadas,
    resultados,
  });
}
