/**
 * Ruteo de modelos por paso (PRD §8.2).
 *
 * Regla de diseño: cada paso declara un modelo primario y una cadena de
 * fallback. Si OpenAI responde `model_not_found` (nombre retirado, cuenta sin
 * acceso), el cliente baja al siguiente de la lista en vez de reventar la
 * corrida. Un modelo mal escrito degrada calidad, nunca disponibilidad.
 *
 * Todo es override-able por env var: cambiar de modelo NO requiere desplegar.
 * Ver docs/wiki/03-agentes.md §"Ruteo de modelos"
 */

export type StepName =
  | 'research'
  | 'extract'
  | 'adaptive_question'
  | 'diagnosis'
  | 'angles'
  | 'classify';

export interface StepConfig {
  /** Cadena de modelos: se intenta en orden. */
  models: string[];
  /** Tope duro de tokens de salida. Corta costos, no calidad. */
  maxOutputTokens: number;
  /** Si el paso puede buscar en la web. */
  webSearch: boolean;
  /** Temperatura. `null` = no enviar el parámetro (modelos de razonamiento). */
  temperature: number | null;
  /** Presupuesto informativo para logs y alertas de costo. */
  budgetTokens: number;
}

function chain(envVar: string, ...defaults: string[]): string[] {
  const override = process.env[envVar];
  const list = override ? override.split(',').map((m) => m.trim()) : [];
  return [...list, ...defaults].filter(Boolean);
}

export const MODEL_ROUTES: Record<StepName, StepConfig> = {
  // Investigación: el paso caro. Web search + lectura del sitio.
  research: {
    models: chain('MODEL_RESEARCH', 'gpt-5', 'gpt-4.1'),
    maxOutputTokens: 8000,
    webSearch: true,
    temperature: null,
    budgetTokens: 120_000,
  },

  // Extracción estructurada de los hallazgos crudos a JSON estricto.
  extract: {
    models: chain('MODEL_EXTRACT', 'gpt-5-mini', 'gpt-4.1-mini'),
    maxOutputTokens: 6000,
    webSearch: false,
    temperature: 0.1,
    budgetTokens: 30_000,
  },

  // Pregunta adaptativa: barata y rápida, corre entre pantallas del quiz.
  adaptive_question: {
    models: chain('MODEL_ADAPTIVE', 'gpt-5-mini', 'gpt-4.1-mini'),
    maxOutputTokens: 1200,
    webSearch: false,
    temperature: 0.6,
    budgetTokens: 4_000,
  },

  // Síntesis del diagnóstico: lo que el cliente lee. Aquí no se ahorra.
  diagnosis: {
    models: chain('MODEL_DIAGNOSIS', 'gpt-5', 'gpt-4.1'),
    maxOutputTokens: 9000,
    webSearch: false,
    temperature: null,
    budgetTokens: 60_000,
  },

  // Ángulos y copy del CMO.
  angles: {
    models: chain('MODEL_ANGLES', 'gpt-5-mini', 'gpt-4.1-mini'),
    maxOutputTokens: 4000,
    webSearch: false,
    temperature: 0.8,
    budgetTokens: 20_000,
  },

  // Clasificación de respuestas inbound. Volumen alto, decisión simple.
  classify: {
    models: chain('MODEL_CLASSIFY', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4.1-mini'),
    maxOutputTokens: 500,
    webSearch: false,
    temperature: 0,
    budgetTokens: 4_000,
  },
};

/**
 * Precios USD por millón de tokens, para calcular `cost_usd` en `agent_runs`.
 * Son aproximados a propósito: sirven para detectar una corrida que se fue de
 * precio, no para conciliar la factura de OpenAI.
 */
export const PRICING_PER_MTOK: Record<string, { in: number; out: number }> = {
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
};

const DEFAULT_PRICE = { in: 1, out: 5 };

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const price = PRICING_PER_MTOK[model] ?? DEFAULT_PRICE;
  const cost = (tokensIn * price.in + tokensOut * price.out) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

/** Tope de costo por diagnóstico completo (PRD §11: <$1,20). Alerta, no bloqueo. */
export const COST_ALERT_USD_PER_DIAGNOSTIC = 1.2;

/** Tope duro por sesión anónima (PRD §10: costo del research por visitante). */
export const COST_HARD_CAP_USD_PER_SESSION = 3.0;
