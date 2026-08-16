import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { normalizeEmail } from '@/lib/utils';
import { normalizePhone, persistBatch, summarize, type NormalizedLead } from '@/lib/leads/ingest';

/**
 * Instantly: fuente de datos, NO motor de envío (ADR 0009).
 *
 * Traemos sus listas y sus leads a nuestra base; el envío, la secuencia, la
 * clasificación de respuestas y la medición se quedan acá. Es la decisión más
 * importante de este archivo y va contra el camino fácil, que sería lanzar sus
 * campañas por API y leer los resultados.
 *
 * Por qué: si la campaña corre allá, la unidad económica vive allá. El
 * agendamiento, la venta atribuida y el cobro por resultado —que es todo el
 * modelo de negocio— dependen de que la conversión pase por una superficie
 * nuestra. Además, un cliente que quiera irse se lleva la operación completa
 * apagando una integración.
 *
 * Sobre la API: Instantly cambió de v1 a v2 y la documentación se mueve. Todo
 * lo que se lee acá se valida defensivamente y se guarda crudo en `meta`: si
 * cambian un campo, importamos de menos, no reventamos.
 */

const API = 'https://api.instantly.ai/api/v2';

async function keyFor(organizationId: string): Promise<string | null> {
  const { data } = await db()
    .from('integrations')
    .select('credentials, status')
    .eq('organization_id', organizationId)
    .eq('provider', 'instantly')
    .maybeSingle();

  const own = (data?.credentials as { api_key?: string } | null)?.api_key;
  if (own) return own;
  return env.instantlyApiKey || null;
}

async function call<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, data: null, error: `http_${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, data: null, error: String(err) };
  }
}

export async function connectInstantly(args: {
  organizationId: string;
  apiKey: string;
}): Promise<{ ok: boolean; error?: string; lists?: number }> {
  const probe = await call<{ items?: unknown[] }>(args.apiKey, '/lead-lists?limit=1');

  await db()
    .from('integrations')
    .upsert(
      {
        organization_id: args.organizationId,
        provider: 'instantly',
        status: probe.ok ? 'connected' : 'failed',
        credentials: { api_key: args.apiKey },
        connected_at: probe.ok ? new Date().toISOString() : null,
        last_error: probe.ok ? null : (probe.error ?? 'no se pudo verificar la clave'),
      },
      { onConflict: 'organization_id,provider' },
    );

  return probe.ok
    ? { ok: true, lists: (probe.data?.items ?? []).length }
    : { ok: false, error: probe.error };
}

export interface InstantlyList {
  id: string;
  name: string;
  count: number | null;
}

export async function listLeadLists(organizationId: string): Promise<InstantlyList[]> {
  const apiKey = await keyFor(organizationId);
  if (!apiKey) return [];

  const res = await call<{ items?: Record<string, unknown>[] }>(apiKey, '/lead-lists?limit=100');
  if (!res.ok) {
    await db()
      .from('integrations')
      .update({ last_error: res.error })
      .eq('organization_id', organizationId)
      .eq('provider', 'instantly');
    return [];
  }

  return (res.data?.items ?? []).map((item) => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? 'lista sin nombre'),
    count: typeof item.leads_count === 'number' ? item.leads_count : null,
  }));
}

interface InstantlyLead {
  email?: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone?: string;
  title?: string;
  payload?: Record<string, unknown>;
}

/** Trae los leads de una lista, paginando. El tope de 20.000 es el mismo que
 *  el de la carga por archivo: por encima de eso hablamos antes de importar. */
async function fetchLeads(
  apiKey: string,
  listId: string,
  max = 20_000,
): Promise<{ leads: InstantlyLead[]; error?: string }> {
  const leads: InstantlyLead[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 200 && leads.length < max; page += 1) {
    const res: { ok: boolean; data: { items?: InstantlyLead[]; next_starting_after?: string } | null; error?: string } =
      await call(apiKey, '/leads/list', {
        method: 'POST',
        body: JSON.stringify({
          list_id: listId,
          limit: 100,
          ...(cursor ? { starting_after: cursor } : {}),
        }),
      });

    if (!res.ok) return { leads, error: res.error };

    const items = res.data?.items ?? [];
    leads.push(...items);

    cursor = res.data?.next_starting_after ?? null;
    if (!cursor || items.length === 0) break;
  }

  return { leads };
}

export async function importList(args: {
  organizationId: string;
  listId: string;
  listName: string;
  consentBasis: string;
  consentIp: string | null;
  country?: string | null;
}): Promise<{ ok: boolean; imported?: number; error?: string; batchId?: string }> {
  const apiKey = await keyFor(args.organizationId);
  if (!apiKey) return { ok: false, error: 'Instantly no está conectado.' };

  const { leads: raw, error } = await fetchLeads(apiKey, args.listId);
  if (error && raw.length === 0) return { ok: false, error };

  const seen = new Set<string>();
  const normalized: NormalizedLead[] = [];
  let invalid = 0;
  let duplicates = 0;

  for (const lead of raw) {
    const email = normalizeEmail(lead.email);
    if (!email) {
      invalid += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);

    const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();

    normalized.push({
      full_name: fullName || null,
      email,
      phone_e164: lead.phone ? normalizePhone(lead.phone, args.country ?? null) : null,
      company: lead.company_name ?? null,
      title: lead.title ?? null,
      // Instantly no trae historia de interacción con el cliente: son
      // prospectos, no su base. Entran como fríos y eso los manda al playbook
      // de conquista, que exige calentamiento. Marcarlos tibios sería mentir
      // sobre la temperatura y saltarse la única salvaguarda de reputación.
      last_interaction_at: null,
      temperature: 'cold',
      segment: 'prospeccion_instantly',
    });
  }

  // `summarize` está escrito para archivos: le pasamos una forma equivalente
  // con tantas filas como leads trajo el API, para que `raw_count` cuadre.
  const preview = summarize(
    { headers: [], rows: new Array(raw.length).fill([]) },
    normalized,
    invalid,
    duplicates,
    { full_name: 'name', email: 'email', phone: 'phone', company: 'company_name', title: 'title', last_interaction: null },
    args.country ?? null,
    [`Importado de Instantly · lista "${args.listName}"`],
  );

  const result = await persistBatch({
    organizationId: args.organizationId,
    filename: `instantly: ${args.listName}`,
    consentBasis: args.consentBasis,
    consentIp: args.consentIp,
    mapping: preview.mapping,
    preview,
    leads: normalized,
    source: 'instantly',
  });

  await db()
    .from('integrations')
    .update({ last_sync_at: new Date().toISOString(), last_error: error ?? null })
    .eq('organization_id', args.organizationId)
    .eq('provider', 'instantly');

  return { ok: true, imported: result.inserted, batchId: result.batchId };
}

export async function instantlyStatus(organizationId: string) {
  const { data } = await db()
    .from('integrations')
    .select('status, connected_at, last_sync_at, last_error, meta')
    .eq('organization_id', organizationId)
    .eq('provider', 'instantly')
    .maybeSingle();
  return data;
}
