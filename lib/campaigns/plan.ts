import { db, unwrap } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import { CampaignCopySchema, type CampaignCopy } from '@/lib/ai/schemas';
import { CAMPAIGN_COPY_SYSTEM } from '@/config/prompts';
import { PLAYBOOKS, selectPlaybooks, type Playbook, type PlaybookKey } from '@/config/campaigns';
import { projectCampaign, measurementSchedule } from '@/lib/campaigns/math';
import { resolveAudience, audienceSnapshot } from '@/lib/campaigns/segment';
import { ensureAsset, publicUrlFor } from '@/lib/assets/links';
import { agentIdFor } from '@/lib/agents/contracts';
import { pushFeedItem } from '@/lib/feed/items';
import { hasOpenAI } from '@/lib/env';
import type { Assumptions } from '@/config/assumptions';
import type { SequenceStep } from '@/lib/campaigns/activate';

/**
 * Las tres campañas que se le proponen al cliente después del diagnóstico.
 *
 * Reparto de trabajo, igual que en el diagnóstico (ADR 0007):
 *   · qué tres campañas       → config/campaigns.ts, determinista
 *   · a quién y cuántos son   → lib/campaigns/segment.ts, una consulta
 *   · qué esperamos y cuánto  → lib/campaigns/math.ts, aritmética
 *   · el texto de los correos → el CMO
 *
 * Si el CMO falla, la campaña se propone igual con plantillas de respaldo. Una
 * propuesta con copy mediocre se edita en dos minutos; una propuesta que no
 * existe porque el modelo se cayó no se puede aprobar.
 *
 * Ver docs/wiki/11-campanas.md
 */

export interface ProposedCampaign {
  id: string;
  playbook: PlaybookKey;
  name: string;
  audience: number;
  credits: number;
  expected: ReturnType<typeof projectCampaign>;
}

export async function proposeCampaigns(organizationId: string): Promise<ProposedCampaign[]> {
  const [{ data: org }, { data: diagnostic }, snapshot, { data: products }] = await Promise.all([
    db().from('organizations').select('id, name, domain, currency').eq('id', organizationId).maybeSingle(),
    db()
      .from('diagnostics')
      .select('id, assumptions, brand, identity, leaks')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    audienceSnapshot(organizationId),
    db().from('products').select('id').eq('organization_id', organizationId).eq('active', true).limit(1),
  ]);

  if (!org) throw new Error('[campaigns] organización inexistente');

  const assumptions = (diagnostic?.assumptions ?? null) as Assumptions | null;
  const avgTicket = assumptions?.avg_ticket_usd ?? 1200;
  const brand = (diagnostic?.brand ?? {}) as { clarity_score?: number };

  const { data: recommendation } = await db()
    .from('recommendations')
    .select('route')
    .eq('diagnostic_id', diagnostic?.id ?? '')
    .eq('is_recommended', true)
    .maybeSingle();

  const keys = selectPlaybooks({
    dormantContacts: snapshot.cold + snapshot.dead,
    warmContacts: snapshot.hot + snapshot.warm,
    coldContacts: snapshot.cold,
    recommendedRoute: (recommendation?.route as 'whatsapp' | 'email' | 'brand_content') ?? 'email',
    brandClarityScore: brand.clarity_score ?? 60,
    hasProducts: (products ?? []).length > 0,
  });

  const companyName = org.name ?? org.domain ?? 'tu empresa';
  const cmoAgentId = await agentIdFor(organizationId, 'cmo');

  const proposals: ProposedCampaign[] = [];

  for (const key of keys) {
    const playbook = PLAYBOOKS[key];

    const audience = await resolveAudience({
      organizationId,
      rules: playbook.segment,
      limit: 1, // solo necesitamos el conteo; no traemos 20.000 filas por nada
    });

    const asset = playbook.asset
      ? await ensureAsset({ organizationId, kind: playbook.asset, companyName })
      : null;

    const expected = projectCampaign({
      audience: audience.total,
      steps: playbook.steps.length,
      benchmarks: playbook.benchmarks,
      avgTicketUsd: avgTicket,
    });

    const copy = await writeCopy({
      organizationId,
      cmoAgentId,
      playbook,
      companyName,
      identity: diagnostic?.identity ?? null,
      assetUrl: asset ? publicUrlFor(asset) : null,
    });

    const sequence: SequenceStep[] = playbook.steps.map((step, index) => {
      const written = copy?.steps.find((s) => s.step_index === index);
      return {
        day_offset: step.day_offset,
        purpose: step.purpose,
        subject: written?.subject ?? fallbackSubject(playbook, index, companyName),
        body: written?.body ?? fallbackBody(playbook, index, companyName),
        include_asset: step.include_asset,
      };
    });

    const startsAt = new Date();
    const campaign = unwrap(
      await db()
        .from('campaigns')
        .insert({
          organization_id: organizationId,
          name: playbook.name,
          channel: 'email',
          status: 'proposed',
          playbook: key,
          objective: playbook.promise,
          hypothesis: copy?.hypothesis ?? playbook.why_this_segment,
          segment_name: segmentLabel(playbook),
          segment_rules: playbook.segment,
          sequence,
          asset_id: asset?.id ?? null,
          audience_size: audience.total,
          credits_estimate: expected.credits,
          expected: {
            ...expected,
            benchmarks: playbook.benchmarks,
            avg_ticket_usd: avgTicket,
          },
          measurement: {
            points: measurementSchedule(playbook, startsAt),
            // Lo que hace auditable la campaña: contra qué se compara lo real.
            baseline: playbook.benchmarks,
          },
          iteration: { rules: playbook.iteration },
          proposed_by: 'cmo',
          daily_cap: 200,
        })
        .select('id')
        .single(),
      'campaigns.propose',
    ) as { id: string };

    proposals.push({
      id: campaign.id,
      playbook: key,
      name: playbook.name,
      audience: audience.total,
      credits: expected.credits,
      expected,
    });
  }

  // Un solo item en el feed para las tres. Tres items sería la primera vez que
  // saturamos al operador, y el principio es justo el contrario: involucrado,
  // no ahogado.
  const totalAudience = proposals.reduce((sum, p) => sum + p.audience, 0);
  await pushFeedItem({
    organizationId,
    kind: 'proposal',
    role: 'cmo',
    title: 'Tres campañas listas para que decidas',
    body: `Armamos tres formas de atacar tu base: ${proposals
      .map((p) => `${p.name.toLowerCase()} (${p.audience} contactos)`)
      .join(', ')}. En total ${totalAudience} personas. Cada una trae a quién le pega, qué esperamos, cómo lo medimos y qué cambiamos si no funciona.`,
    rationale:
      'Salen del diagnóstico y de tu base real. No las lanzamos: las aprobás una por una.',
    evidence: Object.fromEntries(
      proposals.map((p) => [
        p.playbook,
        {
          audiencia: p.audience,
          creditos: p.credits,
          citas_esperadas: p.expected.bookings,
          cierres_esperados: `${p.expected.range.low} a ${p.expected.range.high}`,
        },
      ]),
    ),
    requires: 'nothing',
    dedupeKey: `campaigns-proposed-${new Date().toISOString().slice(0, 10)}`,
    payload: { campaign_ids: proposals.map((p) => p.id) },
  });

  return proposals;
}

