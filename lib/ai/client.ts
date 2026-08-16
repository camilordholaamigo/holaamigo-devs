import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { env } from '@/lib/env';
import { db, tryWrite } from '@/lib/supabase/admin';
import { trace } from '@/lib/traces/record';
import {
  routeFor,
  paramsFor,
  estimateCost,
  type StepConfig,
  type StepName,
} from '@/config/models';

/**
 * Envoltura única sobre la Responses API de OpenAI.
 *
 * Todo lo que un agente le pide al modelo pasa por aquí, y aquí pasan cuatro
 * cosas que no queremos repetir en cada llamada:
 *
 *  1. Salida estructurada validada con Zod (PRD §8.4). Nunca se renderiza
 *     JSON sin validar.
 *  2. Cadena de fallback de modelos. Un nombre de modelo retirado degrada
 *     calidad, no disponibilidad.
 *  3. Reintento ante salida inválida; a la tercera se degrada a un esquema
 *     mínimo si el llamador lo ofrece.
 *  4. Registro en `agent_runs` con modelo, tokens, costo y duración. Sin esto
 *     no podemos responder "¿cuánto nos costó este diagnóstico?".
 *
 * Ver docs/wiki/03-agentes.md
 */

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env.openaiApiKey, maxRetries: 2, timeout: 150_000 });
  }
  return client;
}

export interface RunOptions<T> {
  step: StepName;
  /** Nombre del esquema. Va al API y a los logs. snake_case. */
  schemaName: string;
  schema: z.ZodType<T>;
  /** Instrucciones de sistema: quién es el agente y qué no puede hacer. */
  system: string;
  /** El contenido concreto de esta corrida. */
  input: string;
  /** Contexto de trazabilidad. */
  organizationId?: string | null;
  agentId?: string | null;
  role?: 'president' | 'cmo' | 'sales' | null;
  trigger?: string;
  /**
   * Corrida a la que pertenece este paso (P1 · el sustrato).
   *
   * Sin `runId` la llamada se registra igual en `agent_runs`, pero no deja
   * traza — y sin traza no hay costo por corrida, así que la decisión que salga
   * de este paso se queda sin costo imputado. Todo camino que produzca una
   * decisión tiene que pasar un `runId`.
   */
  runId?: string | null;
  /**
   * Fallback si el esquema principal falla dos veces. Puede tener otra forma:
   * `inflate` la lleva de vuelta a `T` para que el llamador no bifurque.
   */
  degradeTo?: {
    schema: z.ZodType<unknown>;
    schemaName: string;
    inflate: (value: never) => T;
  } | null;
  /** Sobrescribe el uso de web search del paso. */
  webSearch?: boolean;
}

export interface RunResult<T> {
  data: T;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  degraded: boolean;
  /** URLs citadas por web_search, si el paso las usó. */
  citations: { url: string; title: string }[];
}

class ModelUnavailableError extends Error {}

