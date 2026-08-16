import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor } from '@/lib/auth/console';
import { proposeCampaigns } from '@/lib/campaigns/plan';
import { debit } from '@/lib/credits';

/**
 * POST /api/campaigns/propose — el CMO arma las tres campañas.
 *
 * No lanza nada: deja tres campañas en estado `proposed`. Lanzar es una
 * decisión aparte, y esa asimetría es el producto (§13.6).
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({ organizationId: z.string().uuid() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Falta la organización.' }, { status: 400 });
  }

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  try {
    const proposals = await proposeCampaigns(parsed.data.organizationId);

    await debit({
      organizationId: parsed.data.organizationId,
      action: 'ai_campaign_plan',
      quantity: proposals.length,
      referenceTable: 'campaigns',
      note: 'plan de las tres campañas',
    });

    return NextResponse.json({
      ok: true,
      campaigns: proposals.map((p) => ({
        id: p.id,
        playbook: p.playbook,
        name: p.name,
        audience: p.audience,
        credits: p.credits,
        expected_bookings: p.expected.bookings,
      })),
    });
  } catch (err) {
    console.error('[campaigns/propose] fallo', err);
    return NextResponse.json({ error: 'No pudimos armar las campañas.' }, { status: 500 });
  }
}
