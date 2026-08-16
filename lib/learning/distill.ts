import { db } from '@/lib/supabase/admin';
import { backfillEmbeddings } from '@/lib/learning/lessons';
import { imputarCostos } from '@/lib/decisions/record';

/**
 * El destilador: de decisiones medidas a reglas.
 *
 * **Todo el cálculo es SQL.** No hay una llamada al modelo en este archivo, y
 * es una decisión, no una omisión: ninguna cifra que el cliente lee sale de un
 * modelo (ADR 0007). El lift, la n y la confianza salen de
 * `holaamigo.destilar_candidatas()` y se pueden verificar con una consulta; el
 * enunciado se arma con `format()` alrededor de esos números.
 *
 * Que el modelo redacte mejor la frase es una mejora futura, y llegará con una
 * condición: que el número que aparezca en el texto se valide contra el número
 * que salió del SQL antes de guardarlo.
 *
 * Umbrales (defaults de la función SQL, se pueden mover por llamada):
 *   n ≥ 8 decisiones medidas en el grupo
 *   lift ≥ 1,2 sobre el resto de opciones
 *   confianza > 0,7 → se activa sola, si el alcance es `organization`
 *
 * Ver docs/wiki/15-sustrato-decisiones-y-aprendizaje.md
 */

export interface DestiladoResumen {
  organizationId: string;
  creadas: number;
  actualizadas: number;
  activadas: number;
  retiradas: number;
  vectores: number;
  error?: string;
}

export async function distillFor(
  organizationId: string,
  opts: { minN?: number; minLift?: number; umbralActivacion?: number } = {},
): Promise<DestiladoResumen> {
  const base: DestiladoResumen = {
    organizationId,
    creadas: 0,
    actualizadas: 0,
    activadas: 0,
    retiradas: 0,
    vectores: 0,
  };

  const { data, error } = await db().rpc('destilar', {
    p_org: organizationId,
    p_min_n: opts.minN ?? 8,
    p_min_lift: opts.minLift ?? 1.2,
    p_umbral_activacion: opts.umbralActivacion ?? 0.7,
  });

  if (error) {
    // Una organización que falla no puede tumbar la noche de las demás.
    console.error(`[destilar:${organizationId}] ${error.message}`);
    return { ...base, error: error.message };
  }

  const resumen = (data ?? {}) as Record<string, number>;

  // Las lecciones nuevas nacen sin vector porque el destilador es SQL puro.
  // Hasta que este paso corra se recuperan por solape de palabras: peor, pero
  // nunca vacío.
  const vectores = await backfillEmbeddings(50);

  return {
    ...base,
    creadas: Number(resumen.creadas ?? 0),
    actualizadas: Number(resumen.actualizadas ?? 0),
    activadas: Number(resumen.activadas ?? 0),
    retiradas: Number(resumen.retiradas ?? 0),
    vectores,
  };
}

/** Organizaciones con decisiones medidas: las únicas donde hay algo que destilar. */
export async function organizacionesConEvidencia(limit = 200): Promise<string[]> {
  const { data } = await db()
    .from('decisions')
    .select('organization_id')
    .not('outcome', 'is', null)
    .limit(5000);

  const vistas = new Set<string>();
  for (const row of data ?? []) {
    if (row.organization_id) vistas.add(row.organization_id as string);
    if (vistas.size >= limit) break;
  }
  return [...vistas];
}

/** La pasada nocturna completa. La llama /api/cron/destilar. */
export async function destilarTodo(): Promise<{
  organizaciones: number;
  resumenes: DestiladoResumen[];
  costos_imputados: number;
  trazas_purgadas: number;
}> {
  const orgs = await organizacionesConEvidencia();
  const resumenes: DestiladoResumen[] = [];
  for (const org of orgs) {
    resumenes.push(await distillFor(org));
  }

  // El orden importa: primero se le imputa costo a las decisiones (la
  // contabilidad de P4 lo va a leer), después se purgan las trazas viejas. Al
  // revés, se borrarían las trazas que sostienen el costo que no se imputó.
  const costos = await imputarCostos();

  let purgadas = 0;
  const { data, error } = await db().rpc('purgar_trazas', { p_dias: 90 });
  if (error) console.error(`[destilar:purga] ${error.message}`);
  else purgadas = Number(data ?? 0);

  return {
    organizaciones: orgs.length,
    resumenes,
    costos_imputados: costos,
    trazas_purgadas: purgadas,
  };
}
