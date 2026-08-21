import type { Playbook } from '@/lib/playbook/types';

/**
 * El playbook, convertido en la instrucción que lee el modelo en cada turno.
 *
 * Es una función pura de un objeto a un string, y eso es todo el punto: la
 * misma versión del playbook produce siempre la misma instrucción, así que dos
 * conversaciones del mismo cliente no pueden diferir por el clima. Cuando algo
 * sale mal, el debugging es leer un JSON y no reconstruir un prompt.
 *
 * No importa nada de servidor: la consola lo usa para mostrarle al cliente,
 * literal, lo que su agente tiene en la cabeza. Un agente cuya instrucción el
 * cliente no puede leer es un agente en el que el cliente no puede confiar.
 *
 * Ver docs/wiki/22-agente-de-agendamiento.md
 */

export function renderInstructions(playbook: Playbook, opts?: { nombreEmpresa?: string }): string {
  const empresa = opts?.nombreEmpresa ?? 'la empresa';
  const p = playbook;

  const bloques: string[] = [];

  bloques.push(
    seccion('LA EMPRESA PARA LA QUE TRABAJAS', [
      `Nombre: ${empresa}`,
      `Qué vende: ${p.oferta.resumen}`,
      `Qué vendes TÚ en esta conversación: ${p.oferta.lo_que_vendemos_aca}`,
    ]),
  );

  if (p.oferta.productos.length > 0) {
    bloques.push(
      seccion(
        'LO QUE OFRECE',
        p.oferta.productos.map((prod) =>
          [`- ${prod.nombre}`, prod.descripcion, prod.para_quien && `(para: ${prod.para_quien})`]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    );
  }

  // ── Precio: la sección que más cuidado necesita ─────────────────────────
  //
  // Se escribe como una PROHIBICIÓN y no como un dato, porque es la única
  // información del playbook que, dicha mal, compromete plata del cliente
  // frente a un tercero. El único modo de decir un precio es repetir uno de
  // los que están acá listados, textualmente.
  bloques.push(
    seccion('PRECIO — LEE ESTO DOS VECES', [
      p.oferta.precio.politica === 'decir_rango'
        ? 'Puedes mencionar SOLO los precios listados abajo, textualmente, sin redondear ni convertir.'
        : 'NO das precios. La política de este cliente es cotizar en la reunión.',
      ...(p.oferta.precio.publicos.length > 0
        ? [`Precios publicados en su sitio: ${p.oferta.precio.publicos.join(' · ')}`]
        : ['No hay precios públicos.']),
      'Cualquier otra cifra de dinero está PROHIBIDA. Si te insisten, escalas.',
    ]),
  );

  bloques.push(
    seccion('CÓMO ESCRIBES', [
      p.tono.descripcion,
      p.tono.tratamiento === 'usted' ? 'Tratas de usted.' : 'Tuteas.',
      p.tono.emojis === 'ninguno' ? 'Sin emojis.' : 'Un emoji como máximo, y solo si encaja.',
      ...(p.tono.ejemplo_del_cliente
        ? [`Un mensaje del cliente que sí funcionó, para calibrar el tono: "${p.tono.ejemplo_del_cliente}"`]
        : []),
      ...(p.tono.prohibidas.length > 0
        ? [`NUNCA dices ni prometes: ${p.tono.prohibidas.join(' · ')}`]
        : []),
    ]),
  );

  // ── Calificación ─────────────────────────────────────────────────────────
  bloques.push(
    seccion('LO QUE TIENES QUE DESCUBRIR, EN ESTE ORDEN', [
      ...p.calificacion.preguntas.map((q, i) => `${i + 1}. [${q.campo}] ${q.pregunta}`),
      '',
      `Necesitas ${p.calificacion.minimo_para_agendar} de los ${p.calificacion.preguntas.length} antes de proponer horario.`,
      'No las dispares en fila como un formulario: se preguntan cuando la conversación las pide.',
      ...(p.calificacion.fuera_de_alcance.length > 0
        ? [
            '',
            `A ESTOS NO LES SIRVE, y con ellos cierras con cortesía en vez de agendar: ${p.calificacion.fuera_de_alcance.join(' · ')}`,
          ]
        : []),
    ]),
  );

  // ── Guion ────────────────────────────────────────────────────────────────
  bloques.push(
    seccion('TU GUION', [
      `Apertura en frío: ${p.guion.apertura}`,
      `Apertura si escribieron primero: ${p.guion.apertura_inbound}`,
      `Puente hacia la cita: ${p.guion.puente_a_la_cita}`,
      `Cómo ofreces horarios: ${p.guion.oferta_de_horarios}`,
      `Confirmación: ${p.guion.confirmacion}`,
      `Cierre con quien no califica: ${p.guion.cierre_cortes}`,
      '',
      'El guion es la INTENCIÓN de cada mensaje, no un texto para copiar y pegar.',
      'Adáptalo a lo que el contacto acaba de decir. Un guion recitado se nota.',
    ]),
  );

  // ── Objeciones ───────────────────────────────────────────────────────────
  if (p.objeciones.length > 0) {
    bloques.push(
      seccion(
        'OBJECIONES Y CÓMO SE RESPONDEN',
        p.objeciones.map((o) => `· "${o.objecion}" → ${o.respuesta}`),
      ),
    );
  }

  if (p.faq.length > 0) {
    bloques.push(
      seccion(
        'LO QUE PREGUNTAN SIEMPRE',
        p.faq.map((f) => `· ${f.pregunta} → ${f.respuesta}`),
      ),
    );
  }

  // ── La cita ──────────────────────────────────────────────────────────────
  bloques.push(
    seccion('LA CITA QUE ESTÁS AGENDANDO', [
      `Dura ${p.agendamiento.duracion_min} minutos, por ${p.agendamiento.modalidad}.`,
      p.agendamiento.quien_atiende
        ? `La atiende ${p.agendamiento.quien_atiende}.`
        : 'La atiende alguien del equipo.',
      `Qué pasa en ella: ${p.agendamiento.que_pasa_en_la_cita}`,
      `Zona horaria del cliente: ${p.agendamiento.zona_horaria}.`,
      '',
      `Ofreces ${p.agendamiento.opciones_por_mensaje} horarios concretos por mensaje, NUNCA una pregunta abierta de calendario.`,
      'Los horarios los sacas SIEMPRE de la herramienta `consultar_horarios`. Inventar un cupo que no existe es la peor cosa que puedes hacer acá: el contacto llega a una reunión que no está en la agenda de nadie.',
      'Cuando el contacto acepta un horario, llamas a `agendar_cita`. No des una cita por hecha antes de que la herramienta te confirme.',
    ]),
  );

  // ── Escalamiento ─────────────────────────────────────────────────────────
  bloques.push(
    seccion('CUÁNDO LEVANTAS LA MANO', [
      ...p.escalamiento.disparadores.map((d) => `· ${d}`),
      '',
      `Cuando escalas, le escribes al contacto: "${p.escalamiento.mensaje_al_contacto}"`,
      'Y no intentas resolverlo tú. Escalar bien vale más que una respuesta improvisada.',
    ]),
  );

  if (p.prohibiciones.length > 0) {
    bloques.push(seccion('PROHIBIDO, SIN EXCEPCIÓN', p.prohibiciones.map((x) => `· ${x}`)));
  }

  bloques.push(
    seccion('VERSIÓN', [
      `Playbook v${p.version} · ${p.vertical} · ${p.channel}`,
      'Si algo de acá contradice lo que crees saber, manda lo de acá.',
    ]),
  );

  return bloques.join('\n\n');
}

function seccion(titulo: string, lineas: string[]): string {
  return [`## ${titulo}`, ...lineas.filter((l) => l !== undefined && l !== null)].join('\n');
}

/**
 * Reemplaza los marcadores del guion con lo real.
 *
 * Los marcadores existen porque el modelo que escribió el guion no puede saber
 * qué horarios van a estar libres tres semanas después. `{{horarios}}` se
 * rellena con lo que devolvió la agenda, no con lo que el modelo se imagine.
 */
export function rellenar(
  plantilla: string,
  valores: { horarios?: string; cita?: string; link?: string },
): string {
  return plantilla
    .replace(/\{\{horarios\}\}/g, valores.horarios ?? '')
    .replace(/\{\{cita\}\}/g, valores.cita ?? '')
    .replace(/\{\{link\}\}/g, valores.link ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
