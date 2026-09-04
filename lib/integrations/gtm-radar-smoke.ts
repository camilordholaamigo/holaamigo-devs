import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { db, mustWrite } from '@/lib/supabase/admin';
import { crearLote } from '@/lib/pruebas/lote';

const Uuid = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const HttpsUrl = z.string().url().max(2048).refine((value) => new URL(value).protocol === 'https:');
const Brand = z.object({
  candidate_id: Uuid,
  brand_id: Uuid,
  brand_name: z.string().trim().min(1).max(160),
  role: z.enum(['primary', 'competitor']),
  phone_e164: E164,
  whatsapp_url: HttpsUrl,
  source_page_url: HttpsUrl,
  observed_at: z.string().datetime(),
  evidence_hash: Sha256,
  confirmed_organization_id: Uuid.nullable().optional(),
}).strict();

export const PreflightSchema = z.object({
  schema_version: z.literal('radar-smoke-preflight-v1'),
  connection_id: Uuid,
  radar_variant_id: Uuid,
  primary_brand_id: Uuid,
  brands: z.array(Brand).min(1).max(5),
}).strict().superRefine(validateSelection);

export const RunRequestSchema = z.object({
  schema_version: z.literal('radar-smoke-run-v1'),
  connection_id: Uuid,
  radar_variant_id: Uuid,
  primary_brand_id: Uuid,
  brands: z.array(Brand).min(1).max(5),
  requested_at: z.string().datetime(),
  callback_url: HttpsUrl,
}).strict().superRefine(validateSelection);

type BrandInput = z.infer<typeof Brand>;
type RunRequest = z.infer<typeof RunRequestSchema>;
type BrandStatus = 'ready' | 'blocked' | 'cooldown' | 'invalid';
const TERMINAL = new Set(['completed', 'timeout', 'failed', 'cancelled']);
const COOLDOWN_MS = 72 * 60 * 60 * 1000;

function validateSelection(value: { primary_brand_id: string; brands: BrandInput[] }, context: z.RefinementCtx) {
  if (new Set(value.brands.map((brand) => brand.brand_id)).size !== value.brands.length) {
    context.addIssue({ code: 'custom', path: ['brands'], message: 'Each brand may be selected once' });
  }
  if (new Set(value.brands.map((brand) => brand.phone_e164)).size !== value.brands.length) {
    context.addIssue({ code: 'custom', path: ['brands'], message: 'A phone may belong to only one selected brand' });
  }
  if (!value.brands.some((brand) => brand.brand_id === value.primary_brand_id && brand.role === 'primary')) {
    context.addIssue({ code: 'custom', path: ['primary_brand_id'], message: 'Primary brand must be selected' });
  }
}

