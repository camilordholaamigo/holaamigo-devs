'use client';

import { useState } from 'react';

/** Copiar el link del activo. El cliente lo va a pegar en su bio, en su
 *  WhatsApp y en su firma — no solo lo va a usar el agente. */
export function CopyLink({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          /* sin permiso de portapapeles: el link igual está visible al lado */
        }
      }}
      className="rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition hover:border-ink"
    >
      {copied ? 'Copiado' : (label ?? 'Copiar link')}
    </button>
  );
}
