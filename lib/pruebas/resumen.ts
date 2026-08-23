import { db } from '@/lib/supabase/admin';
import { formatoDuracion } from '@/lib/pruebas/motor';
import type {
  Auditoria,
  CerroCon,
  Evaluacion,
  EstadoPrueba,
  Mensaje,
  PlanDePrueba,
} from '@/lib/pruebas/types';

/**
 * Lo que el cliente lee sobre su propia línea.
 *
 * **Todas las cifras de acá las calcula este archivo**, restando timestamps y
 * contando filas. Ninguna sale de un modelo (ADR 0007). El modelo escribe la
 * frase que las acompaña, y esa frase está prohibida de contener números — se
 * lo pide el prompt del evaluador y lo verifica el esquema, que no tiene un
 * solo `z.number()`.
 *
 * La otra regla, que es de ADR 0023: **esto nunca finge progreso**. Si la
 * prueba está corriendo, dice que está corriendo y muestra cuánto lleva. Si
 * nadie contestó todavía, dice que nadie contestó todavía. La tentación de
 * poner una barra que avanza sola es exactamente la que este producto no se
 * puede permitir, porque lo único que vende es que los números son ciertos.
 */

export type EstadoDeLaPrueba =
  | 'escribiendo'
  | 'esperando'
  | 'conversando'
  | 'cerrada'
  | 'fallida';

export interface PruebaResumida {
  id: string;
  template_id: string;
  /** Cómo se llama la prueba para el cliente. */
  titulo: string;
  que_mide: string;
  telefono: string;
  estado: EstadoDeLaPrueba;
  /** Lo que pasó, en una frase, sin adornos. La escribe el código. */
  titular: string;
  segundos_primera_respuesta: number | null;
  /** Ya formateado: «16 minutos». */
  tardanza: string | null;
  /** Segundos que llevamos esperando, si todavía no contestaron. */
  esperando_hace: number | null;
  turno: number;
  max_turnos: number;
  /**
   * 0–100. Es honesto porque cada tramo corresponde a un hecho con hora:
   * mandado, contestado, cada turno, cerrado. No avanza solo.
   */
  avance: number;
  cerro_con: CerroCon | null;
  conversation: Mensaje[];
  auditoria: Auditoria | null;
  evaluacion: Evaluacion | null;
  enviado_at: string | null;
}

export interface ResumenDeCorrida {
  runId: string;
  estado: 'running' | 'done' | 'cancelled';
  /** El renglón que va arriba de todo. Lo escribe el código. */
  titular: string;
  pruebas: PruebaResumida[];
  progreso: Array<{ t: string; step: string; detail: string }>;
  /** Cuántas siguen vivas. Cero significa que ya está todo. */
  vivas: number;
}

const TITULOS: Record<string, { titulo: string; que_mide: string }> = {
  servicio: {
    titulo: 'Servicio al cliente',
    que_mide: 'Le escribimos como un cliente con una duda simple.',
  },
  faq: {
    titulo: 'Preguntas frecuentes',
    que_mide: 'Le hicimos las preguntas que tu propio sitio ya responde.',
  },
  ventas: {
    titulo: 'Ventas',
    que_mide: 'Le escribimos como un comprador listo para comprar.',
  },
};

export async function resumenDeCorrida(runId: string): Promise<ResumenDeCorrida | null> {
  const { data: run } = await db()
    .from('smoke_runs')
    .select('id, estado, progress_log')
    .eq('id', runId)
    .maybeSingle();

  if (!run) return null;

  const { data: filas } = await db()
    .from('smoke_probes')
    .select(
      `id, template_id, target_phone, plan, conversation, estado, cerro_con, turno, max_turnos,
       enviado_at, primera_respuesta_at, segundos_primera_respuesta, ultimo_entrante_at,
       auditoria, evaluacion, created_at`,
    )
    .eq('run_id', runId)
    .order('created_at', { ascending: true });

  const pruebas = (filas ?? []).map(resumirFila);
  const vivas = pruebas.filter((p) => p.estado === 'escribiendo' || p.estado === 'esperando' || p.estado === 'conversando').length;

  return {
    runId: run.id,
    estado: run.estado as ResumenDeCorrida['estado'],
    titular: titularDeLaCorrida(pruebas, vivas),
    pruebas,
    progreso: Array.isArray(run.progress_log) ? run.progress_log.slice(-12) : [],
    vivas,
  };
}