export function verifyMachineRequest(raw: string, headers: Headers, now = Date.now()) {
  const secret = env.gtmRadarMachineHmacKey;
  if (Buffer.byteLength(secret) < 32) throw new Error('MACHINE_AUTH_UNCONFIGURED');
  const timestamp = headers.get('x-growth-timestamp') ?? '';
  const idempotencyKey = headers.get('x-growth-idempotency-key') ?? '';
  const signature = headers.get('x-growth-signature') ?? '';
  const epoch = Date.parse(timestamp);
  if (!idempotencyKey || idempotencyKey.length > 200 || !Number.isFinite(epoch) || Math.abs(now - epoch) > 300_000) {
    throw new Error('MACHINE_AUTH_INVALID');
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${idempotencyKey}.${raw}`).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('MACHINE_AUTH_INVALID');
  }
  return { idempotencyKey };
}

export async function preflight(input: z.infer<typeof PreflightSchema>) {
  const parsed = PreflightSchema.parse(input);
  const [{ count: channels, error: channelError }, ...brandChecks] = await Promise.all([
    db().from('smoke_channels').select('id', { count: 'exact', head: true }).eq('activo', true),
    ...parsed.brands.map((brand) => inspectBrand(brand)),
  ]);
  if (channelError) throw new Error(`PREFLIGHT_CHANNELS_FAILED:${channelError.message}`);
  const available = channels ?? 0;
  const brands = brandChecks.map((item) => item as Awaited<ReturnType<typeof inspectBrand>>);
  return {
    schema_version: 'radar-smoke-preflight-response-v1' as const,
    connection_id: parsed.connection_id,
    ready: available > 0 && brands.every((brand) => brand.status === 'ready'),
    channels_available: available,
    estimated_conversations: parsed.brands.reduce((sum, brand) => sum + (brand.role === 'primary' ? 3 : 1), 0),
    brands,
  };
}

async function inspectBrand(brand: BrandInput): Promise<{ brand_id: string; status: BrandStatus; reason: string | null; organization_matches: Array<{ id: string; name: string | null; domain: string }> }> {
  if (!isCandidateConsistent(brand)) return { brand_id: brand.brand_id, status: 'invalid', reason: 'La URL pública no contiene el número seleccionado.', organization_matches: [] };
  const domain = normalizedDomain(brand.source_page_url);
  const [targetResult, organizationsResult] = await Promise.all([
    db().from('smoke_targets').select('bloqueado,ultima_prueba_at').eq('phone_e164', brand.phone_e164).maybeSingle(),
    db().from('organizations').select('id,name,domain').eq('domain', domain).limit(5),
  ]);
  if (targetResult.error) throw new Error(`PREFLIGHT_TARGET_FAILED:${targetResult.error.message}`);
  if (organizationsResult.error) throw new Error(`PREFLIGHT_ORG_FAILED:${organizationsResult.error.message}`);
  const matches = organizationsResult.data ?? [];
  if (brand.confirmed_organization_id && !matches.some((match) => match.id === brand.confirmed_organization_id)) {
    return { brand_id: brand.brand_id, status: 'invalid', reason: 'La organización confirmada no coincide con el dominio observado.', organization_matches: matches };
  }
  if (targetResult.data?.bloqueado) return { brand_id: brand.brand_id, status: 'blocked', reason: 'El número pidió no recibir más mensajes.', organization_matches: matches };
  const last = targetResult.data?.ultima_prueba_at ? Date.parse(targetResult.data.ultima_prueba_at) : 0;
  if (last && Date.now() - last < COOLDOWN_MS) return { brand_id: brand.brand_id, status: 'cooldown', reason: 'El número está dentro del enfriamiento de 72 horas.', organization_matches: matches };
  return { brand_id: brand.brand_id, status: 'ready', reason: null, organization_matches: matches };
}

export async function acceptRun(input: RunRequest, idempotencyKey: string, rawBody: string) {
  if (!env.gtmRadarSmokeEnabled) throw new Error('RADAR_SMOKE_DISABLED');
  const parsed = RunRequestSchema.parse(input);
  const bodyHash = sha256(rawBody);
  const existing = await db().from('radar_smoke_requests').select('id,connection_id,status,created_at,body_hash').eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existing.error) throw new Error(`RADAR_SMOKE_READ_FAILED:${existing.error.message}`);
  if (existing.data) {
    if (existing.data.body_hash !== bodyHash) throw new Error('RADAR_SMOKE_IDEMPOTENCY_CONFLICT');
    return accepted(existing.data.id, existing.data.connection_id, existing.data.status, existing.data.created_at);
  }
  const check = await preflight({ ...parsed, schema_version: 'radar-smoke-preflight-v1' });
  if (!check.ready) throw new Error('RADAR_SMOKE_PREFLIGHT_BLOCKED');
  const { data: inserted, error: insertError } = await db().rpc('accept_radar_smoke_request', {
    p_connection_id: parsed.connection_id,
    p_radar_variant_id: parsed.radar_variant_id,
    p_idempotency_key: idempotencyKey,
    p_body_hash: bodyHash,
    p_callback_url: parsed.callback_url,
    p_targets: parsed.brands,
  });
  if (insertError) throw new Error(`RADAR_SMOKE_REQUEST_INSERT_FAILED:${insertError.message}`);
  if (!inserted || typeof inserted !== 'object' || Array.isArray(inserted)) throw new Error('RADAR_SMOKE_REQUEST_INSERT_EMPTY');
  return accepted(String(inserted.id), String(inserted.connection_id), String(inserted.status), String(inserted.created_at));
}

function accepted(requestId: string, connectionId: string, status: string, acceptedAt: string) {
  const publicStatus = status === 'queued' ? 'accepted' : status;
  return { schema_version: 'radar-smoke-run-accepted-v1' as const, connection_id: connectionId, request_id: requestId, status: publicStatus, accepted_at: acceptedAt };
}

export async function serviceRadarSmoke(requestId?: string): Promise<{ started: number; finalized: number; delivered: number }> {
  let started = 0;
  let finalized = 0;
  let delivered = 0;
  const queuedQuery = db().from('radar_smoke_requests').select('id').eq('status', 'queued').order('created_at').limit(5);
  const { data: queued, error: queuedError } = requestId ? await queuedQuery.eq('id', requestId) : await queuedQuery;
  if (queuedError) throw new Error(`RADAR_SMOKE_QUEUE_FAILED:${queuedError.message}`);
  for (const row of queued ?? []) if (await executeRequest(row.id)) started += 1;

  const runningQuery = db().from('radar_smoke_requests').select('id').eq('status', 'running').limit(20);
  const { data: running, error: runningError } = requestId ? await runningQuery.eq('id', requestId) : await runningQuery;
  if (runningError) throw new Error(`RADAR_SMOKE_RUNNING_FAILED:${runningError.message}`);
  for (const row of running ?? []) if (await finalizeRequest(row.id)) finalized += 1;
  delivered += await deliverCallbacks(requestId);
  return { started, finalized, delivered };
}

async function executeRequest(requestId: string): Promise<boolean> {
  const claim = await db().from('radar_smoke_requests').update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', requestId).eq('status', 'queued').select('id').maybeSingle();
  if (claim.error) throw new Error(`RADAR_SMOKE_CLAIM_FAILED:${claim.error.message}`);
  if (!claim.data) return false;
  const { data: targets, error } = await db().from('radar_smoke_request_targets').select('*').eq('request_id', requestId).order('created_at');
  if (error) throw new Error(`RADAR_SMOKE_TARGETS_FAILED:${error.message}`);
  for (const target of targets ?? []) {
    try {
      const live = await inspectBrand({
        candidate_id: target.candidate_id, brand_id: target.external_brand_id, brand_name: target.brand_name,
        role: target.role, phone_e164: target.phone_e164, whatsapp_url: target.whatsapp_url,
        source_page_url: target.source_page_url, observed_at: target.created_at, evidence_hash: target.source_evidence_hash,
        confirmed_organization_id: target.organization_id,
      });
      if (live.status !== 'ready') throw new Error(`TARGET_${live.status.toUpperCase()}`);
      const { data: reservation, error: reservationError } = await db().rpc('reserve_radar_smoke_target', {
        p_phone_e164: target.phone_e164,
        p_organization_id: target.organization_id,
        p_name: target.brand_name,
        p_source_url: target.source_page_url,
      });
      if (reservationError) throw new Error(`TARGET_RESERVATION_FAILED:${reservationError.message}`);
      if (!reservation || typeof reservation !== 'object' || reservation.ready !== true) throw new Error(`TARGET_${String(reservation?.reason ?? 'RESERVATION_FAILED').toUpperCase()}`);
      const result = await crearLote({
        nombre: `GTM Radar · ${target.brand_name}`,
        proposito: 'prospeccion',
        objetivos: [{ organizationId: target.organization_id, telefono: target.phone_e164, nombre: target.brand_name, sourceUrl: target.source_page_url, confianza: 1 }],
        plantillas: target.role === 'primary' ? ['servicio', 'faq', 'ventas'] : ['servicio'],
        maxConcurrentes: 1,
        ritmoSegundos: 30,
        creadoPor: 'gtm-radar',
        notas: `connection:${requestId};brand:${target.external_brand_id}`,
      });
      if (!result.loteId || result.error) throw new Error(result.error ?? 'BATCH_NOT_CREATED');
      await mustWrite(db().from('radar_smoke_request_targets').update({ batch_id: result.loteId, status: 'running', updated_at: new Date().toISOString() }).eq('id', target.id), 'radar_smoke_target.running');
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 200) : 'TARGET_FAILED';
      await mustWrite(db().from('radar_smoke_request_targets').update({ status: 'failed', error_code: code, updated_at: new Date().toISOString() }).eq('id', target.id), 'radar_smoke_target.failed');
    }
  }
  return true;
}

async function finalizeRequest(requestId: string): Promise<boolean> {
  const { data: request, error: requestError } = await db().from('radar_smoke_requests').select('*').eq('id', requestId).single();
  if (requestError || !request) throw new Error(`RADAR_SMOKE_REQUEST_FAILED:${requestError?.message ?? 'missing'}`);
  const { data: targets, error: targetError } = await db().from('radar_smoke_request_targets').select('*').eq('request_id', requestId);
  if (targetError) throw new Error(`RADAR_SMOKE_TARGETS_FAILED:${targetError.message}`);
  const brands = [];
  for (const target of targets ?? []) {
    if (!target.batch_id) {
      brands.push({ brand_id: target.external_brand_id, role: target.role, status: 'failed', assessment: emptyAssessment() });
      continue;
    }
    const { data: probes, error: probeError } = await db().from('smoke_probes').select('estado,segundos_primera_respuesta,evaluacion').eq('batch_id', target.batch_id);
    if (probeError) throw new Error(`RADAR_SMOKE_PROBES_FAILED:${probeError.message}`);
    if (!probes?.length || probes.some((probe) => !TERMINAL.has(probe.estado))) return false;
    const assessment = aggregateAssessment(probes);
    const status = probes.every((probe) => probe.estado === 'failed' || probe.estado === 'cancelled') ? 'failed' : probes.some((probe) => probe.estado === 'failed' || probe.estado === 'cancelled' || !probe.evaluacion) ? 'partial' : 'completed';
    brands.push({ brand_id: target.external_brand_id, role: target.role, status, assessment });
    await mustWrite(db().from('radar_smoke_request_targets').update({ status, updated_at: new Date().toISOString() }).eq('id', target.id), 'radar_smoke_target.complete');
  }
  if (!brands.length) return false;
  const status = brands.every((brand) => brand.status === 'failed') ? 'failed' : brands.some((brand) => brand.status !== 'completed') ? 'partial' : 'completed';
  const completedAt = new Date().toISOString();
  const adminBatch = (targets ?? []).find((target) => target.batch_id)?.batch_id ?? null;
  const adminUrl = adminBatch && env.siteUrl.startsWith('https://') ? `${env.siteUrl}/admin/pruebas/lotes/${adminBatch}` : null;
  const unsigned = { schema_version: 'radar-smoke-result-v1' as const, connection_id: request.connection_id, request_id: request.id, radar_variant_id: request.radar_variant_id, status, completed_at: completedAt, admin_url: adminUrl, brands };
  const body = { ...unsigned, evidence_hash: sha256(JSON.stringify(unsigned)) };
  assertNoSensitiveCallback(body);
  await mustWrite(db().from('radar_smoke_callback_outbox').upsert({ request_id: request.id, idempotency_key: `result:${request.id}`, body, body_hash: sha256(JSON.stringify(body)), updated_at: completedAt }, { onConflict: 'request_id', ignoreDuplicates: true }), 'radar_smoke_outbox');
  await mustWrite(db().from('radar_smoke_requests').update({ status, completed_at: completedAt, updated_at: completedAt }).eq('id', request.id).eq('status', 'running'), 'radar_smoke_request.complete');
  return true;
}

async function deliverCallbacks(requestId?: string): Promise<number> {
  let query = db().from('radar_smoke_callback_outbox').select('*,radar_smoke_requests!inner(callback_url)').is('delivered_at', null).lte('next_attempt_at', new Date().toISOString()).lt('attempts', 20).limit(10);
  if (requestId) query = query.eq('request_id', requestId);
  const { data, error } = await query;
  if (error) throw new Error(`RADAR_SMOKE_OUTBOX_FAILED:${error.message}`);
  let delivered = 0;
  for (const item of data ?? []) {
    const raw = JSON.stringify(item.body);
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', env.gtmRadarMachineHmacKey).update(`${timestamp}.${item.idempotency_key}.${raw}`).digest('hex');
    try {
      const response = await fetch(item.radar_smoke_requests.callback_url, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-growth-timestamp': timestamp, 'x-growth-idempotency-key': item.idempotency_key, 'x-growth-signature': signature }, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      await mustWrite(db().from('radar_smoke_callback_outbox').update({ delivered_at: new Date().toISOString(), attempts: item.attempts + 1, last_error: null, updated_at: new Date().toISOString() }).eq('id', item.id), 'radar_smoke_outbox.delivered');
      delivered += 1;
    } catch (error) {
      const attempts = item.attempts + 1;
      const delayMinutes = Math.min(360, 2 ** Math.min(attempts, 8));
      await mustWrite(db().from('radar_smoke_callback_outbox').update({ attempts, last_error: error instanceof Error ? error.message.slice(0, 500) : 'CALLBACK_FAILED', next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(), updated_at: new Date().toISOString() }).eq('id', item.id), 'radar_smoke_outbox.retry');
    }
  }
  return delivered;
}

function aggregateAssessment(probes: Array<{ estado: string; segundos_primera_respuesta: number | null; evaluacion: unknown }>) {
  const evaluated = probes.map((probe) => probe.evaluacion).filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
  const values = (field: string) => evaluated.map((row) => Number(row[field])).filter(Number.isFinite);
  const avg = (field: string) => { const all = values(field); return all.length ? Math.round(all.reduce((sum, value) => sum + value, 0) / all.length) : null; };
  const responseTimes = probes.map((probe) => probe.segundos_primera_respuesta).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const suggestions = evaluated.flatMap((row) => Array.isArray(row.sugerencias) ? row.sugerencias : []).filter((value): value is string => typeof value === 'string').map(scrubSensitive).filter(Boolean);
  const safety = avg('riesgo_alucinacion');
  return {
    conversations: probes.length,
    answered: responseTimes.length,
    median_first_response_seconds: responseTimes.length ? responseTimes[Math.floor((responseTimes.length - 1) / 2)] : null,
    response: probes.length ? Math.round(responseTimes.length / probes.length * 100) : null,
    exactness: avg('exactitud'), tone: avg('tono'), completeness: avg('completitud'), proactivity: avg('proactividad'),
    hallucination_risk: safety === null ? null : 100 - safety,
    summary: probes.length ? `${responseTimes.length} de ${probes.length} conversaciones recibieron respuesta.` : null,
    recommendations: [...new Set(suggestions)].slice(0, 10),
  };
}

function emptyAssessment() {
  return { conversations: 0, answered: 0, median_first_response_seconds: null, response: null, exactness: null, tone: null, completeness: null, proactivity: null, hallucination_risk: null, summary: null, recommendations: [] };
}

function isCandidateConsistent(brand: BrandInput): boolean {
  try {
    const url = new URL(brand.whatsapp_url);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const raw = host === 'wa.me' ? url.pathname.split('/').filter(Boolean)[0] ?? '' : host === 'api.whatsapp.com' && url.pathname.replace(/\/+$/, '') === '/send' ? url.searchParams.get('phone') ?? '' : '';
    return `+${raw.replace(/\D/g, '')}` === brand.phone_e164;
  } catch { return false; }
}

function normalizedDomain(value: string): string {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function scrubSensitive(value: string): string { return value.replace(/\+[1-9]\d{7,14}/g, '[dato reservado]').slice(0, 500); }
function assertNoSensitiveCallback(value: unknown) {
  const raw = JSON.stringify(value);
  if (/"(?:phone|telefono|conversation|transcript|messages?)"\s*:/i.test(raw) || /\+[1-9]\d{7,14}/.test(raw)) throw new Error('RADAR_SMOKE_CALLBACK_SENSITIVE');
}
