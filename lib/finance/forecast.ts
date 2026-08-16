import { db, tryWrite } from '@/lib/supabase/admin';

/**
 * ¿Vamos a llegar a la meta del trimestre, y con qué probabilidad?
 *
 * Toda la matemática está acá, en código, y es deliberadamente simple. Un
 * pronóstico que nadie puede explicar es un número con autoridad y sin
 * defensa — y este producto se trata de lo contrario (ADR 0007).
 *
 * EL MODELO, en tres líneas:
 *
 *   1. Ritmo diario = ingreso neto de los últimos 90 días / días con datos.
 *   2. Banda = coeficiente de variación semanal, acotado entre 15% y 60%.
 *   3. Escenarios = ritmo × días restantes, ± la banda.
 *
 * Las probabilidades NO salen de una simulación: son la lectura estándar de una
 * banda P85/P50/P15. "Hay 85% de probabilidad de superar el conservador" es lo
 * que significa construir el conservador así, y decirlo de otra forma sería
 * inventar precisión estadística que no tenemos con doce semanas de datos.
 *
 * LO QUE ESTE MODELO NO HACE, y hay que decirlo cuando alguien pregunte:
 * no distingue estacionalidad, no modela el pipeline abierto y no sabe de
 * contratos con fecha de renovación. Con tres meses de historia, cualquier
 * modelo que pretenda eso está sobreajustando ruido.
 *
 * Ver docs/wiki/18-el-president-como-cro.md
 */

export type Scenario = 'conservative' | 'base' | 'aggressive';

export interface ForecastLine {
  scenario: Scenario;
  value: number;
  probability: number;
  assumptions: Record<string, unknown>;
}

export interface Forecast {
  horizonEnd: string;
  metric: string;
  lines: ForecastLine[];
  /** Probabilidad de alcanzar la meta, si hay meta declarada. */
  meta: number | null;
  probabilidad_de_meta: number | null;
  explicacion: string;
}

/** Lo que significa cada escenario. Es la lectura estándar de una banda. */
const PROBABILIDAD: Record<Scenario, number> = {
  conservative: 0.85,
  base: 0.5,
  aggressive: 0.15,
};

export async function forecast(args: {
  organizationId: string;
  horizonEnd: Date;
  /** Meta de ingreso del periodo, si el Brief la declara. */
  meta?: number | null;
  hoy?: Date;
}): Promise<Forecast> {
  const hoy = args.hoy ?? new Date();
  const desde = new Date(hoy.getTime() - 90 * 86_400_000);

  const { data } = await db()
    .from('revenue_events')
    .select('amount_usd, kind, occurred_at')
    .eq('organization_id', args.organizationId)
    .gte('occurred_at', desde.toISOString())
    .lte('occurred_at', hoy.toISOString())
    .limit(5000);

  const eventos = (data ?? []).map((e) => ({
    monto:
      e.kind === 'refund' || e.kind === 'churn'
        ? -Number(e.amount_usd ?? 0)
        : Number(e.amount_usd ?? 0),
    fecha: new Date(e.occurred_at),
  }));

  const diasRestantes = Math.max(
    0,
    Math.ceil((args.horizonEnd.getTime() - hoy.getTime()) / 86_400_000),
  );

  if (eventos.length === 0) {
    return {
      horizonEnd: args.horizonEnd.toISOString().slice(0, 10),
      metric: 'ingreso_usd',
      lines: (['conservative', 'base', 'aggressive'] as Scenario[]).map((scenario) => ({
        scenario,
        value: 0,
        probability: PROBABILIDAD[scenario],
        assumptions: { motivo: 'todavía no hay ingresos registrados' },
      })),
      meta: args.meta ?? null,
      probabilidad_de_meta: args.meta ? 0 : null,
      explicacion:
        'Todavía no hay un solo ingreso registrado, así que no hay ritmo que proyectar. ' +
        'El pronóstico aparece cuando entre la primera venta.',
    };
  }

  const total = eventos.reduce((sum, e) => sum + e.monto, 0);
  const diasConDatos = Math.max(
    1,
    Math.ceil((hoy.getTime() - Math.min(...eventos.map((e) => e.fecha.getTime()))) / 86_400_000),
  );
  const ritmoDiario = total / diasConDatos;

  const banda = coeficienteDeVariacionSemanal(eventos);
  const base = ritmoDiario * diasRestantes;

  const lines: ForecastLine[] = (['conservative', 'base', 'aggressive'] as Scenario[]).map(
    (scenario) => {
      const factor = scenario === 'conservative' ? 1 - banda : scenario === 'aggressive' ? 1 + banda : 1;
      return {
        scenario,
        value: Math.round(Math.max(0, base * factor)),
        probability: PROBABILIDAD[scenario],
        assumptions: {
          ritmo_diario_usd: Math.round(ritmoDiario * 100) / 100,
          dias_con_datos: diasConDatos,
          dias_restantes: diasRestantes,
          banda_de_variacion: Math.round(banda * 100) / 100,
          eventos_considerados: eventos.length,
        },
      };
    },
  );

  return {
    horizonEnd: args.horizonEnd.toISOString().slice(0, 10),
    metric: 'ingreso_usd',
    lines,
    meta: args.meta ?? null,
    probabilidad_de_meta: args.meta ? probabilidadDeMeta(lines, args.meta) : null,
    explicacion:
      `Con el ritmo de los últimos ${diasConDatos} días (USD ${Math.round(ritmoDiario)} por día) ` +
      `y ${diasRestantes} días por delante, lo más probable es cerrar en USD ${lines[1].value}. ` +
      `La banda de ±${Math.round(banda * 100)}% sale de cuánto varió semana a semana, no de una estimación.`,
  };
}

