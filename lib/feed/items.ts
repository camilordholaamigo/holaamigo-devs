import { db, unwrap } from '@/lib/supabase/admin';
import { track } from '@/lib/events';
import { activateCampaign, rejectCampaign } from '@/lib/campaigns/activate';

/**
 * El feed: cómo el President le habla al humano (ADR 0012).
 *
 * `approvals` sigue siendo el registro de decisiones — es la auditoría y no se
 * toca. `feed_items` es la conversación: propone, pide, reporta y celebra. Un
 * item de tipo `proposal` SIEMPRE crea su fila en `approvals`, así que "¿quién
 * autorizó ese envío?" se responde en un solo lugar.
 *
 * Por qué no meter todo en `approvals`: porque la mitad de lo que el President
 * necesita decir no es una decisión. "Ayer enviamos 340 y contestaron 21" no se
 * aprueba ni se rechaza, y meterlo en la cola de decisiones convierte la cola
 * en un timeline — que es exactamente cómo muere el principio §13.6.
 *
 * Ver docs/wiki/13-feed-y-autonomia.md
 */

export type FeedKind = 'proposal' | 'ask' | 'digest' | 'alert' | 'win';
export type FeedRequires = 'approval' | 'input' | 'nothing';

export interface FeedItem {
  id: string;
  created_at: string;
  organization_id: string;
  kind: FeedKind;
  role: 'president' | 'cmo' | 'sales' | 'system';
  title: string;
  body: string;
  rationale: string | null;
  evidence: Record<string, unknown>;
  requires: FeedRequires;
  input_kind: string | null;
  approval_id: string | null;
  campaign_id: string | null;
  thread_id: string | null;
  payload: Record<string, unknown>;
  status: 'open' | 'approved' | 'rejected' | 'answered' | 'dismissed' | 'expired';
  severity: 'low' | 'normal' | 'high';
  response: Record<string, unknown> | null;
  responded_by: string | null;
  responded_at: string | null;
  expires_at: string | null;
}

export async function pushFeedItem(args: {
  organizationId: string;
  kind: FeedKind;
  role?: 'president' | 'cmo' | 'sales' | 'system';
  title: string;
  body: string;
  rationale?: string | null;
  evidence?: Record<string, unknown>;
  requires?: FeedRequires;
  inputKind?: string | null;
  campaignId?: string | null;
  threadId?: string | null;
  payload?: Record<string, unknown>;
  severity?: 'low' | 'normal' | 'high';
  expiresAt?: string | null;
  /** Evita duplicados: un digest por día, una alerta por hilo. */
  dedupeKey?: string | null;
  /** Datos de la aprobación cuando el item es una propuesta. */
  approval?: {
    kind: string;
    if_approved: string;
    if_rejected: string;
    payload?: Record<string, unknown>;
  } | null;
}): Promise<FeedItem | null> {
  try {
    let approvalId: string | null = null;

    if (args.approval) {
      const approval = unwrap(
        await db()
          .from('approvals')
          .insert({
            organization_id: args.organizationId,
            kind: args.approval.kind,
            title: args.title,
            rationale: args.rationale ?? args.body,
            if_approved: args.approval.if_approved,
            if_rejected: args.approval.if_rejected,
            payload: args.approval.payload ?? args.payload ?? {},
            severity: args.severity ?? 'normal',
          })
          .select('id')
          .single(),
        'feed.approval',
      ) as { id: string };
      approvalId = approval.id;
    }

    const { data, error } = await db()
      .from('feed_items')
      .insert({
        organization_id: args.organizationId,
        kind: args.kind,
        role: args.role ?? 'president',
        title: args.title,
        body: args.body,
        rationale: args.rationale ?? null,
        evidence: args.evidence ?? {},
        requires: args.requires ?? 'nothing',
        input_kind: args.inputKind ?? null,
        approval_id: approvalId,
        campaign_id: args.campaignId ?? null,
        thread_id: args.threadId ?? null,
        payload: args.payload ?? {},
        severity: args.severity ?? 'normal',
        expires_at: args.expiresAt ?? null,
        dedupe_key: args.dedupeKey ?? null,
      })
      .select('*')
      .maybeSingle();

    // Choque con el índice de deduplicación: ya existe el item de hoy. No es
    // un error, es la garantía funcionando.
    if (error) {
      if (error.message.includes('duplicate key')) return null;
      throw new Error(error.message);
    }

    return (data as FeedItem | null) ?? null;
  } catch (err) {
    // Igual que la telemetría: el feed nunca tumba la operación que lo generó.
    console.error('[feed] no se pudo publicar el item', err);
    return null;
  }
}

