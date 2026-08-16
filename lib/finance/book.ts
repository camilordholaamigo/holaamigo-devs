import { db } from '@/lib/supabase/admin';
import { pnl, periodoActual, type PnL } from '@/lib/finance/economics';
import { experimentsFor, type ExperimentRow } from '@/lib/finance/experiments';
import { forecast, type Forecast } from '@/lib/finance/forecast';
import { propuestasPendientes } from '@/lib/finance/allocation';
import type { DecisionRow } from '@/lib/decisions/types';

/**
 * El libro de resultados: seis secciones, un solo objeto.
 *
 * **La columna de calibración es el diferenciador.** Ningún competidor le
 * muestra al cliente qué tan bien predice su propia IA. Nosotros mostramos, mes
 * a mes, qué dijo cada agente que iba a pasar, qué pasó, y qué tan lejos estuvo.
 *
 * Todo el libro se arma acá y las dos salidas —la pantalla imprimible y el
 * CSV— leen el MISMO objeto. Ese es el motivo de que exista `buildResultsBook`
 * en vez de dos funciones: el criterio de aceptación pide que el PDF y el CSV
 * traigan los mismos números, y la única forma de garantizarlo es que no haya
 * dos caminos de cálculo. Si mañana el PDF muestra otra cifra, es un bug de
 * render, no una discrepancia de datos.
 *
 * Ver docs/wiki/18-el-president-como-cro.md
 */

export interface BookDecision {
  id: string;
  fecha: string;
  agente: string;
  tipo: string;
  pregunta: string;
  elegida: string;
  costo_usd: number | null;
  metrica: string | null;
  predijo: number | null;
  paso: number | null;
  calibracion: number | null;
}

export interface ResultsBook {
  organizationId: string;
  periodo: string;
  generado_en: string;
  resumen: string;
  pnl: PnL;
  decisiones: BookDecision[];
  calibracion_promedio: number | null;
  experimentos: ExperimentRow[];
  lecciones: Array<{ statement: string; n_support: number; confidence: number; status: string }>;
  pronostico: Forecast;
  reasignacion: Array<Record<string, unknown>>;
}

export async function buildResultsBook(
  organizationId: string,
  periodo = periodoActual(),
): Promise<ResultsBook> {
  const desde = `${periodo}-01T00:00:00Z`;
  const [anio, mes] = periodo.split('-').map(Number);
  const hasta = new Date(Date.UTC(anio, mes, 1)).toISOString();
  const finDeTrimestre = new Date(Date.UTC(anio, Math.ceil(mes / 3) * 3, 0));

  const [cuentas, decisiones, experimentos, lecciones, reasignacion] = await Promise.all([
    pnl(organizationId, periodo),
    db()
      .from('decisions')
      .select('*')
      .eq('organization_id', organizationId)
      .gte('created_at', desde)
      .lt('created_at', hasta)
      .order('created_at', { ascending: false })
      .limit(500),
    experimentsFor(organizationId, { limit: 100 }),
    db()
      .from('lessons')
      .select('statement, n_support, confidence, status, updated_at')
      .or(`scope_ref.eq.${organizationId},scope_ref.like.${organizationId}:%`)
      .gte('updated_at', desde)
      .order('confidence', { ascending: false })
      .limit(50),
    propuestasPendientes(organizationId),
  ]);

  const filas = ((decisiones.data ?? []) as DecisionRow[]).map(toBookDecision);
  const medidas = filas.filter((d) => d.calibracion !== null);
  const calibracionPromedio =
    medidas.length > 0
      ? Math.round((medidas.reduce((sum, d) => sum + (d.calibracion ?? 0), 0) / medidas.length) * 1000) / 1000
      : null;

  const pronostico = await forecast({
    organizationId,
    horizonEnd: finDeTrimestre,
  });

  return {
    organizationId,
    periodo,
    generado_en: new Date().toISOString(),
    resumen: narrar(cuentas, filas, medidas.length, calibracionPromedio, experimentos),
    pnl: cuentas,
    decisiones: filas,
    calibracion_promedio: calibracionPromedio,
    experimentos: experimentos.filter(
      (e) => e.readout_at === null || (e.readout_at >= desde && e.readout_at < hasta),
    ),
    lecciones: (lecciones.data ?? []).map((l) => ({
      statement: l.statement,
      n_support: l.n_support,
      confidence: Number(l.confidence),
      status: l.status,
    })),
    pronostico,
    reasignacion: reasignacion as Array<Record<string, unknown>>,
  };
}

function toBookDecision(d: DecisionRow): BookDecision {
  return {
    id: d.id,
    fecha: d.created_at.slice(0, 10),
    agente: d.role ?? '—',
    tipo: d.kind,
    pregunta: d.question,
    elegida: d.chosen?.label ?? '—',
    costo_usd: d.cost_usd === null ? null : Number(d.cost_usd),
    metrica: d.prediction?.metric ?? null,
    predijo: d.prediction?.expected_value ?? null,
    paso: d.outcome?.actual_value ?? null,
    calibracion: d.calibration === null ? null : Number(d.calibration),
  };
}

/**
 * El resumen narrado, en código.
 *
 * Doscientas palabras escritas con `format` y no por el modelo, y es a
 * propósito: este documento es el que el cliente le muestra a su socio o a su
 * junta. Un número inventado acá no es un texto flojo, es un problema
 * contractual. Cuando el modelo entre a mejorar la prosa —y va a entrar—, va a
 * ser con la misma verificación de cifras del Capítulo (P3).
 */