export async function resumenPorOrganizacion(
  organizationId: string,
): Promise<ResumenDeCorrida | null> {
  const { data } = await db()
    .from('smoke_runs')
    .select('id')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1);

  return data?.[0] ? resumenDeCorrida(data[0].id) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNA PRUEBA
// ═══════════════════════════════════════════════════════════════════════════

interface FilaCruda {
  id: string;
  template_id: string;
  target_phone: string;
  plan: PlanDePrueba;
  conversation: Mensaje[] | null;
  estado: EstadoPrueba;
  cerro_con: CerroCon | null;
  turno: number;
  max_turnos: number;
  enviado_at: string | null;
  primera_respuesta_at: string | null;
  segundos_primera_respuesta: number | null;
  ultimo_entrante_at: string | null;
  auditoria: Auditoria | null;
  evaluacion: Evaluacion | null;
  created_at: string;
}

function resumirFila(f: FilaCruda): PruebaResumida {
  const meta = TITULOS[f.template_id] ?? {
    titulo: f.template_id,
    que_mide: 'Prueba a medida.',
  };

  const estado = estadoVisible(f);
  const conversation = f.conversation ?? [];

  const esperandoHace =
    estado === 'esperando' && f.enviado_at
      ? Math.max(0, Math.round((Date.now() - Date.parse(f.enviado_at)) / 1000))
      : null;

  return {
    id: f.id,
    template_id: f.template_id,
    titulo: meta.titulo,
    que_mide: meta.que_mide,
    telefono: f.target_phone,
    estado,
    titular: titular(f, estado, esperandoHace),
    segundos_primera_respuesta: f.segundos_primera_respuesta,
    tardanza:
      f.segundos_primera_respuesta !== null
        ? formatoDuracion(f.segundos_primera_respuesta)
        : null,
    esperando_hace: esperandoHace,
    turno: f.turno,
    max_turnos: f.max_turnos,
    avance: avance(f, estado),
    cerro_con: f.cerro_con,
    conversation,
    auditoria: f.auditoria,
    evaluacion: f.evaluacion,
    enviado_at: f.enviado_at,
  };
}

function estadoVisible(f: FilaCruda): EstadoDeLaPrueba {
  if (f.estado === 'failed' || f.estado === 'cancelled') return 'fallida';
  if (f.estado === 'completed' || f.estado === 'timeout') return 'cerrada';
  if (f.estado === 'pending') return 'escribiendo';
  return f.primera_respuesta_at ? 'conversando' : 'esperando';
}

/**
 * La barra.
 *
 * Cada tramo se gana con un hecho que tiene hora en la base:
 *
 *   0 %   la prueba existe pero no salió el mensaje
 *   15 %  el mensaje salió
 *   45 %  contestaron  ← el salto grande, porque es el dato que importa
 *   45-90 % un tramo por turno completado
 *   100 % cerrada
 *
 * Entre dos hechos la barra NO SE MUEVE, y eso es a propósito. Una barra que
 * repta sola mientras no pasa nada es la mentira más común de las interfaces
 * de espera, y acá el producto entero se apoya en que no mentimos. Lo que sí
 * corre es el cronómetro de al lado: ese es real.
 */
