import OpenAI, { toFile } from 'openai';
import { db, unwrap, tryWrite } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { findingsForOrganization } from '@/lib/research/run';
import { authorize } from '@/lib/governance/authorize';
import { agentIdFor } from '@/lib/agents/contracts';
import { track } from '@/lib/events';
import { slugify } from '@/lib/utils';
import type { Playbook } from '@/lib/playbook/types';

/**
 * La base de conocimiento: el vector store del cliente en OpenAI.
 *
 * QUÉ ES Y QUÉ NO ES, porque la distinción decide todo el diseño del archivo:
 *
 *   NO es donde viven los hechos. Los hechos —qué vendemos, a qué precio, qué
 *   se responde a cada objeción— viven en el playbook, que entra completo en la
 *   instrucción de sistema de cada turno. Si vivieran acá, el agente tendría
 *   que hacer una búsqueda para saber qué vende, y una búsqueda que falla se
 *   convierte en un agente amnésico.
 *
 *   SÍ es donde el agente busca cuando le preguntan algo puntual que no está en
 *   el playbook: "¿ustedes trabajan en Barranquilla?", "¿tienen la
 *   certificación X?". Son las palabras del sitio del cliente, indexadas.
 *
 * La consecuencia práctica: **si esto falla, el agente sigue funcionando.** Se
 * marca `failed`, se corre sin `file_search`, y el cliente lo ve en la consola.
 * Un onboarding que se cae porque un índice no se construyó sería exactamente
 * el problema que estamos resolviendo.
 *
 * Ver docs/adr/0024-el-agente-se-compila-del-diagnostico.md
 */

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: env.openaiApiKey, maxRetries: 2, timeout: 120_000 });
  return client;
}

/**
 * Vencimiento del vector store.
 *
 * Los vector stores se cobran por GB/día pasado el primer GB gratis. Sin
 * vencimiento, cada prospecto que probó el producto y nunca volvió nos cuesta
 * plata para siempre — y en un lead magnet eso son la mayoría. 30 días desde el
 * último uso: un cliente activo lo renueva solo con trabajar, uno que se fue
 * deja de costar. Si vuelve, se reconstruye en 20 segundos.
 */
const DIAS_DE_VIDA = 30;

/** Tope de bytes por archivo. Un `text` de 6k caracteres por página no se acerca. */
const MAX_BYTES_POR_ARCHIVO = 400_000;

export interface KnowledgeResult {
  id: string;
  externalId: string | null;
  status: 'ready' | 'failed';
  fileCount: number;
  bytes: number;
  error: string | null;
}

export interface KnowledgeProgress {
  fase: 'redactando' | 'subiendo' | 'indexando' | 'listo';
  detalle: string;
}