function narrar(
  cuentas: PnL,
  decisiones: BookDecision[],
  medidas: number,
  calibracion: number | null,
  experimentos: ExperimentRow[],
): string {
  const ganados = experimentos.filter((e) => e.status === 'won').length;
  const perdidos = experimentos.filter((e) => e.status === 'lost').length;
  const inconclusos = experimentos.filter((e) => e.status === 'inconclusive').length;

  const partes = [
    `En ${cuentas.periodo} entraron USD ${cuentas.ingreso_usd} y salieron USD ${cuentas.costo_usd}, ` +
      `con un margen de USD ${cuentas.margen_usd}.`,
    cuentas.clientes_nuevos > 0
      ? `Llegaron ${cuentas.clientes_nuevos} clientes nuevos a un costo promedio de USD ${cuentas.cac_promedio_usd}` +
        (cuentas.payback_dias !== null ? `, que se paga solo en ${cuentas.payback_dias} días.` : '.')
      : 'No entró ningún cliente nuevo este periodo.',
    `Los agentes tomaron ${decisiones.length} decisiones registradas` +
      (medidas > 0
        ? `, de las cuales ${medidas} ya se midieron: la calibración promedio fue ${calibracion}, ` +
          `donde 1 es predecir exacto y 0 es errar por completo.`
        : ', y todavía ninguna cumplió su horizonte de medición.'),
    experimentos.length > 0
      ? `Se corrieron ${experimentos.length} experimentos: ${ganados} ganados, ${perdidos} perdidos y ${inconclusos} sin muestra suficiente.`
      : 'No hubo experimentos con readout en el periodo.',
  ];

  return partes.join(' ');
}

/**
 * El CSV. Un archivo con secciones, no una tabla.
 *
 * Un P&G, una lista de decisiones y una de experimentos no comparten columnas,
 * y forzarlas a una sola tabla produce un archivo con veinte columnas vacías
 * por fila. Excel abre esto perfecto y cada bloque se copia entero.
 */
export function bookToCSV(book: ResultsBook): string {
  const lineas: string[] = [];
  const fila = (...celdas: Array<string | number | null>) =>
    lineas.push(celdas.map(escapar).join(','));

  fila(`Libro de resultados`, book.periodo);
  fila('Generado', book.generado_en);
  fila();
  fila('RESUMEN');
  fila(book.resumen);
  fila();

  fila('P&G');
  fila('Ingreso USD', book.pnl.ingreso_usd);
  fila('Costo USD', book.pnl.costo_usd);
  fila('Margen USD', book.pnl.margen_usd);
  fila('Clientes nuevos', book.pnl.clientes_nuevos);
  fila('CAC promedio USD', book.pnl.cac_promedio_usd);
  fila('ROAS', book.pnl.roas);
  fila('Payback días', book.pnl.payback_dias);
  fila();

  fila('POR CANAL');
  fila('Canal', 'Tipo', 'Ingreso USD', 'Costo USD', 'Margen USD', 'Clientes', 'CAC USD', 'ROAS');
  for (const canal of book.pnl.por_canal) {
    fila(
      canal.canal ?? 'sin canal',
      canal.tipo ?? '—',
      canal.ingreso_usd,
      canal.costo_usd,
      canal.margen_usd,
      canal.clientes_nuevos,
      canal.cac_usd,
      canal.roas,
    );
  }
  fila();

  fila('POR CATEGORÍA DE GASTO');
  for (const [categoria, monto] of Object.entries(book.pnl.por_categoria)) {
    fila(categoria, monto);
  }
  fila();

  fila('DECISIONES');
  fila('Fecha', 'Agente', 'Tipo', 'Pregunta', 'Elegida', 'Costo USD', 'Métrica', 'Predijo', 'Pasó', 'Calibración');
  for (const d of book.decisiones) {
    fila(d.fecha, d.agente, d.tipo, d.pregunta, d.elegida, d.costo_usd, d.metrica, d.predijo, d.paso, d.calibracion);
  }
  fila('Calibración promedio', book.calibracion_promedio);
  fila();

  fila('EXPERIMENTOS');
  fila('Hipótesis', 'Métrica', 'Esperado', 'Real', 'Muestra', 'Estado', 'Nota');
  for (const e of book.experimentos) {
    fila(e.hypothesis, e.primary_metric, e.expected_effect, e.actual_effect, e.actual_sample, e.status, e.readout_note);
  }
  fila();

  fila('LECCIONES');
  fila('Enunciado', 'n', 'Confianza', 'Estado');
  for (const l of book.lecciones) fila(l.statement, l.n_support, l.confidence, l.status);
  fila();

  fila('PRONÓSTICO', book.pronostico.horizonEnd);
  fila('Escenario', 'Valor USD', 'Probabilidad');
  for (const linea of book.pronostico.lines) fila(linea.scenario, linea.value, linea.probability);
  fila('Explicación', book.pronostico.explicacion);

  return lineas.join('\r\n');
}

/**
 * Escapado de CSV.
 *
 * `\r\n` como separador de línea y comillas dobles duplicadas: es lo que Excel
 * en español espera. Sin esto, una pregunta de decisión con una coma —o sea,
 * casi todas— parte la fila en dos y el archivo se ve corrupto justo en la
 * columna que importa.
 */
function escapar(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor);
  if (/[",\r\n]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}
