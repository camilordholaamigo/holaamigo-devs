import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { dispatchDue } from '@/lib/campaigns/dispatch';
import { runDailyBriefing } from '@/lib/feed/president';
import { agentConfigFor, withinSendWindow, type SalesConfig } from '@/lib/agents/config';

/**
 * GET /api/cron/dispatch — el motor del correo.
 *
 * Hace tres cosas, en este orden y por una razón:
 *   1. Activa las campañas cuya hora ya llegó.
 *   2. Envía lo que esté vencido, respetando franja horaria y topes.
 *   3. Una vez al día, corre el briefing del President.
 *
 * El briefing va DESPUÉS del envío: si corriera antes, propondría sobre
 * números de ayer teniendo los de hoy a medio hacer.
 *
 * Protegido con CRON_SECRET, igual que `/api/cron/sweep`.
 *
 * ── LA HORA A LA QUE CORRE NO ES LIBRE ─────────────────────────────────────
 *
 * Se diseñó para correr cada 5 minutos. En el plan Hobby corre UNA vez al día,
 * y eso convierte el horario en parte de la lógica:
 *
 *  · El briefing del paso 3 solo se publica entre las 12 y las 14 UTC. Con un
 *    cron diario fuera de esa franja, el President simplemente no habla nunca.
 *    Está agendado a las 13:30 UTC por eso, no por gusto.
 *  · El paso 2 respeta la franja de envío de cada cliente. Con una sola
 *    corrida diaria, un cliente cuya franja no incluya las 8:30 a. m. de
 *    Colombia **no recibe envíos ese día**. Corriendo cada cinco minutos eso
 *    no podía pasar.
 *
 * Las dos cosas se arreglan devolviéndole el cron de cada cinco minutos en un
 * plan Pro.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (env.cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
  }

  const report = {
    activated: 0,
    dispatch: { considered: 0, sent: 0, skipped: 0, failed: 0, reasons: {} as Record<string, number> },
    briefings: 0,
    out_of_window: 0,
  };

  try {
    // ── 1 · Campañas programadas cuya hora llegó ──────────────────────────
    const { data: dueCampaigns } = await db()
      .from('campaigns')
      .select('id')
      .eq('status', 'scheduled')
      .lte('scheduled_for', new Date().toISOString())
      .limit(20);

    for (const campaign of dueCampaigns ?? []) {
      await db()
        .from('campaigns')
        .update({ status: 'active', started_at: new Date().toISOString() })
        .eq('id', campaign.id);
      report.activated += 1;
    }

    // ── 2 · Franja horaria por organización ───────────────────────────────
    // Un correo comercial que llega el domingo a las 11 p.m. dice más de
    // nosotros que su contenido. Los mensajes fuera de franja no se pierden:
    // esperan y salen a la mañana siguiente.
    const { data: orgsWithWork } = await db()
      .from('messages')
      .select('organization_id')
      .eq('status', 'scheduled')
      .lte('scheduled_for', new Date().toISOString())
      .limit(500);

    const orgIds = [...new Set((orgsWithWork ?? []).map((row) => row.organization_id).filter(Boolean))] as string[];

    let anyOpen = orgIds.length === 0;
    for (const orgId of orgIds) {
      const { config } = await agentConfigFor(orgId, 'sales');
      const { data: org } = await db()
        .from('organizations')
        .select('country')
        .eq('id', orgId)
        .maybeSingle();

      const timeZone = timezoneFor(org?.country ?? null);
      if (withinSendWindow(config as SalesConfig, new Date(), timeZone)) {
        anyOpen = true;
      } else {
        report.out_of_window += 1;
      }
    }

    if (anyOpen) {
      report.dispatch = await dispatchDue();
    }

    // ── 3 · Briefing diario del President ─────────────────────────────────
    // La deduplicación por día vive en `feed_items.dedupe_key`, así que correr
    // esto muchas veces es inofensivo: solo el primero del día publica. La
    // ventana 12–14 UTC es lo que hace que el cron diario TENGA que estar
    // agendado adentro de ella; ver el encabezado.
    const hour = new Date().getUTCHours();
    if (hour >= 12 && hour <= 14) {
      const { data: activeOrgs } = await db()
        .from('agents')
        .select('organization_id')
        .eq('role', 'president')
        .eq('status', 'active')
        .limit(200);

      const unique = [...new Set((activeOrgs ?? []).map((row) => row.organization_id))];
      for (const orgId of unique) {
        try {
          await runDailyBriefing(orgId);
          report.briefings += 1;
        } catch (err) {
          console.error(`[cron/dispatch] briefing fallido de ${orgId}`, err);
        }
      }
    }

    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    console.error('[cron/dispatch] fallo', err);
    return NextResponse.json({ error: 'despacho incompleto', ...report }, { status: 500 });
  }
}

/** Zona horaria por país. Aproximación deliberada, igual que la tasa de cambio
 *  de ADR 0006: sirve para no escribir de madrugada, no para agendar vuelos. */
function timezoneFor(country: string | null): string {
  const map: Record<string, string> = {
    CO: 'America/Bogota',
    MX: 'America/Mexico_City',
    PE: 'America/Lima',
    CL: 'America/Santiago',
    AR: 'America/Argentina/Buenos_Aires',
    BR: 'America/Sao_Paulo',
    ES: 'Europe/Madrid',
    US: 'America/New_York',
  };
  return map[country ?? ''] ?? 'America/Bogota';
}
