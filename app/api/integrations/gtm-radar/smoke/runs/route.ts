import { after, NextResponse } from 'next/server';
import { RunRequestSchema, acceptRun, serviceRadarSmoke, verifyMachineRequest } from '@/lib/integrations/gtm-radar-smoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('BODY_TOO_LARGE');
    const auth = verifyMachineRequest(raw, request.headers);
    const accepted = await acceptRun(RunRequestSchema.parse(JSON.parse(raw)), auth.idempotencyKey, raw);
    after(() => serviceRadarSmoke(accepted.request_id).catch((error) => console.error('[gtm-radar:after]', error)));
    return NextResponse.json(accepted, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RUN_FAILED';
    const status = /MACHINE_AUTH_INVALID/.test(message) ? 401 : /BODY_TOO_LARGE/.test(message) ? 413 : /Zod|JSON/.test(message) ? 400 : /PREFLIGHT_BLOCKED|IDEMPOTENCY_CONFLICT/.test(message) ? 409 : /DISABLED/.test(message) ? 503 : 503;
    console.error('[gtm-radar:run]', { code: message.split(':', 1)[0], status });
    return NextResponse.json({ error: status >= 500 ? 'RADAR_SMOKE_UNAVAILABLE' : message.split(':', 1)[0] }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
