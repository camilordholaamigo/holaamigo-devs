import { db, mustWrite } from '@/lib/supabase/admin';
import { hasOpenAI } from '@/lib/env';
import { runStructured } from '@/lib/ai/client';
import { ChapterSchema } from '@/lib/ai/schemas';
import { CHAPTER_SYSTEM } from '@/config/prompts';
import { newRunId } from '@/lib/traces/record';
import { room } from '@/lib/deliberation/room';
import { priorizarFeed } from '@/lib/feed/priority';
import { isoInDays } from '@/lib/utils';

/**
 * El Capítulo: 150–250 palabras cada mañana.
 *
 * Es una **serie, no una notificación**. Se archiva y se puede leer de corrido
 * tres meses después: "¿qué estaba pasando en septiembre?" es una pregunta que
 * un dueño se hace, y hoy la única respuesta es abrir doce pantallas.
 *
 * La regla dura de este archivo, que es la de todo el producto (ADR 0007):
 * **el modelo narra, el código cuenta.** Las cifras se calculan antes de
 * llamarlo, se le pasan como lista cerrada, y si el texto que devuelve trae un
 * número que no está en esa lista, se descarta el texto y se publica la versión
 * determinista. Un número inventado en el capítulo es peor que un capítulo sin
 * números: el cliente no tiene cómo saber cuál de los dos es cierto, y deja de
 * creerle a los dos.
 *
 * Ver docs/wiki/17-la-sala-el-feed-y-el-capitulo.md
 */

export interface ChapterStats {
  enviados: number;
  respuestas: number;
  citas: number;
  decisiones: number;
  deliberaciones_abiertas: number;
  deliberaciones_resueltas: number;
  reaperturas: number;
  bloqueos_de_la_correa: number;
  pendientes_de_ti: number;
  costo_usd: number;
}

export interface ChapterResult {
  organizationId: string;
  dia: string;
  numero: number;
  titulo: string;
  body: string;
  stats: ChapterStats;
  needs_from_human: string[];
  degradado: boolean;
  saltado?: string;
}

/** Ayer, en cifras. Todas de la base, ninguna del modelo. */
export async function chapterStats(organizationId: string): Promise<ChapterStats> {
  const desde = isoInDays(-1);
  const hasta = new Date().toISOString();

  const [enviados, respuestas, citas, decisiones, deliberaciones, guard, cola] = await Promise.all([
    db()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('direction', 'out')
      .gte('sent_at', desde),
    db()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('direction', 'in')
      .gte('created_at', desde),
    db()
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .gte('created_at', desde),
    db()
      .from('decisions')
      .select('id, cost_usd', { count: 'exact' })
      .eq('organization_id', organizationId)
      .gte('created_at', desde),
    db()
      .from('deliberations')
      .select('id, status, opened_at, resolved_at, reopened_count')
      .eq('organization_id', organizationId)
      .gte('opened_at', desde),
    db()
      .from('guard_events')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('verdict', 'blocked')
      .gte('created_at', desde),
    priorizarFeed(organizationId),
  ]);

  const hilos = deliberaciones.data ?? [];

  return {
    enviados: enviados.count ?? 0,
    respuestas: respuestas.count ?? 0,
    citas: citas.count ?? 0,
    decisiones: decisiones.count ?? 0,
    deliberaciones_abiertas: hilos.filter((d) => d.status === 'open').length,
    deliberaciones_resueltas: hilos.filter(
      (d) => d.resolved_at && d.resolved_at >= desde && d.resolved_at <= hasta,
    ).length,
    reaperturas: hilos.reduce((sum, d) => sum + Number(d.reopened_count ?? 0), 0),
    bloqueos_de_la_correa: guard.count ?? 0,
    pendientes_de_ti: cola.mostrados.length + cola.postergados.length,
    costo_usd:
      Math.round(
        (decisiones.data ?? []).reduce((sum, d) => sum + Number(d.cost_usd ?? 0), 0) * 100,
      ) / 100,
  };
}