/**
 * Cuánto varía el ingreso semana a semana.
 *
 * Se acota entre 15% y 60% a propósito: con pocas semanas, el coeficiente real
 * puede dar 4% (una banda falsamente estrecha que hace parecer certero un
 * pronóstico que no lo es) o 300% (una banda tan ancha que no dice nada). Los
 * topes son un juicio declarado, no un dato.
 */
function coeficienteDeVariacionSemanal(eventos: Array<{ monto: number; fecha: Date }>): number {
  const porSemana = new Map<string, number>();
  for (const evento of eventos) {
    const semana = new Date(evento.fecha);
    semana.setUTCDate(semana.getUTCDate() - semana.getUTCDay());
    const clave = semana.toISOString().slice(0, 10);
    porSemana.set(clave, (porSemana.get(clave) ?? 0) + evento.monto);
  }

  const valores = [...porSemana.values()];
  if (valores.length < 2) return 0.6;

  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  if (media === 0) return 0.6;

  const varianza =
    valores.reduce((sum, v) => sum + (v - media) ** 2, 0) / valores.length;
  const cv = Math.sqrt(varianza) / Math.abs(media);

  return Math.min(0.6, Math.max(0.15, cv));
}

/**
 * Dónde cae la meta dentro de la banda, por interpolación lineal.
 *
 * No es una probabilidad bayesiana ni pretende serlo: es "la meta está entre el
 * escenario base y el agresivo, más cerca del base", traducido a un número. Se
 * dice así en la pantalla.
 */
function probabilidadDeMeta(lines: ForecastLine[], meta: number): number {
  const [conservador, base, agresivo] = lines;
  if (meta <= conservador.value) return 0.95;
  if (meta >= agresivo.value) return 0.05;

  if (meta <= base.value) {
    const t = (meta - conservador.value) / Math.max(1, base.value - conservador.value);
    return Math.round((0.85 - t * 0.35) * 100) / 100;
  }
  const t = (meta - base.value) / Math.max(1, agresivo.value - base.value);
  return Math.round((0.5 - t * 0.35) * 100) / 100;
}

/** Guarda el pronóstico. Es telemetría: si falla, no tumba nada. */
export async function guardarForecast(organizationId: string, resultado: Forecast): Promise<void> {
  for (const line of resultado.lines) {
    await tryWrite(
      db().from('forecasts').insert({
        organization_id: organizationId,
        horizon_end: resultado.horizonEnd,
        scenario: line.scenario,
        metric: resultado.metric,
        value: line.value,
        probability: line.probability,
        assumptions: line.assumptions,
      }),
      `forecasts.${line.scenario}`,
    );
  }
}
