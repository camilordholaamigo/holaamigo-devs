import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SourceMark } from '@/components/ui';
import { AccionesDePrueba } from '@/components/pruebas-admin';
import { ConversacionEnVivo } from '@/components/conversacion-en-vivo';
import { formatoDuracion } from '@/lib/pruebas/motor';
import { cn } from '@/lib/utils';
import { modoDelPlan, type PruebaRow } from '@/lib/pruebas/types';

/**
 * La ficha completa de una conversación de prueba.
 *
 * El orden en que se lee no es el orden en que se calcula, y esa es la única
 * decisión de esta pantalla:
 *
 *   1. **La transcripción.** Es lo que de verdad pasó. Todo lo demás son
 *      lecturas de esto, y quien va a llamar al prospecto necesita las
 *      palabras, no la nota.
 *   2. **El plan.** Qué le preguntamos, por qué, y contra qué ficha se juzga.
 *      Sin esto la calificación es una opinión sin contexto.
 *   3. **Los veredictos.** Auditoría determinística primero —es la que no se
 *      discute— y la del modelo después.
 *
 * Una nota sola arriba de todo invitaría a leer solo la nota, que es
 * exactamente lo que no sirve.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Conversación de prueba · admin', robots: { index: false } };

export default async function PruebaPage({ params }: PageProps<'/admin/pruebas/[pruebaId]'>) {
  const { pruebaId } = await params;

  const { data } = await db()
    .from('smoke_probes')
    .select(
      `*, smoke_targets ( nombre, organization_id, source_url, origen, bloqueado ),
          smoke_channels ( label, phone_e164 )`,
    )
    .eq('id', pruebaId)
    .maybeSingle();

  if (!data) notFound();

  const p = data as unknown as PruebaRow & {
    smoke_targets: {
      nombre: string | null;
      organization_id: string | null;
      source_url: string | null;
      origen: string;
      bloqueado: boolean;
    } | null;
    smoke_channels: { label: string; phone_e164: string } | null;
  };

  const plan = p.plan;
  const viva = p.estado === 'running' || p.estado === 'pending';

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-6 py-10">
      <div className="space-y-4">
        <Link
          href="/admin/pruebas"
          className="text-[13px] text-ink-faint transition hover:text-ink"
        >
          ← Pruebas de línea
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {p.smoke_targets?.nombre ?? plan?.negocio ?? p.target_phone}
            </h1>
            {/* Desde qué línea nuestra salió, y no solo a quién: con tres
                líneas contra el mismo negocio hay tres conversaciones que se
                ven idénticas si no se dice cuál es cuál (ADR 0027). */}
            <p className="tnum text-[13.5px] text-ink-faint">
              {p.target_phone}
              {p.smoke_channels ? <> · desde {p.smoke_channels.phone_e164}</> : null}
              {p.smoke_targets?.source_url ? (
                <SourceMark url={p.smoke_targets.source_url} />
              ) : (
                <SourceMark inferred={p.smoke_targets?.origen !== 'manual'} />
              )}
            </p>
          </div>
          <AccionesDePrueba
            pruebaId={p.id}
            viva={viva}
            yaEvaluada={Boolean(p.evaluacion)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge tone={p.cerro_con === 'sin_respuesta' ? 'leak' : 'muted'}>
            {p.cerro_con ?? p.estado}
          </Badge>
          {p.segundos_primera_respuesta !== null ? (
            <Badge tone="money">
              contestaron en {formatoDuracion(p.segundos_primera_respuesta)}
            </Badge>
          ) : null}
          <Badge tone="muted">
            turno {p.turno} de {p.max_turnos}
          </Badge>
          <Badge tone="muted">
            {plan && modoDelPlan(plan) === 'guion' ? 'preguntas fijas' : p.template_id}
          </Badge>
          {plan?.degradado ? <Badge tone="leak">compilada sin modelo</Badge> : null}
          {p.smoke_targets?.bloqueado ? <Badge tone="leak">número bloqueado</Badge> : null}
        </div>

        {p.motivo_cierre ? (
          <p className="text-[13.5px] leading-relaxed text-ink-soft">{p.motivo_cierre}</p>
        ) : null}
        {p.error ? (
          <p className="rounded-xl bg-leak-soft px-4 py-3 text-[13px] leading-relaxed text-leak">
            {p.error}
          </p>
        ) : null}
      </div>

      {/* ── 1 · la transcripción ─────────────────────────────────────────
          Primero, y en vivo. Es lo que de verdad pasó; todo lo demás son
          lecturas de esto, y quien va a llamar al prospecto necesita las
          palabras, no la nota. */}
      <ConversacionEnVivo
        runId={p.run_id}
        pruebaId={p.id}
        viva={viva}
        inicial={{
          conversation: p.conversation ?? [],
          turno: p.turno,
          maxTurnos: p.max_turnos,
        }}
      />

      {/* ── 2 · el plan ──────────────────────────────────────────────────── */}
      {plan ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">La prueba compilada</h2>
            <p className="tnum text-[12.5px] text-ink-faint">
              {plan.cobertura.porcentaje}% de los criterios se pueden verificar contra su sitio
            </p>
          </div>

          <Card>
            <div className="space-y-5 p-5">
              <Bloque titulo="Objetivo">
                <p className="text-[13.5px] leading-relaxed text-ink-soft">{plan.objetivo}</p>
              </Bloque>

              {plan.contexto ? (
                <Bloque titulo="Lo que sabíamos de ellos">
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-soft">
                    {plan.contexto}
                  </p>
                  <p className="text-[12px] leading-snug text-ink-faint">
                    Escrito por el equipo. Sin fuente verificable, así que sirvió para preguntar
                    pero no cuenta como ficha: no se puede acusar a nadie de contradecir algo que
                    nosotros escribimos de memoria.
                  </p>
                </Bloque>
              ) : null}

              {plan.instrucciones ? (
                <Bloque titulo="Cómo se le pidió que se comportara">
                  <p className="text-[13.5px] leading-relaxed text-ink-soft">
                    {plan.instrucciones}
                  </p>
                </Bloque>
              ) : null}

              <Bloque
                titulo={
                  modoDelPlan(plan) === 'guion'
                    ? 'El guion, tal como se mandó'
                    : 'Lo que se preguntó'
                }
              >
                <ul className="space-y-2">
                  {plan.sondas.map((s) => (
                    <li key={s.id} className="space-y-0.5">
                      <p className="text-[13.5px] text-ink">
                        {s.pregunta}
                        {s.origen === 'research' ? (
                          <span className="ml-2 rounded bg-money-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-money">
                            del research
                          </span>
                        ) : null}
                        {s.origen === 'admin' ? (
                          <span className="ml-2 rounded bg-paper-sunken px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                            la escribió el equipo
                          </span>
                        ) : null}
                      </p>
                      <p className="text-[12.5px] leading-snug text-ink-faint">{s.por_que}</p>
                    </li>
                  ))}
                </ul>
              </Bloque>

              <Bloque titulo="La ficha de verdad">
                {plan.ficha.length === 0 ? (
                  <p className="text-[13px] leading-relaxed text-ink-faint">
                    Sin ficha. Esta prueba mide atención —si contestan y en cuánto— pero
                    no puede medir exactitud: no hay contra qué comparar lo que dijeron.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {plan.ficha.map((h, i) => (
                      <li key={`${h.clave}-${i}`} className="text-[13px] leading-relaxed text-ink-soft">
                        <span className="font-medium text-ink">{h.clave}:</span> {h.valor}
                        <SourceMark url={h.fuente} inferred={!h.fuente} />
                      </li>
                    ))}
                  </ul>
                )}
              </Bloque>
            </div>
          </Card>
        </section>
      ) : null}

      {/* ── 3 · veredictos ───────────────────────────────────────────────── */}
      {p.auditoria ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">
              Auditoría · determinística
            </h2>
            <p className="tnum text-[12.5px] text-ink-faint">
              {p.auditoria.verificables > 0
                ? `${p.auditoria.score} / 100 sobre ${p.auditoria.verificables} criterios`
                : 'sin criterios verificables'}
            </p>
          </div>
          <Card>
            <div className="divide-y divide-line/60">
              {p.auditoria.criterios.map((c) => (
                <div key={c.id} className="flex gap-3 px-5 py-3">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-[3px] shrink-0 text-[13px]',
                      c.paso === true && 'text-money-bright',
                      c.paso === false && 'text-leak',
                      c.paso === null && 'text-ink-faint',
                    )}
                  >
                    {c.paso === true ? '✓' : c.paso === false ? '✕' : '–'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] text-ink">{c.criterio}</p>
                    <p className="text-[12.5px] leading-snug text-ink-faint">{c.detalle}</p>
                  </div>
                  <span className="tnum shrink-0 text-[12px] text-ink-faint">×{c.peso}</span>
                </div>
              ))}
            </div>
          </Card>
        </section>
      ) : null}

      {p.evaluacion ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">Calidad · con modelo</h2>
            <p className="tnum text-[12.5px] text-ink-faint">{p.evaluacion.score} / 100</p>
          </div>
          <Card>
            <div className="space-y-5 p-5">
              <p className="text-[14px] leading-relaxed text-ink-soft">{p.evaluacion.resumen}</p>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Dim label="Exactitud" valor={p.evaluacion.exactitud} />
                <Dim label="Tono" valor={p.evaluacion.tono} />
                <Dim label="Completitud" valor={p.evaluacion.completitud} />
                <Dim label="Proactividad" valor={p.evaluacion.proactividad} />
                <Dim label="No inventó" valor={p.evaluacion.riesgo_alucinacion} />
              </div>

              <Listas titulo="Se inventaron" items={p.evaluacion.alucinaciones} tono="leak" />
              <Listas titulo="Errores" items={p.evaluacion.errores} tono="neutral" />
              <Listas titulo="Sugerencias" items={p.evaluacion.sugerencias} tono="money" />

              {/* Las notas de esta sección salen de juicios cualitativos del
                  modelo convertidos por una tabla fija en el código. Se dice
                  acá porque quien compare dos pruebas necesita saber que la
                  escala es reproducible y no una estimación del modelo. */}
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                El modelo no devuelve números: devuelve juicios («bien», «regular») y
                el código los convierte con una tabla fija. Dos evaluaciones con los
                mismos juicios dan exactamente la misma nota.
              </p>
            </div>
          </Card>
        </section>
      ) : null}
    </main>
  );
}

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {titulo}
      </p>
      {children}
    </div>
  );
}

function Dim({ label, valor }: { label: string; valor: number }) {
  return (
    <div className="space-y-1">
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <p className="tnum text-[18px] font-semibold text-ink">{valor}</p>
    </div>
  );
}

function Listas({
  titulo,
  items,
  tono,
}: {
  titulo: string;
  items: string[];
  tono: 'leak' | 'money' | 'neutral';
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p
        className={cn(
          'text-[11px] font-semibold uppercase tracking-[0.12em]',
          tono === 'leak' && 'text-leak',
          tono === 'money' && 'text-money',
          tono === 'neutral' && 'text-ink-faint',
        )}
      >
        {titulo}
      </p>
      <ul className="space-y-1">
        {items.map((x) => (
          <li key={x} className="text-[13.5px] leading-relaxed text-ink-soft">
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}
