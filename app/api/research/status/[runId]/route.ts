import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';

/**
 * GET /api/research/status/[runId] — fallback de polling (PRD §8.3.3).
 *
 * El camino normal es SSE. Esto existe para navegadores o proxies corporativos
 * que cortan `text/event-stream`, que sí pasa y no queremos que rompa el quiz.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const { data, error } = await db()
    .from('research_runs')
    .select('id, status, progress_log, error, finished_at')
    .eq('id', runId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'no disponible' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'no encontrado' }, { status: 404 });

  return NextResponse.json(
    {
      status: data.status,
      progress: data.progress_log ?? [],
      finished: ['done', 'partial', 'failed'].includes(data.status),
      error: data.error ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
