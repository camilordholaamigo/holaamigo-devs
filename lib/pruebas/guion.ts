import { clamp } from '@/lib/utils';
import { modoDelPlan } from '@/lib/pruebas/types';
import type {
  CriterioRubrica,
  HechoDeReferencia,
  ModoDePrueba,
  Persona,
  PlanDePrueba,
  Sonda,
} from '@/lib/pruebas/types';

/**
 * La prueba a medida: de lo que escribió una persona a un `PlanDePrueba`.
 *
 * `compilar.ts` produce un plan leyendo el research con ayuda de un modelo.
 * Este archivo produce **el mismo objeto** leyendo un formulario. Río abajo
 * nadie se enteró: el motor, el auditor, el evaluador y el informe leen el plan
 * y les da igual quién lo escribió (ADR 0027, decisión 1).
 *
 * ── ES PURO A PROPÓSITO ────────────────────────────────────────────────────
 *
 * No importa la base, ni el cliente de IA, ni `resolverRubrica`. La rúbrica
 * llega ya resuelta desde el llamador. Dos razones:
 *
 *   1. La vista previa del formulario tiene que poder mostrar EXACTAMENTE lo
 *      que se va a mandar, y para eso este módulo tiene que poder correr en el
 *      navegador. Un preview que se calcula distinto que lo que se manda es
 *      peor que no tener preview.
 *   2. Se puede probar sin levantar nada.
 *
 * ── LO QUE ESTE MÓDULO NO HACE ─────────────────────────────────────────────
 *
 * **No le pasa `blanquearCifras()` al texto del operador.** La red de cifras
 * existe para que un MODELO no invente un precio (ADR 0007/0024). Acá los
 * números los escribió una persona que sabe lo que está preguntando, y taparle
 * el «¿cuánto vale el tratamiento de 4 sesiones?» convertiría la herramienta en
 * un adivinador. Lo que sí se hace es declarar esas cifras como permitidas para
 * el comprador —`cifrasDelPlan()`— para que el modelo pueda repetirlas sin que
 * la red se las coma, y ninguna otra.
 */

/** Tope de preguntas. Más de seis no es una prueba, es un cuestionario. */
export const MAX_SONDAS = 6;
/** Tope de mensajes del guion. Ocho mensajes a un desconocido ya es demasiado. */
export const MAX_GUION = 8;

export interface EntradaAMedida {
  modo: ModoDePrueba;
  /** Cómo se llama el negocio. Se usa en el saludo y en el informe. */
  negocio: string;
  /** Qué vende, en una línea. «tratamientos faciales y corporales». */
  producto: string;
  /** Modo conversar: el primer mensaje, tal cual va a salir. */
  apertura: string;
  /** Modo conversar: a dónde tiene que llegar la conversación. */
  objetivo: string;
  /** Modo conversar: lo que hay que averiguar, una por línea. */
  preguntas: string[];
  /** Modo guion: los mensajes exactos, en orden. El primero es el saludo. */
  guion: string[];
  /** Lo que el equipo sabe del negocio. Contexto para el comprador, no ficha. */
  contexto: string | null;
  /** Cómo tiene que comportarse el comprador. Tono, nunca hechos. */
  instrucciones: string | null;
  persona: Partial<Persona>;
  maxTurnos: number;
}

export const PERSONA_POR_DEFECTO: Persona = {
  nombre: 'Camila Restrepo',
  correo: 'camila.restrepo.pruebas@gmail.com',
  telefono: '3054182637',
  ciudad: 'Bogotá',
};

/** El molde al que apunta cada modo. Es clave foránea, no adorno. */
export function moldeDelModo(modo: ModoDePrueba): string {
  return modo === 'guion' ? 'guion' : 'a-medida';
}

// ═══════════════════════════════════════════════════════════════════════════
// SUGERENCIAS
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que el formulario propone antes de que el operador toque nada. Vive acá y
// no en el componente para que la sugerencia y el plan no se puedan desalinear:
// si el operador no cambia nada, lo que ve en el preview es literalmente lo que
// esta función devolvió.

export function aperturaSugerida(negocio: string, producto: string): string {
  const quien = negocio.trim();
  const que = producto.trim();
  if (quien && que) return `Hola, buenas 🙂 Vi ${quien} y me interesa ${que}, ¿me pueden ayudar?`;
  if (quien) return `Hola, buenas 🙂 Vi ${quien} y quería preguntar una cosa`;
  return 'Hola, buenas 🙂 Quería preguntar una cosa';
}

