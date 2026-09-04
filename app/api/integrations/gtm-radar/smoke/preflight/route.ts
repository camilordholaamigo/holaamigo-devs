import { NextResponse } from 'next/server';
import { PreflightSchema, preflight, verifyMachineRequest } from '@/lib/integrations/gtm-radar-smoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await boundedBody(request);
    verifyMachineRequest(raw, request.headers);
    return NextResponse.json(await preflight(PreflightSchema.parse(JSON.parse(raw))), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

async function boundedBody(request: Request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('BODY_TOO_LARGE');
  return raw;
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'PREFLIGHT_FAILED';
  const status = /MACHINE_AUTH_INVALID/.test(message) ? 401 : /BODY_TOO_LARGE/.test(message) ? 413 : /Zod|JSON/.test(message) ? 400 : 503;
  console.error('[gtm-radar:preflight]', { code: message.split(':', 1)[0], status });
  return NextResponse.json({ error: status >= 500 ? 'PREFLIGHT_UNAVAILABLE' : message.split(':', 1)[0] }, { status, headers: { 'Cache-Control': 'no-store' } });
}
