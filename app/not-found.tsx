import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="max-w-md space-y-4 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">404</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Ese enlace no existe o ya expiró.
        </h1>
        <p className="text-[14.5px] leading-relaxed text-ink-soft">
          Si estabas viendo un diagnóstico, revisa el correo que te mandamos: el enlace de ahí es
          el permanente.
        </p>
        <Link
          href="/"
          className="inline-block rounded-xl bg-ink px-6 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright"
        >
          Empezar de nuevo
        </Link>
      </div>
    </main>
  );
}
