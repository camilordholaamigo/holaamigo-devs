import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { verifyMachineRequest } from '@/lib/integrations/gtm-radar-smoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    verifyMachineRequest('', request.headers);
    const { requestId } = await params;
    const { data, error } = await db().from('radar_smoke_requests').select('id,connection_id,status,error_code,created_at,started_at,completed_at').eq('id', requestId).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'STATUS_FAILED';
    return NextResponse.json({ error: /MACHINE_AUTH_INVALID/.test(message) ? 'MACHINE_AUTH_INVALID' : 'STATUS_UNAVAILABLE' }, { status: /MACHINE_AUTH_INVALID/.test(message) ? 401 : 503 });
  }
}
