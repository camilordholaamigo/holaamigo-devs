import { db } from '@/lib/supabase/admin';
import { registrarEntrante } from '@/lib/pruebas/motor';
import { VENTANA_RAFAGA_MS } from '@/lib/pruebas/types';
import type { Entrante } from '@/lib/pruebas/callbell';

/**
 * Correlación: a qué conversación pertenece este mensaje.
 *
 * **Se empareja POR NÚMERO.** Es la decisión que más consecuencias tiene en
 * todo el smoke tester, y está tomada así desde el diseño y no como una mejora
 * posterior.
 *
 * El paquete del que viene esto emparejaba contra «la conversación activa más
 * reciente», sin mirar el teléfono. Funciona, con dos precios que se pagan
 * todos los días: no se puede correr más de una conversación a la vez, y
 * cualquier conversación colgada se traga los mensajes de las siguientes. Con
 * emparejamiento por número podemos escribirle a tres líneas al mismo tiempo,
 * que es justo lo que hace falta cuando el cliente está esperando el resultado
 * en pantalla.
 *
 * La comparación es por los últimos dígitos y no por igualdad exacta: el mismo
 * número llega como `+573001234567`, `573001234567` y `3001234567` según quién
 * reenvíe el evento, y las tres son el mismo teléfono.
 */

const MIN_DIGITOS = 8;

export type ResultadoCorrelacion =
  | { tipo: 'turno'; pruebaId: string; token: string }
  | { tipo: 'rafaga'; pruebaId: string; token: string }
  | { tipo: 'sin_match'; detalle: Record<string, unknown> }
  | { tipo: 'ignorado'; motivo: string };

interface PruebaViva {
  id: string;
  target_phone: string;
  estado: string;
  awaiting_reply: boolean;
  ultimo_entrante_at: string | null;
  updated_at: string;
  template_id: string;
}

export async function correlacionar(entrante: Entrante): Promise<ResultadoCorrelacion> {
  if (entrante.direccion === 'saliente') {
    return { tipo: 'ignorado', motivo: 'es eco de un mensaje nuestro' };
  }

  const { data } = await db()
    .from('smoke_probes')
    .select('id, target_phone, estado, awaiting_reply, ultimo_entrante_at, updated_at, template_id')
    .eq('estado', 'running')
    .order('updated_at', { ascending: false })
    .limit(50);

  const vivas = (data ?? []) as PruebaViva[];

  const coinciden = vivas.filter((p) =>
    entrante.candidatos.some((c) => mismoNumero(c, p.target_phone)),
  );

  // Camino 1 · la conversación está esperando respuesta de este número.
  const esperando = coinciden.filter((p) => p.awaiting_reply);
  if (esperando.length > 0) {
    const elegida = esperando[0];
    const token = await registrarEntrante(elegida.id, entrante.texto);
    return token
      ? { tipo: 'turno', pruebaId: elegida.id, token }
      : { tipo: 'ignorado', motivo: 'la prueba cambió de estado mientras correlacionábamos' };
  }

  // Camino 2 · continuación de una respuesta que ya empezó.
  //
  // El primer chunk consumió el `awaiting_reply` y bajó la bandera. Los que
  // siguen no encuentran a quién pegarse y —sin este camino— se descartan en
  // silencio: la transcripción queda mutilada y el evaluador califica una
  // respuesta a medias.
  const continuacion = coinciden.find(
    (p) =>
      p.ultimo_entrante_at &&
      Date.now() - Date.parse(p.ultimo_entrante_at) < VENTANA_RAFAGA_MS,
  );
  if (continuacion) {
    const token = await registrarEntrante(continuacion.id, entrante.texto);
    return token
      ? { tipo: 'rafaga', pruebaId: continuacion.id, token }
      : { tipo: 'ignorado', motivo: 'la prueba se cerró mientras llegaba la ráfaga' };
  }

  // Sin match. Éste es el caso que MÁS información necesita y el que se suele
  // escribir como un `return false`. Se devuelve el estado del mundo que sí
  // encontramos: es el dato que resuelve el incidente.
  return {
    tipo: 'sin_match',
    detalle: {
      candidatos: entrante.candidatos,
      preview: entrante.texto.slice(0, 80),
      vivas: vivas.slice(0, 5).map((p) => ({
        id: p.id,
        telefono: p.target_phone,
        esperando: p.awaiting_reply,
        plantilla: p.template_id,
      })),
    },
  };
}

/**
 * ¿Son el mismo teléfono?
 *
 * Se comparan los últimos ocho dígitos como mínimo. Ocho y no diez porque hay
 * mercados con números nacionales más cortos; ocho y no seis porque con seis
 * dos negocios distintos empiezan a colisionar y un mensaje se anexaría a la
 * conversación equivocada — que es peor que perderlo.
 */
export function mismoNumero(a: string, b: string): boolean {
  const da = a.replace(/\D/g, '');
  const dbn = b.replace(/\D/g, '');
  if (da.length < MIN_DIGITOS || dbn.length < MIN_DIGITOS) return false;
  const n = Math.min(da.length, dbn.length, 12);
  return da.slice(-n) === dbn.slice(-n);
}
