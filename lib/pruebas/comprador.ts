import { runStructured } from '@/lib/ai/client';
import { CompradorTurnoSchema } from '@/lib/ai/schemas';
import { COMPRADOR_SYSTEM } from '@/config/prompts';
import { hasOpenAI } from '@/lib/env';
import { blanquearCifras } from '@/lib/playbook/compile';
import { cifrasDelPlan } from '@/lib/pruebas/guion';
import type { Mensaje, PlanDePrueba } from '@/lib/pruebas/types';

/**
 * El comprador sintético: el otro lado de la conversación.
 *
 * Recibe el hilo completo y devuelve el mensaje siguiente. Tres cosas lo hacen
 * funcionar, y ninguna es el modelo:
 *
 * 1. IDENTIDAD FIJA. El mismo nombre, el mismo correo, el mismo celular
 *    durante toda la conversación. No es realismo: es lo que hace VERIFICABLE
 *    la prueba. Terminada la conversación, el dueño del negocio puede ir a su
 *    CRM y confirmar que el lead llegó con ese correo exacto. Con una
 *    identidad que muta no se puede afirmar nada.
 *
 * 2. UN OBJETIVO. Después de contestar lo que le preguntaron, empuja hacia
 *    ahí. Sin objetivo la conversación deriva y nunca llega a un cierre
 *    evaluable.
 *
 * 3. CRITERIO DE CIERRE PROPIO. El comprador decide cuándo terminar. Es lo que
 *    evita que la prueba se quede dando vueltas hasta agotar el tope de turnos.
 *
 * Y una cuarta que se paga sola: SIN LLAVE DE OPENAI NO EXPLOTA. Cae a un
 * comprador de reglas. Peor conversación, mismo flujo completo. Un arnés de QA
 * que se cae cuando falta una variable de entorno deja de usarse a la semana.
 */

export interface TurnoDelComprador {
  mensaje: string;
  terminar: boolean;
  motivo: string;
  /** `ia` o `heuristico`. Se guarda: cambia cómo se lee la transcripción. */
  fuente: 'ia' | 'heuristico';
}

export async function siguienteTurno(args: {
  plan: PlanDePrueba;
  conversation: Mensaje[];
  turno: number;
  organizationId: string | null;
  runId?: string | null;
}): Promise<TurnoDelComprador> {
  const { plan, conversation, turno } = args;

  const permitidas = cifrasDelPlan(plan);

  if (hasOpenAI()) {
    try {
      const r = await runStructured({
        step: 'comprador',
        schemaName: 'comprador_turno',
        schema: CompradorTurnoSchema,
        system: COMPRADOR_SYSTEM,
        input: armarInstrucciones(plan, conversation, turno),
        organizationId: args.organizationId,
        role: 'cmo',
        trigger: 'smoke_test',
        runId: args.runId ?? null,
      });

      const mensaje = limpiarParaWhatsapp(r.data.mensaje, permitidas);
      if (mensaje) {
        return {
          mensaje,
          terminar: Boolean(r.data.terminar),
          motivo: String(r.data.motivo ?? '').slice(0, 300),
          fuente: 'ia',
        };
      }
    } catch (err) {
      console.error('[pruebas] el comprador IA falló, cae a heurístico', err);
    }
  }

  return heuristico(plan, conversation, turno, permitidas);
}

/**
 * La red de cifras, con la voz del comprador.
 *
 * Un comprador que dice «vi que cuesta $2.400.000 en su página» cuando el sitio
 * no dice eso invalida la prueba entera: el negocio le contesta a un dato
 * inventado y después el evaluador lo califica por esa respuesta. Es el mismo
 * argumento de ADR 0024, del otro lado del mostrador.
 */
