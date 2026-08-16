import { readSetting } from '@/lib/settings';

/**
 * Ruteo de modelos por paso (PRD §8.2).
 *
 * Tres reglas de diseño:
 *
 *  1. **Cadena de fallback.** Cada paso declara una lista de modelos y se
 *     intentan en orden. Si OpenAI responde `model_not_found` (nombre
 *     retirado, cuenta sin acceso), se baja al siguiente en vez de reventar la
 *     corrida. Un modelo mal escrito degrada calidad, nunca disponibilidad.
 *
 *  2. **Configurable en caliente.** Precedencia: tabla `settings` (editable en
 *     `/admin/modelos`) → variable de entorno → default de este archivo.
 *     Cambiar de modelo no exige desplegar ni tocar Vercel.
 *     Ver docs/adr/0014-configuracion-en-caliente.md
 *
 *  3. **Los parámetros dependen de la familia del modelo.** Los modelos de
 *     razonamiento (gpt-5*, o1, o3, o4) RECHAZAN `temperature` con un 400, y
 *     su `max_output_tokens` incluye los tokens de razonamiento invisibles. Si
 *     se les manda el presupuesto de un modelo clásico, contestan vacío. Eso lo
 *     resuelve `paramsFor()`, no cada llamador.
 *
 * Ver docs/wiki/03-agentes.md §"Ruteo de modelos"
 */

export type StepName =
  | 'research'
  | 'extract'
  | 'adaptive_question'
  | 'diagnosis'
  | 'angles'
  | 'classify';

export const STEP_NAMES: StepName[] = [
  'research',
  'extract',
  'adaptive_question',
  'diagnosis',
  'angles',
  'classify',
];

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface StepConfig {
  /** Cadena de modelos: se intenta en orden. */
  models: string[];
  /** Tope duro de tokens de salida. En modelos de razonamiento incluye el
   *  razonamiento invisible, por eso los números son más altos de lo que el
   *  texto final sugiere. */
  maxOutputTokens: number;
  /** Si el paso puede buscar en la web. */
  webSearch: boolean;
  /** Temperatura para modelos que la aceptan. `null` = no enviarla nunca. */
  temperature: number | null;
  /** Esfuerzo de razonamiento para los modelos que lo soportan. */
  reasoningEffort: ReasoningEffort;
  /** Presupuesto informativo para logs y alertas de costo. */
  budgetTokens: number;
}

/** Etiquetas para el admin. El texto explica en qué se nota subir el modelo. */
export const STEP_LABELS: Record<StepName, { title: string; detail: string }> = {
  research: {
    title: 'Investigación del sitio',
    detail: 'Lee el sitio del cliente y busca competidores. Es el paso más caro y el único con búsqueda web.',
  },
  extract: {
    title: 'Extracción a JSON',
    detail: 'Pasa los hallazgos crudos a estructura. Mecánico: subir el modelo casi no se nota.',
  },
  adaptive_question: {
    title: 'Preguntas adaptativas del quiz',
    detail: 'Corre entre pantallas del quiz, con el cliente esperando. La velocidad importa más que la profundidad.',
  },
  diagnosis: {
    title: 'Diagnóstico (lo que el cliente lee)',
    detail: 'La síntesis del President. Es el texto que decide si el cliente confía o no. Acá es donde subir el modelo se nota.',
  },
  angles: {
    title: 'Ángulos y copy del CMO',
    detail: 'Redacción de campañas. Se revisa antes de enviarse, así que un modelo barato es defendible.',
  },
  classify: {
    title: 'Clasificación de respuestas',
    detail: 'Decide qué es cada correo entrante. Volumen alto, decisión simple, el modelo más barato basta.',
  },
};

function chain(envVar: string, ...defaults: string[]): string[] {
  const override = process.env[envVar];
  const list = override ? override.split(',').map((m) => m.trim()) : [];
  return [...list, ...defaults].filter(Boolean);
}

/**
 * Defaults de v2.1: TODO en la familia mini/nano.
 *
 * Decisión explícita y temporal: mientras se prueba el flujo de punta a punta,
 * cada diagnóstico completo cuesta centavos en vez de un dólar largo, y se
 * pueden correr treinta pruebas sin pensar en la factura. La calidad del texto
 * baja un escalón y el producto sigue siendo defendible porque **ninguna cifra
 * que el cliente lee sale del modelo** (ADR 0007): las fugas, la cuenta al
 * revés y los costos los calcula `lib/diagnostic/math.ts`.
 *
 * Para volver a calidad de producción no hay que desplegar: `/admin/modelos`,
 * subir `diagnosis` y `research` a `gpt-5`. Esa es toda la operación.
 */
