import { db } from '@/lib/supabase/admin';
import { registrarEntrante } from '@/lib/pruebas/motor';
import { VENTANA_RAFAGA_MS } from '@/lib/pruebas/types';
import type { Entrante } from '@/lib/pruebas/callbell';

/**
 * Correlación: a qué conversación pertenece este mensaje.
 *
 * **Se empareja POR EL PAR (nuestra línea, su número).** Es la decisión que más
 * consecuencias tiene en todo el smoke tester.
 *
 * El paquete del que viene esto emparejaba contra «la conversación activa más
 * reciente», sin mirar el teléfono. Funciona, con dos precios que se pagan todos
 * los días: no se puede correr más de una conversación a la vez, y cualquier
 * conversación colgada se traga los mensajes de las siguientes. Emparejar por
 * número arregló las dos y permitió escribirle a tres negocios al mismo tiempo.
 *
 * Lo que agregó ADR 0027 es el otro eje: **tres de NUESTRAS líneas escribiéndole
 * al MISMO negocio.** Ahí el número ya no alcanza, porque las tres conversaciones
 * comparten `target_phone` y son tres hilos de WhatsApp distintos. Se desambigua
 * con lo que el payload traiga, en este orden:
 *
 *   1. el `channel_uuid` del proveedor;
 *   2. nuestro propio número —para un entrante también viene en el payload—;
 *   3. a ciegas, la más reciente que espera respuesta, y queda en el log.
 *
 * El paso 3 no es una rendición: es el comportamiento que había antes de que
 * existieran varias líneas, y con una sola línea es exactamente correcto.
 *
 * La comparación de números es por los últimos dígitos y no por igualdad exacta:
 * el mismo número llega como `+573001234567`, `573001234567` y `3001234567`
 * según quién reenvíe el evento, y las tres son el mismo teléfono.
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
  channel_id: string;
  smoke_channels: { channel_uuid: string; phone_e164: string } | null;
}

export async function correlacionar(entrante: Entrante): Promise<ResultadoCorrelacion> {
  if (entrante.direccion === 'saliente') {
    return { tipo: 'ignorado', motivo: 'es eco de un mensaje nuestro' };
  }

  const { data } = await db()
    .from('smoke_probes')
    .select(
      `id, target_phone, estado, awaiting_reply, ultimo_entrante_at, updated_at, template_id,
       channel_id, smoke_channels ( channel_uuid, phone_e164 )`,
    )
    .eq('estado', 'running')
    .order('updated_at', { ascending: false })
    .limit(50);

  const vivas = (data ?? []) as unknown as PruebaViva[];

  const porNumero = vivas.filter((p) =>
    entrante.candidatos.some((c) => mismoNumero(c, p.target_phone)),
  );

  const { coinciden, aCiegas } = porLinea(porNumero, entrante);

  if (aCiegas) {
    // Este log es el que resuelve el incidente el día que dos conversaciones
    // simultáneas contra el mismo negocio cruzan un mensaje. Se escribe con
    // estas palabras a propósito, para que se pueda buscar.
    console.warn('[pruebas] desambiguación a ciegas entre líneas', {
      candidatas: coinciden.length,
      telefono: coinciden[0]?.target_phone,
      canal_en_payload: entrante.canalUuid,
    });
  }

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
      canal: entrante.canalUuid,
      preview: entrante.texto.slice(0, 80),
      vivas: vivas.slice(0, 5).map((p) => ({
        id: p.id,
        telefono: p.target_phone,
        esperando: p.awaiting_reply,
        plantilla: p.template_id,
        linea: p.smoke_channels?.phone_e164 ?? p.channel_id,
      })),
    },
  };
}

/**
 * Reduce las candidatas a las de la línea por la que entró el mensaje.
 *
 * Con cero o una candidata no hace nada: es el caso normal y no vale la pena
 * gastarle una comparación. Con dos o más —el caso de varias de nuestras líneas
 * contra el mismo negocio— reduce, y si no puede reducir avisa.
 *
 * **Nunca devuelve una lista vacía.** Si el payload trae un `channel_uuid` que no
 * coincide con ninguna candidata, lo más probable no es que el mensaje no sea de
 * ninguna: es que el proveedor cambió el nombre del campo, o que reenvía el uuid
 * de otra cosa. Descartar ahí perdería el mensaje en silencio, que es el peor
 * modo de fallo de todo el subsistema — sin el entrante la conversación se cuelga
 * y el negocio queda reportado como «no contestó».
 */
function porLinea(
  candidatas: PruebaViva[],
  entrante: Entrante,
): { coinciden: PruebaViva[]; aCiegas: boolean } {
  if (candidatas.length <= 1) return { coinciden: candidatas, aCiegas: false };

  if (entrante.canalUuid) {
    const porCanal = candidatas.filter(
      (p) => p.smoke_channels?.channel_uuid === entrante.canalUuid,
    );
    if (porCanal.length > 0) return { coinciden: porCanal, aCiegas: false };
  }

  // Nuestro propio número. Para un mensaje recibido, Callbell lo manda en `from`
  // —al revés de lo que dice la intuición— y el parser lo junta con los demás.
  const porNuestroNumero = candidatas.filter((p) => {
    const nuestro = p.smoke_channels?.phone_e164;
    return nuestro ? entrante.candidatos.some((c) => mismoNumero(c, nuestro)) : false;
  });
  if (porNuestroNumero.length > 0 && porNuestroNumero.length < candidatas.length) {
    return { coinciden: porNuestroNumero, aCiegas: false };
  }

  return { coinciden: candidatas, aCiegas: true };
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