function limpiarParaWhatsapp(raw: string, permitidas: string[]): string {
  let texto = String(raw ?? '').trim();
  if (!texto) return '';

  // Los LLM escriben viñetas y negritas por defecto. Nadie manda markdown por
  // WhatsApp, y un mensaje que parece generado hace que el negocio del otro
  // lado conteste distinto — que es exactamente lo que no queremos medir.
  texto = texto
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^["']([\s\S]*)["']$/, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return blanquearCifras(texto, 0, permitidas, 'no me acuerdo del monto exacto').slice(0, 700);
}

function armarInstrucciones(plan: PlanDePrueba, conversation: Mensaje[], turno: number): string {
  const p = plan.persona;

  const pendientes = plan.sondas
    .filter((s) => !yaSePregunto(s.pregunta, conversation))
    .map((s) => `- ${s.pregunta}`)
    .join('\n');

  const hilo = conversation
    .map((m) => `${m.role === 'comprador' ? 'TÚ' : 'EL NEGOCIO'}: ${m.text}`)
    .join('\n');

  return [
    'TU IDENTIDAD (úsala siempre igual, nunca la cambies ni la inventes de nuevo):',
    `- Nombre completo: ${p.nombre}`,
    `- Correo: ${p.correo}`,
    `- Celular: ${p.telefono}`,
    `- Ciudad: ${p.ciudad}`,
    p.presupuesto ? `- Presupuesto: ${p.presupuesto}` : '',
    '',
    `LE ESTÁS ESCRIBIENDO A: ${plan.negocio}`,
    `LO QUE TE INTERESA: ${plan.producto}`,
    '',
    `TU OBJETIVO: ${plan.objetivo}`,
    '',
    // Lo que el equipo escribió del negocio. Entra como «lo que sabés», no como
    // verdad citable: no tiene fuente, así que el comprador puede apoyarse en
    // ello para preguntar pero no para afirmar (§13.4).
    plan.contexto ? `LO QUE SABÉS DE ELLOS:\n${plan.contexto}` : '',
    plan.contexto
      ? 'Eso te sirve para preguntar. NO lo cites como si lo hubieras leído en su web.\n'
      : '',
    // Las instrucciones ajustan el TONO. Van después del objetivo y antes de
    // las preguntas para que no puedan reescribir ninguno de los dos.
    plan.instrucciones ? `CÓMO TE TENÉS QUE COMPORTAR: ${plan.instrucciones}\n` : '',
    pendientes
      ? `LO QUE TODAVÍA NO PREGUNTASTE (una por mensaje, en este orden):\n${pendientes}`
      : 'Ya preguntaste todo lo que querías. Ahora empuja al objetivo o cierra.',
    '',
    'CUÁNDO DAR LA CONVERSACIÓN POR TERMINADA:',
    plan.criterios_cierre.map((c) => `- ${c}`).join('\n'),
    '',
    `VAS EN EL TURNO ${turno} DE ${plan.max_turnos}.`,
    turno >= plan.max_turnos - 1
      ? 'Es de los últimos. Si no vas a llegar al objetivo, cierra con cortesía.'
      : '',
    '',
    'LA CONVERSACIÓN HASTA AHORA:',
    hilo || '(todavía no has escrito nada)',
  ]
    .filter((l) => l !== '')
    .join('\n')
    .slice(0, 20_000);
}

/** ¿Ya se hizo esta pregunta? Comparación laxa: importa el tema, no la forma. */
function yaSePregunto(pregunta: string, conversation: Mensaje[]): boolean {
  const claves = pregunta
    .toLowerCase()
    .replace(/[¿?¡!.,]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 4);
  if (claves.length === 0) return false;

  const mio = conversation
    .filter((m) => m.role === 'comprador')
    .map((m) => m.text.toLowerCase())
    .join(' ');

  const aciertos = claves.filter((k) => mio.includes(k)).length;
  return aciertos / claves.length >= 0.6;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL COMPRADOR DE REGLAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sin modelo: peor conversación, mismo flujo completo.
 *
 * Reconoce qué le pidieron y lo entrega desde la misma identidad; si no
 * reconoce nada, avanza por las sondas del plan en orden. No es tan bueno
 * como el comprador IA — repite estructura y se nota — pero llega al final,
 * y una prueba que llega al final mide algo. Además permite correr el arnés en
 * CI sin gastar un peso en tokens.
 */
function heuristico(
  plan: PlanDePrueba,
  conversation: Mensaje[],
  turno: number,
  permitidas: string[],
): TurnoDelComprador {
  const p = plan.persona;
  const ultimo = [...conversation].reverse().find((m) => m.role === 'negocio');
  const texto = (ultimo?.text ?? '').toLowerCase();

  const cerrar = (motivo: string, mensaje: string): TurnoDelComprador => ({
    mensaje: limpiarParaWhatsapp(mensaje, permitidas),
    terminar: true,
    motivo,
    fuente: 'heuristico',
  });

  if (/no (nos )?escrib|no me escrib|dar de baja|remover|no contactar|spam/i.test(texto)) {
    return cerrar('el negocio pidió que no le escribamos', 'Listo, entendido. Gracias.');
  }
  if (/#agendado|#cotizacion|#cotización/i.test(texto)) {
    return cerrar('el negocio emitió la etiqueta de cierre', 'Perfecto, muchas gracias 🙌');
  }
  if (turno >= plan.max_turnos) {
    return cerrar('se acabaron los turnos', 'Bueno, gracias por la info. Cualquier cosa te escribo.');
  }

  // Contestar lo que preguntaron es lo primero. Un comprador que ignora la
  // pregunta del negocio produce una conversación que no avanza nunca.
  const datos: string[] = [];
  if (/correo|email|e-mail/.test(texto)) datos.push(`Mi correo es ${p.correo}`);
  if (/nombre|con qui[eé]n/.test(texto)) datos.push(`Soy ${p.nombre}`);
  if (/celular|tel[eé]fono|whats/.test(texto)) datos.push(`Mi celular es ${p.telefono}`);
  if (/ciudad|d[oó]nde (est|viv|qued)|ubicaci/.test(texto)) datos.push(`Estoy en ${p.ciudad}`);
  if (/presupuesto|cu[aá]nto (puedes|pod[eé]s|piensas) invertir/.test(texto) && p.presupuesto) {
    datos.push(`Mi presupuesto es ${p.presupuesto}`);
  }
  if (/autoriz|tratamiento de datos|habeas data|pol[ií]tica de privacidad/.test(texto)) {
    datos.push('Sí, autorizo');
  }

  const pendiente = plan.sondas.find((s) => !yaSePregunto(s.pregunta, conversation));
  const pregunta = pendiente?.pregunta ?? '¿Cómo seguimos entonces?';

  const partes = [...datos, pregunta].filter(Boolean);

  return {
    mensaje: limpiarParaWhatsapp(partes.join('. '), permitidas),
    terminar: false,
    motivo: pendiente
      ? `heurístico: contesta lo pedido y pregunta por ${pendiente.id}`
      : 'heurístico: no quedan sondas, empuja al cierre',
    fuente: 'heuristico',
  };
}