export async function buildKnowledgeBase(args: {
  organizationId: string;
  playbook: Playbook;
  companyName: string;
  onProgress?: (p: KnowledgeProgress) => void;
}): Promise<KnowledgeResult> {
  const say = args.onProgress ?? (() => {});

  const permiso = await authorize({
    organizationId: args.organizationId,
    capabilityId: 'knowledge.index',
    agentId: await agentIdFor(args.organizationId, 'cmo'),
    title: 'Indexar la información del cliente',
  });
  if (permiso.accion_permitida === 'nada') {
    return await marcarFallo(args.organizationId, `sin permiso: ${permiso.reason ?? 'bloqueado'}`);
  }

  say({ fase: 'redactando', detalle: 'Reuniendo lo que dice tu sitio' });

  const research = await findingsForOrganization(args.organizationId);
  const archivos = componerArchivos({
    companyName: args.companyName,
    playbook: args.playbook,
    research,
  });

  if (archivos.length === 0) {
    return await marcarFallo(args.organizationId, 'no había nada que indexar');
  }

  // La fila se crea ANTES de llamar a OpenAI y en estado `building`. Si la
  // función se muere a mitad —timeout, deploy— queda el rastro de que se
  // intentó, en vez de un silencio que obliga a adivinar.
  const fila = unwrap(
    await db()
      .from('knowledge_bases')
      .insert({
        organization_id: args.organizationId,
        provider: 'openai',
        status: 'building',
        sources: archivos.map((a) => ({ nombre: a.nombre, origen: a.origen, bytes: a.contenido.length })),
        is_current: true,
      })
      .select('id')
      .single(),
    'knowledge_bases.insert',
  );

  try {
    say({ fase: 'subiendo', detalle: `Subiendo ${archivos.length} documentos` });

    const store = await openai().vectorStores.create({
      name: `holaamigo-${slugify(args.companyName)}-${args.organizationId.slice(0, 8)}`,
      // `last_active_at` y no `created_at`: lo que queremos borrar es lo que
      // nadie usa, no lo que es viejo. Un cliente de hace un año que conversa
      // todos los días tiene una base perfectamente viva.
      expires_after: { anchor: 'last_active_at', days: DIAS_DE_VIDA },
      metadata: {
        organization_id: args.organizationId,
        playbook_version: String(args.playbook.version),
      },
    });

    say({ fase: 'indexando', detalle: 'Indexando para que el agente pueda buscar' });

    const uploads = await Promise.all(
      archivos.map((a) => toFile(Buffer.from(a.contenido, 'utf8'), a.nombre, { type: 'text/markdown' })),
    );

    // `uploadAndPoll` espera a que el índice esté listo. Es la diferencia entre
    // "el agente ya puede buscar" y "el agente puede buscar en un rato": si
    // devolviéramos antes, el cliente probaría su agente en el simulador contra
    // un índice vacío y concluiría que no sabe nada de su negocio.
    const batch = await openai().vectorStores.fileBatches.uploadAndPoll(store.id, {
      files: uploads,
    });

    const bytes = archivos.reduce((sum, a) => sum + Buffer.byteLength(a.contenido, 'utf8'), 0);
    const fallidos = batch.file_counts?.failed ?? 0;

    await db()
      .from('knowledge_bases')
      .update({
        external_id: store.id,
        status: 'ready',
        file_count: batch.file_counts?.completed ?? archivos.length,
        bytes,
        built_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + DIAS_DE_VIDA * 86_400_000).toISOString(),
        error: fallidos > 0 ? `${fallidos} archivo(s) no se pudieron indexar` : null,
      })
      .eq('id', fila.id);

    say({ fase: 'listo', detalle: 'Tu agente ya puede consultar tu información' });

    await track('knowledge_base_built', {
      organizationId: args.organizationId,
      props: { files: archivos.length, bytes, failed: fallidos },
    });

    return {
      id: fila.id,
      externalId: store.id,
      status: 'ready',
      fileCount: batch.file_counts?.completed ?? archivos.length,
      bytes,
      error: fallidos > 0 ? `${fallidos} archivo(s) no se pudieron indexar` : null,
    };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error('[knowledge] falló la construcción', err);

    await tryWrite(
      db().from('knowledge_bases').update({ status: 'failed', error: mensaje }).eq('id', fila.id),
      'knowledge_bases.fail',
    );

    return { id: fila.id, externalId: null, status: 'failed', fileCount: 0, bytes: 0, error: mensaje };
  }
}

