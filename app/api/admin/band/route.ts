import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { overrideBand } from '@/lib/scoring';

export const runtime = 'nodejs';

const Body = z.object({
  organizationId: z.string().uuid(),
  band: z.enum(['auto', 'assist', 'attack']),
  note: z.string().trim().min(3).max(500),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'La nota es obligatoria y debe tener al menos 3 caracteres.' },
      { status: 400 },
    );
  }

  try {
    await overrideBand({ ...parsed.data, by: admin.user });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[admin/band] fallo', err);
    return NextResponse.json({ error: 'No se pudo guardar.' }, { status: 500 });
  }
}
