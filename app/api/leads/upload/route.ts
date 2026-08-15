import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { clientIp } from '@/lib/utils';
import { checkRateLimit, LIMITS } from '@/lib/ratelimit';
import { refreshScore } from '@/lib/scoring';
import {
  parseDelimited,
  parseXlsx,
  mapColumns,
  normalizeRows,
  summarize,
  persistBatch,
  type ParsedFile,
} from '@/lib/leads/ingest';
import type { ColumnMapping } from '@/lib/ai/schemas';

/**
 * POST /api/leads/upload — carga de leads (PRD §4.6).
 *
 * Dos modos sobre la misma ruta:
 *   mode=preview  → parsea, mapea con IA, normaliza y devuelve el resumen.
 *   mode=commit   → recibe el mapeo ya confirmado por el usuario y persiste.
 *
 * Por qué el archivo se manda dos veces en vez de guardar el parseo entre
 * pasos: el servidor queda sin estado, no hay que inventar un almacén temporal
 * de PII con TTL, y el archivo ya está en el navegador — reenviarlo no le
 * cuesta nada al usuario. La llamada al modelo ocurre solo en preview; en
 * commit el mapeo llega dado.
 *
 * SIN CHECKBOX DE BASE LEGAL NO SE PROCESA. Es la línea que no se cruza.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'No pudimos leer el archivo.' }, { status: 400 });
  }

  const mode = String(form.get('mode') ?? 'preview');
  const organizationId = String(form.get('organizationId') ?? '');
  const file = form.get('file');
  const pasted = form.get('pasted');

  if (!organizationId) {
    return NextResponse.json({ error: 'Falta la organización.' }, { status: 400 });
  }

  const { data: org } = await db()
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: 'Organización no encontrada.' }, { status: 404 });
  }

  const limit = await checkRateLimit(
    `upload:org:${organizationId}`,
    LIMITS.uploadPerOrg.limit,
    LIMITS.uploadPerOrg.windowSeconds,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Demasiadas cargas seguidas. Espera un momento.' },
      { status: 429 },
    );
  }

  // ── Parseo ────────────────────────────────────────────────────────────────
  let parsedFile: ParsedFile;
  let filename: string | null = null;

  try {
    if (typeof pasted === 'string' && pasted.trim()) {
      parsedFile = parseDelimited(pasted);
      filename = 'pegado-desde-portapapeles';
    } else if (file instanceof File) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: 'El archivo pesa más de 25 MB. Divídelo o exporta solo las columnas necesarias.' },
          { status: 413 },
        );
      }
      filename = file.name;
      const buffer = Buffer.from(await file.arrayBuffer());

      if (/\.xlsx?$/i.test(file.name)) {
        parsedFile = await parseXlsx(buffer);
      } else {
        parsedFile = parseDelimited(buffer.toString('utf-8'));
      }
    } else {
      return NextResponse.json({ error: 'Sube un archivo o pega los contactos.' }, { status: 400 });
    }
  } catch (err) {
    console.error('[leads] parseo fallido', err);
    return NextResponse.json(
      { error: 'No pudimos leer ese archivo. Prueba exportándolo como CSV.' },
      { status: 400 },
    );
  }

  if (parsedFile.rows.length === 0) {
    return NextResponse.json({ error: 'El archivo llegó vacío.' }, { status: 400 });
  }

  // ── Mapeo de columnas ─────────────────────────────────────────────────────
  let mapping: ColumnMapping['mapping'];
  let country: string | null;
  let notes: string[] = [];

  const providedMapping = form.get('mapping');
  if (typeof providedMapping === 'string' && providedMapping.trim()) {
    try {
      const raw = JSON.parse(providedMapping) as ColumnMapping['mapping'];
      mapping = raw;
      country = (form.get('country') as string) || null;
    } catch {
      return NextResponse.json({ error: 'Mapeo inválido.' }, { status: 400 });
    }
  } else {
    const result = await mapColumns(parsedFile, organizationId);
    mapping = result.mapping;
    country = result.country;
    notes = result.notes;
  }

  if (!mapping.email && !mapping.phone) {
    return NextResponse.json(
      {
        error: 'No encontramos ni correo ni teléfono en el archivo. Sin uno de los dos no hay a quién escribirle.',
        headers: parsedFile.headers,
        mapping,
      },
      { status: 422 },
    );
  }

  // ── Normalización y resumen ───────────────────────────────────────────────
  const { leads, invalid, duplicates } = normalizeRows(parsedFile, mapping, country);
  const preview = summarize(parsedFile, leads, invalid, duplicates, mapping, country, notes);

  if (mode === 'preview') {
    return NextResponse.json({ preview, headers: parsedFile.headers });
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  const consentBasis = String(form.get('consentBasis') ?? '').trim();
  if (!consentBasis) {
    return NextResponse.json(
      { error: 'Tienes que declarar la base legal sobre estos contactos.' },
      { status: 400 },
    );
  }

  if (leads.length === 0) {
    return NextResponse.json(
      { error: 'Ningún contacto quedó utilizable después de validar.' },
      { status: 422 },
    );
  }

  try {
    const result = await persistBatch({
      organizationId,
      filename,
      consentBasis,
      consentIp: clientIp(request.headers),
      mapping,
      preview,
      leads,
    });

    await refreshScore(organizationId);

    return NextResponse.json({
      batchId: result.batchId,
      inserted: result.inserted,
      suppressed: result.suppressed,
      preview,
      next: `/panel/${organizationId}`,
    });
  } catch (err) {
    console.error('[leads] commit fallido', err);
    return NextResponse.json({ error: 'No pudimos guardar los contactos.' }, { status: 500 });
  }
}
