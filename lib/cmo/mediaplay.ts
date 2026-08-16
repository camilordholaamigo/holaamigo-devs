import { db, unwrap } from '@/lib/supabase/admin';

/**
 * Media play (enterprise).
 *
 * La idea: casi todo cliente con volumen tiene un **activo de data propietaria**
 * que no sabe que tiene. Un operador logístico con 8.000 contactos sabe cuánto
 * tarda su sector en responder una cotización, y nadie más lo sabe. Eso es un
 * reporte publicable, y un reporte publicable es prensa, pódcast y una razón
 * para que lo llamen a él en vez de al revés.
 *
 * La CMO **genera el brief, no la publicación**. `content.publish` tiene techo
 * de plataforma L2 y no hay plan que lo suba: publicar a nombre de la marca de
 * alguien no se deshace.
 *
 * DISPARO MANUAL, a propósito (§13.3): esto se hace a mano las primeras tres
 * veces. La detección del activo es automática y el brief también, pero quién
 * decide que este cliente vale un media play es un humano nuestro, mirando la
 * cuenta. Cuando lo hayamos hecho tres veces sabremos qué automatizar; hoy solo
 * sabríamos automatizar nuestra corazonada.
 *
 * Ver docs/wiki/19-la-cmo-expandida.md
 */

export interface ActivoDeData {
  contactos: number;
  cierres: number;
  mensajes: number;
  sectores: string[];
  /** Qué se puede afirmar con esta data, en una frase. */
  tesis: string | null;
}

/**
 * Qué data propietaria tiene este cliente, de verdad.
 *
 * Todo sale de contar filas. La tesis se arma con plantilla: es una afirmación
 * sobre el negocio del cliente y las afirmaciones llevan fuente (§13.4) — acá
 * la fuente es su propia base, y el número va en la frase para que se pueda
 * verificar.
 */
export async function detectarActivoDeData(organizationId: string): Promise<ActivoDeData> {
  const [contactos, cierres, mensajes, segmentos] = await Promise.all([
    db().from('leads').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    db()
      .from('revenue_events')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('kind', 'new'),
    db()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('direction', 'in'),
    db().from('leads').select('segment').eq('organization_id', organizationId).limit(1000),
  ]);

  const sectores = [
    ...new Set(((segmentos.data ?? []) as Array<{ segment: string | null }>)
      .map((l) => l.segment)
      .filter((s): s is string => Boolean(s))),
  ].slice(0, 6);

  const nContactos = contactos.count ?? 0;
  const nRespuestas = mensajes.count ?? 0;

  // El umbral no es un número redondo por gusto: debajo de 500 contactos y 100
  // respuestas, cualquier "hallazgo" es una anécdota, y publicar una anécdota
  // como estudio es la forma más rápida de perder la autoridad que se buscaba.
  const tesis =
    nContactos >= 500 && nRespuestas >= 100
      ? `Con ${nContactos} contactos y ${nRespuestas} respuestas reales de ${sectores.length || 1} segmento(s), ` +
        'se puede publicar cómo responde de verdad este sector: tiempos, objeciones y qué mueve una respuesta.'
      : null;

  return {
    contactos: nContactos,
    cierres: cierres.count ?? 0,
    mensajes: nRespuestas,
    sectores,
    tesis,
  };
}

/**
 * Deja el brief listo. No publica.
 *
 * El brief es determinista: se arma con las cifras del activo y una estructura
 * fija. Podría escribirlo el modelo y va a hacerlo cuando esto se haya hecho
 * tres veces a mano — con la misma verificación de cifras del Capítulo (P3).
 * Hoy, un brief predecible que el operador ajusta en diez minutos vale más que
 * uno bonito que hay que revisar entero.
 */
export async function proponerMediaPlay(args: {
  organizationId: string;
  dataAsset?: string;
  thesis?: string;
}): Promise<{ id: string; brief: Record<string, unknown> } | { saltado: string }> {
  const activo = await detectarActivoDeData(args.organizationId);

  if (!args.thesis && !activo.tesis) {
    return {
      saltado: `todavía no hay data suficiente: ${activo.contactos} contactos y ${activo.mensajes} respuestas`,
    };
  }

  const tesis = args.thesis ?? (activo.tesis as string);
  const dataAsset =
    args.dataAsset ??
    `${activo.contactos} contactos y ${activo.mensajes} respuestas propias en ${activo.sectores.join(', ') || 'su sector'}`;

  const brief = {
    titulo_tentativo: `Cómo responde de verdad ${activo.sectores[0] ?? 'el sector'}`,
    de_donde_sale: dataAsset,
    hallazgos_a_verificar: [
      'Tiempo real de respuesta del sector, contra el que dicen tener',
      'Qué objeción aparece primero y en qué porcentaje de las conversaciones',
      'Qué día y hora concentran las respuestas',
    ],
    angulos_de_prensa: [
      'El dato que contradice lo que el sector cree de sí mismo',
      'La comparación entre lo prometido y lo medido',
    ],
    podcasts: ['Programas de logística y operaciones del país', 'Pódcast de fundadores del sector'],
    escenarios_para_el_fundador: [
      'Presentar el reporte en el gremio del sector',
      'Mesa redonda con dos clientes que salgan en el estudio',
    ],
    lo_que_no_hacemos:
      'Publicar. El brief queda listo y la publicación la aprueba y ejecuta el cliente: ' +
      'lo que sale a nombre de su marca no se puede despublicar de verdad.',
  };

  const row = unwrap(
    await db()
      .from('media_plays')
      .insert({
        organization_id: args.organizationId,
        data_asset: dataAsset,
        thesis: tesis,
        brief,
      })
      .select('id')
      .single(),
    'media_plays.insert',
  ) as { id: string };

  return { id: row.id, brief };
}

export async function mediaPlaysDe(organizationId: string) {
  const { data } = await db()
    .from('media_plays')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  return data ?? [];
}
