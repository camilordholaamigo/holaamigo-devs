import { db, mustWrite, tryWrite, unwrap } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import {
  InformeLenguajeSchema,
  InformeLenguajeMinimalSchema,
  inflarInformeLenguaje,
} from '@/lib/ai/schemas';
import { INFORME_SYSTEM } from '@/config/prompts';
import { hasOpenAI } from '@/lib/env';
import { track } from '@/lib/events';
import { formatoDuracion } from '@/lib/pruebas/motor';

/**
 * El informe: de N conversaciones sueltas a una cosa que se puede mandar.
 *
 * ── EL REPARTO, OTRA VEZ ───────────────────────────────────────────────────
 *
 * El CÓDIGO pone las cifras (`salud_de_linea`), los hallazgos con su
 * frecuencia (`hallazgos_por_frecuencia`), las citas textuales
 * (`citas_del_periodo`) y decide QUÉ recomendar. El MODELO pone las palabras:
 * la narrativa, el título de cada recomendación y el borrador del correo.
 *
 * ── POR QUÉ LA FRECUENCIA ES TODO ──────────────────────────────────────────
 *
 * «Falló en 4 de 5 conversaciones» y «falló en 1 de 5» piden cosas distintas:
 * la primera es un problema del guion y se arregla cambiando el guion; la
 * segunda es una conversación mala y se ignora. Sin esa distinción un informe
 * es una lista de reclamos, y una lista de reclamos no se lee dos veces.
 *
 * Por eso los hallazgos se agrupan por `id` de criterio —que es estable— y no
 * por el texto que devuelve el modelo, que nunca agruparía. Y por eso las
 * alucinaciones van aparte, textuales y sin contar: son citas, y una cita
 * resumida deja de ser prueba.
 *
 * ── SIN MODELO EL INFORME EXISTE IGUAL ─────────────────────────────────────
 *
 * Las cifras y los hallazgos no dependen de OpenAI. Si la llamada falla, el
 * informe se guarda sin narrativa y la pantalla lo muestra igual — con menos
 * prosa y los mismos hechos. Es la misma regla del resto del subsistema:
 * degradar en vez de fallar.
 *
 * Ver docs/wiki/24-lotes-e-informes.md
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONTRATOS
// ═══════════════════════════════════════════════════════════════════════════

export interface ResumenDeLinea {
  conversaciones: number;
  contestadas: number;
  sin_respuesta: number;
  mediana_segundos: number | null;
  p90_segundos: number | null;
  mas_rapida_segundos: number | null;
  mas_lenta_segundos: number | null;
  propusieron_paso: number;
  cerraron_cita: number;
  auditoria_promedio: number | null;
  evaluacion_promedio: number | null;
}

export interface Hallazgo {
  id: string;
  criterio: string;
  dimension: string;
  peso: number;
  fallo_en: number;
  de: number;
  ejemplos: string[];
  /** Lo calcula el código desde frecuencia × peso. Nunca el modelo. */
  impacto: 'alto' | 'medio' | 'bajo';
}

export interface Cita {
  texto: string;
  probe_id: string;
  plantilla: string;
  telefono: string;
}

export interface Recomendacion {
  clave: string;
  titulo: string;
  porque: string;
  impacto: 'alto' | 'medio' | 'bajo';
}

export interface BorradorDeCorreo {
  asunto: string;
  cuerpo: string;
}

