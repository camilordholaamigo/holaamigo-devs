import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { db } from '@/lib/supabase/admin';

/**
 * De dónde salen los números a los que les escribimos.
 *
 * NINGÚN MODELO ELIGE UN NÚMERO. El crawler ya extrajo con regex los `wa.me/`
 * y los `tel:` del sitio del cliente y los guardó en
 * `research_findings.channels.crawl_signals`. Acá se normalizan, se ordenan y
 * se les pone la fuente. Un número de teléfono es exactamente el tipo de dato
 * que ADR 0007 prohíbe que salga de un modelo: el cliente lo va a leer en su
 * diagnóstico —«le escribimos a este número»— y si está mal, le escribimos a
 * un tercero.
 *
 * El orden es por evidencia, no por preferencia:
 *   1. Los `wa.me/…` — el negocio publicó ese número COMO WhatsApp. Certeza.
 *   2. Los `tel:` que además son celulares — probable WhatsApp.
 *   3. Los `tel:` fijos — se descartan: no tienen WhatsApp y escribirles es
 *      gastar un mensaje para reportar «no contestó», que sería mentira.
 */

export interface NumeroEncontrado {
  phone_e164: string;
  /** `wa.me` | `tel:` — qué evidencia tenemos de que es un WhatsApp. */
  evidencia: 'wa.me' | 'tel';
  /** La URL de la página donde lo leímos. Sin esto no entra (§13.4). */
  source_url: string | null;
  /** 0–1. Alta para wa.me, media para celular en tel:. */
  confianza: number;
}

/** Cuántos números se prueban como máximo por organización. */
export const MAX_NUMEROS = 3;

interface SenalesDelCrawl {
  whatsappNumbers?: unknown;
  phones?: unknown;
}

/**
 * Normaliza a E.164 usando el país que el research infirió.
 *
 * El fallback a Colombia no es chovinismo: `libphonenumber` rechaza un
 * `3001234567` sin país, y ese formato —diez dígitos empezando en 3— es como
 * está escrito el celular en casi todos los sitios colombianos, que es el
 * mercado donde opera esto. Sin el fallback perderíamos la mayoría de los
 * números del mercado principal. Cualquier otro formato sí exige indicativo.
 */
export function aE164(raw: string, country: CountryCode | null): string | null {
  const limpio = String(raw).trim();
  if (!limpio) return null;

  const parsed = parsePhoneNumberFromString(limpio, country ?? undefined);
  if (parsed?.isValid()) return parsed.number;

  const digitos = limpio.replace(/\D/g, '');
  if (/^3\d{9}$/.test(digitos)) return `+57${digitos}`;
  if (/^57 ?3\d{9}$/.test(digitos)) return `+${digitos}`;

  return null;
}

/** ¿Es un celular? Un fijo no tiene WhatsApp y escribirle no mide nada. */
function esMovil(e164: string): boolean {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return false;
  const tipo = parsed.getType();
  // `undefined` es lo que devuelve para números válidos de países donde la
  // librería no distingue tipo. Se acepta: descartar por no-saber perdería
  // números buenos, y el costo de un mensaje de más es un mensaje.
  return tipo === undefined || tipo === 'MOBILE' || tipo === 'FIXED_LINE_OR_MOBILE';
}

/**
 * Lee los números del research de una organización.
 *
 * Devuelve como máximo `MAX_NUMEROS`, ordenados por evidencia. Lista vacía si
 * el crawl falló o si el sitio no publica ningún número — que es en sí mismo
 * un hallazgo, y así se le cuenta al cliente.
 */
