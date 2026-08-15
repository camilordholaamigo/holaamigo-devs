'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeUrl, isValidEmail } from '@/lib/utils';

/**
 * El formulario de la landing (PRD §4.1).
 *
 * TRES CAMPOS. Nombre, correo, URL. Nada más.
 *
 * No pedimos teléfono, empresa, cargo ni tamaño — cada campo extra cuesta
 * conversión y todo eso lo preguntamos en el quiz, cuando ya invirtió tiempo y
 * la fricción está justificada. Si alguien propone agregar un campo aquí, la
 * respuesta por defecto es no.
 *
 * La validación de URL es en cliente y perdona: "acme.com", "www.acme.com/x" y
 * "http://acme.com" son todos válidos y se normalizan a https://acme.com.
 */

export function IntakeForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState({ name: '', email: '', url: '' });
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (field: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((prev) => ({ ...prev, [field]: event.target.value }));
    if (error?.field === field) setError(null);
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (values.name.trim().length < 2) {
      setError({ message: '¿Cómo te llamas?', field: 'name' });
      return;
    }
    if (!isValidEmail(values.email)) {
      setError({ message: 'Ese correo no parece válido.', field: 'email' });
      return;
    }
    const normalized = normalizeUrl(values.url);
    if (!normalized) {
      setError({ message: 'Escribe tu sitio, por ejemplo acme.com', field: 'url' });
      return;
    }

    setSubmitting(true);

    const params = new URLSearchParams(window.location.search);
    const utm: Record<string, string> = {};
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      const value = params.get(key);
      if (value) utm[key] = value;
    }

    try {
      const response = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          email: values.email.trim(),
          url: normalized,
          utm,
          referrer: document.referrer || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError({ message: data.error ?? 'Algo se rompió. Intenta de nuevo.', field: data.field });
        setSubmitting(false);
        return;
      }

      // No esperamos al research: derecho al quiz (§4.1).
      startTransition(() => router.push(data.next));
    } catch {
      setError({ message: 'No hay conexión. Revisa tu internet e intenta de nuevo.' });
      setSubmitting(false);
    }
  }

  const busy = submitting || pending;

  return (
    <form onSubmit={onSubmit} className="w-full max-w-lg space-y-3" noValidate>
      <Field
        id="name"
        label="Tu nombre"
        placeholder="Camilo Ramírez"
        value={values.name}
        onChange={update('name')}
        autoComplete="name"
        invalid={error?.field === 'name'}
        disabled={busy}
      />
      <Field
        id="email"
        label="Tu correo"
        type="email"
        placeholder="camilo@empresa.com"
        value={values.email}
        onChange={update('email')}
        autoComplete="email"
        invalid={error?.field === 'email'}
        disabled={busy}
      />
      <Field
        id="url"
        label="El sitio de tu empresa"
        placeholder="miempresa.com"
        value={values.url}
        onChange={update('url')}
        autoComplete="url"
        inputMode="url"
        invalid={error?.field === 'url'}
        disabled={busy}
      />

      {error ? (
        <p role="alert" className="slide-in text-[13px] font-medium text-leak">
          {error.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="group relative w-full rounded-xl bg-ink px-6 py-4 text-[15px] font-semibold text-paper transition
                   hover:bg-money-bright disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-paper" />
            Preparando tu análisis…
          </span>
        ) : (
          'Analizar mi negocio gratis'
        )}
      </button>

      <p className="text-center text-[12px] leading-relaxed text-ink-faint">
        Toma 6 minutos. No pedimos tarjeta y no te vamos a llamar sin que lo pidas.
      </p>
    </form>
  );
}

function Field({
  id,
  label,
  invalid,
  ...props
}: {
  id: string;
  label: string;
  invalid?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-invalid={invalid}
        className={`w-full rounded-xl border bg-paper-raised px-4 py-3.5 text-[15px] text-ink
                    placeholder:text-ink-faint/70 transition
                    focus:border-money-bright focus:outline-none
                    disabled:opacity-60
                    ${invalid ? 'border-leak' : 'border-line'}`}
        {...props}
      />
    </div>
  );
}
