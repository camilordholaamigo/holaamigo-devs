import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { serviceRadarSmoke } from '@/lib/integrations/gtm-radar-smoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!env.cronSecret || request.headers.get('authorization') !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await serviceRadarSmoke()) });
  } catch (error) {
    console.error('[cron:gtm-radar-smoke]', error);
    return NextResponse.json({ ok: false, error: 'RADAR_SMOKE_SERVICE_FAILED' }, { status: 500 });
  }
}
