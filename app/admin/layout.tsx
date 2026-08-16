import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/admin';
import { AdminLogout } from '@/components/admin-logout';

/**
 * Puerta del admin. Todo lo que cuelga de /admin pasa por aquí.
 *
 * La verificación es server-side y en cada request: la cookie está firmada con
 * HMAC y se valida contra el secreto, no es un flag booleano que se pueda
 * escribir desde la consola del navegador.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

const NAV = [
  { href: '/admin/prospects', label: 'Prospectos' },
  { href: '/admin/approvals', label: 'Cola' },
  // Las señales de upsell viven acá y NO en la consola del cliente. Esa
  // separación es la disciplina de P5: la CMO detecta, nosotros decidimos qué
  // se le ofrece. Ver docs/adr/0021-la-cmo-expandida.md
  { href: '/admin/senales', label: 'Señales' },
  { href: '/admin/agents', label: 'Agentes' },
  { href: '/admin/runs', label: 'Corridas' },
  { href: '/admin/modelos', label: 'Modelos' },
];

export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  const admin = await currentAdmin();
  if (!admin) redirect('/admin-login');

  const [{ count: pending }, { count: attack }] = await Promise.all([
    db().from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    db().from('prospect_scores').select('organization_id', { count: 'exact', head: true }).eq('band', 'attack'),
  ]);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-7 gap-y-3 px-6 py-4">
          <Link href="/admin/prospects" className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            <span className="text-[13px] font-semibold tracking-tight text-ink">Hola Amigo</span>
            <span className="text-[13px] text-ink-faint">admin</span>
          </Link>

          <nav className="flex items-center gap-5">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[13.5px] font-medium text-ink-soft transition hover:text-ink"
              >
                {item.label}
                {item.href === '/admin/approvals' && pending ? (
                  <span className="tnum ml-1.5 rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-paper">
                    {pending}
                  </span>
                ) : null}
                {item.href === '/admin/prospects' && attack ? (
                  <span className="tnum ml-1.5 rounded-full bg-leak px-1.5 py-0.5 text-[10px] font-semibold text-paper">
                    {attack}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>

          <div className="ml-auto">
            <AdminLogout />
          </div>
        </div>
      </header>

      <div className="flex-1">{children}</div>
    </div>
  );
}
