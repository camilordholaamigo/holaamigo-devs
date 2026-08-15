import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Autenticación del admin.
 *
 * DECISIÓN v1: contraseña compartida + cookie firmada con HMAC, no Supabase
 * Auth. Razón: el admin lo usan 3 personas del equipo interno, y montar
 * Supabase Auth exige SMTP configurado en el proyecto de Rentmies, magic links
 * y una allowlist que mantener — trabajo que no mueve la aguja de las ventas
 * esta semana. Una cookie HMAC httpOnly + Secure + SameSite=Lax es segura
 * frente a lo que realmente nos amenaza (nadie tiene la URL del admin) y se
 * cambia por Supabase Auth en una tarde cuando haya usuarios reales.
 *
 * Lo que SÍ es innegociable y ya está: la cookie va firmada (no es un flag
 * booleano), la comparación de contraseña es en tiempo constante, y el middleware
 * bloquea /admin y /api/admin completos.
 *
 * Ver docs/adr/0005-auth-admin.md
 */

const COOKIE = 'ha_admin';
const TTL_SECONDS = 60 * 60 * 12;

function sign(payload: string): string {
  return createHmac('sha256', env.adminSecret).update(payload).digest('base64url');
}

export function issueToken(user = 'admin'): string {
  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  const nonce = randomBytes(8).toString('base64url');
  const payload = `${user}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): { user: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;

  const [user, expiresAt, nonce, signature] = parts;
  const payload = `${user}.${expiresAt}.${nonce}`;
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiresAt) < Date.now()) return null;

  return { user };
}

/** Comparación en tiempo constante contra ADMIN_PASSWORD. */
export function checkPassword(candidate: string): boolean {
  const expected = env.adminPassword;
  const a = Buffer.from(candidate ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Igual gastamos el tiempo, para no filtrar la longitud por temporización.
    timingSafeEqual(Buffer.from(expected), Buffer.from(expected));
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function currentAdmin(): Promise<{ user: string } | null> {
  const store = await cookies();
  return verifyToken(store.get(COOKIE)?.value);
}

export async function setAdminCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_SECONDS,
  });
}

export async function clearAdminCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export const ADMIN_COOKIE_NAME = COOKIE;
