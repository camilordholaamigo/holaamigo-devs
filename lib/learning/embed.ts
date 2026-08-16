import OpenAI from 'openai';
import { env, hasOpenAI } from '@/lib/env';

/**
 * Vectores para recuperar lecciones por similitud.
 *
 * Tres decisiones que vale la pena explicar:
 *
 *  1. **El vector se guarda en `jsonb`, no en pgvector.** El proyecto de
 *     Supabase es compartido con Rentmies (producción) y una extensión es un
 *     objeto de base de datos, no de schema. Con cientos de lecciones por
 *     organización, el coseno en TypeScript es más barato que la conversación
 *     sobre instalar una extensión en una base ajena.
 *     Ver docs/adr/0017-lecciones-sin-pgvector.md
 *
 *  2. **Degrada, no rompe.** Si no hay API key o la llamada falla, devuelve
 *     `null` y la recuperación cae a solape de palabras. Una lección recuperada
 *     con un método peor sigue siendo mejor que una corrida caída.
 *
 *  3. **`text-embedding-3-small`, 1536 dimensiones.** Es 6 veces más barato que
 *     el grande y la diferencia no se nota en frases de una línea, que es lo
 *     único que embebemos.
 */

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: env.openaiApiKey, maxRetries: 1, timeout: 20_000 });
  return client;
}

export async function embed(text: string): Promise<number[] | null> {
  if (!hasOpenAI() || !text.trim()) return null;
  try {
    const response = await openai().embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8_000),
    });
    return response.data[0]?.embedding ?? null;
  } catch (err) {
    console.error('[learning:embed] no se pudo calcular el vector', err);
    return null;
  }
}

export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  if (!hasOpenAI() || texts.length === 0) return texts.map(() => null);
  try {
    const response = await openai().embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts.map((t) => t.slice(0, 8_000)),
    });
    return texts.map((_, i) => response.data[i]?.embedding ?? null);
  } catch (err) {
    console.error('[learning:embed] lote fallido', err);
    return texts.map(() => null);
  }
}

/** Coseno. Devuelve 0 si alguno de los dos no existe o no coinciden las dimensiones. */
export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const VACIAS = new Set([
  'de','la','el','los','las','en','y','a','que','con','para','por','un','una','del','al','se','es',
  'su','sus','lo','más','como','sobre','este','esta','ese','esa','no','sí','the','of','to','and','in',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !VACIAS.has(w)),
  );
}

/**
 * Similitud de respaldo: Jaccard sobre palabras, sin acentos ni vacías.
 *
 * Existe para el caso sin embeddings (sin API key, o lección recién destilada a
 * la que todavía no le corrió el job de vectores). Es peor que el coseno y da
 * igual: el orden aproximado de 6 lecciones es suficiente para el bloque de
 * contexto, y lo alternativo es no inyectar nada.
 */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}
