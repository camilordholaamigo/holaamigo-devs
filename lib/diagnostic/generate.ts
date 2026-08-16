import { db, unwrap, mustWrite } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import {
  DiagnosisSchema,
  DiagnosisMinimalSchema,
  inflateDiagnosis,
  type Diagnosis,
} from '@/lib/ai/schemas';
import { DIAGNOSIS_SYSTEM } from '@/config/prompts';
import { findingsForOrganization } from '@/lib/research/run';
import { getAnswers } from '@/lib/quiz/service';
import {
  buildAssumptions,
  computeLeaks,
  computeInverseMath,
  totalLeakUsd,
  type LeakContext,
} from '@/lib/diagnostic/math';
import { buildRoutes } from '@/config/routes';
import { provisionAgents, agentIdFor } from '@/lib/agents/contracts';
import { newRunId } from '@/lib/traces/record';
import { buildLearningContext } from '@/lib/learning/context';
import { recordDecision, imputarCostos } from '@/lib/decisions/record';
import { refreshScore } from '@/lib/scoring';
import { track } from '@/lib/events';
import { sendDiagnosticEmail } from '@/lib/notify';
import { isoInDays } from '@/lib/utils';
import type { Assumptions } from '@/config/assumptions';

/**
 * Generación del diagnóstico (PRD §7).
 *
 * Reparto de trabajo, y es la decisión de diseño más importante del archivo:
 *
 *   El MODELO aporta lenguaje y evidencia: quién eres, contra quién compites,
 *   por qué esta fuga existe en TU negocio, qué ruta y por qué, los ángulos.
 *
 *   El CÓDIGO aporta los números: cuánta plata, la cuenta al revés, los costos
 *   de cada ruta, las fechas del roadmap.
 *
 * Nunca al revés. Un número que sale de un modelo no se puede defender cuando
 * el cliente pregunta de dónde salió, y en este producto siempre pregunta.
 *
 * Se genera aunque el research haya quedado `partial` o `failed` (§8.3.5).
 * Nunca dejamos al usuario sin salida.
 *
 * Ver docs/wiki/06-diagnostico-y-matematica.md
 */

export interface GenerateResult {
  diagnosticId: string;
  shareToken: string;
  researchQuality: 'full' | 'partial' | 'none';
  totalLeakUsd: number;
  degraded: boolean;
}

