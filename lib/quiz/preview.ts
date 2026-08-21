import { buildAssumptions, computeLeaks } from '@/lib/diagnostic/math';

/**
 * La primera cifra, a mitad del quiz.
 *
 * En la pregunta 5 (`dormant_db`) el sistema ya tiene todo lo que necesita para
 * calcular la primera fuga, y no la muestra hasta el diagnóstico. Ese silencio
 * es la parte del flujo que se siente tonta: el cliente acaba de darle a un
 * formulario el dato que más plata mueve y el formulario responde pasando a la
 * pregunta 6.
 *
 * Reglas que hacen que esto no se vuelva un truco:
 *
 *  1. Sale de `computeLeaks`, no de una fórmula copiada. Si mañana cambia el
 *     4% de reactivación, cambia acá también. Un adelanto que no coincide con
 *     el diagnóstico final es peor que no dar adelanto.
 *  2. Solo la fuga de base dormida. Es la única cuyo monto depende
 *     exclusivamente de lo ya respondido: `dormant_db × ticket_band`. Las otras
 *     tres necesitan `leads_per_month`, que se deriva de la facturación y de la
 *     tasa de cierre de la industria — y la industria la trae el research, que
 *     a esta altura puede no haber terminado. Adelantar un número que después
 *     se mueve es exactamente lo que destruye la confianza.
 *  3. Si respondió "No sé", no hay adelanto. El punto medio de 800 contactos
 *     sirve para no dejar el diagnóstico sin cifra, pero presentárselo como
 *     "tu base vale X" a alguien que acaba de decir que no sabe cuánta base
 *     tiene es inventarle un dato.
 *
 * Es TypeScript puro por la misma razón que `lib/diagnostic/math.ts`: no debe
 * importar nada de servidor.
 */

export interface QuizPreview {
  /** Monto mensual en USD. La conversión a moneda local es de presentación. */
  leak_usd: number;
  /** La fórmula escrita como el cliente la leería. */
  formula: string;
  contacts: number;
  ticket_usd: number;
}

export function buildQuizPreview(answers: Record<string, unknown>): QuizPreview | null {
  const dormant = answers.dormant_db;
  const ticket = answers.ticket_band;

  if (typeof dormant !== 'string' || typeof ticket !== 'string') return null;
  if (dormant === 'unknown') return null;

  const assumptions = buildAssumptions({ dormant_db: dormant, ticket_band: ticket });
  const leak = computeLeaks(assumptions).find((l) => l.key === 'dormant_db');
  if (!leak || leak.monthly_value_usd <= 0) return null;

  return {
    leak_usd: leak.monthly_value_usd,
    formula: leak.formula,
    contacts: assumptions.dormant_contacts,
    ticket_usd: assumptions.avg_ticket_usd,
  };
}
