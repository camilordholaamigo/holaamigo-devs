import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { currentAdmin } from '@/lib/auth/admin';
import { track } from '@/lib/events';

/**
 * POST /api/approvals/[id]/decide — la cola de decisiones (PRD §9.3).
 *
 * "La cola de decisiones es el producto" (§13.6). Aprobar es un clic; rechazar
 * EXIGE nota. Esa asimetría es intencional: aprobar sin pensar es barato de
 * revertir, rechazar sin explicar destruye la única señal de aprendizaje que
 * tenemos sobre por qué un ángulo no sirve.
 *
 * Aprobar un `angle_new` mueve el ángulo a `approved`, que es lo único que
 * habilita a SALES a usarlo (contrato §3.3).
 */

export const runtime = 'nodejs';

const Body = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).nullish(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Decisión inválida' }, { status: 400 });
  }

  const { decision, note } = parsed.data;

  if (decision === 'rejected' && !note?.trim()) {
    return NextResponse.json(
      { error: 'Rechazar exige una nota. Es la única forma de aprender por qué no sirvió.' },
      { status: 400 },
    );
  }

  try {
    const { data: approval } = await db()
      .from('approvals')
      .select('id, organization_id, kind, status, payload')
      .eq('id', id)
      .maybeSingle();

    if (!approval) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
    if (approval.status !== 'pending') {
      return NextResponse.json({ error: 'Ya estaba decidido.' }, { status: 409 });
    }

    await db()
      .from('approvals')
      .update({
        status: decision,
        decided_by: admin.user,
        decided_at: new Date().toISOString(),
        decision_note: note?.trim() || null,
      })
      .eq('id', id);

    // Efectos por tipo de decisión.
    const payload = (approval.payload ?? {}) as { angle_id?: string; campaign_id?: string };

    if (approval.kind === 'angle_new' && payload.angle_id) {
      await db()
        .from('angles')
        .update({ status: decision === 'approved' ? 'approved' : 'retired' })
        .eq('id', payload.angle_id);
    }

    if (approval.kind === 'campaign_launch' && payload.campaign_id) {
      await db()
        .from('campaigns')
        .update({
          status: decision === 'approved' ? 'active' : 'draft',
          started_at: decision === 'approved' ? new Date().toISOString() : null,
        })
        .eq('id', payload.campaign_id);
    }

    await track('approval_decided', {
      organizationId: approval.organization_id,
      props: { kind: approval.kind, decision, by: admin.user },
    });

    return NextResponse.json({ ok: true, decision });
  } catch (err) {
    console.error('[approvals/decide] fallo', err);
    return NextResponse.json({ error: 'No pudimos registrar la decisión.' }, { status: 500 });
  }
}
