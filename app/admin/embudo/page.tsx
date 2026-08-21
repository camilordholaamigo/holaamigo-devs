import { Card, SectionTitle, Stat, Empty, Badge } from '@/components/ui';
import { formatNumber } from '@/lib/utils';
import {
  embudoInicial,
  caidaPorPregunta,
  supuestosDiscutidos,
  duracionDelQuiz,
} from '@/lib/funnel/queries';

/**
 * El embudo del flujo inicial.
 *
 * Esta pantalla existe porque `plg_events` llevaba desde 0001 guardando todo lo
 * necesario para responder tres preguntas y nadie las estaba haciendo.
 *
 * El criterio de wiki/14 se respeta al pie: **una métrica que no cambia una
 * decisión es ruido**. Por eso no hay serie temporal, ni gráfica de tendencia,
 * ni conteos por día. Hay tres bloques y cada uno tiene su decisión escrita
 * encima:
 *
 *   · dónde se cae la gente        → qué pantalla hay que arreglar
 *   · en qué pregunta se cae       → qué pregunta hay que reescribir
 *   · qué supuesto discute         → qué default de config/assumptions.ts mover
 *
 * Lo que NO se puede medir todavía va dicho en pantalla y no escondido: no hay
 * evento de visita a la landing, así que la conversión de visitante a submit
 * —la métrica que la propia landing declara en §4.1— no se puede calcular acá.
 * Decirlo es más útil que dibujar una primera barra al 100% que parezca que sí.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DIAS = 30;
const DIAS_SUPUESTOS = 90;

export default async function EmbudoPage() {
  const [etapas, preguntas, supuestos, duracion] = await Promise.all([
    embudoInicial(DIAS),
    caidaPorPregunta(DIAS),
    supuestosDiscutidos(DIAS_SUPUESTOS),
    duracionDelQuiz(DIAS),
  ]);

  const tope = etapas[0]?.organizaciones ?? 0;

  // La peor caída es la única fila que se resalta. Resaltar todas es no
  // resaltar ninguna, y el operador entra acá para saber qué tocar primero.
  const peor = etapas
    .filter((e) => e.del_anterior !== null)
    .reduce<(typeof etapas)[number] | null>(
      (worst, e) => (!worst || (e.del_anterior ?? 100) < (worst.del_anterior ?? 100) ? e : worst),
      null,
    );

  const abandonoTotal = preguntas.reduce((sum, p) => sum + p.abandonos, 0);
  const peorPregunta = preguntas.reduce<(typeof preguntas)[number] | null>(
    (worst, p) => (!worst || p.abandonos > worst.abandonos ? p : worst),
    null,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-12 px-6 py-10">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">Embudo del flujo inicial</h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-ink-soft">
          Últimos {DIAS} días, contado por organización y anclado al primer{' '}
          <code className="font-mono text-[13px] text-ink">landing_submit</code>. Cada bloque
          responde una pregunta que cambia algo; si no cambia nada, no está acá.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <Card className="p-5">
          <Stat
            label="Entraron"
            value={formatNumber(tope)}
            hint={`organizaciones · ${DIAS} días`}
          />
        </Card>
        <Card className="p-5">
          <Stat
            label="Duración real del quiz"
            value={duracion.mediana_minutos !== null ? `${duracion.mediana_minutos} min` : '—'}
            tone={
              duracion.mediana_minutos !== null && duracion.mediana_minutos > 6 ? 'leak' : 'money'
            }
            hint={`mediana de ${formatNumber(duracion.sesiones)} completados · la landing promete 6`}
          />
        </Card>
        <Card className="p-5">
          <Stat
            label="Abandonos dentro del quiz"
            value={formatNumber(abandonoTotal)}
            tone={abandonoTotal > 0 ? 'leak' : 'neutral'}
            hint={
              peorPregunta && peorPregunta.abandonos > 0
                ? `el peor: ${peorPregunta.clave}`
                : 'nadie se quedó a mitad'
            }
          />
        </Card>
      </div>

      {/* ── 1 · El embudo ───────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle
          eyebrow="Decisión: qué pantalla arreglar"
          title="Dónde se cae la gente"
          subtitle="La visita a la landing no se registra todavía, así que la conversión visitante → submit no aparece acá. El embudo arranca en el submit."
        />
        {etapas.length === 0 ? (
          <Empty title="Todavía no hay nadie en la ventana" hint={`Últimos ${DIAS} días.`} />
        ) : (
          <Card className="space-y-5 p-6 sm:p-8">
            {etapas.map((etapa) => {
              const ancho = tope > 0 ? (etapa.organizaciones / tope) * 100 : 0;
              const esPeor = peor?.orden === etapa.orden;

              return (
                <div key={etapa.orden}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="text-[13.5px] font-medium text-ink">
                      {etapa.etapa}
                      {esPeor ? (
                        <span className="ml-2 align-middle">
                          <Badge tone="leak">peor caída</Badge>
                        </span>
                      ) : null}
                    </p>
                    <p className="tnum shrink-0 text-[13.5px] text-ink-soft">
                      <span className="font-semibold text-ink">
                        {formatNumber(etapa.organizaciones)}
                      </span>
                      {etapa.del_anterior !== null ? (
                        <span className={esPeor ? 'ml-2 text-leak' : 'ml-2 text-ink-faint'}>
                          {etapa.del_anterior}% del anterior
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-paper-sunken">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${ancho}%`,
                        background: esPeor ? 'var(--color-leak)' : 'var(--color-ink)',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      {/* ── 2 · La caída pregunta por pregunta ──────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle
          eyebrow="Decisión: qué pregunta reescribir"
          title="En qué pregunta se cae"
          subtitle="Abandonos es la cuenta que importa: sesiones cuya última respuesta fue esa y que nunca terminaron. La mediana de segundos es el tiempo desde la respuesta anterior."
        />
        {preguntas.length === 0 ? (
          <Empty title="Sin respuestas en la ventana" />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                  <th className="px-5 py-3">Pregunta</th>
                  <th className="px-5 py-3 text-right">Llegaron</th>
                  <th className="px-5 py-3 text-right">Mediana</th>
                  <th className="px-5 py-3 text-right">Se cayeron ahí</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {preguntas.map((p) => (
                  <tr key={p.clave}>
                    <td className="px-5 py-3 font-mono text-[12.5px] text-ink">{p.clave}</td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink-soft">
                      {formatNumber(p.sesiones)}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink-faint">
                      {p.mediana_segundos !== null ? `${p.mediana_segundos}s` : '—'}
                    </td>
                    <td
                      className={`tnum px-5 py-3 text-right text-[13px] font-semibold ${
                        p.abandonos > 0 ? 'text-leak' : 'text-ink-faint'
                      }`}
                    >
                      {formatNumber(p.abandonos)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {/* ── 3 · Los supuestos que no se creen ───────────────────────────── */}
      <section className="space-y-4">
        <SectionTitle
          eyebrow="Decisión: qué default mover"
          title="Qué números nuestros no se creen"
          subtitle={`Últimos ${DIAS_SUPUESTOS} días. Un supuesto que suben siempre es uno donde somos demasiado conservadores; uno que bajan siempre es uno donde no nos creen. Las dos lecturas piden lo contrario de config/assumptions.ts.`}
        />
        {supuestos.length === 0 ? (
          <Empty
            title="Nadie ha discutido un número todavía"
            hint="Solo cuentan las ediciones que traen valor previo y posterior — las anteriores a la 3.6.0 no lo guardaban."
          />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                  <th className="px-5 py-3">Supuesto</th>
                  <th className="px-5 py-3 text-right">Ediciones</th>
                  <th className="px-5 py-3 text-right">Prospectos</th>
                  <th className="px-5 py-3 text-right">Subieron</th>
                  <th className="px-5 py-3 text-right">Bajaron</th>
                  <th className="px-5 py-3 text-right">Cambio mediano</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {supuestos.map((s) => (
                  <tr key={s.supuesto}>
                    <td className="px-5 py-3 font-mono text-[12.5px] text-ink">{s.supuesto}</td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink">
                      {formatNumber(s.ediciones)}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink-soft">
                      {formatNumber(s.organizaciones)}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-money">
                      {s.subieron > 0 ? `↑ ${formatNumber(s.subieron)}` : '—'}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-leak">
                      {s.bajaron > 0 ? `↓ ${formatNumber(s.bajaron)}` : '—'}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] font-semibold text-ink">
                      {s.cambio_mediano_pct !== null
                        ? `${s.cambio_mediano_pct > 0 ? '+' : ''}${s.cambio_mediano_pct}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
