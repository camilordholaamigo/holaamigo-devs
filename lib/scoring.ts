import { db } from '@/lib/supabase/admin';
import { alertSlack } from '@/lib/notify';
import { env } from '@/lib/env';
import { track } from '@/lib/events';

/**
 * Scoring de prospecto (PRD §9.1).
 *
 * La tesis: PLG por defecto, humano por excepción. El humano entra por señal,
 * no por corazonada. Este archivo es esa señal.
 *
 * FIT mide si el negocio nos sirve. INTENT mide si se está involucrando.
 * `dormant_db` es el que más pesa en FIT porque es el que hace real la promesa
 * de 24 horas: sin base propia, no hay reactivación, y sin reactivación
 * estamos vendiendo cold email con 3 semanas de calentamiento.
 *
 * Ver docs/wiki/08-scoring-plg.md
 */

export type Band = 'auto' | 'assist' | 'attack';

const FIT_POINTS = {
  rev_band: { lt_10k: 4, '10k_50k': 12, '50k_200k': 20, '200k_1m': 18, gt_1m: 14 },
  ticket_band: { lt_500: 3, '500_2k': 10, '2k_10k': 15, '10k_50k': 13, gt_50k: 8 },
  dormant_db: { unknown: 6, lt_500: 4, '500_2k': 10, '2k_10k': 15, gt_10k: 15 },
  sales_team: { '0': 2, '1_2': 10, '3_5': 10, '6_15': 8, gt_15: 6 },
} as const;

const INTENT_POINTS = {
  quiz_completed: 15,
  diagnostic_viewed: 5,
  assumption_edited: 5,
  channel_connected: 10,
  leads_uploaded: 15,
  returned_48h: 5,
  urgent_deadline: 5,
} as const;

export interface ScoreResult {
  fit: number;
  intent: number;
  total: number;
  band: Band;
  reasons: { label: string; points: number }[];
}

function bandFor(total: number): Band {
  if (total >= 70) return 'attack';
  if (total >= 45) return 'assist';
  return 'auto';
}

export function computeScore(args: {
  answers: Record<string, unknown>;
  events: string[];
}): ScoreResult {
  const reasons: { label: string; points: number }[] = [];
  let fit = 0;

  const answerValue = (key: string): string | null => {
    const raw = args.answers[key];
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object' && 'value' in raw) {
      return String((raw as { value: unknown }).value);
    }
    return null;
  };

  for (const [question, table] of Object.entries(FIT_POINTS)) {
    const value = answerValue(question);
    if (!value) continue;
    const points = (table as Record<string, number>)[value] ?? 0;
    if (points > 0) {
      fit += points;
      reasons.push({ label: `${question} = ${value}`, points });
    }
  }

  let intent = 0;
  const seen = new Set(args.events);

  const addIntent = (key: keyof typeof INTENT_POINTS, present: boolean, label: string) => {
    if (!present) return;
    intent += INTENT_POINTS[key];
    reasons.push({ label, points: INTENT_POINTS[key] });
  };

  addIntent('quiz_completed', seen.has('quiz_completed'), 'completó el quiz');
  addIntent('diagnostic_viewed', seen.has('diagnostic_viewed'), 'vio el diagnóstico');
  addIntent('assumption_edited', seen.has('assumption_edited'), 'editó un supuesto');
  addIntent('channel_connected', seen.has('channel_connected'), 'conectó un canal');
  addIntent('leads_uploaded', seen.has('leads_uploaded'), 'cargó leads');
  addIntent('returned_48h', seen.has('returned_48h'), 'volvió en 48 h');

  const deadline = answerValue('goal_deadline');
  addIntent(
    'urgent_deadline',
    deadline === 'week' || deadline === 'month',
    `deadline = ${deadline}`,
  );

  fit = Math.min(60, fit);
  intent = Math.min(40, intent);
  const total = fit + intent;

  return { fit, intent, total, band: bandFor(total), reasons };
}