export function objetivoSugerido(producto: string): string {
  const que = producto.trim();
  return que
    ? `Entender qué ofrecen en ${que}, cuánto cuesta, y terminar con un paso siguiente concreto: una cita con fecha y hora o una cotización.`
    : 'Entender qué ofrecen y cuánto cuesta, y terminar con un paso siguiente concreto: una cita con fecha y hora o una cotización.';
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Devuelve el primer problema, o null.
 *
 * Corre en el cliente para deshabilitar el botón y **otra vez en el servidor**
 * antes de mandar un solo mensaje. No es paranoia: la petición del cliente es
 * un dato de entrada, y del otro lado del botón hay un WhatsApp real a un
 * negocio real.
 */
export function validarAMedida(e: EntradaAMedida): string | null {
  if (!e.negocio.trim()) return 'Falta el nombre del negocio.';

  if (e.modo === 'guion') {
    const msgs = limpiarLista(e.guion);
    if (msgs.length === 0) return 'Escribí al menos un mensaje para mandar.';
    if (msgs.length > MAX_GUION) return `Máximo ${MAX_GUION} mensajes en el guion.`;
    return null;
  }

  if (!e.apertura.trim()) return 'Falta el primer mensaje.';
  if (!e.objetivo.trim()) return 'Falta el objetivo de la conversación.';
  if (limpiarLista(e.preguntas).length === 0) {
    return 'Escribí al menos una cosa que quieras averiguar.';
  }
  if (limpiarLista(e.preguntas).length > MAX_SONDAS) {
    return `Máximo ${MAX_SONDAS} preguntas. Más que eso deja de ser una prueba y es un cuestionario.`;
  }
  return null;
}

/** Cuántos turnos nuestros va a tener esta prueba como máximo. */
export function turnosDe(e: EntradaAMedida): number {
  if (e.modo === 'guion') {
    // Exactamente el largo del guion, para que la pantalla diga «turno 3 de 3»
    // cuando se mandó el último. El tope no es el criterio de cierre en este
    // modo: el motor cierra cuando `plan.guion[turno]` no existe, y esa rama
    // corre ANTES del chequeo del tope. Si el orden se invirtiera, la prueba
    // cerraría como «incompleta» justo cuando en realidad se completó — hay una
    // prueba en scripts/test-smoke-tester.mjs que vigila ese orden.
    return clamp(limpiarLista(e.guion).length, 2, 40);
  }
  return clamp(Math.round(e.maxTurnos), 2, 40);
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPILAR
// ═══════════════════════════════════════════════════════════════════════════

export function planALaMedida(args: {
  entrada: EntradaAMedida;
  /** Ya resuelta contra la ficha por el llamador. Vacía es válido. */
  rubrica: CriterioRubrica[];
  /** Del research, si la organización está vinculada. Vacía si no. */
  ficha?: HechoDeReferencia[];
}): PlanDePrueba {
  const e = args.entrada;
  const ficha = args.ficha ?? [];
  const rubrica = args.rubrica;

  const negocio = e.negocio.trim() || 'el negocio';
  const producto = e.producto.trim() || 'lo que ofrecen';
  const persona = { ...PERSONA_POR_DEFECTO, ...limpiarPersona(e.persona) };

  const guion = e.modo === 'guion' ? limpiarLista(e.guion).slice(0, MAX_GUION) : [];

  // `guion[0]` con la lista vacía sería `undefined`, y `apertura` está tipado
  // como `string`: TypeScript no lo ve porque el índice de un array miente. El
  // llamador valida antes, pero un plan con `apertura: undefined` mandaría el
  // literal "undefined" por WhatsApp a un negocio real, y ese error no se
  // arregla con un rollback.
  const apertura =
    e.modo === 'guion'
      ? guion[0] || aperturaSugerida(negocio, producto)
      : e.apertura.trim() || aperturaSugerida(negocio, producto);

  // En modo guion las sondas son los mensajes 2..n. No es una traducción
  // caprichosa: es lo que hace que el evaluador pueda decir «no contestó la
  // pregunta 3» y que el informe pueda agrupar por pregunta entre negocios.
  const sondas: Sonda[] =
    e.modo === 'guion'
      ? guion.slice(1).map((mensaje, i) => ({
          id: `guion_${i + 2}`,
          pregunta: mensaje,
          por_que: `Mensaje ${i + 2} del guion. Se manda igual, sin importar qué hayan contestado.`,
          origen: 'admin' as const,
        }))
      : limpiarLista(e.preguntas)
          .slice(0, MAX_SONDAS)
          .map((pregunta, i) => ({
            id: `admin_${i + 1}`,
            pregunta,
            por_que: 'Lo pidió el equipo al armar la prueba.',
            origen: 'admin' as const,
          }));

  const conFuente = rubrica.filter((c) => c.chequeo !== null).length;

  return {
    template_id: moldeDelModo(e.modo),
    modo: e.modo,
    guion: e.modo === 'guion' ? guion : undefined,
    negocio,
    producto,
    objetivo:
      e.modo === 'guion'
        ? `Mandar las ${guion.length} preguntas del guion y registrar lo que contestaron.`
        : e.objetivo.trim() || objetivoSugerido(producto),
    persona,
    apertura,
    sondas,
    ficha,
    rubrica,
    contexto: recortar(e.contexto, 4_000),
    instrucciones: recortar(e.instrucciones, 1_000),
    criterios_cierre:
      e.modo === 'guion'
        ? ['Se mandaron todas las preguntas del guion']
        : [
            'Contestaron todo lo que se preguntó',
            'Propusieron una cita con fecha y hora, una llamada o una cotización',
            'Dijeron que un humano se contacta después y no hay nada más que hacer',
            'La conversación empezó a dar vueltas',
          ],
    max_turnos: turnosDe(e),
    cobertura: {
      con_fuente: conFuente,
      total: rubrica.length,
      porcentaje: rubrica.length > 0 ? Math.round((conFuente / rubrica.length) * 100) : 0,
    },
    // `degradado` significa «el compilador corrió sin modelo o con esquema
    // recortado». Una prueba escrita a mano no está degradada: está escrita a
    // mano, que es más deliberado que cualquier compilación.
    degradado: false,
  };
}

/**
 * El inverso de `planALaMedida()`: de un plan guardado, de vuelta al formulario.
 *
 * Es lo que hace posible el botón «Reintentar» sin volver a escribir nada. Un
 * plan es el contrato de una prueba (ADR 0027) y está guardado entero en
 * `smoke_probes.plan`, así que reintentar no es recompilar: es **volver a mandar
 * el mismo contrato**. Recompilar contra el research daría otras preguntas, y
 * entonces las dos corridas no serían comparables — que es justo lo único que se
 * quiere de un reintento.
 *
 * Lo que NO viaja acá, y es a propósito: la ficha y la rúbrica. Las dos se
 * derivan de la organización del objetivo, así que el llamador manda el mismo
 * `organizationId` y `compilarUnidad()` las vuelve a resolver igual. Meterlas en
 * la entrada las volvería un dato editable a mano, y una rúbrica escrita a mano
 * deja de ser una medición.
 *
 * Redondear el viaje —`planALaMedida(aMedidaDelPlan(p))`— tiene que devolver un
 * plan equivalente. Hay una prueba que lo verifica.
 */
export function aMedidaDelPlan(plan: PlanDePrueba): EntradaAMedida {
  const modo = modoDelPlan(plan);
  const guion = modo === 'guion' ? (plan.guion ?? []) : [];

  return {
    modo,
    negocio: plan.negocio,
    producto: plan.producto,
    apertura: plan.apertura,
    // En modo guion el objetivo lo redacta `planALaMedida` a partir de la
    // cantidad de mensajes. Devolverlo tal cual haría que el texto generado
    // volviera a entrar como si lo hubiera escrito una persona, y al segundo
    // reintento diría «Mandar las 4 preguntas» de una prueba de 3.
    objetivo: modo === 'guion' ? '' : plan.objetivo,
    preguntas: modo === 'guion' ? [] : plan.sondas.map((s) => s.pregunta),
    guion,
    contexto: plan.contexto ?? null,
    instrucciones: plan.instrucciones ?? null,
    persona: plan.persona,
    maxTurnos: plan.max_turnos,
  };
}

/**
 * Las cifras que el comprador tiene permitido decir en esta prueba.
 *
 * Su presupuesto, más cualquier número que una persona haya escrito en el plan
 * —en el objetivo, en las preguntas, en el contexto—. Un precio que el operador
 * puso ahí es una premisa de la prueba; taparlo haría que el negocio conteste a
 * una pregunta distinta de la que se quiso hacer. Todo lo demás sigue tapado:
 * si el modelo se inventa una cifra, no sale.
 */
export function cifrasDelPlan(plan: PlanDePrueba): string[] {
  const texto = [
    plan.objetivo,
    plan.contexto ?? '',
    plan.instrucciones ?? '',
    ...plan.sondas.map((s) => s.pregunta),
    ...(plan.guion ?? []),
    ...plan.ficha.filter((h) => h.clave === 'precio').map((h) => h.valor),
  ].join('\n');

  const cifras = texto.match(/\d[\d.,]*/g) ?? [];

  return [plan.persona.presupuesto ?? '', ...cifras].filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════

function limpiarLista(xs: string[] | null | undefined): string[] {
  return (xs ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
}

function recortar(v: string | null | undefined, max: number): string | null {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, max) : null;
}

function limpiarPersona(raw: Partial<Persona>): Partial<Persona> {
  const salida: Partial<Persona> = {};
  for (const clave of ['nombre', 'correo', 'telefono', 'ciudad', 'presupuesto'] as const) {
    const v = String(raw[clave] ?? '').trim();
    if (v) salida[clave] = v;
  }
  return salida;
}