/** ¿El error dice "ese modelo no existe / no tienes acceso"? */
function isModelUnavailable(err: unknown): boolean {
  const anyErr = err as { status?: number; code?: string; message?: string };
  if (anyErr?.code === 'model_not_found') return true;
  if (anyErr?.status === 404) return true;
  const msg = (anyErr?.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('do not have access');
}

function isToolUnsupported(err: unknown): boolean {
  const msg = ((err as { message?: string })?.message ?? '').toLowerCase();
  return msg.includes('web_search') && (msg.includes('unsupported') || msg.includes('invalid'));
}

/**
 * ¿El 400 dice "ese parámetro no va con este modelo"?
 *
 * Pasa con `temperature` en la familia gpt-5 y con `reasoning` en los modelos
 * clásicos. `paramsFor()` ya evita el caso conocido; esto cubre el desconocido:
 * un modelo nuevo que el admin escriba en el formulario y que no encaje en
 * ninguna de las dos familias. Sin este camino, un nombre de modelo bien
 * escrito pero de otra familia mata el paso entero — y no como
 * `model_not_found`, así que la cadena de fallback tampoco lo salvaría.
 */
function unsupportedParam(err: unknown): 'temperature' | 'reasoning' | null {
  const anyErr = err as { status?: number; message?: string; param?: string };
  if (anyErr?.status !== 400) return null;
  const haystack = `${anyErr.param ?? ''} ${anyErr.message ?? ''}`.toLowerCase();
  if (!/unsupported|not supported|unknown parameter|does not support/.test(haystack)) return null;
  if (haystack.includes('temperature')) return 'temperature';
  if (haystack.includes('reasoning')) return 'reasoning';
  return null;
}

interface RawCall {
  text: string;
  tokensIn: number;
  tokensOut: number;
  citations: { url: string; title: string }[];
  /** `max_output_tokens` alcanzado: el modelo se quedó sin presupuesto. */
  truncated: boolean;
}

interface CallShape {
  useWebSearch: boolean;
  webSearchType: 'web_search' | 'web_search_preview';
  /** Parámetros que un 400 previo nos dijo que este modelo no acepta. */
  drop: Set<'temperature' | 'reasoning'>;
}

async function callOnce(
  model: string,
  opts: RunOptions<unknown>,
  route: StepConfig,
  schema: z.ZodType<unknown>,
  schemaName: string,
  shape: CallShape,
): Promise<RawCall> {
  const params = paramsFor(model, route);

  const body: Record<string, unknown> = {
    model,
    instructions: opts.system,
    input: opts.input,
    max_output_tokens: route.maxOutputTokens,
    text: { format: zodTextFormat(schema, schemaName) },
  };

  if (params.temperature !== null && !shape.drop.has('temperature')) {
    body.temperature = params.temperature;
  }
  if (params.reasoningEffort !== null && !shape.drop.has('reasoning')) {
    body.reasoning = { effort: params.reasoningEffort };
  }
  if (shape.useWebSearch) body.tools = [{ type: shape.webSearchType }];

  // El body se arma dinámicamente (temperature, reasoning y tools son
  // condicionales), así que lo tipamos en el borde en vez de pelear con la
  // unión del SDK.
  const create = openai().responses.create.bind(openai().responses) as (
    b: Record<string, unknown>,
  ) => Promise<unknown>;
  const response = await create(body);

  const res = response as {
    output_text?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
    output?: Array<{
      type: string;
      content?: Array<{
        type: string;
        text?: string;
        annotations?: Array<{ type: string; url?: string; title?: string }>;
      }>;
    }>;
  };

  const citations: { url: string; title: string }[] = [];
  for (const item of res.output ?? []) {
    for (const part of item.content ?? []) {
      for (const ann of part.annotations ?? []) {
        if (ann.type === 'url_citation' && ann.url) {
          citations.push({ url: ann.url, title: ann.title ?? ann.url });
        }
      }
    }
  }

  return {
    text: res.output_text ?? '',
    tokensIn: res.usage?.input_tokens ?? 0,
    tokensOut: res.usage?.output_tokens ?? 0,
    citations,
    truncated:
      res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens',
  };
}

export async function runStructured<T>(opts: RunOptions<T>): Promise<RunResult<T>> {
  // Se resuelve una sola vez por corrida: si el admin cambia el modelo a mitad
  // de un diagnóstico, esa corrida termina con el que empezó. Cambiar de modelo
  // entre el intento 1 y el 2 haría imposible leer los logs.
  const route = await routeFor(opts.step);
  const startedAt = Date.now();

  let tokensIn = 0;
  let tokensOut = 0;
  let lastError: unknown = null;
  const shape: CallShape = {
    useWebSearch: opts.webSearch ?? route.webSearch,
    webSearchType: 'web_search',
    drop: new Set(),
  };

  // Dos intentos con el esquema pedido; si el llamador ofrece uno degradado,
  // un tercero con ese. Cada intento puede rotar de modelo por indisponibilidad.
  const identity = (value: unknown) => value as T;
  const attempts: Array<{
    schema: z.ZodType<unknown>;
    name: string;
    degraded: boolean;
    inflate: (value: unknown) => T;
  }> = [
    { schema: opts.schema, name: opts.schemaName, degraded: false, inflate: identity },
    { schema: opts.schema, name: opts.schemaName, degraded: false, inflate: identity },
  ];
  if (opts.degradeTo) {
    const { schema, schemaName, inflate } = opts.degradeTo;
    attempts.push({
      schema,
      name: schemaName,
      degraded: true,
      inflate: (value: unknown) => inflate(value as never),
    });
  }

  for (const attempt of attempts) {
    for (const model of route.models) {
      try {
        const call = () =>
          callOnce(
            model,
            opts as unknown as RunOptions<unknown>,
            route,
            attempt.schema,
            attempt.name,
            shape,
          );

        let raw: RawCall;
        try {
          raw = await call();
        } catch (err) {
          const dropped = unsupportedParam(err);
          if (dropped && !shape.drop.has(dropped)) {
            // El modelo no acepta ese parámetro. Se anota para el resto de la
            // corrida y se reintenta sin él, en vez de dar el paso por perdido.
            shape.drop.add(dropped);
            raw = await call();
          } else if (
            shape.useWebSearch &&
            shape.webSearchType === 'web_search' &&
            isToolUnsupported(err)
          ) {
            // Cuenta antigua: el tool se llama distinto. Reintentamos una vez.
            shape.webSearchType = 'web_search_preview';
            raw = await call();
          } else if (isModelUnavailable(err)) {
            throw new ModelUnavailableError(String((err as Error)?.message ?? err));
          } else {
            throw err;
          }
        }

        tokensIn += raw.tokensIn;
        tokensOut += raw.tokensOut;

        if (raw.truncated || !raw.text.trim()) {
          // Casi siempre es un modelo de razonamiento que gastó el presupuesto
          // pensando y no alcanzó a escribir. El mensaje lo dice explícito
          // porque desde afuera se ve idéntico a un fallo de esquema, y así se
          // perdieron horas: la solución es subir maxOutputTokens o bajar el
          // esfuerzo en /admin/modelos, no tocar el esquema.
          lastError = new Error(
            `${model} devolvió una respuesta vacía o cortada con max_output_tokens=${route.maxOutputTokens}. ` +
              'Sube el tope de tokens o baja el esfuerzo de razonamiento en /admin/modelos.',
          );
          break; // mismo modelo, siguiente intento del bucle externo
        }

        let payload: unknown;
        try {
          payload = JSON.parse(raw.text);
        } catch {
          lastError = new Error(`${model} devolvió algo que no es JSON: ${raw.text.slice(0, 200)}`);
          break;
        }

        const parsed = attempt.schema.safeParse(payload);
        if (!parsed.success) {
          lastError = new Error(
            `salida inválida contra ${attempt.name}: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(' · ')}`,
          );
          break; // mismo modelo, siguiente intento del bucle externo
        }

        const value = attempt.inflate(parsed.data);
        const durationMs = Date.now() - startedAt;
        const costUsd = estimateCost(model, tokensIn, tokensOut);

        await logRun(opts, {
          model,
          tokensIn,
          tokensOut,
          costUsd,
          durationMs,
          status: attempt.degraded ? 'degraded' : 'ok',
          error: attempt.degraded ? `degradado a ${attempt.name}` : null,
          output: value,
        });

        return {
          data: value,
          model,
          tokensIn,
          tokensOut,
          costUsd,
          durationMs,
          degraded: attempt.degraded,
          citations: raw.citations,
        };
      } catch (err) {
        lastError = err;
        if (err instanceof ModelUnavailableError) continue; // probar el siguiente modelo
        break; // error real: no rotar modelo, reintentar el paso
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await logRun(opts, {
    model: route.models[0],
    tokensIn,
    tokensOut,
    costUsd: estimateCost(route.models[0], tokensIn, tokensOut),
    durationMs,
    status: 'failed',
    error: message,
    output: null,
  });

  throw new Error(`[ai:${opts.step}] ${message}`);
}

type AnyRunOptions = Omit<RunOptions<unknown>, 'schema' | 'degradeTo'>;

async function logRun(
  opts: AnyRunOptions,
  result: {
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    durationMs: number;
    status: 'ok' | 'failed' | 'degraded' | 'escalated';
    error: string | null;
    output: unknown;
  },
): Promise<void> {
  // `tryWrite` y no `mustWrite`: el log nunca debe tumbar la corrida real, pero
  // tampoco puede desaparecer sin dejar rastro — sin `agent_runs` no se puede
  // responder "¿cuánto costó este diagnóstico?".
  await tryWrite(
    db()
      .from('agent_runs')
      .insert({
        agent_id: opts.agentId ?? null,
        organization_id: opts.organizationId ?? null,
        role: opts.role ?? null,
        step: opts.step,
        trigger: opts.trigger ?? 'intake',
        input: { system: opts.system.slice(0, 2000), input: opts.input.slice(0, 8000) },
        output: result.output ?? null,
        model: result.model,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        status: result.status,
        error: result.error,
      }),
    'agent_runs.insert',
  );

  // La misma llamada, en la capa de abajo. `agent_runs` responde "¿cuánto costó
  // este diagnóstico?"; `traces` responde "¿qué pasó adentro de esta corrida y
  // cuánto le toca a cada decisión que salió de ella?". No es duplicación: son
  // dos preguntas distintas con dos vidas distintas — las trazas se purgan a
  // los 90 días, `agent_runs` no.
  if (opts.runId) {
    await trace({
      organizationId: opts.organizationId ?? null,
      agentId: opts.agentId ?? null,
      role: opts.role ?? null,
      runId: opts.runId,
      stepType: result.status === 'failed' ? 'error' : 'output',
      name: opts.step,
      input: { system: opts.system.slice(0, 2000), input: opts.input.slice(0, 8000) },
      output: result.status === 'failed' ? { error: result.error } : result.output,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    });
  }
}

/** Gasto acumulado de IA de una organización, para el tope por sesión (§10). */
export async function spentUsd(organizationId: string): Promise<number> {
  const { data } = await db()
    .from('agent_runs')
    .select('cost_usd')
    .eq('organization_id', organizationId);
  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
}
