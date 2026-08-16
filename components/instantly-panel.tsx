'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@/components/ui';

/**
 * Conectar Instantly y traer sus listas.
 *
 * La base legal se pide igual que en la carga de un CSV, y no es burocracia:
 * que los contactos lleguen por API no los hace más contactables. La obligación
 * de Habeas Data es sobre a quién le escribimos, no sobre cómo llegó el archivo.
 */

export interface InstantlyList {
  id: string;
  name: string;
  count: number | null;
}

export function InstantlyPanel({
  orgId,
  connected,
  lists,
  lastSync,
  lastError,
}: {
  orgId: string;
  connected: boolean;
  lists: InstantlyList[];
  lastSync: string | null;
  lastError: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [apiKey, setApiKey] = useState('');
  const [consent, setConsent] = useState('legitimate_interest');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function connect() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch('/api/integrations/instantly', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, apiKey: apiKey.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos conectar.');
        return;
      }
      setApiKey('');
      setMessage('Conectado. Abajo aparecen tus listas.');
      router.refresh();
    });
  }

  function importList(list: InstantlyList) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch('/api/integrations/instantly', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: orgId,
          listId: list.id,
          listName: list.name,
          consentBasis: consent,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; imported?: number };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos importar.');
        return;
      }
      setMessage(`Importados ${data.imported ?? 0} contactos nuevos de "${list.name}".`);
      router.refresh();
    });
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[14px] font-semibold text-ink">Instantly</span>
        <Badge tone={connected ? 'money' : 'muted'}>{connected ? 'Conectado' : 'Sin conectar'}</Badge>
        {lastSync ? (
          <span className="text-[12px] text-ink-faint">
            última sincronización: {new Date(lastSync).toLocaleDateString('es-CO')}
          </span>
        ) : null}
      </div>

      <p className="text-[12.5px] leading-snug text-ink-faint">
        Traemos tus listas de contactos. El envío, la secuencia y la medición se quedan acá: si la
        campaña corriera allá, tus agendamientos y tus ventas también vivirían allá.
      </p>

      {!connected ? (
        <div className="flex flex-wrap gap-2">
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="API key de Instantly"
            className="min-w-64 flex-1 rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink"
          />
          <button
            type="button"
            disabled={pending || apiKey.trim().length < 8}
            onClick={connect}
            className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
          >
            {pending ? 'Probando…' : 'Conectar'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-[12px] text-ink-faint">
              Base legal con la que vas a contactar a esta lista
            </span>
            <select
              value={consent}
              onChange={(event) => setConsent(event.target.value)}
              className="w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none focus:border-ink"
            >
              <option value="existing_relationship">Ya son clientes o me dejaron su dato</option>
              <option value="opt_in">Se suscribieron explícitamente</option>
              <option value="legitimate_interest">Interés legítimo B2B (prospección en frío)</option>
            </select>
          </label>

          {lists.length === 0 ? (
            <p className="text-[12.5px] text-ink-faint">
              No encontramos listas. {lastError ? `El API respondió: ${lastError}` : ''}
            </p>
          ) : (
            <ul className="space-y-2">
              {lists.map((list) => (
                <li key={list.id} className="flex flex-wrap items-center gap-3">
                  <span className="text-[13.5px] text-ink">{list.name}</span>
                  {list.count !== null ? (
                    <span className="tnum text-[12.5px] text-ink-faint">{list.count} contactos</span>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => importList(list)}
                    className="ml-auto rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition hover:border-ink"
                  >
                    Traer
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error ? <p className="text-[13px] text-leak">{error}</p> : null}
      {message ? <p className="text-[13px] text-money">{message}</p> : null}
    </Card>
  );
}
