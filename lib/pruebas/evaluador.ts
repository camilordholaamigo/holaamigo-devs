import { db, mustWrite } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import { EvaluacionPruebaSchema, type Juicio } from '@/lib/ai/schemas';
import { PRUEBA_EVALUAR_SYSTEM } from '@/config/prompts';
import { hasOpenAI } from '@/lib/env';
import { clamp } from '@/lib/utils';
import { leerPrueba } from '@/lib/pruebas/motor';
import type { Evaluacion, Mensaje, PlanDePrueba } from '@/lib/pruebas/types';

/**
 * Capa 3 · la evaluación con modelo.
 *
 * Lo caro y lo que más se lee. Contesta lo que las capas 1 y 2 no pueden:
 * ¿la respuesta estuvo BIEN? ¿inventó algo? ¿qué habría que cambiar?
 *
 * DOS DECISIONES QUE LA SEPARAN DEL PAQUETE DEL QUE VIENE:
 *
 * 1. **El modelo no devuelve números.** Devuelve cinco juicios cualitativos y
 *    el código los convierte con la tabla de abajo. Pedirle un 78 sería falsa
 *    precisión: la misma transcripción le saca 74 y 79 en dos corridas, y ese
 *    ruido llegaría al cliente disfrazado de medición. Con juicios, la
 *    varianza se ve — «bien» o «regular» — y la nota es una función pura de
 *    ellos, que es lo que exige ADR 0007.
 *
 * 2. **Se dispara sola**, no desde un botón. En el paquete original la capa 3
 *    estaba detrás de un botón y por eso casi nunca se corría; una evaluación
 *    que hay que acordarse de pedir es una evaluación que no existe. Quién la
 *    dispara y por qué no es `cerrarPrueba()` está en
 *    `evaluarCerradasSinEvaluar()`, al final del archivo.
 *
 * Sin `ficha` en el plan, `exactitud` y `ausencia_de_invenciones` no
 * significan nada —el evaluador no tiene contra qué comparar— y se excluyen de
 * la nota. Es la misma disciplina del auditor: no se juzga lo que no se puede
 * verificar.
 */

/**
 * La tabla. Vive en el código y por eso la nota es reproducible: dos
 * evaluaciones con los mismos juicios dan exactamente el mismo número.
 */
const VALOR: Record<Juicio, number> = {
  excelente: 95,
  bien: 80,
  regular: 55,
  mal: 30,
  pesimo: 10,
};

/** Cuánto pesa cada dimensión. Suman lo que suman; se normaliza al promediar. */
const PESO = {
  exactitud: 3,
  tono: 1,
  completitud: 2,
  proactividad: 2,
  ausencia_de_invenciones: 3,
} as const;

export async function evaluarPrueba(pruebaId: string): Promise<Evaluacion | null> {
  const prueba = await leerPrueba(pruebaId);

  if (prueba.evaluacion) return prueba.evaluacion;
  if (!hasOpenAI()) return null;

  const plan = prueba.plan as PlanDePrueba;
  const conversation = prueba.conversation ?? [];

  // Una conversación de un solo mensaje —el nuestro— no tiene nada que
  // evaluar. Gastar una llamada para que un modelo escriba «no hubo
  // respuesta» es gastar una llamada.
  if (!conversation.some((m) => m.role === 'negocio')) {
    const vacia = sinRespuesta();
    await guardar(pruebaId, vacia);
    return vacia;
  }

  try {
    const r = await runStructured({
      step: 'prueba',
      schemaName: 'evaluacion_prueba',
      schema: EvaluacionPruebaSchema,
      system: PRUEBA_EVALUAR_SYSTEM,
      input: armarInput(plan, conversation),
      organizationId: prueba.organization_id,
      role: 'cmo',
      trigger: 'smoke_test',
    });

    const hayFicha = plan.ficha.length > 0;
    const evaluacion = componer(r.data, hayFicha);
    await guardar(pruebaId, evaluacion);
    return evaluacion;
  } catch (err) {
    // La evaluación es la única de las tres capas que puede faltar. Que se
    // caiga no puede tocar el estado de la prueba: las capas 1 y 2 ya
    // escribieron y el informe del cliente ya tiene con qué armarse.
    console.error('[pruebas] la evaluación falló', err);
    return null;
  }
}

