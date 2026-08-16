import { db, mustWrite, tryWrite, unwrap } from '@/lib/supabase/admin';

/**
 * HubSpot: traer los contactos del cliente sin meterlos a operación.
 *
 * El flujo completo:
 *
 *   conectar → descubrir propiedades → mapear → sync incremental con cursor
 *   → staging → (lote de análisis) → leads
 *
 * **El paso que falta a propósito es el último.** Los contactos aterrizan en
 * `staging_contacts` y no entran a operación hasta que se corra un lote de
 * análisis. Es deliberado por dos razones: obliga a pasar por el paso que paga,
 * y evita que 8.000 contactos crudos y sin segmentar aparezcan como si fueran
 * leads trabajables — que es la forma más rápida de que un cliente mande una
 * campaña a gente que no debía.
 *
 * LA CREDENCIAL NO SE GUARDA EN LA TABLA. `credentials_ref` guarda el nombre de
 * la variable de entorno donde está el token. Una tabla con tokens de HubSpot
 * en texto plano es una fuga esperando a que alguien haga un `select *` durante
 * un soporte.
 *
 * Ver docs/wiki/20-integraciones-crm-y-habilidades.md
 */

const API = 'https://api.hubapi.com';

export interface Integracion {
  id: string;
  organization_id: string;
  provider: string;
  status: string;
  credentials_ref: string | null;
  config: { mapping?: Record<string, string>; portal_id?: string };
  cursor: string | null;
  last_sync_at: string | null;
  last_error: string | null;
}

