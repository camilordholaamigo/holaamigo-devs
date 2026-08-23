import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { Card } from '@/components/ui';
import { InformeAcciones, Transcripcion } from '@/components/informe-acciones';
import { informePorToken, registrarVista, type Hallazgo } from '@/lib/pruebas/informe';
import { formatoDuracion } from '@/lib/pruebas/motor';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';
import type { Mensaje } from '@/lib/pruebas/types';

/**
 * El informe que se le manda al cliente.
 *
 * Público por `share_token`, igual que el diagnóstico y por la misma razón: el
 * cliente lo reenvía a su socio y ese reenvío es nuestro mejor canal. El token
 * de 64 caracteres es lo que lo protege de ser enumerable.
 *
 * ── EL ORDEN DE LA PÁGINA ES LA DECISIÓN ───────────────────────────────────
 *
 * 1. UNA FRASE con lo que pasó. Si el lector solo lee esto, ya recibió el
 *    mensaje.
 * 2. LAS CIFRAS, grandes. Son hechos con hora, no proyecciones.
 * 3. QUÉ FALLÓ, con su frecuencia. «4 de 5» es lo que separa un problema
 *    sistemático de una conversación mala, y sin esa distinción el informe es
 *    una lista de reclamos.
 * 4. LAS CITAS. Textuales. Es la única parte verificable y por eso va antes de
 *    los consejos: primero la prueba, después la opinión.
 * 5. QUÉ HACER.
 * 6. LAS CONVERSACIONES, plegadas. Están porque un informe que afirma sin
 *    poder mostrar es una opinión con tipografía bonita.
 *
 * Ni una sola cifra de esta página sale de un modelo (ADR 0007). El modelo
 * escribió la narrativa del punto 1 y los títulos del punto 5, y su esquema no
 * tiene un `z.number()`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/informe/[shareToken]'>) {
  const { shareToken } = await params;
  const informe = await informePorToken(shareToken);
  if (!informe) return { title: 'Informe · Hola Amigo' };

  const { data: org } = await db()
    .from('organizations')
    .select('name, domain')
    .eq('id', informe.organization_id)
    .maybeSingle();

  const negocio = org?.name ?? org?.domain ?? 'tu negocio';

  return {
    title: `Le escribimos a ${negocio} · Hola Amigo`,
    // La descripción es lo que se ve en la previsualización de WhatsApp, y esa
    // previsualización es el 80% de si abren el link. Va el hecho, no la marca.
    description: titularDe(informe.resumen),
    robots: { index: false, follow: false },
  };
}

export default async function InformePage({ params }: PageProps<'/informe/[shareToken]'>) {
  const { shareToken } = await params;
  const informe = await informePorToken(shareToken);
  if (!informe) notFound();

  const [{ data: org }, { data: pruebas }] = await Promise.all([
    db()
      .from('organizations')
      .select('name, domain, website_url')
      .eq('id', informe.organization_id)
      .maybeSingle(),
    db()
      .from('smoke_probes')
      .select('id, template_id, target_phone, conversation, segundos_primera_respuesta, cerro_con, enviado_at')
      .eq('organization_id', informe.organization_id)
      .gte('created_at', informe.periodo_desde)
      .neq('estado', 'cancelled')
      .not('enviado_at', 'is', null)
      .order('created_at', { ascending: true })
      .limit(12),
  ]);

  await registrarVista(informe);

  const negocio = org?.name ?? org?.domain ?? 'tu negocio';
  const r = informe.resumen;
  const url = `${env.siteUrl}/informe/${shareToken}`;

  return (
    <main className="mx-auto max-w-3xl space-y-12 px-6 py-12 sm:py-16">
      {/* ── 1 · la frase ──────────────────────────────────────────────── */}
      <header className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight text-ink">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            Hola Amigo
          </span>
          <InformeAcciones url={url} negocio={negocio} />
        </div>

        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Le escribimos a {negocio}
          </p>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            {titularDe(r)}
          </h1>
          {informe.narrativa ? (
            <p className="max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              {informe.narrativa}
            </p>
          ) : null}
        </div>

        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          Escribimos desde un número nuestro, como escribiría un cliente cualquiera,
          al número que {negocio} publica en su propio sitio. Nadie del otro lado
          sabía que era una prueba — por eso lo que sigue es lo que le pasa a un
          cliente de verdad.
        </p>
      </header>

      {/* ── 2 · las cifras ────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Cifra
            etiqueta="Conversaciones"
            valor={String(r.conversaciones)}
            nota="que abrimos"
          />
          <Cifra
            etiqueta="Contestaron"
            valor={`${r.contestadas} de ${r.conversaciones}`}
            tono={r.sin_respuesta > 0 ? 'leak' : 'money'}
            nota={r.sin_respuesta > 0 ? `${r.sin_respuesta} sin respuesta` : 'todas'}
          />
          <Cifra
            etiqueta="Tardaron"
            valor={r.mediana_segundos !== null ? formatoDuracion(r.mediana_segundos) : '—'}
            nota="lo habitual"
            tono={r.mediana_segundos !== null && r.mediana_segundos > 300 ? 'leak' : 'money'}
          />
          <Cifra
            etiqueta="Propusieron algo"
            valor={`${r.propusieron_paso} de ${r.conversaciones}`}
            nota="cita, llamada o cotización"
            tono={r.propusieron_paso === 0 ? 'leak' : 'neutral'}
          />
        </div>

        {/* La barra por conversación. Es HTML y CSS, sin librería: son cuatro
            rectángulos y los nombres son frases largas en español que en SVG
            habría que truncar. Mismo argumento que la cascada del diagnóstico. */}
        {pruebas && pruebas.length > 0 ? (
          <Card>
            <div className="space-y-4 p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Cuánto tardaron, una por una
              </p>
              <BarrasDeTiempo
                filas={pruebas.map((p) => ({
                  etiqueta: NOMBRE[p.template_id] ?? p.template_id,
                  segundos: p.segundos_primera_respuesta,
                }))}
              />
            </div>
          </Card>
        ) : null}
      </section>

      {/* ── 3 · qué falló ─────────────────────────────────────────────── */}
      {informe.hallazgos.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink">Qué no pasó</h2>
          <div className="space-y-2.5">
            {informe.hallazgos.map((h) => (
              <FilaDeHallazgo key={h.id} hallazgo={h} />
            ))}
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-faint">
            La proporción importa más que el hecho: algo que falla en casi todas las
            conversaciones es un problema de cómo está armada la atención. Algo que
            falla una vez es una conversación mala y no hay que tocarla.
          </p>
        </section>
      ) : null}

      {/* ── 4 · las citas ─────────────────────────────────────────────── */}
      {informe.citas.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink">
            Cosas que dijeron y que tu sitio no dice
          </h2>
          <div className="space-y-2.5">
            {informe.citas.map((c, i) => (
              <Card key={`${c.probe_id}-${i}`} className="border-leak/25 bg-leak-soft/40">
                <p className="px-5 py-4 text-[14.5px] leading-relaxed text-ink">
                  <span className="text-leak">«</span>
                  {c.texto}
                  <span className="text-leak">»</span>
                </p>
              </Card>
            ))}
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-faint">
            Son citas textuales de lo que escribieron, contrastadas contra lo que
            está publicado en tu sitio. Podés verificarlas en las conversaciones de
            abajo.
          </p>
        </section>
      ) : null}

      {/* ── 5 · qué hacer ─────────────────────────────────────────────── */}
      {informe.recomendaciones.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink">
            Por dónde empezar
          </h2>
          <ol className="space-y-3">
            {informe.recomendaciones.map((rec, i) => (
              <li key={rec.clave}>
                <Card>
                  <div className="flex gap-4 p-5">
                    <span className="tnum shrink-0 text-[13px] font-semibold text-ink-faint">
                      {i + 1}
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="text-[15.5px] font-semibold text-ink">{rec.titulo}</h3>
                        <Impacto nivel={rec.impacto} />
                      </div>
                      <p className="text-[14px] leading-relaxed text-ink-soft">{rec.porque}</p>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ── 6 · la prueba ─────────────────────────────────────────────── */}
      {pruebas && pruebas.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink">
            Las conversaciones, completas
          </h2>
          <div className="space-y-2.5">
            {pruebas.map((p) => (
              <Transcripcion
                key={p.id}
                titulo={NOMBRE[p.template_id] ?? p.template_id}
                subtitulo={subtituloDe(p)}
                mensajes={(p.conversation ?? []) as Mensaje[]}
              />
            ))}
          </div>
        </section>
      ) : null}

      <footer className="space-y-4 border-t border-line pt-8">
        <InformeAcciones url={url} negocio={negocio} />
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          Hola Amigo · Este informe es tuyo y el enlace es permanente. Si preferís
          que lo bajemos, escribinos y lo despublicamos.
        </p>
      </footer>
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EL TITULAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Una frase con lo que pasó.
 *
 * La escribe el CÓDIGO, no el modelo, aunque parezca prosa: contiene cifras, y
 * ninguna cifra que el cliente lee sale de un modelo. Prioriza el peor
 * resultado en vez del promedio — un negocio con dos líneas buenas y una
 * muerta tiene un problema, y promediarlo lo escondería.
 */
function titularDe(r: {
  conversaciones: number;
  contestadas: number;
  sin_respuesta: number;
  mediana_segundos: number | null;
  cerraron_cita: number;
  propusieron_paso: number;
}): string {
  if (r.conversaciones === 0) return 'Todavía no hay conversaciones que mostrar.';

  if (r.contestadas === 0) {
    return r.conversaciones === 1
      ? 'Le escribimos a tu línea y nadie contestó.'
      : `Le escribimos ${r.conversaciones} veces y no contestaron ninguna.`;
  }

  const tiempo = r.mediana_segundos !== null ? formatoDuracion(r.mediana_segundos) : null;

  if (r.sin_respuesta > 0) {
    return `De ${r.conversaciones} veces que escribimos, ${r.sin_respuesta} se quedaron sin respuesta.`;
  }

  if (r.cerraron_cita === 0 && r.propusieron_paso === 0) {
    return tiempo
      ? `Contestaron en ${tiempo}, y ninguna conversación terminó en algo concreto.`
      : 'Contestaron, y ninguna conversación terminó en algo concreto.';
  }

  return tiempo ? `Contestaron en ${tiempo}.` : 'Contestaron.';
}

const NOMBRE: Record<string, string> = {
  servicio: 'Un cliente con una duda',
  faq: 'Un cliente con tres preguntas',
  ventas: 'Un cliente listo para comprar',
};

function subtituloDe(p: {
  target_phone: string;
  segundos_primera_respuesta: number | null;
  cerro_con: string | null;
}): string {
  const partes = [p.target_phone];
  partes.push(
    p.segundos_primera_respuesta !== null
      ? `contestaron en ${formatoDuracion(p.segundos_primera_respuesta)}`
      : 'sin respuesta',
  );
  if (p.cerro_con === 'agendado') partes.push('agendaron');
  if (p.cerro_con === 'cotizacion') partes.push('ofrecieron cotización');
  return partes.join(' · ');
}

// ═══════════════════════════════════════════════════════════════════════════
// PIEZAS
// ═══════════════════════════════════════════════════════════════════════════

function Cifra({
  etiqueta,
  valor,
  nota,
  tono = 'neutral',
}: {
  etiqueta: string;
  valor: string;
  nota: string;
  tono?: 'neutral' | 'money' | 'leak';
}) {
  return (
    <Card>
      <div className="space-y-1 p-5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          {etiqueta}
        </p>
        <p
          className={cn(
            'tnum text-[26px] font-semibold leading-none tracking-tight',
            tono === 'leak' && 'text-leak',
            tono === 'money' && 'text-money',
            tono === 'neutral' && 'text-ink',
          )}
        >
          {valor}
        </p>
        <p className="text-[12px] leading-snug text-ink-faint">{nota}</p>
      </div>
    </Card>
  );
}

/**
 * Las barras de tiempo.
 *
 * La escala es LINEAL contra el peor tiempo de la prueba, no logarítmica. Con
 * una conversación de 2 minutos y otra de 40, la primera queda como una
 * astilla — y esa astilla ES la información: la diferencia entre las dos es el
 * problema del que estamos hablando. Comprimirla para que «se vean bien las
 * dos» sería mentir con la geometría.
 *
 * Las que no contestaron llevan la barra completa en rojo, porque «no
 * contestaron» no es un tiempo largo: es otra cosa, y una barra corta las
 * haría ver mejor que a las lentas.
 */
function BarrasDeTiempo({
  filas,
}: {
  filas: Array<{ etiqueta: string; segundos: number | null }>;
}) {
  const maximo = Math.max(1, ...filas.map((f) => f.segundos ?? 0));

  return (
    <div className="space-y-2.5">
      {filas.map((f, i) => {
        const sinRespuesta = f.segundos === null;
        const ancho = sinRespuesta ? 100 : Math.max(2, ((f.segundos ?? 0) / maximo) * 100);
        return (
          <div key={`${f.etiqueta}-${i}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-4 text-[12.5px]">
              <span className="truncate text-ink-soft">{f.etiqueta}</span>
              <span
                className={cn('tnum shrink-0 font-medium', sinRespuesta ? 'text-leak' : 'text-ink')}
              >
                {sinRespuesta ? 'sin respuesta' : formatoDuracion(f.segundos ?? 0)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-paper-sunken">
              <div
                className={cn(
                  'h-full rounded-full',
                  sinRespuesta
                    ? 'bg-leak'
                    : (f.segundos ?? 0) > 300
                      ? 'bg-leak/60'
                      : 'bg-money-bright',
                )}
                style={{ width: `${ancho}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FilaDeHallazgo({ hallazgo }: { hallazgo: Hallazgo }) {
  const proporcion = hallazgo.de > 0 ? hallazgo.fallo_en / hallazgo.de : 0;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
        <div className="min-w-[12rem] flex-1">
          <p className="text-[14.5px] text-ink">{hallazgo.criterio}</p>
        </div>

        {/* Los puntitos: `fallo_en` de `de`, dibujado. Un «4 de 5» se entiende
            leyéndolo; cinco puntos con cuatro llenos se entienden sin leer. */}
        <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
          {Array.from({ length: Math.min(hallazgo.de, 8) }).map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-2 w-2 rounded-full',
                i < hallazgo.fallo_en ? 'bg-leak' : 'bg-line-strong',
              )}
            />
          ))}
        </div>

        <p className="tnum w-28 shrink-0 text-right text-[13px] font-medium text-leak">
          {hallazgo.fallo_en} de {hallazgo.de}
        </p>

        <span className="sr-only">
          Falló en {hallazgo.fallo_en} de {hallazgo.de} conversaciones
          {proporcion >= 0.8 ? ', casi siempre' : ''}
        </span>
      </div>
    </Card>
  );
}

function Impacto({ nivel }: { nivel: 'alto' | 'medio' | 'bajo' }) {
  const estilos = {
    alto: 'bg-leak-soft text-leak',
    medio: 'bg-paper-sunken text-ink-soft',
    bajo: 'bg-paper-sunken text-ink-faint',
  } as const;

  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        estilos[nivel],
      )}
    >
      impacto {nivel}
    </span>
  );
}
