import { db, unwrap, mustWrite, tryWrite } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import {
  ResearchSchema,
  ResearchMinimalSchema,
  inflateResearch,
  type ResearchOutput,
} from '@/lib/ai/schemas';
import { RESEARCH_SYSTEM } from '@/config/prompts';
import { crawlSite, crawlToPrompt } from '@/lib/research/crawl';
import { track } from '@/lib/events';
import { CURRENCY_BY_COUNTRY } from '@/config/assumptions';
import { lanzarDesdeElDiagnostico } from '@/lib/pruebas/lanzar';

/**
 * El motor de investigación (PRD §4.1, §8.3).
 *
 * Corre en background después de responder el intake. Escribe `progress_log`
 * a medida que avanza; el quiz lo lee por SSE. Nunca lanza hacia afuera: si
 * todo falla, marca el run como `partial` o `failed` y el diagnóstico se
 * genera igual con menos secciones (§8.3.5 — nunca dejamos al usuario sin
 * salida).
 *
 * Ver docs/wiki/04-motor-de-research.md
 */

const CACHE_DAYS = 30;
const MAX_ATTEMPTS = 2;

export interface ProgressEntry {
  t: string;
  step: string;
  detail: string;
}

/** Agrega una línea al progreso. Lectura-modificación-escritura: el único
 *  escritor de un run es su propio worker, así que no hay carrera real. */
export async function pushProgress(runId: string, step: string, detail: string): Promise<void> {
  try {
    const { data } = await db()
      .from('research_runs')
      .select('progress_log')
      .eq('id', runId)
      .single();

    const log: ProgressEntry[] = Array.isArray(data?.progress_log) ? data.progress_log : [];
    log.push({ t: new Date().toISOString(), step, detail });

    // El progreso es cosmético: si se pierde una línea, el ticker se ve más
    // callado. No vale la pena tumbar un research de 90 segundos por eso.
    await tryWrite(
      db()
        .from('research_runs')
        .update({ progress_log: log.slice(-40) })
        .eq('id', runId),
      'research_runs.progress',
    );
  } catch (err) {
    console.error('[research] no se pudo escribir progreso', err);
  }
}