/** El vector store vigente y utilizable. `null` si no hay o si falló. */
export async function currentVectorStoreId(organizationId: string): Promise<string | null> {
  const { data } = await db()
    .from('knowledge_bases')
    .select('external_id, status, expires_at')
    .eq('organization_id', organizationId)
    .eq('is_current', true)
    .maybeSingle();

  if (!data || data.status !== 'ready' || !data.external_id) return null;

  // Un store vencido en OpenAI devuelve error al buscar, y ese error llega en
  // medio de una conversación con un contacto real. Se prefiere correr sin
  // `file_search` a arriesgar un turno perdido.
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;

  return data.external_id as string;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS ARCHIVOS
// ═══════════════════════════════════════════════════════════════════════════

interface ArchivoKB {
  nombre: string;
  origen: string;
  contenido: string;
}

/**
 * Qué se indexa y en qué archivo.
 *
 * Un archivo por tema y no un archivote con todo: el `file_search` devuelve
 * fragmentos, y un fragmento que empieza en la mitad de la sección de precios y
 * termina en la de competidores es un fragmento que confunde más de lo que
 * ayuda. Los encabezados son parte del contenido a propósito — el modelo los
 * lee y sabe de qué le están hablando.
 */
function componerArchivos(args: {
  companyName: string;
  playbook: Playbook;
  research: Awaited<ReturnType<typeof findingsForOrganization>>;
}): ArchivoKB[] {
  const { companyName, playbook, research } = args;
  const archivos: ArchivoKB[] = [];
  const seccion = (n: string) => research.sections[n]?.payload as Record<string, unknown> | undefined;

  // ── El negocio ──────────────────────────────────────────────────────────
  const offer = seccion('offer') as { summary?: string; products?: { name: string; description: string }[] } | undefined;
  const icp = seccion('icp') as { description?: string; segments?: string[] } | undefined;
  const positioning = seccion('positioning') as
    | { claim?: string; differentiators?: string[]; weaknesses?: string[] }
    | undefined;

  archivos.push({
    nombre: 'negocio.md',
    origen: 'research + playbook',
    contenido: [
      `# ${companyName}`,
      '',
      '## Qué vende',
      playbook.oferta.resumen,
      offer?.summary && offer.summary !== playbook.oferta.resumen ? offer.summary : '',
      '',
      '## Productos y servicios',
      ...(playbook.oferta.productos.length > 0
        ? playbook.oferta.productos.map((p) => `- **${p.nombre}**: ${p.descripcion}`)
        : ['No se pudieron identificar productos concretos en el sitio.']),
      '',
      '## A quién le sirve',
      icp?.description ?? 'Sin descripción del cliente ideal.',
      ...(icp?.segments?.length ? ['', 'Segmentos:', ...icp.segments.map((s) => `- ${s}`)] : []),
      '',
      '## A quién NO le sirve',
      ...(playbook.calificacion.fuera_de_alcance.length > 0
        ? playbook.calificacion.fuera_de_alcance.map((s) => `- ${s}`)
        : ['Sin restricciones declaradas.']),
      '',
      '## Qué lo hace distinto',
      positioning?.claim ?? '',
      ...(positioning?.differentiators?.map((d) => `- ${d}`) ?? []),
    ]
      .filter((l) => l !== '')
      .join('\n'),
  });

  // ── Precios ─────────────────────────────────────────────────────────────
  //
  // Se indexa aunque la política sea no darlos: el agente necesita SABER qué
  // hay publicado para no contradecir el sitio del cliente cuando el contacto
  // lo tenga abierto en otra pestaña.
  const pricing = seccion('pricing') as { is_public?: boolean; observed?: string[]; notes?: string } | undefined;
  archivos.push({
    nombre: 'precios.md',
    origen: 'research',
    contenido: [
      '# Precios',
      '',
      playbook.oferta.precio.politica === 'decir_rango'
        ? 'Estos precios están publicados en el sitio y se pueden mencionar TEXTUALMENTE.'
        : 'Este cliente NO publica precios. No se dan cifras por chat.',
      '',
      ...(pricing?.observed?.length
        ? ['## Publicados en el sitio', ...pricing.observed.map((p) => `- ${p}`)]
        : ['No hay precios públicos en el sitio.']),
      '',
      pricing?.notes ?? '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // ── Competencia ─────────────────────────────────────────────────────────
  const competitors = (seccion('competitors') as { list?: Array<{ name: string; promise?: string; positioning?: string }> } | undefined)?.list;
  if (competitors?.length) {
    archivos.push({
      nombre: 'competencia.md',
      origen: 'research',
      contenido: [
        '# Con quién nos comparan',
        '',
        'Si el contacto menciona a alguno, no lo criticamos: reconocemos y volvemos a lo nuestro.',
        '',
        ...competitors.map((c) =>
          [`## ${c.name}`, c.promise && `Prometen: ${c.promise}`, c.positioning && `Se posicionan: ${c.positioning}`]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n'),
    });
  }

  // ── Objeciones y FAQ: el playbook, otra vez, a propósito ────────────────
  //
  // Ya están en la instrucción de sistema. Se indexan IGUAL porque la búsqueda
  // semántica encuentra la objeción parecida que el modelo no relacionó: el
  // contacto no escribe "¿de dónde sacaste mi número?", escribe "quién te dio
  // mis datos", y ahí es donde el índice gana.
  archivos.push({
    nombre: 'objeciones.md',
    origen: 'playbook',
    contenido: [
      '# Objeciones y cómo se responden',
      '',
      ...playbook.objeciones.map((o) => `## ${o.objecion}\n${o.respuesta}`),
    ].join('\n\n'),
  });

  if (playbook.faq.length > 0) {
    archivos.push({
      nombre: 'preguntas-frecuentes.md',
      origen: 'playbook',
      contenido: ['# Preguntas frecuentes', '', ...playbook.faq.map((f) => `## ${f.pregunta}\n${f.respuesta}`)].join('\n\n'),
    });
  }

  // ── La cita ─────────────────────────────────────────────────────────────
  archivos.push({
    nombre: 'la-cita.md',
    origen: 'playbook',
    contenido: [
      '# La reunión que estamos agendando',
      '',
      `- Dura ${playbook.agendamiento.duracion_min} minutos.`,
      `- Modalidad: ${playbook.agendamiento.modalidad}.`,
      playbook.agendamiento.quien_atiende ? `- La atiende: ${playbook.agendamiento.quien_atiende}.` : '',
      `- Zona horaria: ${playbook.agendamiento.zona_horaria}.`,
      '',
      '## Qué pasa en ella',
      playbook.agendamiento.que_pasa_en_la_cita,
      '',
      '## Cómo se reprograma o cancela',
      playbook.agendamiento.url
        ? `Desde el mismo link de la confirmación: ${playbook.agendamiento.url}`
        : 'Escribiendo por este mismo chat.',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // ── El sitio, en sus palabras ───────────────────────────────────────────
  //
  // Es lo que hace que el agente conteste "sí, trabajamos en Barranquilla"
  // cuando eso está en la página de cobertura y en ningún otro lado. Sin esto
  // la base de conocimiento sería el playbook contado dos veces.
  const pages = (seccion('pages') as { pages?: Array<{ url: string; title: string; text: string }> } | undefined)?.pages;
  for (const [i, page] of (pages ?? []).entries()) {
    if (!page.text?.trim()) continue;
    archivos.push({
      nombre: `sitio-${i + 1}-${slugify(page.title || `pagina-${i + 1}`).slice(0, 40) || 'pagina'}.md`,
      origen: page.url,
      contenido: [`# ${page.title || page.url}`, '', `Fuente: ${page.url}`, '', page.text].join('\n'),
    });
  }

  return archivos
    .filter((a) => a.contenido.trim().length > 40)
    .map((a) => ({ ...a, contenido: a.contenido.slice(0, MAX_BYTES_POR_ARCHIVO) }))
    .slice(0, 24);
}

async function marcarFallo(organizationId: string, error: string): Promise<KnowledgeResult> {
  const { data } = await db()
    .from('knowledge_bases')
    .insert({ organization_id: organizationId, status: 'failed', error, is_current: true })
    .select('id')
    .maybeSingle();

  return {
    id: data?.id ?? '',
    externalId: null,
    status: 'failed',
    fileCount: 0,
    bytes: 0,
    error,
  };
}
