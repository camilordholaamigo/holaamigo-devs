/**
 * Créditos: la unidad de consumo del producto (ADR 0011).
 *
 * Por qué créditos y no dólares en pantalla: el President propone envíos varias
 * veces por semana y el cliente tiene que poder decidir en tres segundos. "Esto
 * cuesta 1.240 créditos, te quedan 8.000" se decide de un vistazo; "esto cuesta
 * USD 24,80 más el prorrateo de infraestructura" abre una conversación.
 *
 * REGLA (ADR 0007): estos números los calcula el código. El President los LEE y
 * los redacta, nunca los estima. Un agente que inventa el costo de su propia
 * propuesta es un agente que puede pedir permiso para gastar lo que quiera.
 *
 * Anclaje: 1 crédito = 1 correo enviado. Todo lo demás se cotiza contra eso,
 * que es la acción más frecuente y la que el cliente entiende sin explicación.
 */

export type CreditAction =
  | 'email_send'
  | 'email_reply'
  | 'whatsapp_conversation'
  | 'lead_import'
  | 'ai_research'
  | 'ai_diagnosis'
  | 'ai_campaign_plan'
  | 'ai_classify'
  | 'booking'
  | 'checkout_order';

/**
 * Costo en créditos por acción. Los de IA salen de dividir el costo real
 * observado en `agent_runs` por el precio del crédito, redondeado hacia arriba:
 * preferimos cobrar de más en la estimación y devolver, a quedarnos cortos y
 * tener que pedir plata a mitad de una campaña.
 */
export const CREDIT_COST: Record<CreditAction, number> = {
  email_send: 1,
  // Responder es más caro que enviar: clasificación + redacción + envío.
  email_reply: 2,
  // Conversación de marketing de Meta (~USD 0,0125) + el margen operativo.
  whatsapp_conversation: 3,
  lead_import: 0,
  ai_research: 40,
  ai_diagnosis: 30,
  ai_campaign_plan: 12,
  ai_classify: 1,
  // El agendador y el checkout NO consumen créditos: son los activos que
  // demuestran valor. Cobrar por agendar sería cobrar por el momento exacto en
  // el que el cliente ve que esto funciona.
  booking: 0,
  checkout_order: 0,
};

/** USD por crédito a precio de lista. Lo usamos para traducir en el admin. */
export const CREDIT_USD = 0.02;

export const CREDIT_PACKS = [
  { credits: 2_500, usd: 49, label: 'Arranque' },
  { credits: 10_000, usd: 179, label: 'Operación' },
  { credits: 50_000, usd: 749, label: 'Volumen' },
] as const;

/** Créditos que recibe una organización al activarse. Alcanza para una
 *  reactivación completa de una base mediana sin poner tarjeta. */
export const WELCOME_CREDITS = 1_000;

/** Umbral bajo el cual el President avisa en el feed antes de proponer. */
export const LOW_BALANCE_CREDITS = 500;

export function creditsFor(action: CreditAction, quantity = 1): number {
  return Math.ceil(CREDIT_COST[action] * quantity);
}

/**
 * Costo de una campaña completa: cada paso de la secuencia se envía a la
 * audiencia que sigue viva. No multiplicamos audiencia × pasos a lo bruto
 * porque los que responden salen de la secuencia — y eso baja el costo real
 * entre 15% y 30%. Estimar de más hace que el cliente rechace propuestas que
 * en realidad puede pagar.
 */
export function creditsForCampaign(args: {
  audience: number;
  steps: number;
  expectedReplyRate: number;
}): number {
  let alive = args.audience;
  let total = 0;
  for (let step = 0; step < args.steps; step += 1) {
    total += creditsFor('email_send', alive);
    alive = Math.round(alive * (1 - args.expectedReplyRate));
  }
  // Las respuestas también cuestan: clasificarlas y contestarlas.
  const replies = Math.round(args.audience * args.expectedReplyRate);
  total += creditsFor('email_reply', replies);
  return total;
}

export function creditsToUsd(credits: number): number {
  return Math.round(credits * CREDIT_USD * 100) / 100;
}
