import { buildResultsBook } from '@/lib/finance/book';
import { periodoActual } from '@/lib/finance/economics';
import { SectionTitle, Card, Stat, Empty } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { formatMoney, formatNumber } from '@/lib/utils';

/**
 * El libro de resultados.
 *
 * Se descarga en dos formatos y los dos leen el mismo objeto: el CSV por
 * `/api/libro/[orgId]`, y el PDF por el diálogo de impresión del navegador con
 * una hoja de estilo de impresión.
 *
 * POR QUÉ NO HAY LIBRERÍA DE PDF: son entre 2 y 6 MB de dependencia y un cold
 * start de función serverless, para producir un documento que el navegador ya
 * sabe renderizar mejor que nosotros —con las fuentes del sistema, con la
 * paginación del sistema y con la vista previa incluida. Cuando haga falta un
 * PDF generado en servidor (para adjuntarlo a un correo, por ejemplo), se
 * agrega ahí y esta pantalla no cambia.
 *
 * La columna que importa es la última de la tabla de decisiones: **qué predijo
 * el agente, qué pasó, y qué tan lejos estuvo.** Ningún competidor le muestra
 * eso al cliente.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Libro de resultados · Hola Amigo', robots: { index: false } };

const ESCENARIO: Record<string, string> = {
  conservative: 'Conservador',
  base: 'Base',
  aggressive: 'Optimista',
};

export default async function LibroPage({ params, searchParams }: PageProps<'/consola/[orgId]/libro'>) {
  const { orgId } = await params;
  const query = await searchParams;
  const pedido = typeof query.periodo === 'string' ? query.periodo : null;
  const periodo = pedido && /^\d{4}-\d{2}$/.test(pedido) ? pedido : periodoActual();

  const book = await buildResultsBook(orgId, periodo);
  const medidas = book.decisiones.filter((d) => d.calibracion !== null);

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-6 py-12 print:max-w-none print:px-0 print:py-0">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionTitle
          eyebrow={`Libro de resultados · ${periodo}`}
          title="Qué entró, qué salió y qué tan bien predijimos"
          subtitle="Las mismas cifras en pantalla, en CSV y en PDF. La última columna de las decisiones es la que ningún competidor te muestra."
        />
        <div className="flex gap-2 print:hidden">
          <a
            href={`/api/libro/${orgId}?periodo=${periodo}&formato=csv`}
            className="rounded-xl border border-line-strong px-4 py-2 text-[13px] font-medium text-ink-soft transition hover:border-ink"
          >
            Descargar CSV
          </a>
          <PrintButton />
        </div>
      </div>

      <p className="prosa text-[15px] leading-[1.75] text-ink-soft">{book.resumen}</p>

      <section className="grid gap-4 sm:grid-cols-4">
        <Card className="p-5">
          <Stat label="Ingreso" value={formatMoney(book.pnl.ingreso_usd)} tone="money" />
        </Card>
        <Card className="p-5">
          <Stat label="Costo" value={formatMoney(book.pnl.costo_usd)} />
        </Card>
        <Card className="p-5">
          <Stat
            label="Margen"
            value={formatMoney(book.pnl.margen_usd)}
            tone={book.pnl.margen_usd < 0 ? 'leak' : 'money'}
          />
        </Card>
        <Card className="p-5">
          <Stat
            label="Calibración"
            value={book.calibracion_promedio === null ? '—' : book.calibracion_promedio.toFixed(2)}
            hint={
              book.calibracion_promedio === null
                ? 'ninguna decisión cumplió su horizonte todavía'
                : `sobre ${medidas.length} decisiones medidas · 1 es predecir exacto`
            }
          />
        </Card>
      </section>

      <Seccion titulo="Por canal">
        {book.pnl.por_canal.length === 0 ? (
          <Empty title="Sin movimiento" hint="Cuando entre el primer ingreso o gasto con canal, aparece acá." />
        ) : (
          <Tabla
            cabeceras={['Canal', 'Ingreso', 'Costo', 'Margen', 'Clientes', 'CAC', 'ROAS']}
            filas={book.pnl.por_canal.map((c) => [
              c.canal ?? 'sin canal',
              formatMoney(c.ingreso_usd),
              formatMoney(c.costo_usd),
              formatMoney(c.margen_usd),
              formatNumber(c.clientes_nuevos),
              c.cac_usd === null ? '—' : formatMoney(c.cac_usd),
              c.roas === null ? '—' : `${Number(c.roas).toFixed(2)}x`,
            ])}
          />
        )}
      </Seccion>

      <Seccion titulo="Decisiones del periodo">
        {book.decisiones.length === 0 ? (
          <Empty title="Ninguna decisión registrada" />
        ) : (
          <Tabla
            cabeceras={['Fecha', 'Agente', 'Decisión', 'Costo', 'Predijo', 'Pasó', 'Calibración']}
            filas={book.decisiones
              .slice(0, 60)
              .map((d) => [
                d.fecha,
                d.agente,
                `${d.pregunta} → ${d.elegida}`,
                d.costo_usd === null ? '—' : formatMoney(d.costo_usd),
                d.predijo === null ? '—' : `${d.predijo} ${d.metrica ?? ''}`,
                d.paso === null ? 'sin medir' : String(d.paso),
                d.calibracion === null ? '—' : d.calibracion.toFixed(2),
              ])}
          />
        )}
      </Seccion>

      <Seccion titulo="Experimentos">
        {book.experimentos.length === 0 ? (
          <Empty
            title="Sin experimentos"
            hint="Ninguna acción consecuente se ejecuta sin declarar antes qué esperamos. Cuando haya una, aparece acá con su regla de decisión."
          />
        ) : (
          <Tabla
            cabeceras={['Hipótesis', 'Métrica', 'Esperado', 'Real', 'Muestra', 'Resultado']}
            filas={book.experimentos.map((e) => [
              e.hypothesis,
              e.primary_metric,
              String(e.expected_effect),
              e.actual_effect === null ? '—' : String(e.actual_effect),
              e.actual_sample === null ? '—' : `${e.actual_sample} / ${e.min_sample}`,
              e.status,
            ])}
          />
        )}
      </Seccion>

      <Seccion titulo="Lecciones nuevas">
        {book.lecciones.length === 0 ? (
          <Empty title="Todavía no hay lecciones destiladas de este periodo" />
        ) : (
          <ul className="space-y-2">
            {book.lecciones.map((l) => (
              <li key={l.statement} className="text-[14px] leading-relaxed text-ink-soft">
                {l.statement}{' '}
                <span className="text-[12px] text-ink-faint">
                  [n={l.n_support} · confianza {l.confidence.toFixed(2)} · {l.status}]
                </span>
              </li>
            ))}
          </ul>
        )}
      </Seccion>

      <Seccion titulo={`Pronóstico al ${book.pronostico.horizonEnd}`}>
        <Tabla
          cabeceras={['Escenario', 'Ingreso proyectado', 'Probabilidad de superarlo']}
          filas={book.pronostico.lines.map((l) => [
            ESCENARIO[l.scenario] ?? l.scenario,
            formatMoney(l.value),
            `${Math.round(l.probability * 100)}%`,
          ])}
        />
        <p className="mt-3 text-[13px] leading-relaxed text-ink-faint">{book.pronostico.explicacion}</p>
      </Seccion>

      {book.reasignacion.length > 0 ? (
        <Seccion titulo="Propuesta para el próximo periodo">
          {book.reasignacion.map((p) => (
            <p key={String(p.id)} className="prosa text-[14px] leading-relaxed text-ink-soft">
              {String(p.reasoning)}
            </p>
          ))}
        </Seccion>
      ) : null}

      <p className="border-t border-line pt-4 text-[12px] text-ink-faint">
        Generado el{' '}
        {new Date(book.generado_en).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' })}.
        Las cifras salen de los eventos registrados, no de una estimación del modelo.
      </p>
    </main>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 break-inside-avoid">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{titulo}</h2>
      {children}
    </section>
  );
}

function Tabla({ cabeceras, filas }: { cabeceras: string[]; filas: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line-strong text-left">
            {cabeceras.map((c) => (
              <th key={c} className="py-2 pr-4 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((fila, i) => (
            <tr key={i} className="border-b border-line">
              {fila.map((celda, j) => (
                <td key={j} className={`py-2 pr-4 ${j === 0 ? 'text-ink' : 'tnum text-ink-soft'}`}>
                  {celda}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