/**
 * Las cifras que el modelo tiene permitido escribir.
 *
 * Se incluyen los valores y nada más: si el capítulo dice "340 correos" y 340
 * está acá, pasa; si dice "un 12% de respuesta" y ese 12 no se calculó en
 * código, no pasa. Estricto a propósito — la versión determinista es legible y
 * el costo de rechazar un texto bueno es cero.
 */
function cifrasPermitidas(stats: ChapterStats): Set<number> {
  const permitidas = new Set<number>();
  for (const valor of Object.values(stats)) permitidas.add(Math.round(Number(valor)));
  // El día del mes y el número de capítulo aparecen de forma natural en la
  // prosa ("el capítulo 12", "el martes 16") y no son afirmaciones sobre el
  // negocio.
  for (let dia = 1; dia <= 31; dia += 1) permitidas.add(dia);
  return permitidas;
}

/** ¿El texto trae alguna cifra que no le dimos? Devuelve las intrusas. */
export function cifrasInventadas(texto: string, permitidas: Set<number>): number[] {
  const encontradas = texto.match(/\d[\d.,]*/g) ?? [];
  const intrusas: number[] = [];
  for (const bruto of encontradas) {
    const valor = Number(bruto.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
    if (!Number.isFinite(valor)) continue;
    if (!permitidas.has(Math.round(valor))) intrusas.push(valor);
  }
  return intrusas;
}

/** La versión sin modelo. Aburrida, corta y siempre cierta. */
export function chapterDeterminista(stats: ChapterStats): { titulo: string; body: string } {
  if (stats.enviados === 0 && stats.decisiones === 0 && stats.respuestas === 0) {
    return {
      titulo: 'Día tranquilo',
      body:
        'Ayer no salió nada y no hubo nada que decidir. La organización estuvo quieta. ' +
        (stats.pendientes_de_ti > 0
          ? `Quedan ${stats.pendientes_de_ti} cosas esperando tu decisión: mientras no las respondas, no avanzamos.`
          : 'No necesito nada de ti hoy.'),
    };
  }

  const partes = [
    `Ayer salieron ${stats.enviados} mensajes y contestaron ${stats.respuestas}.`,
    stats.citas > 0 ? `Se agendaron ${stats.citas} citas.` : null,
    stats.decisiones > 0
      ? `Los agentes tomaron ${stats.decisiones} decisiones, y costaron ${stats.costo_usd} dólares.`
      : null,
    stats.deliberaciones_resueltas > 0
      ? `Se cerraron ${stats.deliberaciones_resueltas} discusiones.`
      : null,
    stats.reaperturas > 0
      ? `Reabriste ${stats.reaperturas}: lo que escribiste cambió la recomendación.`
      : null,
    stats.bloqueos_de_la_correa > 0
      ? `La correa frenó ${stats.bloqueos_de_la_correa} acciones que se salían de lo que autorizaste.`
      : null,
    stats.pendientes_de_ti > 0
      ? `Quedan ${stats.pendientes_de_ti} cosas esperando tu decisión.`
      : 'No necesito nada de ti hoy.',
  ].filter(Boolean);

  return { titulo: 'El día de ayer', body: partes.join(' ') };
}

export async function writeChapter(
  organizationId: string,
  fecha = new Date(),
): Promise<ChapterResult> {
  const dia = fecha.toISOString().slice(0, 10);

  const { data: existente } = await db()
    .from('chapters')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('dia', dia)
    .maybeSingle();

  if (existente) {
    return {
      organizationId,
      dia,
      numero: existente.numero,
      titulo: existente.titulo,
      body: existente.body,
      stats: existente.stats as ChapterStats,
      needs_from_human: (existente.needs_from_human ?? []) as string[],
      degradado: false,
      saltado: 'ya estaba escrito',
    };
  }

  const stats = await chapterStats(organizationId);
  const { count: anteriores } = await db()
    .from('chapters')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId);
  const numero = (anteriores ?? 0) + 1;

  const fallback = chapterDeterminista(stats);
  let titulo = fallback.titulo;
  let body = fallback.body;
  let needs: string[] = [];
  let degradado = true;

  if (hasOpenAI()) {
    try {
      const hilos = await room(organizationId, { limit: 6 });
      const result = await runStructured({
        step: 'chapter',
        schemaName: 'chapter',
        schema: ChapterSchema,
        system: CHAPTER_SYSTEM,
        input: buildChapterInput(stats, hilos, numero),
        organizationId,
        role: 'president',
        trigger: 'cron',
        runId: newRunId(),
      });

      const intrusas = cifrasInventadas(result.data.body, cifrasPermitidas(stats));
      if (intrusas.length > 0) {
        // No se corrige ni se reintenta: se descarta. Reintentar cuesta y la
        // versión determinista ya dice lo mismo sin riesgo. Queda en el log
        // porque un modelo que inventa cifras seguido es una señal, no ruido.
        console.error(
          `[capitulo:${organizationId}] el modelo inventó cifras (${intrusas.join(', ')}); se publica la versión determinista`,
        );
      } else {
        titulo = result.data.titulo;
        body = result.data.body;
        needs = result.data.needs_from_human ?? [];
        degradado = false;
      }
    } catch (err) {
      console.error(`[capitulo:${organizationId}] el modelo falló, se publica lo determinista`, err);
    }
  }

  await mustWrite(
    db().from('chapters').insert({
      organization_id: organizationId,
      dia,
      numero,
      titulo,
      body,
      stats,
      needs_from_human: needs,
    }),
    'chapters.insert',
  );

  return { organizationId, dia, numero, titulo, body, stats, needs_from_human: needs, degradado };
}