/** ¿Ya investigamos este dominio hace poco? (§10 — costo por visitante) */
async function findCachedRun(organizationId: string, excludeRunId: string) {
  const since = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
  const { data } = await db()
    .from('research_runs')
    .select('id, status, finished_at')
    .eq('organization_id', organizationId)
    .in('status', ['done', 'partial'])
    .is('reused_from_run_id', null)
    .gte('finished_at', since)
    .neq('id', excludeRunId)
    .order('finished_at', { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

export async function executeResearch(runId: string): Promise<void> {
  const run = unwrap(
    await db()
      .from('research_runs')
      .select('id, organization_id, session_id, status, attempts')
      .eq('id', runId)
      .single(),
    'research_runs.get',
  );

  if (run.status === 'done' || run.status === 'partial') return;

  const org = unwrap(
    await db()
      .from('organizations')
      .select('id, name, website_url, domain, country, industry')
      .eq('id', run.organization_id)
      .single(),
    'organizations.get',
  );

  // Si esta marca no queda, el barrido vuelve a tomar la misma corrida y
  // pagamos el research dos veces. Es el estado que evita el trabajo duplicado.
  await mustWrite(
    db()
      .from('research_runs')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
        attempts: (run.attempts ?? 0) + 1,
      })
      .eq('id', runId),
    'research_runs.running',
  );

  // ── Cache por dominio ─────────────────────────────────────────────────────
  const cached = await findCachedRun(org.id, runId);
  if (cached) {
    await pushProgress(runId, 'cache', `Ya conocíamos ${org.domain} — recuperando el análisis`);
    await tryWrite(
      db()
        .from('research_runs')
        .update({
          status: cached.status,
          reused_from_run_id: cached.id,
          finished_at: new Date().toISOString(),
          cost_usd: 0,
        })
        .eq('id', runId),
      'research_runs.cached',
    );
    await track('research_reused', {
      organizationId: org.id,
      sessionId: run.session_id,
      props: { domain: org.domain, from: cached.id },
    });

    // El research se reusa; las pruebas de línea NO se saltan por eso. El
    // enfriamiento de 72 h de `lib/pruebas/lanzar.ts` es el que decide si esta
    // vez se escribe o no, y es la decisión correcta: el análisis del sitio
    // sigue valiendo un mes, pero que hoy contesten en dos minutos no dice
    // nada de si contestaban hace tres semanas.
    await lanzarPruebasDeLinea(org.id, run.session_id);
    return;
  }

  await track('research_started', { organizationId: org.id, sessionId: run.session_id });

  // ── Crawl propio: progreso real y aterrizaje del modelo ──────────────────
  const crawl = await crawlSite(org.website_url, (step, detail) =>
    pushProgress(runId, step, detail),
  );

  // ── Una llamada al modelo, con web search y el sitio ya leído ────────────
  await pushProgress(runId, 'competitors', 'Buscando con quién te comparan');

  try {
    const input = [
      `EMPRESA: ${org.name ?? org.domain}`,
      `SITIO: ${org.website_url}`,
      org.country ? `PAÍS DECLARADO: ${org.country}` : null,
      '',
      crawlToPrompt(crawl),
    ]
      .filter((line) => line !== null)
      .join('\n');

    const result = await runStructured({
      step: 'research',
      schemaName: 'research_findings',
      schema: ResearchSchema,
      system: RESEARCH_SYSTEM,
      input,
      organizationId: org.id,
      role: 'cmo',
      trigger: 'intake',
      degradeTo: {
        schema: ResearchMinimalSchema,
        schemaName: 'research_minimal',
        inflate: inflateResearch,
      },
    });

    const findings = result.data;

    // Fuentes: lo que citó el web search + lo que leímos nosotros.
    const crawlSources = crawl.pages.map((p) => ({
      url: p.url,
      title: p.title,
      retrieved_at: new Date().toISOString(),
    }));
    const modelSources = [...result.citations, ...findings.sources].map((s) => ({
      url: s.url,
      title: s.title,
      retrieved_at: new Date().toISOString(),
    }));
    const allSources = dedupeSources([...crawlSources, ...modelSources]);

    await persistFindings(runId, findings, crawl, allSources);
    await enrichOrganization(org.id, findings);

    const status = crawl.ok && findings.competitors.length >= 3 ? 'done' : 'partial';

    await pushProgress(
      runId,
      'done',
      findings.competitors.length
        ? `Encontramos ${findings.competitors.length} competidores · ${allSources.length} fuentes`
        : `Análisis listo · ${allSources.length} fuentes`,
    );

    // `tryWrite` en los cambios de estado terminales: si esta escritura falla,
    // la corrida se queda en `running` y el barrido de /api/cron/sweep la
    // recoge. Lanzar acá sería peor — mandaría al catch de abajo una corrida
    // que en realidad salió bien, y marcaría como fallido un research que ya
    // tiene sus hallazgos guardados.
    await tryWrite(
      db()
        .from('research_runs')
        .update({
          status,
          model: result.model,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          cost_usd: result.costUsd,
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId),
      'research_runs.finished',
    );

    await track(status === 'done' ? 'research_done' : 'research_partial', {
      organizationId: org.id,
      sessionId: run.session_id,
      props: {
        competitors: findings.competitors.length,
        cost_usd: result.costUsd,
        degraded: result.degraded,
        crawl_ok: crawl.ok,
      },
    });

    await lanzarPruebasDeLinea(org.id, run.session_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (run.attempts ?? 0) + 1;

    // Si el crawl sí funcionó, guardamos lo que leímos aunque el modelo falle.
    // Un diagnóstico con la oferta del cliente y sin competencia sigue sirviendo.
    if (crawl.ok && crawl.pages.length > 0) {
      await persistCrawlOnly(runId, crawl);
    }

    const terminal = attempts >= MAX_ATTEMPTS;
    await pushProgress(
      runId,
      terminal ? 'partial' : 'retry',
      terminal
        ? 'Análisis parcial — seguimos con lo que sí pudimos leer'
        : 'Reintentando el análisis',
    );

    await tryWrite(
      db()
        .from('research_runs')
        .update({
          status: terminal ? (crawl.ok ? 'partial' : 'failed') : 'queued',
          error: message.slice(0, 900),
          finished_at: terminal ? new Date().toISOString() : null,
        })
        .eq('id', runId),
      'research_runs.failed',
    );

    await track(terminal ? 'research_failed' : 'research_partial', {
      organizationId: org.id,
      sessionId: run.session_id,
      props: { error: message.slice(0, 300), attempts },
    });
  }
}

function dedupeSources<T extends { url: string }>(sources: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out.slice(0, 25);
}

async function persistFindings(
  runId: string,
  f: ResearchOutput,
  crawl: Awaited<ReturnType<typeof crawlSite>>,
  sources: { url: string; title: string; retrieved_at: string }[],
): Promise<void> {
  await mustWrite(
    db().from('research_findings').delete().eq('research_run_id', runId),
    'research_findings.clear',
  );

  const rows = [
    { section: 'offer', payload: f.offer, confidence: clamp01(f.offer.confidence) },
    { section: 'pricing', payload: f.pricing, confidence: clamp01(f.pricing.confidence) },
    { section: 'icp', payload: f.icp, confidence: clamp01(f.icp.confidence) },
    {
      section: 'competitors',
      payload: { list: f.competitors },
      confidence: f.competitors.length >= 3 ? 0.8 : 0.4,
    },
    { section: 'positioning', payload: f.positioning, confidence: clamp01(f.positioning.confidence) },
    {
      section: 'channels',
      payload: { ...f.channels, crawl_signals: crawl.signals },
      confidence: crawl.ok ? 0.9 : 0.3,
    },
    { section: 'social_proof', payload: f.social_proof, confidence: crawl.ok ? 0.8 : 0.3 },
    // El TEXTO de las páginas, no solo lo que el modelo extrajo de ellas.
    //
    // Se agregó con P7: la base de conocimiento del agente de agendamiento se
    // arma con las palabras del cliente, y las palabras del cliente estaban
    // pasando por el crawler y muriendo ahí. Guardarlas cuesta unos KB de jsonb
    // y evita volver a bajar el sitio cada vez que se reindexa.
    //
    // Confianza 1: es texto textual, no una inferencia. No hay nada que dudar.
    {
      section: 'pages',
      payload: {
        pages: crawl.pages.map((page) => ({
          url: page.url,
          title: page.title,
          description: page.description,
          text: page.text,
        })),
      },
      confidence: crawl.ok ? 1 : 0,
    },
    {
      section: 'meta',
      payload: {
        company_name: f.company_name,
        country: f.country,
        industry: f.industry,
        language: f.language,
        crawl_ok: f.crawl_ok && crawl.ok,
      },
      confidence: 1,
    },
  ];

  // Los hallazgos SON el research. Si esto no se guarda, el diagnóstico se
  // arma a ciegas y el cliente lee un texto genérico después de haber esperado
  // minuto y medio. Se prefiere marcar la corrida como fallida.
  await mustWrite(
    db().from('research_findings').insert(
      rows.map((r) => ({
        research_run_id: runId,
        section: r.section,
        payload: r.payload,
        confidence: r.confidence,
        sources,
      })),
    ),
    'research_findings.insert',
  );
}

/** Camino de rescate: el modelo falló pero el sitio sí se leyó. */
async function persistCrawlOnly(
  runId: string,
  crawl: Awaited<ReturnType<typeof crawlSite>>,
): Promise<void> {
  const sources = crawl.pages.map((p) => ({
    url: p.url,
    title: p.title,
    retrieved_at: new Date().toISOString(),
  }));

  const { data: existing } = await db()
    .from('research_findings')
    .select('id')
    .eq('research_run_id', runId)
    .limit(1);
  if (existing?.length) return;

  await mustWrite(
    db()
    .from('research_findings')
    .insert([
      {
        research_run_id: runId,
        section: 'offer',
        payload: {
          summary: crawl.pages[0]?.description || crawl.pages[0]?.title || '',
          products: [],
          confidence: 0.3,
          raw_title: crawl.pages[0]?.title ?? '',
        },
        confidence: 0.3,
        sources,
      },
      {
        research_run_id: runId,
        section: 'channels',
        payload: { detected: [], crawl_signals: crawl.signals },
        confidence: 0.9,
        sources,
      },
    ]),
    'research_findings.crawl_only',
  );
}

/** Lo que aprendimos del sitio se guarda en la organización: país, industria,
 *  moneda. Es lo que hace que las cifras salgan en pesos y no en dólares. */
async function enrichOrganization(organizationId: string, f: ResearchOutput): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (f.company_name) patch.name = f.company_name;
  if (f.industry) patch.industry = f.industry;
  if (f.country) {
    const iso = f.country.trim().toUpperCase().slice(0, 2);
    patch.country = iso;
    if (CURRENCY_BY_COUNTRY[iso]) patch.currency = CURRENCY_BY_COUNTRY[iso];
  }
  if (Object.keys(patch).length === 0) return;

  // Acá se decide la moneda del diagnóstico. Si no queda, el cliente colombiano
  // lee sus cifras en dólares — se ve mal, pero no rompe nada.
  await tryWrite(
    db().from('organizations').update(patch).eq('id', organizationId),
    'organizations.enrich',
  );
}

function clamp01(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

export interface FindingsBundle {
  status: string;
  sections: Record<string, { payload: unknown; confidence: number }>;
  sources: { url: string; title: string }[];
  runId?: string;
}

/** Hallazgos listos para consumir, siguiendo el puntero de caché si lo hay. */
export async function findingsForOrganization(
  organizationId: string,
): Promise<FindingsBundle> {
  const { data: runs } = await db()
    .from('research_runs')
    .select('id, status, reused_from_run_id, progress_log, error')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(5);

  const latest = runs?.[0];
  if (!latest) return { status: 'none', sections: {}, sources: [] };

  const sourceRunId = latest.reused_from_run_id ?? latest.id;
  const { data: findings } = await db()
    .from('research_findings')
    .select('section, payload, confidence, sources')
    .eq('research_run_id', sourceRunId);

  const sections: Record<string, { payload: unknown; confidence: number }> = {};
  const sources: { url: string; title: string }[] = [];
  for (const f of findings ?? []) {
    sections[f.section] = { payload: f.payload, confidence: Number(f.confidence ?? 0) };
    for (const s of (f.sources ?? []) as { url: string; title: string }[]) {
      if (!sources.some((existing) => existing.url === s.url)) sources.push(s);
    }
  }

  return { status: String(latest.status), sections, sources, runId: latest.id };
}

/**
 * Le escribe a la línea del prospecto, en cuanto sabemos cuál es.
 *
 * Se dispara acá y no al terminar el quiz porque éste es el primer instante en
 * que existen las dos cosas que hacen falta: los números que el sitio publica y
 * el material para especializar las preguntas. Y son cuatro o cinco minutos de
 * ventaja sobre el cliente, que todavía está respondiendo — cuando llegue al
 * diagnóstico, la primera prueba ya tiene respuesta, o ya sabemos que no la va
 * a tener. Esa ventaja es la diferencia entre mostrarle un resultado y
 * mostrarle un spinner.
 *
 * NUNCA LANZA y nunca bloquea. Un fallo acá no puede tocar el research: el
 * diagnóstico del cliente vale por sí solo y esto es evidencia encima.
 */
async function lanzarPruebasDeLinea(
  organizationId: string,
  sessionId: string | null,
): Promise<void> {
  try {
    const r = await lanzarDesdeElDiagnostico({ organizationId, sessionId });
    if (r.motivo) console.info(`[research] sin pruebas de línea: ${r.motivo}`);
  } catch (err) {
    console.error('[research] el lanzamiento de pruebas falló', err);
  }
}
