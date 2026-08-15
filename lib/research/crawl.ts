/**
 * Crawler mínimo del sitio del cliente.
 *
 * POR QUÉ EXISTE (y no le delegamos todo al web_search del modelo):
 *
 *  1. Progreso real. El indicador vivo del quiz (§4.2) es lo que sostiene la
 *     atención durante 3 minutos, y el PRD dice que no puede ser decorativo.
 *     Una sola llamada al modelo de 90 segundos solo produce dos eventos:
 *     "empezó" y "terminó". Este crawler produce seis eventos verdaderos.
 *  2. Aterrizaje. El modelo con el texto real del sitio alucina muchísimo
 *     menos que el modelo buscando el sitio por su cuenta.
 *  3. Costo. Leer HTML es gratis. Cada token que el modelo no gasta buscando
 *     lo gasta razonando.
 *
 * Sin dependencias: extracción por regex. Para lo que necesitamos —título,
 * texto visible, links— un parser de DOM completo sería peso muerto.
 *
 * Ver docs/wiki/04-motor-de-research.md
 */

const UA =
  'Mozilla/5.0 (compatible; HolaAmigoBot/1.0; +https://holaamigo.co/bot) AppleWebKit/537.36';

const FETCH_TIMEOUT_MS = 9_000;
const MAX_HTML_BYTES = 900_000;
const MAX_TEXT_PER_PAGE = 6_000;

export interface CrawledPage {
  url: string;
  title: string;
  description: string;
  text: string;
}

export interface CrawlSignals {
  hasWhatsapp: boolean;
  whatsappNumbers: string[];
  hasContactForm: boolean;
  hasChatWidget: boolean;
  phones: string[];
  emails: string[];
  socials: string[];
  languages: string[];
  hasPricingPage: boolean;
  responsePromise: string | null;
}

export interface CrawlResult {
  ok: boolean;
  pages: CrawledPage[];
  signals: CrawlSignals;
  error: string | null;
}

/** Palabras que marcan una subpágina que vale la pena leer, en orden de valor. */
const INTERESTING = [
  { keys: ['precio', 'pricing', 'plan', 'tarifa', 'costo'], label: 'precios' },
  { keys: ['servicio', 'service', 'producto', 'product', 'solucion'], label: 'servicios' },
  { keys: ['nosotros', 'about', 'quienes', 'empresa', 'company'], label: 'nosotros' },
  { keys: ['caso', 'case', 'cliente', 'testimonio', 'portfolio'], label: 'casos' },
];

async function fetchText(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'es,en;q=0.8',
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > MAX_HTML_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    return { html: new TextDecoder('utf-8').decode(buffer), finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extract(pattern: RegExp, html: string): string {
  const match = html.match(pattern);
  return match?.[1]?.trim() ?? '';
}

function absoluteLinks(html: string, base: string): string[] {
  const links = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      links.add(url.toString());
    } catch {
      /* link roto, seguimos */
    }
  }
  return [...links];
}

