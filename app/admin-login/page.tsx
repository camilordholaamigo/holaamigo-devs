import { redirect } from 'next/navigation';
import { currentAdmin } from '@/lib/auth/admin';
import { destinoSeguro } from '@/lib/auth/sesion';
import { AdminLoginForm } from '@/components/admin-login-form';

/**
 * Login del admin. Vive FUERA de /admin a propósito: el layout de /admin es
 * el que bloquea todo lo de adentro, y si el login viviera ahí se bloquearía
 * a sí mismo.
 *
 * `?next=` devuelve a la pantalla donde venció la sesión. Se sanea con
 * `destinoSeguro()` y no se usa crudo: un `next` sin filtrar convierte este
 * formulario en un redirect abierto. Ver lib/auth/sesion.ts.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Entrar · Hola Amigo', robots: { index: false, follow: false } };

export default async function AdminLoginPage({ searchParams }: PageProps<'/admin-login'>) {
  const destino = destinoSeguro((await searchParams).next);

  // Ya entraste y volviste acá: se te manda a donde ibas, no al inicio.
  if (await currentAdmin()) redirect(destino);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2">
          <span className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight text-ink">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            Hola Amigo
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Admin</h1>
        </div>
        <AdminLoginForm destino={destino} />
      </div>
    </main>
  );
}
