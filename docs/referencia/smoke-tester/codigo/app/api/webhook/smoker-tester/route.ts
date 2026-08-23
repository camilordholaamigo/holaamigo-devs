import { NextRequest, NextResponse } from 'next/server'
import { handleSmokeTesterWebhook } from '@/lib/smoke-tester/webhook-handler'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
// 300s permite que continueFormTriggeredRun (en webhook-handler) viva el tiempo
// que necesita waitForReply (4 min por mensaje) sin que Vercel mate la función
// tras devolver 200 al wzap. Sin esto: webhook devuelve 200 → función muere a
// los 30s → runner queda sin enviar buyer2.
export const maxDuration = 300

// ─── Smoke Tester webhook (wzap.chat) ────────────────────────────────────────
// Configure this URL in your wzap.chat device → Settings → Webhook.
// Path: /api/webhook/smoker-tester
//
// We always return 200 so wzap doesn't disable the webhook on transient errors.

export async function POST(req: NextRequest) {
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ status: 'ok', note: 'invalid json' }, { status: 200 })
  }

  try {
    const consumed = await handleSmokeTesterWebhook(body as Record<string, unknown>)
    return NextResponse.json(
      { status: 'ok', consumed },
      { status: 200 }
    )
  } catch (err) {
    logger.error('smoker-tester-webhook', 'handler failed', {
      context: { error: err instanceof Error ? err.message : String(err) },
    })
    return NextResponse.json({ status: 'ok', error: 'logged' }, { status: 200 })
  }
}

// wzap may probe the endpoint with GET — return 200 OK.
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'smoker-tester' }, { status: 200 })
}
