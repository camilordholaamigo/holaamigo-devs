import { db } from '@/lib/supabase/admin';
import type { FeedItem } from '@/lib/feed/items';

/**
 * El límite de siete.
 *
 * Máximo 7 tarjetas activas por organización. El límite es **cognitivo, no
 * técnico**: una cola de veinte no se prioriza, se abandona. Con siete, el
 * trabajo del día se ve completo en una pantalla y se puede terminar.
 *
 * Lo que hace que esto no sea una caja negra es que cada tarjeta trae su
 * motivo. "El feed muestra 7" sin decir por qué esas siete es una decisión que
 * el cliente no puede discutir, y este producto se trata justamente de que
 * pueda discutirlas.
 *
 * La fórmula vive en `holaamigo.priorizar_feed()` — SQL, determinista y
 * probada. Acá solo se junta con el contenido de las tarjetas.
 */

export interface PriorizedItem {
  feed_item_id: string;
  puesto: number;
  puntaje: number;
  motivo: string;
  mostrado: boolean;
}

export interface ColaDelFeed {
  mostrados: Array<FeedItem & { motivo: string; puesto: number }>;
  postergados: Array<FeedItem & { motivo: string; puesto: number }>;
  /** Lo que el President dice cuando hay más de siete. Vacío si no hay cola. */
  explicacion: string | null;
}

export async function priorizarFeed(
  organizationId: string,
  opts: { limite?: number } = {},
): Promise<ColaDelFeed> {
  const limite = opts.limite ?? 7;

  const { data: prioridades, error } = await db().rpc('priorizar_feed', {
    p_org: organizationId,
    p_limite: limite,
  });

  if (error) {
    // Sin priorización el feed sigue funcionando: se cae a "todo lo abierto,
    // lo más nuevo primero". Peor orden, misma información. Lo que no se
    // acepta es una pantalla vacía porque una función de ranking falló.
    console.error(`[feed:priorizar] ${error.message}`);
    const { data } = await db()
      .from('feed_items')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('status', 'open')
      .in('requires', ['approval', 'input'])
      .order('created_at', { ascending: false })
      .limit(limite);

    return {
      mostrados: ((data ?? []) as FeedItem[]).map((item, i) => ({
        ...item,
        motivo: 'orden por fecha',
        puesto: i + 1,
      })),
      postergados: [],
      explicacion: null,
    };
  }

  const filas = (prioridades ?? []) as PriorizedItem[];
  if (filas.length === 0) return { mostrados: [], postergados: [], explicacion: null };

  const { data: items } = await db()
    .from('feed_items')
    .select('*')
    .in(
      'id',
      filas.map((f) => f.feed_item_id),
    );

  const porId = new Map(((items ?? []) as FeedItem[]).map((i) => [i.id, i]));

  const armar = (fila: PriorizedItem) => {
    const item = porId.get(fila.feed_item_id);
    if (!item) return null;
    return { ...item, motivo: fila.motivo, puesto: fila.puesto };
  };

  const mostrados = filas
    .filter((f) => f.mostrado)
    .map(armar)
    .filter((x): x is FeedItem & { motivo: string; puesto: number } => x !== null);

  const postergados = filas
    .filter((f) => !f.mostrado)
    .map(armar)
    .filter((x): x is FeedItem & { motivo: string; puesto: number } => x !== null);

  return {
    mostrados,
    postergados,
    explicacion: explicar(mostrados.length, postergados.length),
  };
}

/**
 * Lo que el President dice cuando hay cola.
 *
 * Se arma en código y no con el modelo por la razón de siempre (ADR 0007): las
 * cifras son cifras. Y porque una frase que aparece en cada carga de pantalla
 * tiene que ser idéntica cada vez — si cambia de redacción sola, el cliente
 * empieza a leerla en vez de saltársela, que es lo contrario de lo que quiere
 * una frase de estado.
 */
function explicar(mostrados: number, postergados: number): string | null {
  if (postergados === 0) return null;
  return (
    `Hay ${mostrados + postergados} cosas esperándote y te muestro ${mostrados}. ` +
    `Las otras ${postergados} no se pierden: entran a medida que despejes estas. ` +
    'Una cola de veinte no se prioriza, se abandona.'
  );
}