export interface InformeRow {
  id: string;
  organization_id: string;
  batch_id: string | null;
  share_token: string;
  periodo_desde: string;
  periodo_hasta: string;
  resumen: ResumenDeLinea;
  hallazgos: Hallazgo[];
  citas: Cita[];
  recomendaciones: Recomendacion[];
  narrativa: string | null;
  correo: BorradorDeCorreo | null;
  publicado: boolean;
  vistas: number;
  visto_at: string | null;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CATÁLOGO DE RECOMENDACIONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Qué se recomienda cuando falla cada criterio.
 *
 * Vive en el código y no en un modelo por la misma razón que el playbook: es
 * el consejo que le damos a un cliente, y tiene que ser el mismo consejo todas
 * las veces. El modelo le pone las palabras; QUÉ se recomienda lo decidimos
 * nosotros, una vez, y se puede discutir en un pull request.
 *
 * `accion` es lo que el dueño puede hacer él mismo esta semana. Si una entrada
 * no supera esa prueba, no va — «mejorar el prompt» no es una recomendación
 * para alguien que no tiene un prompt.
 */
const CATALOGO: Record<string, { accion: string; contexto: string }> = {
  contesto: {
    accion: 'Poner a alguien —o algo— a cubrir esa línea',
    contexto:
      'Un mensaje sin respuesta no es un cliente que espera: es un cliente que ya le escribió al siguiente.',
  },
  tiempo: {
    accion: 'Bajar el tiempo de primera respuesta a menos de cinco minutos',
    contexto:
      'La primera respuesta es donde se decide casi todo. Después de los cinco minutos, la conversación ya no es tuya.',
  },
  utilidad: {
    accion: 'Resolver la duda en el primer mensaje, sin pedir que llamen',
    contexto:
      'Cada vez que se devuelve la pregunta en vez de contestarla, se pierde a alguien que ya estaba interesado.',
  },
  horario_correcto: {
    accion: 'Alinear el horario que dicen con el que está publicado',
    contexto:
      'Dos horarios distintos en dos lugares distintos hacen dudar de todo lo demás que dice el negocio.',
  },
  cierre: {
    accion: 'Terminar cada respuesta con una pregunta',
    contexto:
      'Una conversación donde solo pregunta el cliente se acaba cuando él se cansa, no cuando hay una venta.',
  },
  precio_coincide: {
    accion: 'Decir el mismo precio que está publicado, o quitarlo de la página',
    contexto:
      'Un precio distinto por WhatsApp que en la web obliga al cliente a averiguar cuál es el bueno, y muchos no lo hacen.',
  },
  cobertura_coincide: {
    accion: 'Unificar dónde atienden entre la página y la línea',
    contexto:
      'La cobertura es la primera objeción real. Si la respuesta cambia según dónde se pregunte, se cae ahí.',
  },
  sin_inventar: {
    accion: 'Escribir en una sola hoja lo que sí se puede prometer',
    contexto:
      'Cuando quien contesta no tiene el dato a la mano, lo aproxima. Una hoja de referencia lo resuelve más rápido que una capacitación.',
  },
  completitud: {
    accion: 'Contestar todas las preguntas del mensaje, no solo la última',
    contexto:
      'Quien escribe tres preguntas y recibe una respuesta vuelve a preguntar una vez. A la segunda, no.',
  },
  califico: {
    accion: 'Hacer dos preguntas antes de cotizar',
    contexto:
      'Cotizar sin preguntar produce cotizaciones que nadie contesta, y llena la agenda de gente que no iba a comprar.',
  },
  dio_precio: {
    accion: 'Dar un rango, aunque sea amplio, en vez de esquivar el precio',
    contexto:
      'Quien no recibe ni un rango asume el peor caso y se va. Un rango filtra mejor que el silencio.',
  },
  propuso: {
    accion: 'Proponer el paso siguiente sin esperar a que lo pidan',
    contexto:
      'Es el criterio que más separa una línea que atiende de una que vende. El cliente casi nunca lo propone.',
  },
  cerro: {
    accion: 'Cerrar con fecha y hora concretas, no con "te escribo"',
    contexto:
      'Una cita sin hora no es una cita. "Te escribo luego" es la forma más común de perder a alguien que ya dijo que sí.',
  },
};

const GENERICA = {
  accion: 'Revisar ese punto en la conversación de ejemplo',
  contexto: 'Se repitió lo suficiente como para no ser casualidad.',
};

/**
 * Impacto = frecuencia × peso, con umbrales fijos.
 *
 * Una función pura del código: dos informes con los mismos hallazgos ordenan
 * igual. Si el impacto lo pusiera el modelo, el mismo problema saldría "alto"
 * en un cliente y "medio" en otro, y el orden de la lista —que es lo que
 * decide qué arregla primero— dejaría de significar nada.
 */
function impactoDe(fallo: number, de: number, peso: number): Hallazgo['impacto'] {
  const frecuencia = de > 0 ? fallo / de : 0;
  const puntaje = frecuencia * peso;
  if (puntaje >= 2.5) return 'alto';
  if (puntaje >= 1) return 'medio';
  return 'bajo';
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERAR
// ═══════════════════════════════════════════════════════════════════════════

/** Cuántas recomendaciones entran. Ver el comentario de `MAX_RECOS`. */
const MAX_RECOS = 5;
const MAX_CITAS = 8;

export async function generarInforme(args: {
  organizationId: string;
  desde: string;
  batchId?: string | null;
}): Promise<InformeRow | null> {
  const { organizationId, desde } = args;

  const [{ data: salud }, { data: hallazgosRaw }, { data: citasRaw }, { data: org }] =
    await Promise.all([
      db().rpc('salud_de_linea', { p_org: organizationId, p_desde: desde }),
      db().rpc('hallazgos_por_frecuencia', { p_org: organizationId, p_desde: desde }),
      db().rpc('citas_del_periodo', { p_org: organizationId, p_desde: desde, p_limite: MAX_CITAS }),
      db()
        .from('organizations')
        .select('name, domain, website_url')
        .eq('id', organizationId)
        .maybeSingle(),
    ]);

  const resumen = normalizarSalud(salud?.[0]);

  // Sin conversaciones no hay informe. Generar uno vacío y mandarlo sería
  // peor que no mandar nada: el cliente abre un link que no dice nada.
  if (resumen.conversaciones === 0) return null;

  const hallazgos: Hallazgo[] = (hallazgosRaw ?? [])
    .map((h: Record<string, unknown>) => {
      const fallo = Number(h.fallo_en ?? 0);
      const de = Number(h.de ?? 0);
      const peso = Number(h.peso ?? 1);
      return {
        id: String(h.id ?? ''),
        criterio: String(h.criterio ?? ''),
        dimension: String(h.dimension ?? ''),
        peso,
        fallo_en: fallo,
        de,
        ejemplos: Array.isArray(h.ejemplos) ? (h.ejemplos as string[]).slice(0, 3) : [],
        impacto: impactoDe(fallo, de, peso),
      };
    })
    .slice(0, MAX_RECOS);

  const citas: Cita[] = (citasRaw ?? []).map((c: Record<string, unknown>) => ({
    texto: String(c.texto ?? ''),
    probe_id: String(c.probe_id ?? ''),
    plantilla: String(c.plantilla ?? ''),
    telefono: String(c.telefono ?? ''),
  }));

  const negocio = org?.name ?? org?.domain ?? 'tu negocio';

  const lenguaje = await ponerlePalabras({
    organizationId,
    negocio,
    resumen,
    hallazgos,
    citas,
  });

  // El modelo devuelve las recomendaciones en el orden en que le llegaron los
  // hallazgos; el impacto lo pone el código. Si devolvió menos —o inventó una
  // clave que no existe— se completa desde el catálogo en vez de perderla.
  const recomendaciones: Recomendacion[] = hallazgos.map((h) => {
    const delModelo = lenguaje.recomendaciones.find((r) => r.clave === h.id);
    const base = CATALOGO[h.id] ?? GENERICA;
    return {
      clave: h.id,
      titulo: delModelo?.titulo?.trim() || base.accion,
      porque: delModelo?.porque?.trim() || base.contexto,
      impacto: h.impacto,
    };
  });

  const { data: fila, error } = await db()
    .from('smoke_reports')
    .insert({
      organization_id: organizationId,
      batch_id: args.batchId ?? null,
      periodo_desde: desde,
      resumen,
      hallazgos,
      citas,
      recomendaciones,
      narrativa: lenguaje.narrativa,
      correo: lenguaje.correo,
      publicado: true,
    })
    .select('*')
    .single();

  if (error || !fila) {
    console.error('[informe] no se pudo guardar', error?.message);
    return null;
  }

  await track('smoke_report_generated', {
    organizationId,
    props: {
      conversaciones: resumen.conversaciones,
      hallazgos: hallazgos.length,
      con_narrativa: Boolean(lenguaje.narrativa),
    },
  });

  return fila as InformeRow;
}

/**
 * La única llamada al modelo de todo el informe.
 *
 * Recibe las cifras YA CALCULADAS, en prosa, para que escriba alrededor de
 * ellas. No se le piden de vuelta: se le piden palabras.
 */
async function ponerlePalabras(args: {
  organizationId: string;
  negocio: string;
  resumen: ResumenDeLinea;
  hallazgos: Hallazgo[];
  citas: Cita[];
}) {
  const vacio = {
    narrativa: '',
    recomendaciones: [] as Array<{ clave: string; titulo: string; porque: string }>,
    correo: null as BorradorDeCorreo | null,
  };

  if (!hasOpenAI() || args.hallazgos.length === 0) {
    // Sin hallazgos tampoco vale la pena la llamada: el informe es «todo bien»
    // y esa frase la escribe la pantalla.
    return vacio;
  }

  try {
    const r = await runStructured({
      step: 'prueba',
      schemaName: 'informe_lenguaje',
      schema: InformeLenguajeSchema,
      system: INFORME_SYSTEM,
      input: armarInput(args),
      organizationId: args.organizationId,
      role: 'cmo',
      trigger: 'smoke_report',
      degradeTo: {
        schema: InformeLenguajeMinimalSchema,
        schemaName: 'informe_minimo',
        inflate: inflarInformeLenguaje,
      },
    });

    return {
      narrativa: String(r.data.narrativa ?? '').slice(0, 900),
      recomendaciones: r.data.recomendaciones ?? [],
      correo: r.data.correo
        ? {
            asunto: String(r.data.correo.asunto ?? '').slice(0, 120),
            cuerpo: String(r.data.correo.cuerpo ?? '').slice(0, 2_000),
          }
        : null,
    };
  } catch (err) {
    // El informe existe igual: las cifras y los hallazgos no dependen de esto.
    console.error('[informe] el modelo falló, se guarda sin narrativa', err);
    return vacio;
  }
}

function armarInput(args: {
  negocio: string;
  resumen: ResumenDeLinea;
  hallazgos: Hallazgo[];
  citas: Cita[];
}): string {
  const r = args.resumen;

  const cifras = [
    `Conversaciones: ${r.conversaciones}`,
    `Contestaron: ${r.contestadas}`,
    `No contestaron nunca: ${r.sin_respuesta}`,
    r.mediana_segundos !== null
      ? `Tiempo de respuesta típico: ${formatoDuracion(r.mediana_segundos)}`
      : null,
    r.mas_lenta_segundos !== null
      ? `La más lenta: ${formatoDuracion(r.mas_lenta_segundos)}`
      : null,
    `Propusieron un paso siguiente: ${r.propusieron_paso} de ${r.conversaciones}`,
    `Llegaron a cita o cotización: ${r.cerraron_cita} de ${r.conversaciones}`,
  ]
    .filter(Boolean)
    .join('\n');

  const hallazgos = args.hallazgos
    .map(
      (h) =>
        `- clave "${h.id}" · ${h.criterio} · falló en ${h.fallo_en} de ${h.de} conversaciones · impacto ${h.impacto}`,
    )
    .join('\n');

  const citas = args.citas.length
    ? args.citas.map((c) => `- «${c.texto}»`).join('\n')
    : '(ninguna)';

  return [
    `NEGOCIO: ${args.negocio}`,
    '',
    'LAS CIFRAS (ya calculadas — NO las repitas en tu texto):',
    cifras,
    '',
    'LOS HALLAZGOS (una recomendación por cada uno, en este orden, usando la clave tal cual):',
    hallazgos,
    '',
    'COSAS QUE DIJERON Y QUE SU SITIO NO DICE (citas textuales):',
    citas,
  ].join('\n');
}

function normalizarSalud(raw: Record<string, unknown> | undefined): ResumenDeLinea {
  const n = (k: string) => {
    const v = Number(raw?.[k]);
    return Number.isFinite(v) ? v : 0;
  };
  const on = (k: string) => {
    const v = raw?.[k];
    if (v === null || v === undefined) return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };
  return {
    conversaciones: n('conversaciones'),
    contestadas: n('contestadas'),
    sin_respuesta: n('sin_respuesta'),
    mediana_segundos: on('mediana_segundos'),
    p90_segundos: on('p90_segundos'),
    mas_rapida_segundos: on('mas_rapida_segundos'),
    mas_lenta_segundos: on('mas_lenta_segundos'),
    propusieron_paso: n('propusieron_paso'),
    cerraron_cita: n('cerraron_cita'),
    auditoria_promedio: on('auditoria_promedio'),
    evaluacion_promedio: on('evaluacion_promedio'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEER
// ═══════════════════════════════════════════════════════════════════════════

export async function informePorToken(token: string): Promise<InformeRow | null> {
  const { data } = await db()
    .from('smoke_reports')
    .select('*')
    .eq('share_token', token)
    .eq('publicado', true)
    .maybeSingle();
  return (data as InformeRow | null) ?? null;
}

export async function informePorId(id: string): Promise<InformeRow> {
  return unwrap(
    await db().from('smoke_reports').select('*').eq('id', id).single(),
    'smoke_reports.get',
  ) as InformeRow;
}

export async function informesDeOrganizacion(
  organizationId: string,
  limite = 10,
): Promise<InformeRow[]> {
  const { data } = await db()
    .from('smoke_reports')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limite);
  return (data ?? []) as InformeRow[];
}

export async function informesRecientes(limite = 30): Promise<
  Array<InformeRow & { organizations: { name: string | null; domain: string | null } | null }>
> {
  const { data } = await db()
    .from('smoke_reports')
    .select('*, organizations ( name, domain )')
    .order('created_at', { ascending: false })
    .limit(limite);
  return (data ?? []) as never;
}

/**
 * Cuenta una apertura.
 *
 * `tryWrite` y no `mustWrite`: perder una vista es un dato menos, pero una
 * excepción acá le rompe el informe al cliente en la cara. Es exactamente el
 * caso para el que existe la distinción.
 */
export async function registrarVista(informe: InformeRow): Promise<void> {
  await tryWrite(
    db()
      .from('smoke_reports')
      .update({
        vistas: (informe.vistas ?? 0) + 1,
        visto_at: new Date().toISOString(),
      })
      .eq('id', informe.id),
    'smoke_reports.vista',
  );

  await track('smoke_report_viewed', {
    organizationId: informe.organization_id,
    props: { informe: informe.id, vista: (informe.vistas ?? 0) + 1 },
  });
}

export async function despublicar(id: string): Promise<void> {
  await mustWrite(
    db().from('smoke_reports').update({ publicado: false }).eq('id', id),
    'smoke_reports.despublicar',
  );
}