export async function numerosDelResearch(
  organizationId: string,
): Promise<{ numeros: NumeroEncontrado[]; pais: string | null; negocio: string | null }> {
  const { data: run } = await db()
    .from('research_runs')
    .select('id, status, reused_from_run_id')
    .eq('organization_id', organizationId)
    .in('status', ['done', 'partial'])
    .order('finished_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!run) return { numeros: [], pais: null, negocio: null };

  // Un run reutilizado apunta al original con `reused_from_run_id` en vez de
  // copiar los hallazgos (ADR 0004). Sin seguir el puntero, un cliente que
  // vuelve dentro de los 30 días se queda sin números.
  const runConHallazgos = run.reused_from_run_id ?? run.id;

  const { data: filas } = await db()
    .from('research_findings')
    .select('section, payload, sources')
    .eq('research_run_id', runConHallazgos)
    .in('section', ['channels', 'meta', 'pages']);

  const channels = filas?.find((f) => f.section === 'channels');
  const meta = filas?.find((f) => f.section === 'meta');
  const paginas = filas?.find((f) => f.section === 'pages');

  const senales = ((channels?.payload as { crawl_signals?: SenalesDelCrawl })?.crawl_signals ??
    {}) as SenalesDelCrawl;

  const metaPayload = (meta?.payload ?? {}) as { country?: string; company_name?: string };
  const pais = typeof metaPayload.country === 'string' ? metaPayload.country : null;
  const negocio = typeof metaPayload.company_name === 'string' ? metaPayload.company_name : null;
  const country = paisAIso(pais);

  // La home es la fuente por defecto: el crawler no guarda en qué página vio
  // cada número, y decir «lo leímos en tu sitio» con el link a la home es
  // honesto. Inventar la subpágina exacta no lo sería.
  const home =
    ((paginas?.payload as { pages?: Array<{ url?: string }> })?.pages?.[0]?.url as string) ?? null;

  const vistos = new Set<string>();
  const salida: NumeroEncontrado[] = [];

  const empujar = (raw: unknown, evidencia: NumeroEncontrado['evidencia']) => {
    if (typeof raw !== 'string' && typeof raw !== 'number') return;
    const e164 = aE164(String(raw), country);
    if (!e164 || vistos.has(e164)) return;
    if (evidencia === 'tel' && !esMovil(e164)) return;
    vistos.add(e164);
    salida.push({
      phone_e164: e164,
      evidencia,
      source_url: home,
      confianza: evidencia === 'wa.me' ? 0.95 : 0.6,
    });
  };

  if (Array.isArray(senales.whatsappNumbers)) {
    for (const n of senales.whatsappNumbers) empujar(n, 'wa.me');
  }
  if (Array.isArray(senales.phones)) {
    for (const n of senales.phones) empujar(n, 'tel');
  }

  return { numeros: salida.slice(0, MAX_NUMEROS), pais, negocio };
}

/**
 * El research devuelve el país en prosa («Colombia», «Mexico», «CO»).
 * `libphonenumber` quiere ISO-3166 de dos letras. Solo se mapean los mercados
 * donde operamos; para el resto se devuelve null y el número tiene que traer
 * su indicativo, que es lo correcto.
 */
function paisAIso(pais: string | null): CountryCode | null {
  if (!pais) return 'CO';
  const p = pais.trim().toLowerCase();
  if (p.length === 2) return p.toUpperCase() as CountryCode;
  if (p.includes('colomb')) return 'CO';
  if (p.includes('méxic') || p.includes('mexic')) return 'MX';
  if (p.includes('perú') || p.includes('peru')) return 'PE';
  if (p.includes('chile')) return 'CL';
  if (p.includes('argentin')) return 'AR';
  if (p.includes('ecuador')) return 'EC';
  if (p.includes('españ') || p.includes('spain')) return 'ES';
  if (p.includes('estados unidos') || p.includes('united states')) return 'US';
  return null;
}

/**
 * Registra los números como objetivos y devuelve las filas.
 *
 * Upsert sobre `phone_e164`, que es un índice único plano y por lo tanto sirve
 * de árbitro (ADR 0015). La clave es global y no por organización a propósito:
 * el enfriamiento y el bloqueo tienen que valer aunque el mismo número aparezca
 * en dos sitios distintos.
 *
 * `bloqueado` NO se toca en el upsert. Un número que pidió que no le
 * escribamos no se desbloquea porque alguien volvió a correr el diagnóstico.
 */
export async function registrarObjetivos(
  organizationId: string | null,
  numeros: NumeroEncontrado[],
  nombreNegocio: string | null,
): Promise<void> {
  if (numeros.length === 0) return;

  const filas = numeros.map((n) => ({
    organization_id: organizationId,
    nombre: nombreNegocio,
    phone_e164: n.phone_e164,
    origen: 'research' as const,
    source_url: n.source_url,
    confianza: n.confianza,
  }));

  const { error } = await db()
    .from('smoke_targets')
    .upsert(filas, { onConflict: 'phone_e164', ignoreDuplicates: false });

  if (error) {
    // No es `mustWrite`: si esto falla no hay prueba, pero el diagnóstico del
    // cliente sigue entero. Se registra ruidosamente y se sigue.
    console.error(`[pruebas] no se pudieron registrar los objetivos: ${error.message}`);
  }
}
