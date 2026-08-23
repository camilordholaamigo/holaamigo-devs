import { db, tryWrite } from '@/lib/supabase/admin';

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
  /** Se le mostró la primera cifra a mitad del quiz. Ver lib/quiz/preview.ts */
  | 'quiz_preview_shown'
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
  | 'cta_clicked'
  /** P7 · del diagnóstico al agente. Ver docs/wiki/22-agente-de-agendamiento.md */
  | 'playbook_compiled'
  | 'knowledge_base_built'
  /** El cliente habló con su agente en el simulador. Es la señal de activación
   *  más fuerte que tenemos: quien lo prueba entiende qué compró. */
  | 'agent_tested'
  | 'playbook_field_confirmed'
  | 'whatsapp_number_requested'
  /** Smoke tester · le escribimos a la línea del prospecto. Ver wiki/23. */
  | 'smoke_run_started'
  | 'smoke_probe_closed'
  /** El sitio no publica ningún número. Es un hallazgo, no un fallo: mide
   *  cuántos prospectos ni siquiera tienen por dónde recibir un mensaje. */
  | 'smoke_sin_numeros'
  /** El cliente miró el panel de la prueba en su diagnóstico. */
  | 'smoke_visto'
  /** Lotes e informes. Ver docs/wiki/24-lotes-e-informes.md */
  | 'smoke_batch_started'
  | 'smoke_report_generated'
  /** El cliente ABRIÓ su informe. Es la señal de compra más barata que
   *  tenemos, y decide a quién llamar. No es telemetría: es producto. */
  | 'smoke_report_viewed';

export async function track(
  event: PlgEvent,
  args: {
    organizationId?: string | null;
    sessionId?: string | null;
    props?: Record<string, unknown>;
  } = {},
): Promise<void> {
  // `tryWrite` y no un try/catch alrededor del await: `supabase-js` no lanza,
  // devuelve `{ error }`. El catch de antes nunca se ejecutaba y los eventos
  // perdidos no dejaban ni una línea en el log.
  await tryWrite(
    db().from('plg_events').insert({
      organization_id: args.organizationId ?? null,
      session_id: args.sessionId ?? null,
      event,
      props: args.props ?? {},
    }),
    `plg.${event}`,
  );
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
