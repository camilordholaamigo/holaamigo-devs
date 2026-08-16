import { createHash } from 'node:crypto';
import { db, tryWrite, unwrap } from '@/lib/supabase/admin';
import { hasOpenAI } from '@/lib/env';
import { runStructured } from '@/lib/ai/client';
import { CompetitorImpactSchema } from '@/lib/ai/schemas';
import { COMPETITOR_IMPACT_SYSTEM } from '@/config/prompts';
import { crawlSite } from '@/lib/research/crawl';
import { newRunId } from '@/lib/traces/record';
import { currentPositioning } from '@/lib/cmo/positioning';
import { pushFeedItem } from '@/lib/feed/items';

/**
 * Inteligencia competitiva continua.
 *
 * Job semanal: leer el sitio de cada competidor, guardar un snapshot por
 * sección y **alertar solo lo que cambió**. Un reporte semanal que llega igual
 * cuando no pasó nada se deja de leer en tres semanas, y entonces el que sí
 * importa tampoco se lee.
 *
 * El hash es lo que hace barato el trabajo: si la sección no cambió, no hay
 * diff que calcular ni modelo que llamar. El 90% de las semanas no cambia nada.
 *
 * Las ofertas de empleo son la señal más subestimada: una empresa que abre tres
 * vacantes de vendedores enterprise está diciendo hacia dónde va, y lo dice seis
 * meses antes de que se vea en su sitio.
 *
 * Ver docs/wiki/19-la-cmo-expandida.md
 */

export type Section = 'pricing' | 'offer' | 'jobs' | 'media' | 'home';

export interface CambioDetectado {
  competitor: string;
  section: Section;
  antes: string;
  despues: string;
  why_it_matters: string;
  severity: 'low' | 'normal' | 'high';
}

