import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { activateCampaign, rejectCampaign, pauseCampaign } from '@/lib/campaigns/activate';
import { balance } from '@/lib/credits';

/**
 * PATCH /api/campaigns/[id] — aprobar, pausar, reanudar o rechazar.
 *
 * Aprobar es un clic; rechazar exige nota. Misma asimetría que la cola de
 * decisiones de v1: aprobar sin pensar es barato de revertir, rechazar sin
 * explicar destruye la única señal de por qué una campaña no servía.
 *
 * Antes de aprobar se verifica el saldo. Aprobar una campaña que no se puede
 * pagar y descubrirlo cuando se pausa sola a mitad de la secuencia es la peor
 * secuencia posible de eventos para la confianza del cliente.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  organizationId: z.string().uuid(),
  action: z.enum(['approve', 'reject', 'pause', 'resume', 'schedule']),
  note: z.string().max(1000).nullish(),
  /** ISO. Solo para `schedule`. */
  scheduledFor: z.string().nullish(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const { organizationId, action, note, scheduledFor } = parsed.data;

  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!(await belongsToOrg('campaigns', id, organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  if (action === 'reject' && !note?.trim()) {
    return NextResponse.json(
      { error: 'Rechazar exige una nota. Es lo único que hace que no te vuelva a proponer lo mismo.' },
      { status: 400 },
    );
  }

  try {
    if (action === 'schedule') {
      const when = scheduledFor ? new Date(scheduledFor) : null;
      if (!when || Number.isNaN(when.getTime())) {
        return NextResponse.json({ error: 'Fecha inválida' }, { status: 400 });
      }
      await db().from('campaigns').update({ scheduled_for: when.toISOString() }).eq('id', id);
      return NextResponse.json({ ok: true, scheduled_for: when.toISOString() });
    }

    if (action === 'approve') {
      const { data: campaign } = await db()
        .from('campaigns')
        .select('credits_estimate, name')
        .eq('id', id)
        .maybeSingle();

      const available = await balance(organizationId);
      const needed = Number(campaign?.credits_estimate ?? 0);

      if (needed > available) {
        return NextResponse.json(
          {
            error: `"${campaign?.name}" necesita ${needed} créditos y tienes ${available}. Recarga o baja el tamaño del segmento antes de aprobarla.`,
            credits_needed: needed,
            credits_available: available,
          },
          { status: 402 },
        );
      }

      const result = await activateCampaign({
        campaignId: id,
        approvedBy: actor.user,
        feedItemId: null,
      });

      return NextResponse.json(
        { ok: result.ok, summary: result.summary, scheduled: result.scheduled },
        { status: result.ok ? 200 : 409 },
      );
    }

    if (action === 'reject') {
      await rejectCampaign(id, note!.trim());
      return NextResponse.json({ ok: true, summary: 'Campaña archivada y envíos cancelados.' });
    }

    if (action === 'pause') {
      await pauseCampaign(id, note?.trim() || 'pausada a mano');
      return NextResponse.json({ ok: true, summary: 'Pausada. Lo programado espera.' });
    }

    // resume
    await db()
      .from('campaigns')
      .update({ status: 'active', paused_reason: null })
      .eq('id', id)
      .eq('status', 'paused');
    return NextResponse.json({ ok: true, summary: 'Reanudada.' });
  } catch (err) {
    console.error('[campaigns/patch] fallo', err);
    return NextResponse.json({ error: 'No pudimos aplicar el cambio.' }, { status: 500 });
  }
}
