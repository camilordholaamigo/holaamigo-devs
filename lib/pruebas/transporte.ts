import {
  canalesActivos,
  enviarPorCallbell,
  faltaParaEnviarCallbell,
  type EnvioSpec,
  type ResultadoEnvio,
} from '@/lib/pruebas/callbell';
import { enviarPorWzap, faltaParaEnviarWzap } from '@/lib/pruebas/wzap';
import type { CanalRow, ProveedorDeLinea } from '@/lib/pruebas/types';

/**
 * A qué puerta se toca para mandar un mensaje.
 *
 * El smoke tester tiene dos transportes —wzap y Callbell— y el resto del
 * subsistema no sabe cuál está usando. Esa ignorancia es el punto: `motor.ts`
 * pide «mandá este texto por este canal» y acá se decide con qué proveedor,
 * leyendo `canal.provider`. Agregar un tercero es un `case` y un archivo.
 *
 * Por qué un módulo aparte y no un `if` adentro de `callbell.ts`: un archivo que
 * se llama callbell y despacha a wzap es una mentira que el próximo que lo abra
 * paga. Y el precio de la verdad fueron cinco imports.
 *
 * Ver docs/adr/0028-dos-transportes.md
 */

export type { EnvioSpec, ResultadoEnvio } from '@/lib/pruebas/callbell';

// ═══════════════════════════════════════════════════════════════════════════
// ENVIAR
// ═══════════════════════════════════════════════════════════════════════════

export async function enviarMensaje(spec: EnvioSpec): Promise<ResultadoEnvio> {
  if (spec.canal.provider === 'wzap') {
    // wzap no tiene plantillas: conecta por QR y abre con texto libre. El
    // `usarPlantilla` del spec se ignora en silencio a propósito — el motor lo
    // manda siempre en el primer turno y no tiene por qué saber de proveedores.
    return enviarPorWzap({ canal: spec.canal, to: spec.to, texto: spec.texto });
  }
  return enviarPorCallbell(spec);
}

// ═══════════════════════════════════════════════════════════════════════════
// QUÉ FALTA PARA PODER MANDAR
// ═══════════════════════════════════════════════════════════════════════════
//
// Antes esto era una sola función global: había un proveedor, y «falta la llave»
// era una verdad del sistema entero. Con dos, la pregunta correcta ya no es qué
// falta, sino **qué falta para las líneas que se van a usar**: una WZAP_API_KEY
// ausente no importa si no hay ninguna línea de wzap activa, y decir que sí
// importa manda a alguien a cargar un secreto que no hace nada.

export function faltaParaProveedor(provider: ProveedorDeLinea): Record<string, true> {
  return provider === 'wzap' ? faltaParaEnviarWzap() : faltaParaEnviarCallbell();
}

export function faltaParaCanal(canal: CanalRow): Record<string, true> {
  return faltaParaProveedor(canal.provider);
}

export function hayTransportePara(canal: CanalRow): boolean {
  return Object.keys(faltaParaCanal(canal)).length === 0;
}

/**
 * Lo que falta para un conjunto de líneas ya leídas de la base.
 *
 * Sync y sobre filas, no sobre ids: las dos pantallas que muestran esto ya
 * cargaron los canales para pintarlos. Volver a consultarlos para saber qué
 * variable falta sería una consulta de más por render.
 */
export function faltaParaLineas(canales: CanalRow[]): Record<string, true> {
  const falta: Record<string, true> = {};
  for (const canal of canales) {
    for (const nombre of Object.keys(faltaParaCanal(canal))) falta[nombre] = true;
  }
  return falta;
}

/**
 * Lo que falta para las líneas que una petición pidió — o para la preferida, si
 * no pidió ninguna.
 *
 * Es el prechequeo que corre ANTES de crear una prueba. Un 400 que dice
 * `{ falta: { WZAP_API_KEY: true } }` ahorra horas comparado con una prueba que
 * se creó, quedó en `pending` y «no hizo nada».
 */
export async function faltaParaCanalesPedidos(
  ids?: string[] | null,
): Promise<Record<string, true>> {
  const activas = await canalesActivos();
  if (activas.length === 0) return {};
  const elegidas =
    ids && ids.length > 0 ? activas.filter((c) => ids.includes(c.id)) : [activas[0]];
  return faltaParaLineas(elegidas.length > 0 ? elegidas : [activas[0]]);
}