/**
 * Recalcula y persiste. Si sube a ATTACK y no habíamos alertado, avisa a Slack.
 * La alerta se manda UNA vez: `alerted_at` es el candado. Un canal que grita
 * dos veces por el mismo prospecto se silencia, y ahí perdimos la señal.
 */
export async function refreshScore(organizationId: string): Promise<ScoreResult> {
  const [{ data: sessions }, { data: events }, { data: existing }] = await Promise.all([
    db().from('intake_sessions').select('id').eq('organization_id', organizationId),
    db().from('plg_events').select('event').eq('organization_id', organizationId),
    db()
      .from('prospect_scores')
      .select('band, manual_band, alerted_at')
      .eq('organization_id', organizationId)
      .maybeSingle(),
  ]);

  const sessionIds = (sessions ?? []).map((s) => s.id);
  const answers: Record<string, unknown> = {};
  if (sessionIds.length > 0) {
    const { data: responses } = await db()
      .from('quiz_responses')
      .select('question_id, slot, answer')
      .in('session_id', sessionIds);
    for (const row of responses ?? []) {
      const key = row.question_id ?? row.slot;
      if (key) answers[key] = row.answer;
    }
  }

  const score = computeScore({
    answers,
    events: (events ?? []).map((e) => e.event),
  });

  const shouldAlert =
    score.band === 'attack' && existing?.band !== 'attack' && !existing?.alerted_at;

  await db()
    .from('prospect_scores')
    .upsert(
      {
        organization_id: organizationId,
        fit_score: score.fit,
        intent_score: score.intent,
        band: score.band,
        reasons: score.reasons,
        computed_at: new Date().toISOString(),
        ...(shouldAlert ? { alerted_at: new Date().toISOString() } : {}),
      },
      { onConflict: 'organization_id' },
    );

  if (shouldAlert) {
    const { data: org } = await db()
      .from('organizations')
      .select('name, domain, owner_email')
      .eq('id', organizationId)
      .maybeSingle();

    await alertSlack({
      title: `ATTACK · ${org?.name ?? org?.domain ?? 'prospecto'} · ${score.total}/100`,
      lines: [
        `*Dominio:* ${org?.domain ?? '—'}`,
        `*Contacto:* ${org?.owner_email ?? '—'}`,
        `*Fit:* ${score.fit}/60 · *Intent:* ${score.intent}/40`,
        `*Por qué:* ${score.reasons.slice(0, 5).map((r) => r.label).join(' · ')}`,
        '*SLA: contacto humano en menos de 30 minutos.*',
      ],
      url: `${env.siteUrl}/admin/prospects/${organizationId}`,
      urgent: true,
    });
  }

  return score;
}

/** Override manual (§9.1). La nota es obligatoria y queda en plg_events. */
export async function overrideBand(args: {
  organizationId: string;
  band: Band;
  note: string;
  by: string;
}): Promise<void> {
  if (!args.note.trim()) {
    throw new Error('La nota es obligatoria para cambiar de banda.');
  }

  await db()
    .from('prospect_scores')
    .upsert(
      {
        organization_id: args.organizationId,
        manual_band: args.band,
        band: args.band,
        manual_note: args.note.trim(),
        manual_by: args.by,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id' },
    );

  await track('band_override', {
    organizationId: args.organizationId,
    props: { band: args.band, note: args.note.trim(), by: args.by },
  });
}

export const BAND_LABEL: Record<Band, { label: string; action: string; color: string }> = {
  auto: {
    label: 'AUTO',
    action: 'Nurture automático. Nadie lo toca.',
    color: 'slate',
  },
  assist: {
    label: 'ASSIST',
    action: 'Secuencia con nudge. Mensaje personal si se estanca 48 h.',
    color: 'amber',
  },
  attack: {
    label: 'ATTACK',
    action: 'Contacto humano en menos de 30 minutos.',
    color: 'red',
  },
};
