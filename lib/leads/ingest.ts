import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { db } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import { ColumnMappingSchema, type ColumnMapping } from '@/lib/ai/schemas';
import { COLUMN_MAPPING_SYSTEM } from '@/config/prompts';
import { normalizeEmail } from '@/lib/utils';
import { track } from '@/lib/events';

/**
 * Carga de leads (PRD §4.6). El atajo de valor: es lo que sostiene la promesa
 * de "en 1 día empiezas a tener leads nuevos".
 *
 * Orden del pipeline, y cada paso importa:
 *   parsear → mapear columnas → normalizar → validar → deduplicar →
 *   segmentar por temperatura → insertar
 *
 * El mapeo de columnas usa IA porque los archivos que manda la gente real son
 * un desastre: "Nombre completo", "NOMBRE Y APELLIDO", "contacto", "Cliente",
 * o directamente sin encabezados. Un mapeo por diccionario acierta el 70%; el
 * modelo acierta casi siempre y cuesta menos de un centavo. Pero el mapeo por
 * diccionario corre PRIMERO: si acierta, nos ahorramos la llamada.
 *
 * Ver docs/wiki/07-leads-pipeline.md
 */

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

export interface IngestPreview {
  raw_count: number;
  valid_count: number;
  dup_count: number;
  invalid_count: number;
  phone_count: number;
  mapping: ColumnMapping['mapping'];
  detected_country: string | null;
  segments: Record<string, number>;
  sample: NormalizedLead[];
  notes: string[];
}

export interface NormalizedLead {
  full_name: string | null;
  email: string | null;
  phone_e164: string | null;
  company: string | null;
  title: string | null;
  last_interaction_at: string | null;
  temperature: 'hot' | 'warm' | 'cold' | 'dead';
  segment: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · PARSEO
// ═══════════════════════════════════════════════════════════════════════════

const MAX_ROWS = 50_000;

export function parseDelimited(text: string): ParsedFile {
  const result = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: 'greedy',
    // Papa detecta , ; \t solo. Los CSV colombianos exportados de Excel usan ;
    delimiter: '',
  });

  const rows = (result.data as string[][]).filter((r) => r.some((c) => String(c ?? '').trim()));
  if (rows.length === 0) return { headers: [], rows: [] };

  const first = rows[0].map((c) => String(c ?? '').trim());
  // ¿La primera fila es encabezado? Si ninguna celda parece un dato (correo,
  // teléfono largo), la tratamos como encabezado.
  const looksLikeData = first.some(
    (cell) => cell.includes('@') || /^\+?\d[\d\s().-]{7,}$/.test(cell),
  );

  if (looksLikeData) {
    return {
      headers: first.map((_, i) => `columna_${i + 1}`),
      rows: rows.slice(0, MAX_ROWS),
    };
  }

  return { headers: first, rows: rows.slice(1, MAX_ROWS + 1) };
}

