'use client';

import { useRouter } from 'next/navigation';

export function AdminLogout() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        await fetch('/api/admin/login', { method: 'DELETE' });
        router.push('/admin-login');
        router.refresh();
      }}
      className="text-[13px] text-ink-faint underline underline-offset-4 transition hover:text-ink"
    >
      Salir
    </button>
  );
}