export async function conectar(args: {
  organizationId: string;
  credentialsRef: string;
  by: string;
}): Promise<string> {
  const row = unwrap(
    await db()
      .from('integrations')
      .upsert(
        {
          organization_id: args.organizationId,
          provider: 'hubspot',
          status: 'connected',
          credentials_ref: args.credentialsRef,
          connected_by: args.by,
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,provider' },
      )
      .select('id')
      .single(),
    'integrations.hubspot',
  ) as { id: string };

  return row.id;
}

export async function integracion(
  organizationId: string,
  provider = 'hubspot',
): Promise<Integracion | null> {
  const { data } = await db()
    .from('integrations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .maybeSingle();
  return (data as Integracion | null) ?? null;
}

/** El token, del entorno. Nunca de la base. */
function token(ref: string | null): string | null {
  if (!ref) return null;
  return process.env[ref] ?? null;
}

/**
 * El mapeo por defecto.
 *
 * HubSpot nombra sus propiedades igual para todos, así que el mapeo base es
 * fijo y no requiere modelo. `COLUMN_MAPPING_SYSTEM` está para archivos subidos
 * a mano, donde cada cliente inventa sus encabezados; gastar una llamada de IA
 * en adivinar que `firstname` es el nombre sería pagar por saber lo que ya
 * sabemos.
 */
const MAPEO_HUBSPOT: Record<string, string> = {
  full_name: 'firstname lastname',
  email: 'email',
  phone_e164: 'phone',
  company: 'company',
  title: 'jobtitle',
  last_interaction_at: 'notes_last_contacted',
};

interface ContactoHubSpot {
  id: string;
  properties: Record<string, string | null>;
}

/**
 * Trae contactos a staging. Incremental por cursor.
 *
 * Si no hay token —el caso normal hasta que un cliente conecte de verdad—
 * devuelve cero sin error. Una integración sin credenciales no es un fallo:
 * es una integración sin credenciales, y tratarla como error llena el log de
 * ruido en cada corrida del cron.
 */
export async function sincronizar(args: {
  organizationId: string;
  limite?: number;
}): Promise<{ traidos: number; total: number; cursor: string | null; motivo?: string }> {
  const integ = await integracion(args.organizationId);
  if (!integ) return { traidos: 0, total: 0, cursor: null, motivo: 'sin integración de HubSpot' };

  const auth = token(integ.credentials_ref);
  if (!auth) {
    return { traidos: 0, total: 0, cursor: integ.cursor, motivo: 'sin credencial configurada' };
  }

  const limite = Math.min(100, args.limite ?? 100);
  const propiedades = [...new Set(Object.values(MAPEO_HUBSPOT).flatMap((p) => p.split(' ')))];

  const url = new URL(`${API}/crm/v3/objects/contacts`);
  url.searchParams.set('limit', String(limite));
  url.searchParams.set('properties', propiedades.join(','));
  if (integ.cursor) url.searchParams.set('after', integ.cursor);

  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${auth}` } });
    if (!res.ok) {
      await db()
        .from('integrations')
        .update({ status: 'error', last_error: `HTTP ${res.status}` })
        .eq('id', integ.id);
      return { traidos: 0, total: 0, cursor: integ.cursor, motivo: `HubSpot respondió ${res.status}` };
    }

    const payload = (await res.json()) as {
      results?: ContactoHubSpot[];
      paging?: { next?: { after?: string } };
    };

    const contactos = payload.results ?? [];
    const traidos = await guardarEnStaging({
      organizationId: args.organizationId,
      integrationId: integ.id,
      contactos,
    });

    const siguiente = payload.paging?.next?.after ?? null;

    await db()
      .from('integrations')
      .update({
        cursor: siguiente,
        last_sync_at: new Date().toISOString(),
        status: siguiente ? 'syncing' : 'connected',
        last_error: null,
      })
      .eq('id', integ.id);

    const { count } = await db()
      .from('staging_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', args.organizationId)
      .eq('status', 'staged');

    return { traidos, total: count ?? 0, cursor: siguiente };
  } catch (err) {
    await db()
      .from('integrations')
      .update({ status: 'error', last_error: String(err) })
      .eq('id', integ.id);
    return { traidos: 0, total: 0, cursor: integ.cursor, motivo: String(err) };
  }
}

/**
 * Normaliza y guarda. El upsert por id externo es lo que hace que reimportar
 * sea seguro: sin él, tres corridas del cron triplican la base.
 */
async function guardarEnStaging(args: {
  organizationId: string;
  integrationId: string;
  contactos: ContactoHubSpot[];
}): Promise<number> {
  if (args.contactos.length === 0) return 0;

  const filas = args.contactos.map((c) => {
    const p = c.properties ?? {};
    const nombre = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
    return {
      organization_id: args.organizationId,
      integration_id: args.integrationId,
      external_id: c.id,
      raw: p,
      mapped: {
        full_name: nombre || null,
        email: p.email?.toLowerCase() ?? null,
        phone_e164: p.phone ?? null,
        company: p.company ?? null,
        title: p.jobtitle ?? null,
        last_interaction_at: p.notes_last_contacted ?? null,
      },
    };
  });

  const ok = await tryWrite(
    db()
      .from('staging_contacts')
      .upsert(filas, { onConflict: 'organization_id,integration_id,external_id' }),
    'staging_contacts.upsert',
  );

  return ok ? filas.length : 0;
}

/** Cuánto hay esperando análisis, y qué tan viejo es. */
export async function resumenDeStaging(organizationId: string): Promise<{
  total: number;
  con_email: number;
  con_interaccion_reciente: number;
}> {
  const { data } = await db()
    .from('staging_contacts')
    .select('mapped')
    .eq('organization_id', organizationId)
    .eq('status', 'staged')
    .limit(20_000);

  const filas = (data ?? []) as Array<{ mapped: Record<string, string | null> }>;
  const hace18Meses = Date.now() - 548 * 86_400_000;

  return {
    total: filas.length,
    con_email: filas.filter((f) => f.mapped?.email).length,
    con_interaccion_reciente: filas.filter((f) => {
      const fecha = f.mapped?.last_interaction_at;
      if (!fecha) return false;
      const t = new Date(fecha).getTime();
      return Number.isFinite(t) && t > hace18Meses;
    }).length,
  };
}

/** Promueve a `leads` lo que el lote ya analizó. */
export async function promoverAnalizados(
  organizationId: string,
  batchId: string,
): Promise<number> {
  const { data } = await db()
    .from('staging_contacts')
    .select('id, mapped, analysis')
    .eq('organization_id', organizationId)
    .eq('batch_id', batchId)
    .eq('status', 'analyzed')
    .limit(5000);

  const filas = (data ?? []) as Array<{
    id: string;
    mapped: Record<string, string | null>;
    analysis: Record<string, unknown>;
  }>;

  let promovidos = 0;

  for (let i = 0; i < filas.length; i += 500) {
    const lote = filas.slice(i, i + 500);
    const ok = await tryWrite(
      db()
        .from('leads')
        .upsert(
          lote.map((f) => ({
            organization_id: organizationId,
            full_name: f.mapped.full_name,
            email: f.mapped.email,
            phone_e164: f.mapped.phone_e164,
            company: f.mapped.company,
            title: f.mapped.title,
            last_interaction_at: f.mapped.last_interaction_at,
            temperature: (f.analysis?.temperatura as string) ?? 'cold',
            segment: (f.analysis?.segmento as string) ?? null,
            status: 'new',
            enrichment: { fuente: 'hubspot', analisis: f.analysis },
          })),
          // `leads_identity_key` es un índice de EXPRESIÓN sobre
          // `coalesce(email, phone)`, así que NO puede arbitrar un upsert
          // (ADR 0015). Se usa `ignoreDuplicates` para que el índice actúe como
          // red de seguridad y los duplicados se descarten sin romper el lote.
          { onConflict: 'organization_id,email', ignoreDuplicates: true },
        ),
      'leads.promote',
    );
    if (ok) promovidos += lote.length;
  }

  await db()
    .from('staging_contacts')
    .update({ status: 'promoted' })
    .eq('batch_id', batchId)
    .eq('status', 'analyzed');

  return promovidos;
}

export async function desconectar(organizationId: string): Promise<void> {
  await mustWrite(
    db()
      .from('integrations')
      .update({ status: 'revoked', credentials_ref: null, cursor: null })
      .eq('organization_id', organizationId)
      .eq('provider', 'hubspot'),
    'integrations.revoke',
  );
}
