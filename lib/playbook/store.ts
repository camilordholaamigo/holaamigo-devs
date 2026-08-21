import { db, mustWrite } from '@/lib/supabase/admin';
import type { Playbook } from '@/lib/playbook/types';

/**
 * Leer y corregir el playbook vigente.
 *
 * La lectura pasa por `holaamigo.playbook_vigente()` y no por un `.eq()` suelto
 * porque la definición de "vigente" (`is_current and status = 'active'`) tiene
 * que vivir en un solo lugar. El día que agreguemos playbooks programados —uno
 * para diciembre, otro para el resto del año— cambia la función y no diecisiete
 * consultas repartidas por la app.
 */

export async function playbookVigente(organizationId: string): Promise<Playbook | null> {
  const { data, error } = await db().rpc('playbook_vigente', { p_org: organizationId });

  if (error) {
    console.error(`[playbook:leer] ${error.message}`);
    return null;
  }
  // La función devuelve el tipo de fila; PostgREST lo entrega como objeto o
  // como arreglo de uno según la versión. Se normaliza acá para que ningún
  // llamador tenga que saberlo.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.id) return null;

  return row as Playbook;
}

export async function playbookPorId(id: string): Promise<Playbook | null> {
  const { data } = await db().from('agent_playbooks').select('*').eq('id', id).maybeSingle();
  return (data as Playbook | null) ?? null;
}

export async function historialDePlaybooks(organizationId: string, limit = 10) {
  const { data } = await db()
    .from('agent_playbooks')
    .select('id, version, status, source, created_at, cobertura, is_current')
    .eq('organization_id', organizationId)
    .order('version', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Los campos que el cliente puede corregir desde la consola. */
export type RutaEditable =
  | 'oferta.resumen'
  | 'oferta.lo_que_vendemos_aca'
  | 'agendamiento.quien_atiende'
  | 'agendamiento.que_pasa_en_la_cita'
  | 'calificacion.fuera_de_alcance'
  | `objeciones.${number}`
  | `faq.${number}`
  | `oferta.productos.${number}`;

/**
 * Corregir un campo inferido.
 *
 * NO versiona: edita la fila vigente en el sitio. Y es a propósito, aunque
 * rompa la simetría con el Brief.
 *
 * El razonamiento: la versión existe para poder comparar dos guiones distintos
 * y decir cuál agendó más. Confirmar "sí, atiende Camila" no es un guion
 * distinto — es el mismo guion con un dato que ya no es una suposición. Si cada
 * confirmación creara una versión, un cliente que corrige seis campos en el
 * onboarding generaría siete versiones antes de la primera conversación, y el
 * historial de versiones dejaría de servir para lo único que sirve.
 *
 * Lo que SÍ cambia es `source`, que pasa a `editado`: el cliente tocó esto.
 * Recompilar crea una versión nueva; eso es otro camino y otro botón.
 */
export async function corregirCampo(args: {
  organizationId: string;
  ruta: string;
  valor: unknown;
}): Promise<{ ok: boolean; cobertura?: Playbook['cobertura'] }> {
  const actual = await playbookVigente(args.organizationId);
  if (!actual) return { ok: false };

  const partes = args.ruta.split('.');
  const raiz = partes[0] as keyof Playbook;

  const editables = new Set(['oferta', 'agendamiento', 'calificacion', 'objeciones', 'faq', 'tono', 'guion']);
  if (!editables.has(String(raiz))) return { ok: false };

  const bloque = clonar(actual[raiz]);
  aplicar(bloque, partes.slice(1), args.valor);

  // Lo que el cliente confirma deja de contar como inferido. Es la mitad del
  // valor de la pantalla: el porcentaje de cobertura sube mientras corrige, y
  // eso es lo que hace que valga la pena corregir el segundo campo.
  const cobertura = quitarDeLaLista(actual.cobertura, args.ruta);

  await mustWrite(
    db()
      .from('agent_playbooks')
      .update({ [raiz]: bloque, cobertura, source: 'editado' })
      .eq('id', actual.id),
    'agent_playbooks.corregir',
  );

  return { ok: true, cobertura };
}

function clonar<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** Camina la ruta y escribe. Los índices numéricos entran a arreglos. */
function aplicar(destino: unknown, camino: string[], valor: unknown): void {
  if (camino.length === 0) return;

  let cursor = destino as Record<string, unknown> | unknown[];
  for (const paso of camino.slice(0, -1)) {
    const siguiente = (cursor as Record<string, unknown>)[paso];
    if (siguiente === undefined || siguiente === null) return;
    cursor = siguiente as Record<string, unknown>;
  }

  const ultimo = camino[camino.length - 1];
  const objetivo = (cursor as Record<string, unknown>)[ultimo];

  // Corregir una objeción o una FAQ reemplaza el texto de la respuesta y marca
  // la procedencia como confirmada por el cliente. Una fuente humana vale más
  // que una URL: es la única que puede decir "eso ya no lo vendemos".
  if (objetivo && typeof objetivo === 'object' && 'procedencia' in (objetivo as object)) {
    const item = objetivo as Record<string, unknown>;
    if (typeof valor === 'string') {
      if ('respuesta' in item) item.respuesta = valor;
      else if ('nombre' in item) item.nombre = valor;
    } else if (valor && typeof valor === 'object') {
      Object.assign(item, valor);
    }
    item.procedencia = { fuente: 'confirmado_por_el_cliente', inferido: false };
    return;
  }

  (cursor as Record<string, unknown>)[ultimo] = valor;
}

function quitarDeLaLista(cobertura: Playbook['cobertura'], ruta: string): Playbook['cobertura'] {
  const restantes = (cobertura?.a_confirmar ?? []).filter((c) => c.ruta !== ruta);
  const confirmados = (cobertura?.a_confirmar ?? []).length - restantes.length;
  const conFuente = (cobertura?.con_fuente ?? 0) + confirmados;
  const inferidos = Math.max(0, (cobertura?.inferidos ?? 0) - confirmados);
  const total = conFuente + inferidos;

  return {
    ...cobertura,
    con_fuente: conFuente,
    inferidos,
    porcentaje: total === 0 ? 100 : Math.round((conFuente / total) * 100),
    a_confirmar: restantes,
  };
}
