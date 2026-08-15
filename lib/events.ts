import { db } from '@/lib/supabase/admin';

/**
 * Eventos PLG. Alimentan el intent score (§9.1) y el timeline de la ficha 360.
 *
 * Nunca lanzan: un evento perdido es un dato menos, pero un evento que tumba
 * el flujo del usuario es una venta menos.
 */

export type PlgEvent =
  | 'landing_submit'
  | 'quiz_started'
  | 'quiz_answered'
  | 'quiz_completed'
  | 'quiz_abandoned'
  | 'research_started'
  | 'research_done'
  | 'research_partial'
  | 'research_failed'
  | 'research_reused'
  | 'diagnostic_viewed'
  | 'diagnostic_generated'
  | 'assumption_edited'
  | 'route_viewed'
  | 'channel_connected'
  | 'channel_skipped'
  | 'leads_uploaded'
  | 'agents_provisioned'
  | 'approval_decided'
  | 'band_override'
  | 'returned_48h'
  | 'cta_clicked';

export async function track(
  event: PlgEvent,
  args: {
    organizationId?: string | null;
    sessionId?: string | null;
    props?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await db().from('plg_events').insert({
      organization_id: args.organizationId ?? null,
      session_id: args.sessionId ?? null,
      event,
      props: args.props ?? {},
    });
  } catch (err) {
    console.error(`[plg] no se pudo registrar ${event}`, err);
  }
}

export async function hasEvent(organizationId: string, event: PlgEvent): Promise<boolean> {
  const { data } = await db()
    .from('plg_events')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('event', event)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function eventsFor(organizationId: string) {
  const { data } = await db()
    .from('plg_events')
    .select('id, event, props, created_at, session_id')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(200);
  return data ?? [];
}