export const DEFAULT_ROUTES: Record<StepName, StepConfig> = {
  research: {
    models: chain('MODEL_RESEARCH', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'),
    maxOutputTokens: 12_000,
    webSearch: true,
    temperature: null,
    reasoningEffort: 'low',
    budgetTokens: 120_000,
  },

  extract: {
    models: chain('MODEL_EXTRACT', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'),
    maxOutputTokens: 8_000,
    webSearch: false,
    temperature: 0.1,
    reasoningEffort: 'minimal',
    budgetTokens: 30_000,
  },

  adaptive_question: {
    // El cliente está mirando una pantalla de carga: acá la latencia es la
    // funcionalidad. `minimal` de esfuerzo y modelo pequeño.
    models: chain('MODEL_ADAPTIVE', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'),
    maxOutputTokens: 6_000,
    webSearch: false,
    temperature: 0.6,
    reasoningEffort: 'minimal',
    budgetTokens: 8_000,
  },

  diagnosis: {
    models: chain('MODEL_DIAGNOSIS', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'),
    maxOutputTokens: 16_000,
    webSearch: false,
    temperature: null,
    reasoningEffort: 'low',
    budgetTokens: 60_000,
  },

  angles: {
    models: chain('MODEL_ANGLES', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'),
    maxOutputTokens: 6_000,
    webSearch: false,
    temperature: 0.8,
    reasoningEffort: 'minimal',
    budgetTokens: 20_000,
  },

  classify: {
    models: chain('MODEL_CLASSIFY', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4o-mini'),
    maxOutputTokens: 3_000,
    webSearch: false,
    temperature: 0,
    reasoningEffort: 'minimal',
    budgetTokens: 4_000,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUCIÓN EN CALIENTE
// ═══════════════════════════════════════════════════════════════════════════

export const MODELS_SETTING_KEY = 'ai.models';

/** Lo que el admin puede sobrescribir por paso. Todo opcional. */
export interface StepOverride {
  models?: string[];
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  webSearch?: boolean;
}

const EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/** Normaliza lo que venga del formulario del admin. Nunca se confía en la
 *  forma de un JSON que vive en una tabla. */
export function sanitizeOverride(raw: unknown): StepOverride {
  const value = (raw ?? {}) as Record<string, unknown>;
  const out: StepOverride = {};

  if (Array.isArray(value.models)) {
    const models = value.models
      .map((m) => String(m).trim())
      .filter((m) => m.length > 0 && m.length <= 60)
      .slice(0, 5);
    if (models.length > 0) out.models = models;
  }

  const tokens = Number(value.maxOutputTokens);
  if (Number.isFinite(tokens) && tokens > 0) {
    out.maxOutputTokens = Math.min(64_000, Math.max(500, Math.round(tokens)));
  }

  if (EFFORTS.includes(value.reasoningEffort as ReasoningEffort)) {
    out.reasoningEffort = value.reasoningEffort as ReasoningEffort;
  }

  if (typeof value.webSearch === 'boolean') out.webSearch = value.webSearch;

  return out;
}

export type ModelOverrides = Partial<Record<StepName, StepOverride>>;

export function sanitizeOverrides(raw: unknown): ModelOverrides {
  const value = (raw ?? {}) as Record<string, unknown>;
  const out: ModelOverrides = {};
  for (const step of STEP_NAMES) {
    const override = sanitizeOverride(value[step]);
    if (Object.keys(override).length > 0) out[step] = override;
  }
  return out;
}

export async function currentOverrides(): Promise<ModelOverrides> {
  return sanitizeOverrides(await readSetting(MODELS_SETTING_KEY));
}

/**
 * La configuración vigente de un paso. Es `async` a propósito: leer la tabla es
 * lo que permite cambiar de modelo sin desplegar, y el costo (una lectura
 * cacheada 30 s) es irrelevante frente a la llamada de IA que viene después.
 */
export async function routeFor(step: StepName): Promise<StepConfig> {
  const overrides = await currentOverrides();
  return applyOverride(DEFAULT_ROUTES[step], overrides[step]);
}

export function applyOverride(base: StepConfig, override?: StepOverride): StepConfig {
  if (!override) return base;
  return {
    ...base,
    models: override.models ?? base.models,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    reasoningEffort: override.reasoningEffort ?? base.reasoningEffort,
    webSearch: override.webSearch ?? base.webSearch,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PARÁMETROS POR FAMILIA DE MODELO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ¿Es un modelo de razonamiento?
 *
 * Importa por dos cosas que rompen la corrida si se ignoran:
 *   · Rechazan `temperature` con 400 `unsupported_parameter`. No es un
 *     `model_not_found`, así que la cadena de fallback NO lo cubre: el paso
 *     muere entero.
 *   · Su `max_output_tokens` incluye los tokens de razonamiento, que no se ven
 *     en la respuesta. Con un tope bajo el modelo gasta el presupuesto pensando
 *     y devuelve `output_text` vacío, que parece un fallo de esquema y no lo es.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/i.test(model);
}

export interface CallParams {
  temperature: number | null;
  reasoningEffort: ReasoningEffort | null;
}

export function paramsFor(model: string, route: StepConfig): CallParams {
  if (isReasoningModel(model)) {
    return { temperature: null, reasoningEffort: route.reasoningEffort };
  }
  return { temperature: route.temperature, reasoningEffort: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// COSTOS
// ═══════════════════════════════════════════════════════════════════════════

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
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
};

const DEFAULT_PRICE = { in: 1, out: 5 };

export function priceOf(model: string): { in: number; out: number } {
  return PRICING_PER_MTOK[model] ?? DEFAULT_PRICE;
}

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const price = priceOf(model);
  const cost = (tokensIn * price.in + tokensOut * price.out) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

/** Tope de costo por diagnóstico completo (PRD §11: <$1,20). Alerta, no bloqueo. */
export const COST_ALERT_USD_PER_DIAGNOSTIC = 1.2;

/** Tope duro por sesión anónima (PRD §10: costo del research por visitante). */
export const COST_HARD_CAP_USD_PER_SESSION = 3.0;
