import { db } from '@/lib/supabase/admin';

/**
 * Lectura del flujo inicial. Envuelve las tres funciones de `0012_flujo_inicial`.
 *
 * Todo devuelve arreglo vacío ante un error, nunca lanza: `/admin/embudo` es
 * una pantalla de consulta, y tumbar la consulta entera porque una de las tres
 * agregaciones falló deja al operador sin las otras dos. El error queda en el
 * log del servidor con su nombre.
 */

export interface EtapaDelEmbudo {
  etapa: string;
  orden: number;
  organizaciones: number;
  /** Porcentaje que sobrevivió de la etapa anterior. Null en la primera. */
  del_anterior: number | null;
}

export interface CaidaPorPregunta {
  clave: string;
  orden: number;
  sesiones: number;
  mediana_segundos: number | null;
  abandonos: number;
}

export interface SupuestoDiscutido {
  supuesto: string;
  ediciones: number;
  organizaciones: number;
  subieron: number;
  bajaron: number;
  cambio_mediano_pct: number | null;
}

async function rpc<T>(nombre: string, dias: number): Promise<T[]> {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db().rpc(nombre, { p_desde: desde });

  if (error) {
    console.error(`[embudo:${nombre}] ${error.message}`);
    return [];
  }
  return (data ?? []) as T[];
}

export function embudoInicial(dias = 30) {
  return rpc<EtapaDelEmbudo>('embudo_inicial', dias);
}

export function caidaPorPregunta(dias = 30) {
  return rpc<CaidaPorPregunta>('caida_por_pregunta', dias);
}

export function supuestosDiscutidos(dias = 90) {
  return rpc<SupuestoDiscutido>('supuestos_discutidos', dias);
}

/**
 * Cuánto tarda de verdad el quiz, contra los "6 minutos" que promete la landing.
 *
 * Se calcula en JavaScript y no en SQL a propósito: son dos restas y una
 * mediana sobre las sesiones completadas de la ventana, y no justifica una
 * cuarta función en la base. Si el volumen crece hasta que este `select` pese,
 * el arreglo es moverlo a SQL, no paginarlo — una mediana parcial no es una
 * mediana.
 */
export async function duracionDelQuiz(dias = 30): Promise<{
  sesiones: number;
  mediana_minutos: number | null;
}> {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db()
    .from('intake_sessions')
    .select('created_at, completed_at')
    .gte('created_at', desde)
    .not('completed_at', 'is', null);

  if (error) {
    console.error(`[embudo:duracion] ${error.message}`);
    return { sesiones: 0, mediana_minutos: null };
  }

  const minutos = (data ?? [])
    .map((s) => (Date.parse(s.completed_at) - Date.parse(s.created_at)) / 60_000)
    .filter((m) => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);

  if (minutos.length === 0) return { sesiones: 0, mediana_minutos: null };

  const medio = Math.floor(minutos.length / 2);
  const mediana =
    minutos.length % 2 === 0 ? (minutos[medio - 1] + minutos[medio]) / 2 : minutos[medio];

  return { sesiones: minutos.length, mediana_minutos: Math.round(mediana * 10) / 10 };
}