function componer(
  raw: {
    exactitud: Juicio;
    tono: Juicio;
    completitud: Juicio;
    proactividad: Juicio;
    ausencia_de_invenciones: Juicio;
    alucinaciones: string[];
    errores: string[];
    sugerencias: string[];
    resumen: string;
  },
  hayFicha: boolean,
): Evaluacion {
  const dims = {
    exactitud: VALOR[raw.exactitud] ?? 55,
    tono: VALOR[raw.tono] ?? 55,
    completitud: VALOR[raw.completitud] ?? 55,
    proactividad: VALOR[raw.proactividad] ?? 55,
    ausencia_de_invenciones: VALOR[raw.ausencia_de_invenciones] ?? 55,
  };

  // Sin ficha de verdad, las dos dimensiones que dependen de ella no entran en
  // la nota. Con ficha vacía el modelo no puede saber si un dato es correcto:
  // lo que devuelva sobre exactitud es una opinión sobre plausibilidad.
  const entran = hayFicha
    ? (Object.keys(PESO) as Array<keyof typeof PESO>)
    : (['tono', 'completitud', 'proactividad'] as Array<keyof typeof PESO>);

  const pesoTotal = entran.reduce((s, k) => s + PESO[k], 0);
  const acumulado = entran.reduce((s, k) => s + dims[k] * PESO[k], 0);

  return {
    score: clamp(Math.round(acumulado / pesoTotal), 0, 100),
    ...dims,
    // El nombre público conserva la orientación «más alto es mejor» del
    // paquete original: 100 = no inventó nada.
    riesgo_alucinacion: dims.ausencia_de_invenciones,
    alucinaciones: lista(raw.alucinaciones),
    errores: lista(raw.errores),
    sugerencias: lista(raw.sugerencias),
    resumen: String(raw.resumen ?? '').slice(0, 600),
  };
}

function sinRespuesta(): Evaluacion {
  return {
    score: 0,
    exactitud: 0,
    tono: 0,
    completitud: 0,
    proactividad: 0,
    riesgo_alucinacion: 0,
    alucinaciones: [],
    errores: ['Nadie contestó el mensaje.'],
    sugerencias: [
      'Revisar quién está pendiente de esa línea y en qué horario.',
      'Configurar al menos una respuesta automática que diga cuándo van a contestar.',
    ],
    resumen: 'No hubo respuesta, así que no hay conversación que calificar.',
  };
}

/** Nunca se confía en la forma de lo que devuelve un modelo, aunque se pidió. */
function lista(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function armarInput(plan: PlanDePrueba, conversation: Mensaje[]): string {
  const ficha =
    plan.ficha.length > 0
      ? plan.ficha
          .map((h) => `- ${h.clave}: ${h.valor}${h.fuente ? ` [${h.fuente}]` : ' [inferido]'}`)
          .join('\n')
      : '(no tenemos ficha: NO puedes juzgar exactitud ni invenciones, ponlas en "regular" y deja las listas vacías)';

  return [
    `NEGOCIO EVALUADO: ${plan.negocio}`,
    `TIPO DE PRUEBA: ${plan.template_id}`,
    `OBJETIVO DE LA PRUEBA: ${plan.objetivo}`,
    '',
    'FICHA DE VERDAD (lo que su propio sitio dice):',
    ficha,
    '',
    'LO QUE SE PREGUNTÓ:',
    plan.sondas.map((s) => `- ${s.pregunta}`).join('\n'),
    '',
    'TRANSCRIPCIÓN:',
    conversation
      .map((m) => `${m.role === 'comprador' ? 'COMPRADOR' : 'NEGOCIO'}: ${m.text}`)
      .join('\n'),
  ]
    .join('\n')
    .slice(0, 40_000);
}

async function guardar(pruebaId: string, evaluacion: Evaluacion): Promise<void> {
  await mustWrite(
    db()
      .from('smoke_probes')
      .update({ evaluacion, evaluacion_score: evaluacion.score })
      .eq('id', pruebaId),
    'smoke_probes.evaluacion',
  );
}

/**
 * Evalúa las pruebas cerradas de una corrida que todavía no tienen nota.
 *
 * Se llama desde donde hay un `after()` disponible —el webhook, el estado, el
 * cron—, y NO desde `cerrarPrueba()`. La razón es aburrida y buena: el
 * evaluador necesita `leerPrueba()` del motor, así que si el motor lo llamara
 * habría un ciclo de importación. La consecuencia práctica es mejor de lo que
 * suena: cerrar una prueba nunca espera a una llamada de modelo.
 *
 * Lo que sí se arregla respecto del paquete original es que esto **se dispara
 * solo**. Allá la capa 3 estaba detrás de un botón, y una evaluación que hay
 * que acordarse de pedir es una evaluación que no existe.
 *
 * Nunca lanza: la nota es lo único de las tres capas que puede faltar.
 */
export async function evaluarCerradasSinEvaluar(runId: string): Promise<number> {
  const { data } = await db()
    .from('smoke_probes')
    .select('id')
    .eq('run_id', runId)
    .in('estado', ['completed', 'timeout'])
    .is('evaluacion', null)
    .limit(10);

  let hechas = 0;
  for (const fila of data ?? []) {
    try {
      if (await evaluarPrueba(fila.id)) hechas += 1;
    } catch (err) {
      console.error('[pruebas] no se pudo evaluar', err);
    }
  }
  return hechas;
}
