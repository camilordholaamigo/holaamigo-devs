'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AdminLoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data.error ?? 'No se pudo entrar.');
        setBusy(false);
        return;
      }
      router.push('/admin/prospects');
      router.refresh();
    } catch {
      setError('Sin conexión.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="password"
        autoFocus
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Contraseña"
        className="w-full rounded-xl border border-line bg-paper-raised px-4 py-3.5 text-[15px] text-ink focus:border-money-bright focus:outline-none"
      />
      {error ? <p className="text-[13px] font-medium text-leak">{error}</p> : null}
      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded-xl bg-ink px-6 py-3.5 text-[15px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-50"
      >
        {busy ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
