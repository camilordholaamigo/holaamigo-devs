import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { interject } from '@/lib/deliberation/room';
import { track } from '@/lib/events';

/**
 * POST /api/deliberations/[id]/interject — el cliente entra a la sala.
 *
 * No es un comentario: es una intervención. Lo que escribe entra como
 * `human_input` con peso 2.0 —pesa MÁS que la evidencia del sistema en la
 * próxima corrida—, aparece en el hilo como un turno, y **reabre la
 * deliberación aunque ya estuviera resuelta**.
 *
 * Eso es el titiritero: no está mandando una orden a un formulario, está
 * entrando a la sala.
 */

export const runtime = 'nodejs';

const Body = z.object({
  organizationId: z.string().uuid(),
  body: z.string().min(3).max(4000),
  stance: z.enum(['object', 'support', 'question']).nullish(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!(await belongsToOrg('deliberations', id, parsed.data.organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  const result = await interject({
    deliberationId: id,
    author: actor.kind === 'admin' ? `admin:${actor.user}` : 'cliente',
    authorType: actor.kind === 'admin' ? 'operator' : 'client',
    body: parsed.data.body,
    stance: parsed.data.stance ?? 'object',
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await track('approval_decided', {
    organizationId: parsed.data.organizationId,
    props: { source: 'sala', deliberation_id: id, reabierta: result.reabierta },
  });

  return NextResponse.json({
    ok: true,
    reabierta: result.reabierta,
    // El mensaje lo arma el servidor y no la pantalla: es una promesa sobre lo
    // que va a pasar después, y tiene que decirla quien la puede cumplir.
    efecto: result.reabierta
      ? 'La deliberación se reabrió. La próxima recomendación tiene que citarte.'
      : 'Quedó en el hilo con peso alto para la próxima corrida.',
  });
}
