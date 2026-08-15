import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkPassword, issueToken, setAdminCookie, clearAdminCookie } from '@/lib/auth/admin';
import { checkRateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/utils';

export const runtime = 'nodejs';

const Body = z.object({ password: z.string().max(200) });

export async function POST(request: Request) {
  const ip = clientIp(request.headers) ?? 'desconocida';

  // 10 intentos por hora por IP. Una contraseña compartida sin rate limit es
  // una contraseña adivinable.
  const limit = await checkRateLimit(`admin:login:${ip}`, 10, 3600);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Espera una hora.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  if (!checkPassword(parsed.data.password)) {
    return NextResponse.json({ error: 'Contraseña incorrecta.' }, { status: 401 });
  }

  await setAdminCookie(issueToken('admin'));
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await clearAdminCookie();
  return NextResponse.json({ ok: true });
}
