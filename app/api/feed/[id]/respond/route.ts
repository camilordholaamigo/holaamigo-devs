import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { respondFeedItem } from '@/lib/feed/items';

/**
 * POST /api/feed/[id]/respond — responder al President.
 *
 * Tres formas de responder:
 *   · approved / rejected → propuestas. Rechazar exige nota.
 *   · answered            → peticiones: el link del video, el dato, el texto.
 *   · dismissed           → "ya lo vi, no hagas nada".
 *
 * El efecto de aprobar (activar la campaña, programar los envíos) vive en
 * `respondFeedItem`, no acá: la ruta es transporte, la decisión y sus
 * consecuencias son dominio.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({
  organizationId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected', 'answered', 'dismissed']),
  note: z.string().max(2000).nullish(),
  /** Para los `ask`: {url} de un video, {texto} de un copy, lo que sea. */
  payload: z.record(z.string(), z.unknown()).nullish(),
  /**
   * Lo que el cliente movió antes de aprobar (P3). Números y listas de strings,
   * nunca texto libre: son los valores de los controles que la propuesta
   * declaró. El tipo estrecho es la garantía de que "Ajustar" no se convierta
   * con el tiempo en otra caja de texto con otro nombre.
   */
  ajustes: z.record(z.string(), z.union([z.number(), z.array(z.string())])).nullish(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const { organizationId, decision, note, payload, ajustes } = parsed.data;

  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!(await belongsToOrg('feed_items', id, organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  const result = await respondFeedItem(id, {
    decision,
    note: note ?? null,
    payload: payload ?? undefined,
    ajustes: ajustes ?? undefined,
    by: actor.kind === 'admin' ? `admin:${actor.user}` : 'cliente',
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true, effect: result.effect ?? null });
}
