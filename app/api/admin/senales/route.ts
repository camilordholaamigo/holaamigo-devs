import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { promoverSenal, descartarSenal } from '@/lib/cmo/upsell';

/**
 * POST /api/admin/senales — mover una señal por la escalera.
 *
 * Solo admin. No hay versión de esta ruta para el cliente y no la va a haber:
 * el salto de `proposed_internal` a `proposed_client` es exactamente el punto
 * donde alguien nuestro mira la cuenta y decide si eso se ofrece o no.
 */

export const runtime = 'nodejs';

const Body = z.object({
  signalId: z.string().uuid(),
  accion: z.enum(['promover', 'descartar']),
  nota: z.string().max(1000).nullish(),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  if (parsed.data.accion === 'descartar') {
    if (!parsed.data.nota?.trim()) {
      // Misma asimetría que en el feed del cliente: aprobar es un clic,
      // descartar exige decir por qué. Es la única señal de aprendizaje que
      // tenemos sobre qué señales no sirven.
      return NextResponse.json(
        { error: 'Descartar exige una nota: es lo que evita que la volvamos a detectar igual.' },
        { status: 400 },
      );
    }
    await descartarSenal(parsed.data.signalId, `${parsed.data.nota} — ${admin.user}`);
    return NextResponse.json({ ok: true, status: 'dismissed' });
  }

  const result = await promoverSenal({
    signalId: parsed.data.signalId,
    por: admin.user,
    nota: parsed.data.nota ?? null,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, status: result.status });
}
