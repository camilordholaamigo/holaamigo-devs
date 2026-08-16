import { room } from '@/lib/deliberation/room';
import { chaptersFor } from '@/lib/feed/chapter';
import { SectionTitle, Empty } from '@/components/ui';
import { DeliberationThread } from '@/components/deliberation-thread';

/**
 * La Sala: el cliente lee cómo su organización pensó.
 *
 * Es la única pantalla del producto que no está hecha para hacer nada. Se lee.
 * Por eso la columna es angosta, el interlineado es de libro y no hay ni una
 * tabla: si esto se ve como un dashboard, se usa como un dashboard —se escanea
 * y se cierra— y todo el valor de mostrar la deliberación se pierde.
 *
 * Arriba la serie de capítulos, abajo los hilos. Los dos son lectura, pero el
 * capítulo es el resumen de ayer y el hilo es el detalle de cómo se llegó ahí.
 *
 * Ver docs/wiki/17-la-sala-el-feed-y-el-capitulo.md
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'La Sala · Hola Amigo', robots: { index: false } };

export default async function SalaPage({ params }: PageProps<'/consola/[orgId]/sala'>) {
  const { orgId } = await params;

  const [hilos, capitulos] = await Promise.all([
    room(orgId, { limit: 20 }),
    chaptersFor(orgId, 5),
  ]);

  return (
    <main className="mx-auto max-w-2xl space-y-14 px-6 py-12">
      <SectionTitle
        eyebrow="La Sala"
        title="Cómo pensó tu organización"
        subtitle="Los agentes discuten acá. Podés leer el hilo completo y meterte en cualquier punto: lo que escribas pesa más que los datos y obliga a que la próxima recomendación te cite."
      />

      {capitulos.length > 0 ? (
        <section className="space-y-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            La serie
          </h2>
          <div className="space-y-8">
            {capitulos.map((capitulo) => (
              <article key={capitulo.id} className="space-y-2">
                <p className="text-[12px] text-ink-faint">
                  Capítulo {capitulo.numero} ·{' '}
                  {new Date(`${capitulo.dia}T12:00:00Z`).toLocaleDateString('es-CO', {
                    day: 'numeric',
                    month: 'long',
                  })}
                </p>
                <h3 className="prosa text-[19px] font-semibold tracking-tight text-ink">
                  {capitulo.titulo}
                </h3>
                <p className="prosa whitespace-pre-line text-[15px] leading-[1.75] text-ink-soft">
                  {capitulo.body}
                </p>
                {(capitulo.needs_from_human ?? []).length > 0 ? (
                  <ul className="mt-2 space-y-1 border-l-2 border-line-strong pl-4">
                    {(capitulo.needs_from_human as string[]).map((necesita) => (
                      <li key={necesita} className="text-[13.5px] text-ink-soft">
                        {necesita}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-10">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Las discusiones
        </h2>

        {hilos.length === 0 ? (
          <Empty
            title="Todavía no han discutido nada"
            hint="Cuando los agentes tengan que decidir algo con más de una salida —y casi siempre la tienen— la conversación aparece acá."
          />
        ) : (
          hilos.map((hilo) => (
            <DeliberationThread
              key={hilo.id}
              orgId={orgId}
              deliberation={{
                id: hilo.id,
                question: hilo.question,
                status: hilo.status,
                recommendation: hilo.recommendation,
                confidence: hilo.confidence,
                what_would_change_my_mind: hilo.what_would_change_my_mind,
                dissent: hilo.dissent,
                opened_at: hilo.opened_at,
                reopened_count: hilo.reopened_count,
                turns: hilo.turns.map((t) => ({
                  id: t.id,
                  speaker: t.speaker,
                  speaker_type: t.speaker_type,
                  body: t.body,
                  stance: t.stance,
                  created_at: t.created_at,
                })),
              }}
            />
          ))
        )}
      </section>
    </main>
  );
}