export async function parseXlsx(buffer: Buffer): Promise<ParsedFile> {
  const rows = (await readXlsxFile(buffer)) as unknown as unknown[][];
  const clean = rows
    .map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c).trim())))
    .filter((r) => r.some((c) => c));
  if (clean.length === 0) return { headers: [], rows: [] };
  return { headers: clean[0], rows: clean.slice(1, MAX_ROWS + 1) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · MAPEO DE COLUMNAS
// ═══════════════════════════════════════════════════════════════════════════

/** Diccionario. Corre primero: si cubre lo esencial, no llamamos al modelo. */
const DICTIONARY: Record<keyof ColumnMapping['mapping'], string[]> = {
  full_name: ['nombre', 'name', 'nombre completo', 'full name', 'fullname', 'contacto', 'cliente', 'nombres', 'first name'],
  email: ['email', 'correo', 'e-mail', 'mail', 'correo electronico', 'correo electrónico', 'email address'],
  phone: ['telefono', 'teléfono', 'phone', 'celular', 'movil', 'móvil', 'whatsapp', 'mobile', 'numero', 'número', 'tel'],
  company: ['empresa', 'company', 'compania', 'compañia', 'compañía', 'organizacion', 'organización', 'negocio'],
  title: ['cargo', 'title', 'puesto', 'position', 'rol', 'job title'],
  last_interaction: ['ultima interaccion', 'última interacción', 'last interaction', 'fecha', 'date', 'ultimo contacto', 'último contacto', 'created', 'creado'],
};

function dictionaryMapping(headers: string[]): ColumnMapping['mapping'] {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').trim();

  const result: ColumnMapping['mapping'] = {
    full_name: null,
    email: null,
    phone: null,
    company: null,
    title: null,
    last_interaction: null,
  };

  for (const [field, aliases] of Object.entries(DICTIONARY) as [
    keyof ColumnMapping['mapping'],
    string[],
  ][]) {
    const hit = headers.find((h) => {
      const n = norm(h);
      return aliases.some((a) => n === a) || aliases.some((a) => n.includes(a));
    });
    if (hit) result[field] = hit;
  }

  return result;
}

export async function mapColumns(
  file: ParsedFile,
  organizationId: string,
): Promise<{ mapping: ColumnMapping['mapping']; country: string | null; notes: string[] }> {
  const notes: string[] = [];
  const dict = dictionaryMapping(file.headers);

  // Con correo o teléfono ya podemos trabajar. Nombre es deseable, no crítico.
  const dictIsEnough = Boolean(dict.email || dict.phone);

  if (dictIsEnough) {
    notes.push('Columnas reconocidas por nombre, sin gastar una llamada al modelo.');
    return { mapping: dict, country: guessCountry(file, dict), notes };
  }

  try {
    const sample = file.rows.slice(0, 8).map((r) => r.slice(0, 20));
    const result = await runStructured({
      step: 'extract',
      schemaName: 'column_mapping',
      schema: ColumnMappingSchema,
      system: COLUMN_MAPPING_SYSTEM,
      input: [
        `ENCABEZADOS: ${JSON.stringify(file.headers)}`,
        '',
        'FILAS DE MUESTRA:',
        sample.map((r) => JSON.stringify(r)).join('\n'),
      ].join('\n'),
      organizationId,
      role: 'sales',
      trigger: 'intake',
    });

    // El modelo puede devolver un nombre de columna que no existe. Validamos.
    const mapping = { ...result.data.mapping };
    for (const key of Object.keys(mapping) as (keyof ColumnMapping['mapping'])[]) {
      const value = mapping[key];
      if (value && !file.headers.includes(value)) mapping[key] = null;
    }

    if (result.data.notes) notes.push(result.data.notes);
    return {
      mapping,
      country: result.data.detected_country ?? guessCountry(file, mapping),
      notes,
    };
  } catch (err) {
    console.error('[leads] el mapeo con modelo falló, usando diccionario', err);
    notes.push('No pudimos mapear con IA. Revisa las columnas antes de continuar.');
    return { mapping: dict, country: guessCountry(file, dict), notes };
  }
}

function guessCountry(file: ParsedFile, mapping: ColumnMapping['mapping']): string | null {
  if (!mapping.phone) return null;
  const index = file.headers.indexOf(mapping.phone);
  if (index < 0) return null;

  const samples = file.rows.slice(0, 40).map((r) => String(r[index] ?? '')).filter(Boolean);
  const digits = samples.map((s) => s.replace(/\D/g, '')).filter((d) => d.length >= 7);
  if (digits.length === 0) return null;

  const colombian = digits.filter((d) => /^(57)?3\d{9}$/.test(d)).length;
  const usa = digits.filter((d) => /^1?\d{10}$/.test(d) && !/^3\d{9}$/.test(d)).length;
  const mexican = digits.filter((d) => /^52\d{10}$/.test(d)).length;

  if (colombian >= digits.length * 0.4) return 'CO';
  if (mexican >= digits.length * 0.4) return 'MX';
  if (usa >= digits.length * 0.4) return 'US';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · NORMALIZACIÓN Y SEGMENTACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/** Normalización de teléfonos a E.164, con el país detectado como default. */
export function normalizePhone(raw: string, country: string | null): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(
    trimmed,
    (country as CountryCode | undefined) ?? undefined,
  );
  if (parsed?.isValid()) return parsed.number;

  // Rescate para el caso colombiano más común: 10 dígitos empezando en 3,
  // escritos sin indicativo. libphonenumber los rechaza sin país.
  const digits = trimmed.replace(/\D/g, '');
  if (country === 'CO' && /^3\d{9}$/.test(digits)) return `+57${digits}`;
  if (!country && /^3\d{9}$/.test(digits)) return `+57${digits}`;

  return null;
}

/** Temperatura por última interacción (§4.6 — segmentación automática). */
export function temperatureOf(lastInteraction: Date | null): NormalizedLead['temperature'] {
  if (!lastInteraction) return 'cold';
  const days = (Date.now() - lastInteraction.getTime()) / 86_400_000;
  if (days < 30) return 'hot';
  if (days < 120) return 'warm';
  if (days < 540) return 'cold';
  return 'dead';
}

const SEGMENT_LABEL: Record<NormalizedLead['temperature'], string> = {
  hot: 'reactivacion_inmediata',
  warm: 'reactivacion_suave',
  cold: 'reactivacion_larga',
  dead: 'reengagement_final',
};

function parseDate(raw: string): Date | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  // dd/mm/yyyy es lo normal en LatAm y Date lo lee como mm/dd. Lo forzamos.
  const latam = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (latam) {
    const [, d, m, y] = latam;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeRows(
  file: ParsedFile,
  mapping: ColumnMapping['mapping'],
  country: string | null,
): { leads: NormalizedLead[]; invalid: number; duplicates: number } {
  const index = (column: string | null) => (column ? file.headers.indexOf(column) : -1);
  const idx = {
    full_name: index(mapping.full_name),
    email: index(mapping.email),
    phone: index(mapping.phone),
    company: index(mapping.company),
    title: index(mapping.title),
    last_interaction: index(mapping.last_interaction),
  };

  const seen = new Set<string>();
  const leads: NormalizedLead[] = [];
  let invalid = 0;
  let duplicates = 0;

  for (const row of file.rows) {
    const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');

    const email = normalizeEmail(cell(idx.email));
    const phone = normalizePhone(cell(idx.phone), country);

    // Sin correo válido y sin teléfono usable, no hay a quién escribirle.
    if (!email && !phone) {
      invalid += 1;
      continue;
    }

    const key = email ?? phone!;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    const lastInteraction = idx.last_interaction >= 0 ? parseDate(cell(idx.last_interaction)) : null;
    const temperature = temperatureOf(lastInteraction);

    leads.push({
      full_name: cell(idx.full_name) || null,
      email,
      phone_e164: phone,
      company: cell(idx.company) || null,
      title: cell(idx.title) || null,
      last_interaction_at: lastInteraction ? lastInteraction.toISOString() : null,
      temperature,
      segment: SEGMENT_LABEL[temperature],
    });
  }

  return { leads, invalid, duplicates };
}

export function summarize(
  file: ParsedFile,
  leads: NormalizedLead[],
  invalid: number,
  duplicates: number,
  mapping: ColumnMapping['mapping'],
  country: string | null,
  notes: string[],
): IngestPreview {
  const segments: Record<string, number> = {};
  for (const lead of leads) {
    segments[lead.temperature] = (segments[lead.temperature] ?? 0) + 1;
  }

  return {
    raw_count: file.rows.length,
    valid_count: leads.length,
    dup_count: duplicates,
    invalid_count: invalid,
    phone_count: leads.filter((l) => l.phone_e164).length,
    mapping,
    detected_country: country,
    segments,
    sample: leads.slice(0, 5),
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · PERSISTENCIA
// ═══════════════════════════════════════════════════════════════════════════

export async function persistBatch(args: {
  organizationId: string;
  filename: string | null;
  consentBasis: string;
  consentIp: string | null;
  mapping: ColumnMapping['mapping'];
  preview: IngestPreview;
  leads: NormalizedLead[];
  /** De dónde salió el lote. `upload` es el drag & drop; `instantly` viene de
   *  la integración (ADR 0009). Cambia la trazabilidad, no el procesamiento:
   *  la deduplicación y la supresión son las mismas para todos. */
  source?: 'upload' | 'apollo' | 'apify' | 'instantly' | 'manual' | 'inbound';
}): Promise<{ batchId: string; inserted: number; suppressed: number }> {
  const { data: batch, error } = await db()
    .from('lead_batches')
    .insert({
      organization_id: args.organizationId,
      source: args.source ?? 'upload',
      filename: args.filename,
      raw_count: args.preview.raw_count,
      valid_count: args.preview.valid_count,
      dup_count: args.preview.dup_count,
      invalid_count: args.preview.invalid_count,
      phone_count: args.preview.phone_count,
      column_mapping: args.mapping,
      segments: args.preview.segments,
      consent_basis: args.consentBasis,
      consent_ip: args.consentIp,
    })
    .select('id')
    .single();

  if (error || !batch) throw new Error(`[leads] no se pudo crear el lote: ${error?.message}`);

  // Supresión global: nadie en esa lista entra, aunque venga en el archivo.
  const { data: suppressions } = await db()
    .from('suppressions')
    .select('email, phone_e164')
    .eq('organization_id', args.organizationId);

  const blockedEmails = new Set(
    (suppressions ?? []).map((s) => s.email?.toLowerCase()).filter(Boolean),
  );
  const blockedPhones = new Set((suppressions ?? []).map((s) => s.phone_e164).filter(Boolean));

  const allowed = args.leads.filter(
    (l) =>
      !(l.email && blockedEmails.has(l.email)) && !(l.phone_e164 && blockedPhones.has(l.phone_e164)),
  );
  const suppressed = args.leads.length - allowed.length;

  // Dedup contra lo que YA está en la base.
  //
  // El índice único es sobre `coalesce(email, phone_e164)`, una expresión, y
  // PostgREST no puede apuntar un ON CONFLICT a un índice de expresión. Así
  // que filtramos en la aplicación: leemos las claves existentes y quitamos
  // las repetidas antes de insertar. El índice queda como red de seguridad
  // ante carreras, no como mecanismo principal.
  const existingKeys = new Set<string>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await db()
      .from('leads')
      .select('email, phone_e164')
      .eq('organization_id', args.organizationId)
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const key = row.email ?? row.phone_e164;
      if (key) existingKeys.add(key);
    }
    if (data.length < PAGE) break;
  }

  const fresh = allowed.filter((l) => !existingKeys.has(l.email ?? l.phone_e164!));
  const alreadyKnown = allowed.length - fresh.length;

  // En bloques: 50k filas en un insert revienta el límite de payload.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const chunk = fresh.slice(i, i + CHUNK).map((l) => ({
      organization_id: args.organizationId,
      batch_id: batch.id,
      full_name: l.full_name,
      email: l.email,
      phone_e164: l.phone_e164,
      company: l.company,
      title: l.title,
      last_interaction_at: l.last_interaction_at,
      temperature: l.temperature,
      segment: l.segment,
      status: 'new',
    }));

    const { data, error: insertError } = await db().from('leads').insert(chunk).select('id');
    if (insertError) {
      console.error('[leads] bloque rechazado, insertando fila por fila', insertError.message);
      for (const row of chunk) {
        const { data: single } = await db().from('leads').insert(row).select('id');
        if (single?.length) inserted += 1;
      }
    } else {
      inserted += data?.length ?? 0;
    }
  }

  if (alreadyKnown > 0) {
    await db()
      .from('lead_batches')
      .update({ dup_count: args.preview.dup_count + alreadyKnown })
      .eq('id', batch.id);
  }

  await db()
    .from('intake_sessions')
    .update({ status: 'leads_uploaded' })
    .eq('organization_id', args.organizationId)
    .in('status', ['diagnosed', 'connected', 'quiz']);

  await track('leads_uploaded', {
    organizationId: args.organizationId,
    props: {
      batch_id: batch.id,
      valid: args.preview.valid_count,
      inserted,
      suppressed,
      already_known: alreadyKnown,
      segments: args.preview.segments,
    },
  });

  return { batchId: batch.id, inserted, suppressed };
}
