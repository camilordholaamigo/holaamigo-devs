import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Componentes base. Deliberadamente pocos y sin librería de UI.
 *
 * El producto son cinco pantallas. Traer shadcn/ui completo para cinco
 * pantallas es más superficie que mantener que valor entregado. Cuando el
 * admin crezca y necesitemos tablas, popovers y menús de verdad, se instala.
 * Hasta entonces esto alcanza y se lee de un vistazo.
 */

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={cn(
        'rounded-[14px] border border-line bg-paper-raised',
        'shadow-[0_1px_2px_rgb(18_16_14_/_0.04)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'money' | 'leak' | 'muted';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-ink text-paper',
    money: 'bg-money-soft text-money',
    leak: 'bg-leak-soft text-leak',
    muted: 'bg-paper-sunken text-ink-faint',
  } as const;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        'text-[11px] font-semibold uppercase tracking-wider',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  subtitle,
  className,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {eyebrow ? (
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{title}</h2>
      {subtitle ? <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">{subtitle}</p> : null}
    </div>
  );
}

/**
 * Fuente o marca de inferido. Principio §13.4: toda afirmación sobre el
 * negocio del cliente lleva fuente o se marca como inferida. Sin una de las
 * dos, no se renderiza — por eso este componente devuelve null solo cuando
 * explícitamente no aplica, nunca por omisión.
 */
export function SourceMark({
  url,
  inferred,
}: {
  url?: string | null;
  inferred?: boolean;
}) {
  if (url) {
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* url cruda */
    }
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-1.5 inline-flex items-center gap-1 align-middle text-[11px] text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-money"
      >
        {host}
      </a>
    );
  }

  if (inferred) {
    return (
      <span
        className="ml-1.5 inline-flex items-center rounded bg-paper-sunken px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-ink-faint"
        title="Lo dedujimos del contexto. No lo leímos textual en ninguna parte."
      >
        inferido
      </span>
    );
  }

  return null;
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'money' | 'leak';
}) {
  const tones = {
    neutral: 'text-ink',
    money: 'text-money',
    leak: 'text-leak',
  } as const;

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{label}</p>
      <p className={cn('tnum text-2xl font-semibold tracking-tight', tones[tone])}>{value}</p>
      {hint ? <p className="text-[12px] leading-snug text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-[14px] border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-soft">{title}</p>
      {hint ? <p className="mt-1 text-[13px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}
