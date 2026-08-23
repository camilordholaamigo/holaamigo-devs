import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

// ─── Diagnose endpoint ──────────────────────────────────────────────────────
// Returns env-var status, the latest smoke_test_run + its results, and the
// most recent admin_logs rows for the smoke tester. Use this to figure out
// why a run "didn't do anything" without needing Supabase access.

export async function GET(_req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }
  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })
  }

  const db = createAdminClient()

  // Latest run for this empresa
  const { data: latestRunRows } = await db
    .from('smoke_test_runs')
    .select('id, suite_id, status, total_sequences, completed_sequences, started_at, completed_at, created_at')
    .eq('empresa_id', profile.empresa_id)
    .order('created_at', { ascending: false })
    .limit(1)

  const latestRun = latestRunRows?.[0] ?? null

  // Results for that run
  let latestResults: unknown[] = []
  if (latestRun) {
    const { data: resultRows } = await db
      .from('smoke_test_results')
      .select('id, status, error_message, awaiting_reply, conversation, started_at, completed_at')
      .eq('run_id', (latestRun as { id: string }).id)
      .order('created_at', { ascending: true })
    latestResults = resultRows || []
  }

  // Recent logs from the smoke tester sources
  const { data: logRows } = await db
    .from('admin_logs')
    .select('level, source, message, context, created_at')
    .in('source', ['smoke-runner', 'smoke-webhook', 'smoker-tester-webhook'])
    .order('created_at', { ascending: false })
    .limit(30)

  return NextResponse.json({
    env: {
      WZAP_URL: !!process.env.WZAP_URL,
      WZAP_TOKEN: !!process.env.WZAP_TOKEN,
      WZAP_DEVICE: !!process.env.WZAP_DEVICE,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    },
    latest_run: latestRun,
    latest_results: latestResults,
    recent_logs: logRows || [],
  })
}