function buildChapterInput(
  stats: ChapterStats,
  hilos: Awaited<ReturnType<typeof room>>,
  numero: number,
): string {
  const discusiones = hilos
    .filter((h) => h.turns.length > 0)
    .slice(0, 4)
    .map((h) => {
      const posiciones = h.dissent.length
        ? h.dissent.map((d) => `${d.agent} quería ${d.position} porque ${d.argument}`).join(' · ')
        : 'sin desacuerdo';
      const humano = h.turns.filter((t) => t.speaker_type === 'human');
      return [
        `PREGUNTA: ${h.question}`,
        `ESTADO: ${h.status}${h.reopened_count > 0 ? ` (reabierta ${h.reopened_count} veces)` : ''}`,
        `POSICIONES: ${posiciones}`,
        h.recommendation ? `SE DECIDIÓ: ${h.recommendation.summary}` : 'SIN RESOLVER',
        humano.length > 0 ? `EL CLIENTE DIJO: ${humano.map((t) => t.body).join(' | ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return [
    `CAPÍTULO NÚMERO ${numero}`,
    '',
    'CIFRAS PERMITIDAS (son las únicas que puedes escribir):',
    ...Object.entries(stats).map(([clave, valor]) => `- ${clave.replace(/_/g, ' ')}: ${valor}`),
    '',
    'LO QUE SE DISCUTIÓ',
    discusiones || '(no hubo deliberaciones)',
  ].join('\n');
}

export async function chaptersFor(organizationId: string, limit = 30) {
  const { data } = await db()
    .from('chapters')
    .select('*')
    .eq('organization_id', organizationId)
    .order('dia', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** Organizaciones que ya tienen agentes: las únicas con algo que narrar. */
export async function organizacionesConAgentes(limit = 200): Promise<string[]> {
  const { data } = await db().from('agents').select('organization_id').limit(2000);
  const vistas = new Set<string>();
  for (const row of data ?? []) {
    if (row.organization_id) vistas.add(row.organization_id as string);
    if (vistas.size >= limit) break;
  }
  return [...vistas];
}
