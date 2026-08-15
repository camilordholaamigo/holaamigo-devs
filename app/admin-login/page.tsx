import { redirect } from 'next/navigation';
import { currentAdmin } from '@/lib/auth/admin';
import { AdminLoginForm } from '@/components/admin-login-form';

/**
 * Login del admin. Vive FUERA de /admin a propósito: el layout de /admin es
 * el que bloquea todo lo de adentro, y si el login viviera ahí se bloquearía
 * a sí mismo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Entrar · Hola Amigo', robots: { index: false, follow: false } };

export default async function AdminLoginPage() {
  if (await currentAdmin()) redirect('/admin/prospects');

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
        <AdminLoginForm />
      </div>
    </main>
  );
}