export async function generateDiagnostic(args: {
  sessionId: string;
  organizationId: string;
  force?: boolean;
}): Promise<GenerateResult> {
  const { sessionId, organizationId } = args;

  // Idempotencia: si ya existe uno para esta sesión, se devuelve.
  //
  // `limit(1)` y no `maybeSingle()`: mientras no existió el índice único de la
  // migración 0005 se pudieron crear diagnósticos duplicados, y `maybeSingle()`
  // revienta con "multiple rows" ante ellos — o sea que la comprobación de
  // idempotencia fallaba justo en las sesiones que más la necesitaban.
  if (!args.force) {
    const existing = await findExisting(sessionId);
    if (existing) return existing;
  }

  const org = unwrap(
    await db()
      .from('organizations')
      .select('id, name, domain, website_url, country, currency, industry')
      .eq('id', organizationId)
      .single(),
    'organizations.get',
  );

  const session = unwrap(
    await db()
      .from('intake_sessions')
      .select('id, contact_name, contact_email')
      .eq('id', sessionId)
      .single(),
    'intake_sessions.get',
  );

  const [answers, research] = await Promise.all([
    getAnswers(sessionId),
    findingsForOrganization(organizationId),
  ]);

  const researchQuality: 'full' | 'partial' | 'none' =
    research.status === 'done'
      ? 'full'
      : Object.keys(research.sections).length > 0
        ? 'partial'
        : 'none';

  // ── Supuestos y aritmética ───────────────────────────────────────────────
  const assumptions = buildAssumptions({
    dormant_db: str(answers.dormant_db),
    ticket_band: str(answers.ticket_band),
    rev_band: str(answers.rev_band),
    sales_team: str(answers.sales_team),
    goal_deadline: str(answers.goal_deadline),
    goal_90d: num(answers.goal_90d),
    industry: org.industry,
  });

  // ── El President ensambla ────────────────────────────────────────────────
  //
  // Una corrida (`runId`) agrupa todos los pasos de esta generación. Es lo que
  // permite después imputarle el costo a la decisión que salga de acá: el costo
  // se mide por corrida y se reparte entre lo que la corrida decidió.
  const runId = newRunId();

  // Lo que la organización ya aprendió entra como contexto, no como prompt.
  // La primera vez está vacío y no pasa nada: el bloque solo aparece cuando hay
  // lecciones activas, y su presencia queda registrada en `traces`.
  const learning = await buildLearningContext({
    organizationId,
    role: 'president',
    industry: org.industry,
    task: `Recomendar ruta de crecimiento para ${org.name ?? org.domain} en ${org.industry ?? 'su industria'}`,
    kind: 'route_recommendation',
    runId,
  });

  let diagnosis: Diagnosis;
  let degraded = false;

  try {
    const result = await runStructured({
      step: 'diagnosis',
      schemaName: 'diagnosis',
      schema: DiagnosisSchema,
      system: DIAGNOSIS_SYSTEM,
      input: [buildDiagnosisInput({ org, answers, research, assumptions }), learning.block]
        .filter(Boolean)
        .join('\n\n'),
      organizationId,
      role: 'president',
      trigger: 'intake',
      runId,
      degradeTo: {
        schema: DiagnosisMinimalSchema,
        schemaName: 'diagnosis_minimal',
        inflate: inflateDiagnosis,
      },
    });
    diagnosis = result.data;
    degraded = result.degraded;
  } catch (err) {
    // Ni siquiera el esquema mínimo salió. Armamos el diagnóstico con lo que
    // el research y la aritmética ya nos dan: menos texto, mismos números.
    console.error('[diagnostic] el modelo falló por completo, ensamblando sin él', err);
    diagnosis = fallbackDiagnosis(org.name ?? org.domain, research);
    degraded = true;
  }

  // ── Fugas: montos del código, evidencia del modelo ───────────────────────
  const channels = research.sections.channels?.payload as
    | { bilingual_audience?: boolean; crawl_signals?: { languages?: string[] } }
    | undefined;
  const languageChannelDetected =
    Boolean(channels?.bilingual_audience) ||
    (channels?.crawl_signals?.languages?.length ?? 0) > 1 ||
    diagnosis.leaks.some((l) => l.key === 'language_channel');

  const leakContext: LeakContext = {
    languageChannelDetected,
    evidence: Object.fromEntries(
      diagnosis.leaks.map((l) => [
        l.key,
        { text: l.evidence, source_url: l.source_url, confidence: l.confidence },
      ]),
    ),
  };

  const leaks = computeLeaks(assumptions, leakContext);
  const inverseMath = computeInverseMath(assumptions);
  const total = totalLeakUsd(leaks);

  // ── Persistencia del diagnóstico ─────────────────────────────────────────
  //
  // Si dos llamadas concurrentes llegaron hasta acá (el usuario recargó, el
  // navegador reintentó), el índice único de `session_id` deja pasar una sola.
  // La que pierde relee la ganadora en vez de propagar el error: para el
  // cliente son dos peticiones que devuelven el mismo diagnóstico, que es
  // exactamente lo que promete la ruta.
  const inserted = await db()
    .from('diagnostics')
    .insert({
      organization_id: organizationId,
      session_id: sessionId,
      identity: diagnosis.identity,
      brand: diagnosis.brand,
      competitors: { list: diagnosis.position.competitors, summary: diagnosis.position.summary },
      market_position: {
        axis_x_label: diagnosis.position.axis_x_label,
        axis_y_label: diagnosis.position.axis_y_label,
        you: diagnosis.position.you,
      },
      leaks,
      assumptions,
      inverse_math: inverseMath,
      research_quality: researchQuality,
    })
    .select('id, share_token')
    .single();

  if (inserted.error) {
    if (isDuplicateSession(inserted.error.message)) {
      const winner = await findExisting(sessionId);
      if (winner) return winner;
    }
    throw new Error(`[db:diagnostics.insert] ${inserted.error.message}`);
  }

  const diagnostic = unwrap(inserted, 'diagnostics.insert');

  // ── Las 3 rutas ──────────────────────────────────────────────────────────
  const routes = buildRoutes(assumptions, inverseMath);
  const recommended = inverseMath.feasible ? diagnosis.recommended_route : 'whatsapp';

  // Sin recomendaciones el diagnóstico se renderiza sin las tres rutas, que es
  // la mitad del producto. Si esto falla, falla toda la generación.
  await mustWrite(
    db()
    .from('recommendations')
    .insert(
      routes.map((route) => ({
        diagnostic_id: diagnostic.id,
        route: route.route,
        rank: route.route === recommended ? 1 : route.route === 'whatsapp' ? 2 : 3,
        rationale:
          route.route === recommended
            ? diagnosis.recommended_rationale
            : diagnosis.route_notes[route.route] || route.tagline,
        roadmap: route.roadmap.map((m) => ({
          ...m,
          eta_date: isoInDays(m.eta_days),
        })),
        cost_infra_usd: route.cost_infra_usd,
        cost_fee_usd: route.cost_fee_usd,
        prerequisites: route.prerequisites,
        projected_impact: route.projected_impact,
        is_recommended: route.route === recommended,
      })),
    ),
    'recommendations.insert',
  );

  // ── Brief vivo: el único objeto de contexto (§13.2) ──────────────────────
  await writeBrief({ organizationId, org, answers, diagnosis, assumptions, inverseMath, leaks });

  // ── Los tres agentes ─────────────────────────────────────────────────────
  await provisionAgents(organizationId, {
    goalCustomers90d: assumptions.goal_customers_90d,
  });

  // ── La primera microdecisión de la empresa ───────────────────────────────
  //
  // Recomendar una ruta ES una decisión: hay tres opciones con costo y con
  // consecuencia, se escoge una, y en 90 días se va a poder saber si esa
  // elección funcionó. Registrarla acá es lo que hace que P1 no sea plomería
  // dormida: desde la primera sesión hay una decisión con predicción medible.
  //
  // Se registra DESPUÉS de provisionar agentes para poder colgarla del
  // President; si el agente no existiera, la decisión igual se guarda (la
  // columna es nullable a propósito).
  await recordRouteDecision({
    organizationId,
    runId,
    routes,
    recommended,
    diagnosis,
    assumptions,
    inverseMath,
    learning,
    researchQuality,
  });

  // ── Ángulos propuestos + su aprobación ───────────────────────────────────
  await proposeAngles(organizationId, diagnosis);

  // ── Escalamientos del President ──────────────────────────────────────────
  const escalations = [...diagnosis.escalations];
  if (!inverseMath.feasible && inverseMath.infeasible_reason) {
    escalations.push(inverseMath.infeasible_reason);
  }
  if (escalations.length > 0) {
    await raiseEscalation(organizationId, escalations);
  }

  await track('diagnostic_generated', {
    organizationId,
    sessionId,
    props: {
      research_quality: researchQuality,
      total_leak_usd: Math.round(total),
      recommended,
      degraded,
      feasible: inverseMath.feasible,
    },
  });

  await refreshScore(organizationId);

  // El costo de la corrida se reparte entre las decisiones que produjo. Se hace
  // acá y no solo en el cron nocturno para que el número esté disponible
  // enseguida: si el operador mira la decisión a los cinco minutos y ve
  // `cost_usd: null`, aprende a no confiar en la columna.
  await imputarCostos(organizationId);

  // ── Correo con el enlace permanente (§4.3) ───────────────────────────────
  if (session.contact_email) {
    await sendDiagnosticEmail({
      to: session.contact_email,
      name: session.contact_name,
      company: org.name ?? org.domain,
      shareToken: diagnostic.share_token,
      topLeakLabel: leaks[0]?.name ?? null,
    });
  }

  return {
    diagnosticId: diagnostic.id,
    shareToken: diagnostic.share_token,
    researchQuality,
    totalLeakUsd: total,
    degraded,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Registra la elección de ruta como microdecisión (P1).
 *
 * Las tres invariantes del sustrato se cumplen naturalmente acá, y eso no es
 * casualidad: si una elección no tiene tres opciones con costo, una razón y una
 * consecuencia medible, es que no era una elección.
 *
 *   opciones      las 3 rutas, con su costo real calculado por `buildRoutes`
 *   predicción    los clientes nuevos a 90 días de la cuenta al revés
 *   evidencia     las fuentes del research, las lecciones inyectadas, la
 *                 factibilidad aritmética
 *
 * Nunca lanza. Que el diagnóstico del cliente se caiga porque no se pudo
 * escribir el registro de la decisión sería exactamente al revés de lo que
 * queremos: el registro sirve al producto, no al contrario.
 */
async function recordRouteDecision(args: {
  organizationId: string;
  runId: string;
  routes: ReturnType<typeof buildRoutes>;
  recommended: string;
  diagnosis: Diagnosis;
  assumptions: Assumptions;
  inverseMath: ReturnType<typeof computeInverseMath>;
  learning: { lessonIds: string[]; humanInputIds: string[] };
  researchQuality: 'full' | 'partial' | 'none';
}): Promise<void> {
  try {
    const presidentId = await agentIdFor(args.organizationId, 'president');
    const elegida = args.routes.find((r) => r.route === args.recommended) ?? args.routes[0];

    await recordDecision({
      organizationId: args.organizationId,
      agentId: presidentId,
      role: 'president',
      runId: args.runId,
      kind: 'route_recommendation',
      question: '¿Con cuál de las tres rutas arrancamos?',
      context: { segment: 'diagnostico', channel: elegida.route },
      optionsConsidered: args.routes.map((route) => ({
        label: route.route,
        pros: route.bullets.slice(0, 2),
        cons: route.prerequisites.slice(0, 2),
        est_cost_usd: route.cost_infra_usd + route.cost_fee_usd,
        est_impact: route.tagline,
      })),
      chosen: {
        label: elegida.route,
        payload: {
          costo_infra_usd: elegida.cost_infra_usd,
          costo_fee_usd: elegida.cost_fee_usd,
          proyeccion: elegida.projected_impact,
        },
      },
      rationale: args.diagnosis.recommended_rationale,
      evidence: [
        {
          type: 'metric',
          ref: 'cuenta_al_reves',
          note: args.inverseMath.feasible
            ? `la meta de ${args.assumptions.goal_customers_90d} clientes es alcanzable con el volumen declarado`
            : (args.inverseMath.infeasible_reason ?? 'la meta no cierra con el volumen declarado'),
        },
        { type: 'source', ref: `research:${args.researchQuality}` },
        ...args.learning.lessonIds.map((id) => ({ type: 'lesson' as const, ref: id })),
        ...args.learning.humanInputIds.map((id) => ({ type: 'human' as const, ref: id })),
      ],
      lessonIds: args.learning.lessonIds,
      humanInputIds: args.learning.humanInputIds,
      prediction: {
        metric: 'clientes_nuevos_90d',
        expected_value: args.assumptions.goal_customers_90d,
        horizon_days: 90,
        // La confianza baja cuando el research no pudo leer el sitio o cuando la
        // aritmética no cierra: predecir con la misma seguridad en los dos casos
        // sería registrar una confianza que no tenemos.
        confidence: (args.researchQuality === 'full' ? 0.6 : 0.4) * (args.inverseMath.feasible ? 1 : 0.5),
        direction: 'up',
      },
      // Es reversible: cambiar de ruta antes de conectar canales no cuesta nada
      // más que la conversación.
      reversible: true,
    });
  } catch (err) {
    console.error('[diagnostic] no se pudo registrar la decisión de ruta', err);
  }
}

async function findExisting(sessionId: string): Promise<GenerateResult | null> {
  const { data } = await db()
    .from('diagnostics')
    .select('id, share_token, research_quality, leaks')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1);

  const existing = data?.[0];
  if (!existing) return null;

  return {
    diagnosticId: existing.id,
    shareToken: existing.share_token,
    researchQuality: (existing.research_quality ?? 'partial') as 'full' | 'partial' | 'none',
    totalLeakUsd: sumLeaks(existing.leaks),
    degraded: false,
  };
}

/** ¿El error es el índice único de `diagnostics(session_id)`? */
function isDuplicateSession(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate key|23505|diagnostics_session_key/i.test(message);
}

function buildDiagnosisInput(args: {
  org: { name: string | null; domain: string; website_url: string; industry: string | null; country: string | null };
  answers: Record<string, unknown>;
  research: Awaited<ReturnType<typeof findingsForOrganization>>;
  assumptions: Assumptions;
}): string {
  const { org, answers, research, assumptions } = args;

  const sourcesBlock = research.sources.length
    ? research.sources.map((s) => `- ${s.url} · ${s.title}`).join('\n')
    : '(sin fuentes: el research no pudo leer el sitio)';

  return [
    `EMPRESA: ${org.name ?? org.domain}`,
    `SITIO: ${org.website_url}`,
    org.industry ? `INDUSTRIA: ${org.industry}` : null,
    org.country ? `PAÍS: ${org.country}` : null,
    '',
    `CALIDAD DEL RESEARCH: ${research.status}`,
    '',
    'HALLAZGOS DEL RESEARCH',
    JSON.stringify(research.sections, null, 1).slice(0, 20_000),
    '',
    'FUENTES DISPONIBLES PARA CITAR (usa exactamente estas URLs, no inventes otras)',
    sourcesBlock,
    '',
    'RESPUESTAS DEL CLIENTE EN EL QUIZ',
    JSON.stringify(answers, null, 1).slice(0, 6_000),
    '',
    'SUPUESTOS YA CALCULADOS (no los recalcules, solo úsalos para razonar)',
    `- Contactos dormidos: ${assumptions.dormant_contacts}`,
    `- Ticket promedio: USD ${assumptions.avg_ticket_usd}`,
    `- Facturación mensual: USD ${assumptions.monthly_revenue_usd}`,
    `- Leads/mes estimados: ${assumptions.leads_per_month}`,
    `- Tasa de cierre asumida: ${Math.round(assumptions.close_rate * 100)}%`,
    `- Meta a 90 días: ${assumptions.goal_customers_90d} clientes`,
    `- Semanas disponibles: ${assumptions.weeks_available}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Último recurso: sin modelo, pero con research y aritmética. */
function fallbackDiagnosis(
  companyName: string,
  research: Awaited<ReturnType<typeof findingsForOrganization>>,
): Diagnosis {
  const offer = research.sections.offer?.payload as { summary?: string } | undefined;
  const competitors =
    (research.sections.competitors?.payload as { list?: { name: string; promise?: string }[] })
      ?.list ?? [];

  return inflateDiagnosis({
    identity_sentences: [
      offer?.summary || `${companyName} vende a través de su sitio web.`,
      'No pudimos confirmar el ICP con el sitio. Lo afinamos contigo en 10 minutos.',
      'El modelo de negocio queda por confirmar.',
    ],
    competitors: competitors.slice(0, 3).map((c) => ({ name: c.name, promise: c.promise ?? '' })),
    recommended_route: 'whatsapp',
    recommended_rationale:
      'Es la ruta que produce un resultado medible en 24 horas sin depender de calentamiento de dominios.',
    angles: [
      {
        name: 'Reactivación de base dormida',
        hypothesis: 'Los contactos que no compraron siguen teniendo el problema.',
        opener: 'Hola, te escribo porque hace un tiempo miraste lo que hacemos y quedó ahí. ¿Sigue en pie eso que estabas resolviendo?',
      },
    ],
  });
}

async function writeBrief(args: {
  organizationId: string;
  org: { name: string | null; domain: string; website_url: string; industry: string | null; currency: string };
  answers: Record<string, unknown>;
  diagnosis: Diagnosis;
  assumptions: Assumptions;
  inverseMath: ReturnType<typeof computeInverseMath>;
  leaks: ReturnType<typeof computeLeaks>;
}): Promise<void> {
  const content = {
    identidad: {
      empresa: args.org.name ?? args.org.domain,
      sitio: args.org.website_url,
      industria: args.org.industry,
      moneda: args.org.currency,
      frases: args.diagnosis.identity.sentences,
      modelo_de_negocio: args.diagnosis.identity.business_model,
    },
    oferta_principal: args.answers.main_offer ?? null,
    icp: args.diagnosis.position.summary,
    precios: {
      ticket_promedio_usd: args.assumptions.avg_ticket_usd,
      rango_declarado: args.answers.ticket_band ?? null,
    },
    metas: {
      clientes_90d: args.assumptions.goal_customers_90d,
      deadline: args.answers.goal_deadline ?? null,
      cuenta_al_reves: args.inverseMath,
    },
    fugas: args.leaks.map((l) => ({ key: l.key, name: l.name, usd_mes: Math.round(l.monthly_value_usd) })),
    tono: {
      descripcion: args.diagnosis.brand.tone,
      ejemplo_del_cliente: args.answers.tone ?? null,
    },
    // Las prohibiciones son duras: SALES las lee antes de cada envío.
    prohibiciones: [
      'No prometer precios fuera del rango declarado en este Brief.',
      'No usar un ángulo que no esté en estado approved.',
      'No contactar a nadie sin consent_basis registrado.',
      'No contactar a nadie en la lista de supresión.',
      ...(typeof args.answers.limits === 'string' && args.answers.limits.trim()
        ? [`Restricción declarada por el cliente: ${args.answers.limits.trim()}`]
        : []),
    ],
    ruta_recomendada: args.diagnosis.recommended_route,
    supuestos: args.assumptions,
  };

  // Un solo brief vigente por organización (índice único parcial). El orden
  // importa: primero se baja el vigente y después se inserta el nuevo, porque
  // al revés el índice rechazaría la inserción.
  await mustWrite(
    db()
      .from('briefs')
      .update({ is_current: false })
      .eq('organization_id', args.organizationId)
      .eq('is_current', true),
    'briefs.retire',
  );

  const { data: previous } = await db()
    .from('briefs')
    .select('version')
    .eq('organization_id', args.organizationId)
    .order('version', { ascending: false })
    .limit(1);

  // El Brief es el único objeto de contexto de los tres agentes (§13.2): sin
  // él no hay de dónde razonar. Nunca puede fallar en silencio.
  await mustWrite(
    db()
      .from('briefs')
      .insert({
        organization_id: args.organizationId,
        version: (previous?.[0]?.version ?? 0) + 1,
        created_by: 'president',
        content,
        is_current: true,
      }),
    'briefs.insert',
  );
}

/**
 * Los ángulos entran como `proposed`, no como `approved`. SALES no puede usar
 * un ángulo que no esté aprobado, así que esto crea trabajo real en la cola de
 * decisiones — que es el producto (§13.6).
 */
async function proposeAngles(organizationId: string, diagnosis: Diagnosis): Promise<void> {
  if (diagnosis.angles.length === 0) return;

  const inserted = await mustWrite(
    db()
      .from('angles')
      .insert(
        diagnosis.angles.slice(0, 8).map((a) => ({
          organization_id: organizationId,
          name: a.name,
          hypothesis: a.hypothesis,
          target_segment: a.target_segment,
          variants: [{ label: 'apertura', body: a.opener }],
          status: 'proposed',
        })),
      )
      .select('id, name, hypothesis, target_segment, variants'),
    'angles.insert',
  );

  const cmoId = await agentIdFor(organizationId, 'cmo');
  if ((inserted ?? []).length === 0) return;

  // La cola de decisiones ES el producto (§13.6). Un ángulo que se propone sin
  // su aprobación es un ángulo que SALES nunca va a poder usar y que nadie va a
  // ver: peor que no proponerlo.
  await mustWrite(
    db()
      .from('approvals')
      .insert(
        (inserted ?? []).map((angle) => ({
          organization_id: organizationId,
          agent_id: cmoId,
          kind: 'angle_new',
          title: `Ángulo propuesto: ${angle.name}`,
          rationale: angle.hypothesis,
          if_approved: 'SALES puede usar este ángulo en campañas del segmento asignado.',
          if_rejected: 'El ángulo queda retirado y el CMO propone otro en su lugar.',
          payload: { angle_id: angle.id, segment: angle.target_segment, variants: angle.variants },
          severity: 'normal',
        })),
      ),
    'approvals.angles',
  );
}

async function raiseEscalation(organizationId: string, reasons: string[]): Promise<void> {
  const presidentId = await agentIdFor(organizationId, 'president');

  await mustWrite(
    db().from('approvals').insert({
      organization_id: organizationId,
      agent_id: presidentId,
      kind: 'escalation',
      title: 'El President escaló el plan',
      rationale: reasons.join(' · '),
      if_approved: 'Se acepta el plan tal como está y se sigue adelante con el riesgo declarado.',
      if_rejected: 'Hay que ajustar la meta, el plazo o el canal antes de arrancar.',
      payload: { reasons },
      severity: 'high',
    }),
    'approvals.escalation',
  );
}

function sumLeaks(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.reduce(
    (sum: number, leak) => sum + Number((leak as { monthly_value_usd?: number })?.monthly_value_usd ?? 0),
    0,
  );
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    return num((value as { value: unknown }).value);
  }
  return undefined;
}