function hash(texto: string): string {
  return createHash('sha256').update(texto.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/**
 * Extrae las secciones que valen la pena de un crawl.
 *
 * Se normaliza el texto antes de hashear: espacios colapsados y minúsculas. Sin
 * eso, un rediseño que solo mueve saltos de línea dispara "cambió el precio" y
 * la alerta pierde su valor en la primera semana.
 */
function seccionesDe(paginas: Array<{ url: string; text: string }>): Record<Section, string> {
  const normalizar = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 4000);
  const buscar = (patron: RegExp) =>
    paginas.find((p) => patron.test(p.url) || patron.test(p.text.slice(0, 400)));

  const home = paginas[0];
  const precios = buscar(/preci|pricing|planes|tarifa/i);
  const empleo = buscar(/careers|jobs|empleo|trabaja|vacante/i);
  const oferta = buscar(/product|servicio|solucion|features/i);

  return {
    home: normalizar(home?.text ?? ''),
    pricing: normalizar(precios?.text ?? ''),
    jobs: normalizar(empleo?.text ?? ''),
    offer: normalizar(oferta?.text ?? ''),
    media: '',
  };
}

export async function snapshotCompetidor(args: {
  organizationId: string;
  competitor: string;
  url: string;
}): Promise<CambioDetectado[]> {
  const crawl = await crawlSite(args.url);
  if (!crawl.ok || crawl.pages.length === 0) {
    console.error(`[cmo:competencia] ${args.competitor} no se dejó leer`);
    return [];
  }

  const secciones = seccionesDe(crawl.pages.map((p) => ({ url: p.url, text: p.text })));
  const cambios: CambioDetectado[] = [];

  for (const [section, contenido] of Object.entries(secciones) as Array<[Section, string]>) {
    if (!contenido || contenido.length < 40) continue;

    const nuevoHash = hash(contenido);

    const { data: anterior } = await db()
      .from('competitor_snapshots')
      .select('content, content_hash')
      .eq('organization_id', args.organizationId)
      .eq('competitor', args.competitor)
      .eq('section', section)
      .order('captured_at', { ascending: false })
      .limit(1);

    const previo = anterior?.[0];

    await tryWrite(
      db().from('competitor_snapshots').insert({
        organization_id: args.organizationId,
        competitor: args.competitor,
        url: args.url,
        section,
        content: contenido,
        content_hash: nuevoHash,
      }),
      'competitor_snapshots.insert',
    );

    // Primera vez: se guarda la línea base y no se alerta. Alertar la primera
    // captura llenaría el feed de "cambió todo" el día que se agrega un
    // competidor, que es exactamente cuando el cliente no quiere ruido.
    if (!previo) continue;
    if (previo.content_hash === nuevoHash) continue;

    const impacto = await explicarCambio({
      organizationId: args.organizationId,
      competitor: args.competitor,
      section,
      antes: previo.content,
      despues: contenido,
    });

    const cambio = unwrap(
      await db()
        .from('competitor_changes')
        .insert({
          organization_id: args.organizationId,
          competitor: args.competitor,
          section,
          before_hash: previo.content_hash,
          after_hash: nuevoHash,
          diff: { antes: previo.content.slice(0, 1200), despues: contenido.slice(0, 1200) },
          why_it_matters: impacto.why_it_matters,
          severity: impacto.severity,
        })
        .select('id')
        .single(),
      'competitor_changes.insert',
    ) as { id: string };

    const item = await pushFeedItem({
      organizationId: args.organizationId,
      kind: 'alert',
      role: 'cmo',
      title: `${args.competitor} cambió su ${etiqueta(section)}`,
      body: impacto.why_it_matters,
      rationale: `Antes: "${recorte(previo.content)}"\nAhora: "${recorte(contenido)}"`,
      evidence: { competidor: args.competitor, seccion: etiqueta(section) },
      requires: 'nothing',
      severity: impacto.severity,
      // Un cambio por competidor y sección por semana: si el rival está
      // iterando su sitio todos los días, no queremos una alerta diaria.
      dedupeKey: `competidor-${args.competitor}-${section}-${semanaISO()}`,
    });

    if (item) {
      await db().from('competitor_changes').update({ feed_item_id: item.id }).eq('id', cambio.id);
    }

    cambios.push({
      competitor: args.competitor,
      section,
      antes: previo.content,
      despues: contenido,
      why_it_matters: impacto.why_it_matters,
      severity: impacto.severity,
    });
  }

  return cambios;
}

/**
 * Por qué importa el cambio.
 *
 * El modelo escribe la explicación citando el antes y el después; no inventa
 * cifras porque las dos versiones del texto van en el input. Si no hay modelo,
 * queda la versión determinista — peor redactada y igual de cierta.
 */
async function explicarCambio(args: {
  organizationId: string;
  competitor: string;
  section: Section;
  antes: string;
  despues: string;
}): Promise<{ why_it_matters: string; severity: 'low' | 'normal' | 'high' }> {
  const severidadPorSeccion: Record<Section, 'low' | 'normal' | 'high'> = {
    pricing: 'high',
    offer: 'normal',
    jobs: 'normal',
    home: 'low',
    media: 'low',
  };

  const determinista = {
    why_it_matters: `Cambió la sección de ${etiqueta(args.section)} de ${args.competitor}. Vale la pena mirar el antes y el después antes de reaccionar.`,
    severity: severidadPorSeccion[args.section],
  };

  if (!hasOpenAI()) return determinista;

  try {
    const posicionamiento = await currentPositioning(args.organizationId);
    const result = await runStructured({
      step: 'classify',
      schemaName: 'competitor_impact',
      schema: CompetitorImpactSchema,
      system: COMPETITOR_IMPACT_SYSTEM,
      input: [
        `COMPETIDOR: ${args.competitor}`,
        `SECCIÓN: ${etiqueta(args.section)}`,
        '',
        'ANTES',
        args.antes.slice(0, 2000),
        '',
        'DESPUÉS',
        args.despues.slice(0, 2000),
        '',
        posicionamiento
          ? `POSICIONAMIENTO DEL CLIENTE: ${posicionamiento.statement}\nSUS DIFERENCIADORES: ${posicionamiento.differentiators.join(' · ')}`
          : 'POSICIONAMIENTO DEL CLIENTE: sin declarar',
      ].join('\n'),
      organizationId: args.organizationId,
      role: 'cmo',
      trigger: 'cron',
      runId: newRunId(),
    });
    return result.data;
  } catch (err) {
    console.error('[cmo:competencia] el modelo no pudo explicar el cambio', err);
    return determinista;
  }
}

/** Los competidores que el diagnóstico ya identificó. No se piden dos veces. */
export async function competidoresDe(
  organizationId: string,
): Promise<Array<{ name: string; url: string }>> {
  const { data } = await db()
    .from('diagnostics')
    .select('competitors')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1);

  const lista = (data?.[0]?.competitors as { list?: Array<{ name: string; url: string | null }> })?.list ?? [];
  return lista
    .filter((c) => c.url && /^https?:\/\//.test(c.url))
    .map((c) => ({ name: c.name, url: c.url as string }))
    .slice(0, 5);
}

export async function cambiosRecientes(organizationId: string, limit = 20) {
  const { data } = await db()
    .from('competitor_changes')
    .select('*')
    .eq('organization_id', organizationId)
    .order('detected_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

function etiqueta(section: Section): string {
  const nombres: Record<Section, string> = {
    pricing: 'precios',
    offer: 'oferta',
    jobs: 'vacantes',
    media: 'prensa',
    home: 'página principal',
  };
  return nombres[section];
}

function recorte(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Semana ISO, para deduplicar alertas del mismo competidor. */
function semanaISO(fecha = new Date()): string {
  const lunes = new Date(fecha);
  lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7));
  return lunes.toISOString().slice(0, 10);
}
