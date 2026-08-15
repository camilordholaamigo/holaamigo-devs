import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { computeLeaks, computeInverseMath, type LeakContext } from '@/lib/diagnostic/math';
import { track } from '@/lib/events';
import { refreshScore } from '@/lib/scoring';
import type { Assumptions } from '@/config/assumptions';

/**
 * POST /api/diagnostic/assumptions — el cliente editó un supuesto (§7.3).
 *
 * El recálculo VISIBLE ya ocurrió en el navegador: `lib/diagnostic/math.ts` es
 * TypeScript puro y corre igual en cliente y en servidor, así que el número se
 * mueve mientras arrastra el control. Esta ruta persiste el resultado y — lo
 * importante — registra el evento.
 *
 * Editar un supuesto vale 5 puntos de intent (§9.1) porque es la señal más
 * honesta que existe: alguien que discute tu número ya se apropió del número.
 */

export const runtime = 'nodejs';

const AssumptionsSchema = z.object({
  dormant_contacts: z.number().min(0).max(10_000_000),
  avg_ticket_usd: z.number().min(0).max(10_000_000),
  monthly_revenue_usd: z.number().min(0).max(1_000_000_000),
  leads_per_month: z.number().min(0).max(1_000_000),
  close_rate: z.number().min(0).max(1),
  reactivation_rate: z.number().min(0).max(1),
  after_hours_share: z.number().min(0).max(1),
  followup_abandon_share: z.number().min(0).max(1),
  language_channel_share: z.number().min(0).max(1),
  goal_customers_90d: z.number().min(0).max(1_000_000),
  close_from_meeting: z.number().min(0).max(1),
  booking_rate: z.number().min(0).max(1),
  touches_per_contact: z.number().min(1).max(50),
  weeks_available: z.number().min(1).max(104),
  sends_per_mailbox_week: z.number().min(1).max(2000),
});

const Body = z.object({
  shareToken: z.string().min(16).max(80),
  assumptions: AssumptionsSchema,
  changed: z.string().max(60).nullish(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Supuestos inválidos' }, { status: 400 });
  }

  const { shareToken, assumptions, changed } = parsed.data;

  try {
    const { data: diagnostic } = await db()
      .from('diagnostics')
      .select('id, organization_id, session_id, leaks')
      .eq('share_token', shareToken)
      .maybeSingle();

    if (!diagnostic) {
      return NextResponse.json({ error: 'Diagnóstico no encontrado' }, { status: 404 });
    }

    // La evidencia de cada fuga se conserva: el cliente cambió el número, no
    // la razón por la que la fuga existe.
    const previous = Array.isArray(diagnostic.leaks) ? diagnostic.leaks : [];
    const context: LeakContext = {
      languageChannelDetected: previous.some(
        (l: { key?: string }) => l?.key === 'language_channel',
      ),
      evidence: Object.fromEntries(
        previous.map((l: { key: string; evidence: string; source_url: string | null; confidence: number }) => [
          l.key,
          { text: l.evidence, source_url: l.source_url, confidence: l.confidence },
        ]),
      ),
    };

    const leaks = computeLeaks(assumptions as Assumptions, context);
    const inverseMath = computeInverseMath(assumptions as Assumptions);

    await db()
      .from('diagnostics')
      .update({ assumptions, leaks, inverse_math: inverseMath })
      .eq('id', diagnostic.id);

    await track('assumption_edited', {
      organizationId: diagnostic.organization_id,
      sessionId: diagnostic.session_id,
      props: { changed: changed ?? null, assumptions },
    });

    // Editar un supuesto puede empujar al prospecto a ATTACK.
    await refreshScore(diagnostic.organization_id);

    return NextResponse.json({ leaks, inverse_math: inverseMath });
  } catch (err) {
    console.error('[diagnostic/assumptions] fallo', err);
    return NextResponse.json({ error: 'No pudimos guardar el cambio.' }, { status: 500 });
  }
}
