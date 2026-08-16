import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor } from '@/lib/auth/console';
import { replyToThread, markThreadHandled } from '@/lib/email/reply';

/**
 * POST /api/threads/[id] — responder o cerrar una conversación.
 *
 * La respuesta sale por la misma bandeja que envió el original: ver el
 * comentario de lib/email/reply.ts sobre por qué no abrimos un `mailto:`.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  organizationId: z.string().uuid(),
  action: z.enum(['reply', 'handled']),
  body: z.string().max(5000).nullish(),
  status: z.enum(['open', 'won', 'lost', 'closed']).nullish(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const by = actor.kind === 'admin' ? `admin:${actor.user}` : 'cliente';

  if (parsed.data.action === 'reply') {
    if (!parsed.data.body?.trim()) {
      return NextResponse.json({ error: 'Escribe algo antes de enviar.' }, { status: 400 });
    }
    const result = await replyToThread({
      threadId: id,
      organizationId: parsed.data.organizationId,
      body: parsed.data.body.trim(),
      by,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const result = await markThreadHandled({
    threadId: id,
    organizationId: parsed.data.organizationId,
    by,
    status: parsed.data.status ?? undefined,
  });

  if (!result.ok) return NextResponse.json({ error: 'No pudimos actualizar.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
