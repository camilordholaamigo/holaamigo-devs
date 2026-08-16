import { db } from '@/lib/supabase/admin';
import type { SegmentRules } from '@/config/campaigns';

/**
 * Quién entra a una campaña.
 *
 * Esto lo resuelve el código, nunca un modelo. "Los tibios que no han comprado"
 * suena a instrucción y es una ambigüedad: dos corridas del mismo prompt
 * pueden devolver audiencias distintas, y una audiencia que cambia sola es una
 * campaña que no se puede auditar ni repetir.
 *
 * Tres exclusiones que NUNCA se saltan, ni con la campaña aprobada:
 *   1. Lista de supresión global (PRD §10 · Habeas Data).
 *   2. Contactos ya suprimidos en `leads.status`.
 *   3. Contactos con un envío ya programado por otra campaña — nadie recibe
 *      dos correos nuestros el mismo día desde el mismo cliente.
 */

export interface AudienceLead {
  id: string;
  full_name: string | null;
  email: string;
  company: string | null;
  title: string | null;
  temperature: string | null;
  last_interaction_at: string | null;
}

export interface Audience {
  leads: AudienceLead[];
  total: number;
  excluded: {
    suppressed: number;
    already_scheduled: number;
    no_email: number;
  };
}

export async function resolveAudience(args: {
  organizationId: string;
  rules: SegmentRules;
  limit?: number;
}): Promise<Audience> {
  const { rules } = args;

  let query = db()
    .from('leads')
    .select('id, full_name, email, company, title, temperature, last_interaction_at, status')
    .eq('organization_id', args.organizationId)
    .not('email', 'is', null);

  if (rules.status.length > 0) query = query.in('status', rules.status);
  if (rules.temperature.length > 0) query = query.in('temperature', rules.temperature);

  const { data } = await query.limit(20_000);
  const rows = data ?? [];

  const now = Date.now();
  const withinWindow = rows.filter((lead) => {
    if (lead.status === 'suppressed') return false;
    if (rules.min_days_since_interaction === null && rules.max_days_since_interaction === null) {
      return true;
    }
    // Sin fecha de última interacción tratamos el contacto como frío total:
    // entra si la regla tiene piso (busca dormidos), no entra si tiene techo
    // (busca recientes). Adivinar una fecha sería inventar el segmento.
    if (!lead.last_interaction_at) return rules.max_days_since_interaction === null;

    const days = (now - new Date(lead.last_interaction_at).getTime()) / 86_400_000;
    if (rules.min_days_since_interaction !== null && days < rules.min_days_since_interaction) {
      return false;
    }
    if (rules.max_days_since_interaction !== null && days > rules.max_days_since_interaction) {
      return false;
    }
    return true;
  });

  const emails = withinWindow.map((lead) => (lead.email ?? '').toLowerCase()).filter(Boolean);

  const [{ data: suppressions }, { data: scheduled }] = await Promise.all([
    emails.length > 0
      ? db()
          .from('suppressions')
          .select('email')
          .eq('organization_id', args.organizationId)
          .in('email', emails)
      : Promise.resolve({ data: [] as { email: string | null }[] }),
    db()
      .from('messages')
      .select('lead_id')
      .eq('organization_id', args.organizationId)
      .in('status', ['scheduled', 'queued'])
      .limit(20_000),
  ]);

  const suppressed = new Set(
    (suppressions ?? []).map((row) => (row.email ?? '').toLowerCase()).filter(Boolean),
  );
  const busy = new Set((scheduled ?? []).map((row) => row.lead_id).filter(Boolean) as string[]);

  const excluded = { suppressed: 0, already_scheduled: 0, no_email: rows.length - withinWindow.length };
  const leads: AudienceLead[] = [];

  for (const lead of withinWindow) {
    const email = (lead.email ?? '').toLowerCase();
    if (!email) continue;
    if (suppressed.has(email)) {
      excluded.suppressed += 1;
      continue;
    }
    if (busy.has(lead.id)) {
      excluded.already_scheduled += 1;
      continue;
    }
    leads.push({
      id: lead.id,
      full_name: lead.full_name,
      email,
      company: lead.company,
      title: lead.title,
      temperature: lead.temperature,
      last_interaction_at: lead.last_interaction_at,
    });
  }

  const limited = args.limit ? leads.slice(0, args.limit) : leads;
  return { leads: limited, total: leads.length, excluded };
}

/** Conteo rápido por temperatura. Lo usa el selector de playbooks y el
 *  President para no proponer una campaña sin audiencia. */
export async function audienceSnapshot(organizationId: string): Promise<{
  total: number;
  hot: number;
  warm: number;
  cold: number;
  dead: number;
  withEmail: number;
}> {
  const { data } = await db()
    .from('leads')
    .select('temperature, email, status')
    .eq('organization_id', organizationId)
    .neq('status', 'suppressed')
    .limit(20_000);

  const rows = data ?? [];
  const count = (t: string) => rows.filter((r) => r.temperature === t).length;

  return {
    total: rows.length,
    hot: count('hot'),
    warm: count('warm'),
    cold: count('cold'),
    dead: count('dead'),
    withEmail: rows.filter((r) => Boolean(r.email)).length,
  };
}