function detectSignals(html: string, text: string, links: string[]): CrawlSignals {
  const lower = html.toLowerCase();

  const whatsappNumbers = [
    ...new Set(
      [...lower.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{7,15})/g)].map(
        (m) => m[1],
      ),
    ),
  ];

  const emails = [
    ...new Set(
      [...html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)]
        .map((m) => m[0].toLowerCase())
        .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/.test(e)),
    ),
  ].slice(0, 5);

  const phones = [
    ...new Set(
      [...html.matchAll(/tel:(\+?[\d\s().-]{7,20})/gi)].map((m) => m[1].replace(/\s+/g, '')),
    ),
  ].slice(0, 5);

  const socialHosts = ['instagram.com', 'facebook.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'x.com', 'twitter.com'];
  const socials = [
    ...new Set(
      links
        .map((l) => socialHosts.find((h) => l.includes(h)))
        .filter((h): h is string => Boolean(h)),
    ),
  ];

  const langs = [
    ...new Set(
      [...lower.matchAll(/hreflang\s*=\s*["']([a-z]{2})/g)].map((m) => m[1]),
    ),
  ];
  const htmlLang = extract(/<html[^>]*\blang\s*=\s*["']([a-zA-Z-]{2,5})["']/i, html)
    .slice(0, 2)
    .toLowerCase();
  if (htmlLang && !langs.includes(htmlLang)) langs.unshift(htmlLang);

  // Promesa de tiempo de respuesta: "respondemos en 24 horas", "en minutos".
  const promiseMatch = text.match(
    /(respond\w+|contest\w+|te escribimos|reply|response)[^.]{0,60}?(\d{1,3}\s*(minutos|horas|hours|min|h)\b|inmediat\w+|al instante|24\/7)/i,
  );

  return {
    hasWhatsapp: whatsappNumbers.length > 0 || lower.includes('whatsapp'),
    whatsappNumbers,
    hasContactForm: /<form\b/i.test(html) || lower.includes('contacto') || lower.includes('contact'),
    hasChatWidget: /intercom|drift|tawk|crisp|hubspot-messages|zendesk|tidio|livechat|manychat/i.test(lower),
    phones,
    emails,
    socials,
    languages: langs.slice(0, 4),
    hasPricingPage: links.some((l) =>
      INTERESTING[0].keys.some((k) => l.toLowerCase().includes(k)),
    ),
    responsePromise: promiseMatch ? promiseMatch[0].slice(0, 120) : null,
  };
}

/** Elige hasta `max` subpáginas del mismo dominio que valga la pena leer. */
function pickSubpages(links: string[], origin: string, max: number): { url: string; label: string }[] {
  const sameOrigin = links.filter((l) => {
    try {
      return new URL(l).origin === origin;
    } catch {
      return false;
    }
  });

  const picked: { url: string; label: string }[] = [];
  const seenLabels = new Set<string>();

  for (const group of INTERESTING) {
    if (picked.length >= max) break;
    if (seenLabels.has(group.label)) continue;
    const hit = sameOrigin.find((l) => {
      const path = l.toLowerCase().replace(origin.toLowerCase(), '');
      return group.keys.some((k) => path.includes(k)) && path.length < 90;
    });
    if (hit) {
      picked.push({ url: hit, label: group.label });
      seenLabels.add(group.label);
    }
  }
  return picked;
}

export interface CrawlProgress {
  (step: string, detail: string): Promise<void> | void;
}

export async function crawlSite(
  websiteUrl: string,
  onProgress: CrawlProgress = () => {},
): Promise<CrawlResult> {
  const domain = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  await onProgress('open', `Abriendo ${domain}`);

  const home = await fetchText(websiteUrl);
  if (!home) {
    await onProgress('blocked', `${domain} no se dejó leer — buscándolo por fuera`);
    return {
      ok: false,
      pages: [],
      signals: emptySignals(),
      error: 'no se pudo leer el sitio (bloqueo, timeout o no es HTML)',
    };
  }

  const origin = new URL(home.finalUrl).origin;
  const links = absoluteLinks(home.html, home.finalUrl);
  const homeText = stripToText(home.html);
  const signals = detectSignals(home.html, homeText, links);

  const homeTitle = extract(/<title[^>]*>([\s\S]*?)<\/title>/i, home.html);
  const homeDesc =
    extract(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, home.html) ||
    extract(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i, home.html);

  const pages: CrawledPage[] = [
    {
      url: home.finalUrl,
      title: homeTitle || domain,
      description: homeDesc,
      text: homeText.slice(0, MAX_TEXT_PER_PAGE),
    },
  ];

  const found: string[] = [];
  if (signals.hasWhatsapp) found.push('WhatsApp');
  if (signals.hasChatWidget) found.push('chat');
  if (signals.hasContactForm) found.push('formulario');
  await onProgress(
    'home',
    found.length
      ? `Leímos la home · canales visibles: ${found.join(', ')}`
      : 'Leímos la home',
  );

  const subpages = pickSubpages(links, origin, 3);
  for (const sub of subpages) {
    await onProgress('page', `Leyendo su página de ${sub.label}`);
    const page = await fetchText(sub.url);
    if (!page) continue;
    const text = stripToText(page.html);
    if (text.length < 120) continue;
    pages.push({
      url: page.finalUrl,
      title: extract(/<title[^>]*>([\s\S]*?)<\/title>/i, page.html) || sub.label,
      description: '',
      text: text.slice(0, MAX_TEXT_PER_PAGE),
    });
  }

  return { ok: true, pages, signals, error: null };
}

function emptySignals(): CrawlSignals {
  return {
    hasWhatsapp: false,
    whatsappNumbers: [],
    hasContactForm: false,
    hasChatWidget: false,
    phones: [],
    emails: [],
    socials: [],
    languages: [],
    hasPricingPage: false,
    responsePromise: null,
  };
}

/** Arma el bloque de contexto que va al modelo. */
export function crawlToPrompt(result: CrawlResult): string {
  if (!result.ok || result.pages.length === 0) {
    return 'EL SITIO NO SE PUDO LEER. Busca la marca en la web y devuelve solo lo que puedas sostener con fuente. Marca crawl_ok en false.';
  }

  const s = result.signals;
  const signalLines = [
    `WhatsApp visible: ${s.hasWhatsapp ? `sí${s.whatsappNumbers.length ? ` (${s.whatsappNumbers.join(', ')})` : ''}` : 'no'}`,
    `Widget de chat: ${s.hasChatWidget ? 'sí' : 'no'}`,
    `Formulario de contacto: ${s.hasContactForm ? 'sí' : 'no'}`,
    `Página de precios enlazada: ${s.hasPricingPage ? 'sí' : 'no'}`,
    s.languages.length ? `Idiomas declarados: ${s.languages.join(', ')}` : null,
    s.socials.length ? `Redes: ${s.socials.join(', ')}` : null,
    s.responsePromise ? `Promesa de respuesta en el sitio: "${s.responsePromise}"` : null,
  ].filter(Boolean);

  const pageBlocks = result.pages
    .map((p) => `--- ${p.url}\nTítulo: ${p.title}\n${p.description ? `Descripción: ${p.description}\n` : ''}${p.text}`)
    .join('\n\n');

  return `CONTENIDO REAL DEL SITIO (leído directamente, es fuente citable):

SEÑALES TÉCNICAS DETECTADAS
${signalLines.join('\n')}

PÁGINAS
${pageBlocks}`;
}
