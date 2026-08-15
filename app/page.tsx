import { IntakeForm } from '@/components/intake-form';

/**
 * Landing (PRD §4.1).
 *
 * Una sola conversión. Sin menú, sin secciones de features, sin precios.
 * Above the fold: promesa + tres campos + botón. Debajo del fold, y SOLO eso:
 * qué va a pasar en los próximos 6 minutos, y prueba social.
 *
 * Métrica objetivo: ≥35% de visitantes únicos hacen submit.
 */

export default function LandingPage() {
  return (
    <main className="flex-1">
      {/* ── Above the fold ─────────────────────────────────────────────── */}
      <section className="mx-auto grid min-h-[92vh] max-w-6xl grid-cols-1 items-center gap-14 px-6 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-20">
        <div className="space-y-8">
          <div className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            <span className="text-[13px] font-semibold tracking-tight text-ink">Hola Amigo</span>
          </div>

          <div className="space-y-6">
            <h1 className="text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.02em] text-ink sm:text-[3.4rem]">
              Cuánta plata estás
              <br />
              dejando sobre la mesa.
              <br />
              <span className="text-money">Con el número al lado.</span>
            </h1>

            <p className="max-w-xl text-[17px] leading-relaxed text-ink-soft">
              Analizamos tu sitio, te decimos contra quién compites de verdad, y calculamos qué
              te está costando cada mes lo que hoy no estás atendiendo. Al final quedan tres
              agentes entrenados esperando tu permiso para trabajar.
            </p>
          </div>

          <dl className="flex flex-wrap gap-x-9 gap-y-4 border-t border-line pt-6">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Toma
              </dt>
              <dd className="tnum text-lg font-semibold text-ink">6 minutos</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Primer resultado
              </dt>
              <dd className="tnum text-lg font-semibold text-ink">24 horas</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Costo del diagnóstico
              </dt>
              <dd className="text-lg font-semibold text-money">Cero</dd>
            </div>
          </dl>
        </div>

        <div className="lg:justify-self-end">
          <div className="rounded-[18px] border border-line bg-paper-raised p-7 shadow-[0_2px_16px_rgb(18_16_14_/_0.05)] sm:p-8">
            <IntakeForm />
          </div>
        </div>
      </section>

      {/* ── Debajo del fold: los 3 pasos ───────────────────────────────── */}
      <section className="border-t border-line bg-paper-raised">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Qué va a pasar
          </p>
          <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-ink">
            En los próximos 6 minutos.
          </h2>

          <ol className="mt-12 grid gap-10 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="reveal space-y-3" style={{ '--i': index } as React.CSSProperties}>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-paper-sunken text-ink">
                  {step.icon}
                </div>
                <p className="tnum text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {step.time}
                </p>
                <h3 className="text-[17px] font-semibold tracking-tight text-ink">{step.title}</h3>
                <p className="text-[14px] leading-relaxed text-ink-soft">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Prueba social ──────────────────────────────────────────────── */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                De dónde venimos
              </p>
              <p className="text-[15px] leading-relaxed text-ink-soft">
                El mismo equipo que construyó y opera el agente de WhatsApp que arrienda y vende
                inmuebles 24/7 en Bogotá, Medellín y Cali. Esto no es una demo: es la misma
                maquinaria, apuntada a tu negocio.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {PROOF.map((item) => (
                <div key={item.label} className="rounded-[14px] border border-line bg-paper-raised p-5">
                  <p className="tnum text-2xl font-semibold tracking-tight text-ink">{item.value}</p>
                  <p className="mt-1 text-[13px] leading-snug text-ink-faint">{item.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-[12px] text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>Hola Amigo · Motor de Ventas</p>
          <p>
            Tus datos son tuyos. No los vendemos, no los compartimos, y los borramos si lo pides.
          </p>
        </div>
      </footer>
    </main>
  );
}

const STEPS = [
  {
    time: 'Ahora mismo',
    title: 'Leemos tu sitio',
    body: 'Mientras tú respondes el quiz, nosotros abrimos tu página, tus precios y buscamos con quién te comparan. Lo vas viendo en vivo.',
    icon: <IconSearch />,
  },
  {
    time: 'Minuto 4',
    title: 'Sale el número',
    body: 'Tu posición frente a la competencia y cuánta plata se te está cayendo cada mes. Con la fórmula a la vista, y editable.',
    icon: <IconMoney />,
  },
  {
    time: 'Minuto 6',
    title: 'Los tres agentes',
    body: 'President, CMO y Sales quedan instanciados con objetivo, presupuesto y permisos. No mueven un dedo sin que tú lo autorices.',
    icon: <IconAgents />,
  },
];

const PROOF = [
  { value: '24/7', label: 'Los agentes no duermen ni el domingo a las 9 p.m.' },
  { value: '3', label: 'Ciudades operando hoy: Bogotá, Medellín y Cali.' },
  { value: '<24 h', label: 'Desde que cargas tu base hasta el primer lead trabajado.' },
];

function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function IconMoney() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v18" />
      <path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-2a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-2a3.5 3.5 0 0 1-3.5-2.5" />
    </svg>
  );
}

function IconAgents() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7" cy="8" r="3" />
      <circle cx="17" cy="8" r="3" />
      <path d="M2 20a5 5 0 0 1 10 0" />
      <path d="M12 20a5 5 0 0 1 10 0" />
    </svg>
  );
}