export async function feedFor(
  organizationId: string,
  args: { onlyOpen?: boolean; limit?: number } = {},
): Promise<FeedItem[]> {
  let query = db()
    .from('feed_items')
    .select('*')
    .eq('organization_id', organizationId);

  if (args.onlyOpen) query = query.eq('status', 'open');

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 50);

  return (data ?? []) as FeedItem[];
}

export interface FeedResponse {
  decision: 'approved' | 'rejected' | 'answered' | 'dismissed';
  note?: string | null;
  /** Para los `ask`: el link del video, el texto, el dato. */
  payload?: Record<string, unknown>;
  by: string;
}

/**
 * Responder un item del feed.
 *
 * La asimetría de `/api/approvals/[id]/decide` se mantiene: aprobar es un clic,
 * rechazar exige nota. Es la única señal de aprendizaje que tenemos sobre por
 * qué una propuesta no servía, y sin ella el President repite el mismo error
 * la semana siguiente.
 */
export async function respondFeedItem(
  id: string,
  response: FeedResponse,
): Promise<{ ok: boolean; error?: string; effect?: string }> {
  const { data: item } = await db()
    .from('feed_items')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!item) return { ok: false, error: 'No encontrado' };
  if (item.status !== 'open') return { ok: false, error: 'Ya lo habías respondido.' };

  if (response.decision === 'rejected' && !response.note?.trim()) {
    return {
      ok: false,
      error: 'Rechazar exige una nota. Es lo único que hace que no te vuelva a proponer lo mismo.',
    };
  }

  const now = new Date().toISOString();

  await db()
    .from('feed_items')
    .update({
      status: response.decision,
      response: { note: response.note ?? null, ...(response.payload ?? {}) },
      responded_by: response.by,
      responded_at: now,
    })
    .eq('id', id);

  if (item.approval_id) {
    const approvalStatus =
      response.decision === 'approved'
        ? 'approved'
        : response.decision === 'rejected'
          ? 'rejected'
          : 'expired';
    await db()
      .from('approvals')
      .update({
        status: approvalStatus,
        decided_by: response.by,
        decided_at: now,
        decision_note: response.note?.trim() || null,
      })
      .eq('id', item.approval_id);
  }

  let effect: string | undefined;

  if (item.campaign_id) {
    if (response.decision === 'approved') {
      const result = await activateCampaign({
        campaignId: item.campaign_id,
        approvedBy: response.by,
        approvalId: item.approval_id,
        feedItemId: item.id,
      });
      effect = result.summary;
    } else if (response.decision === 'rejected') {
      await rejectCampaign(item.campaign_id, response.note ?? 'sin nota');
      effect = 'Campaña archivada.';
    }
  }

  await track('approval_decided', {
    organizationId: item.organization_id,
    props: { source: 'feed', kind: item.kind, decision: response.decision, by: response.by },
  });

  return { ok: true, effect };
}

/** Cuántas cosas están esperando al humano. Es el número del badge y, más
 *  importante, el que usamos para NO saturar: si ya hay 5 items abiertos, el
 *  President no propone un sexto. */
export async function openCount(organizationId: string): Promise<number> {
  const { count } = await db()
    .from('feed_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'open')
    .in('requires', ['approval', 'input']);
  return count ?? 0;
}