function avance(f: FilaCruda, estado: EstadoDeLaPrueba): number {
  if (estado === 'cerrada' || estado === 'fallida') return 100;
  if (!f.enviado_at) return 0;
  if (!f.primera_respuesta_at) return 15;

  const turnosUtiles = Math.max(1, f.max_turnos - 1);
  const porTurno = Math.min(1, Math.max(0, (f.turno - 1) / turnosUtiles));
  return Math.round(45 + porTurno * 45);
}

function titular(
  f: FilaCruda,
  estado: EstadoDeLaPrueba,
  esperandoHace: number | null,
): string {
  if (estado === 'escribiendo') return 'En cola: arranca en cuanto se libere la línea.';

  if (estado === 'fallida') return 'No se pudo completar esta prueba.';

  if (estado === 'esperando') {
    const hace = esperandoHace !== null ? formatoDuracion(esperandoHace) : 'un momento';
    return `Escribimos hace ${hace}. Todavía no contestan.`;
  }

  if (estado === 'conversando') {
    const t = f.segundos_primera_respuesta;
    return t !== null
      ? `Contestaron en ${formatoDuracion(t)}. La conversación sigue.`
      : 'Conversación en curso.';
  }

  // Cerrada.
  if (f.cerro_con === 'sin_respuesta') {
    return 'Nadie contestó.';
  }
  if (f.cerro_con === 'bloqueado') {
    return 'Pidieron que no escribiéramos más. Paramos ahí mismo.';
  }

  const t = f.segundos_primera_respuesta;
  const tardanza = t !== null ? `Contestaron en ${formatoDuracion(t)}` : 'Contestaron';

  if (f.cerro_con === 'agendado') return `${tardanza} y agendaron una cita.`;
  if (f.cerro_con === 'cotizacion') return `${tardanza} y ofrecieron cotización.`;
  if (f.cerro_con === 'incompleto') return `${tardanza}, pero la conversación no llegó a nada.`;
  return `${tardanza}.`;
}

/**
 * El renglón de arriba.
 *
 * Prioriza el peor resultado, no el promedio. Un negocio con dos líneas que
 * contestan bien y una muerta tiene un problema, y promediarlo lo escondería.
 */
function titularDeLaCorrida(pruebas: PruebaResumida[], vivas: number): string {
  if (pruebas.length === 0) return 'No encontramos ningún número al que escribirle.';

  const cerradas = pruebas.filter((p) => p.estado === 'cerrada');
  const mudas = cerradas.filter((p) => p.cerro_con === 'sin_respuesta');

  if (vivas > 0 && cerradas.length === 0) {
    const conRespuesta = pruebas.filter((p) => p.segundos_primera_respuesta !== null);
    if (conRespuesta.length === 0) {
      return 'Le estamos escribiendo a tu línea. Todavía no contestan.';
    }
    const mejor = Math.min(...conRespuesta.map((p) => p.segundos_primera_respuesta ?? 0));
    return `Ya contestaron: ${formatoDuracion(mejor)}. Seguimos conversando.`;
  }

  if (mudas.length === pruebas.length) {
    return pruebas.length === 1
      ? 'Le escribimos a tu línea y nadie contestó.'
      : `Le escribimos a ${pruebas.length} de tus líneas y no contestó ninguna.`;
  }

  const conTiempo = pruebas
    .map((p) => p.segundos_primera_respuesta)
    .filter((s): s is number => s !== null);

  if (conTiempo.length === 0) return 'Le escribimos a tu línea. Sin respuesta por ahora.';

  const mediana = medianaDe(conTiempo);
  const cola = vivas > 0 ? ' Seguimos con las demás.' : '';
  const perdidas =
    mudas.length > 0
      ? ` ${mudas.length} de ${pruebas.length} ${mudas.length === 1 ? 'quedó' : 'quedaron'} sin respuesta.`
      : '';

  return `Contestaron en ${formatoDuracion(mediana)}.${perdidas}${cola}`;
}

function medianaDe(xs: number[]): number {
  const orden = [...xs].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 === 0
    ? Math.round((orden[medio - 1] + orden[medio]) / 2)
    : orden[medio];
}