function segmentLabel(playbook: Playbook): string {
  const parts: string[] = [];
  if (playbook.segment.temperature.length > 0) {
    parts.push(playbook.segment.temperature.join(', '));
  }
  if (playbook.segment.min_days_since_interaction !== null) {
    parts.push(`sin contacto hace ${playbook.segment.min_days_since_interaction}+ días`);
  }
  if (playbook.segment.max_days_since_interaction !== null) {
    parts.push(`últimos ${playbook.segment.max_days_since_interaction} días`);
  }
  return parts.join(' · ') || 'toda la base con correo';
}

async function writeCopy(args: {
  organizationId: string;
  cmoAgentId: string | null;
  playbook: Playbook;
  companyName: string;
  identity: unknown;
  assetUrl: string | null;
}): Promise<CampaignCopy | null> {
  if (!hasOpenAI()) return null;

  const stepBrief = args.playbook.steps
    .map(
      (step, index) =>
        `Paso ${index} · día ${step.day_offset} · ${step.purpose}\n  Restricción: ${step.brief}\n  Máximo ${step.max_words} palabras.${
          step.include_asset ? '\n  Este paso incluye un link de agenda que pone el sistema.' : ''
        }`,
    )
    .join('\n');

  const input = `
EMPRESA QUE ENVÍA: ${args.companyName}
IDENTIDAD SEGÚN EL DIAGNÓSTICO: ${JSON.stringify(args.identity ?? {}).slice(0, 1200)}

CAMPAÑA: ${args.playbook.name}
QUÉ ES: ${args.playbook.promise}
A QUIÉN LE PEGA Y POR QUÉ: ${args.playbook.why_this_segment}

LA SECUENCIA (respeta el orden y los índices):
${stepBrief}
`.trim();

  try {
    const result = await runStructured({
      step: 'angles',
      schemaName: 'campaign_copy',
      schema: CampaignCopySchema,
      system: CAMPAIGN_COPY_SYSTEM,
      input,
      organizationId: args.organizationId,
      agentId: args.cmoAgentId,
      role: 'cmo',
      trigger: 'campaign_plan',
    });
    return result.data;
  } catch (err) {
    console.error('[campaigns] el CMO no pudo escribir el copy, se usa el de respaldo', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COPY DE RESPALDO
// Genérico a propósito: está para que la propuesta exista y sea editable, no
// para enviarse tal cual. La UI marca estos pasos como "sin revisar".
// ═══════════════════════════════════════════════════════════════════════════

function fallbackSubject(playbook: Playbook, index: number, company: string): string {
  const subjects: Record<PlaybookKey, string[]> = {
    reactivacion: ['una pregunta rápida', 'lo que cambió desde entonces', '¿cierro esta puerta?'],
    rescate: ['retomo donde quedamos', 'sobre lo que te frenó', '¿lo dejamos o lo cerramos?', 'último'],
    conquista: [`sobre ${company}`, 'un caso parecido al tuyo', '15 minutos', 'otra idea'],
    lanzamiento: ['algo nuevo', 'por si se te pasó'],
  };
  return subjects[playbook.key][index] ?? 'una pregunta';
}

function fallbackBody(playbook: Playbook, index: number, company: string): string {
  const step = playbook.steps[index];
  return [
    'Hola {{nombre}},',
    '',
    `Te escribo de ${company}. ${step.purpose}.`,
    '',
    '[Este texto es de respaldo: el CMO no pudo redactarlo. Revísalo antes de aprobar la campaña.]',
    '',
    '¿Te sirve que lo veamos esta semana?',
  ].join('\n');
}
