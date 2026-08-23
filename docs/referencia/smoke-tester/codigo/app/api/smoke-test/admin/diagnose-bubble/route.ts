// ─── Smoke Tester — Admin: diagnose Bubble connectivity ──────────────────
// Reports the full state of the Bubble integration so the user can debug
// "Bubble webhook failed" errors without SSHing into Vercel:
//   • Which env vars are set (presence + length, never the value)
//   • The URL we're targeting
//   • Result of an actual test fetch (with a non-destructive payload)
//   • err.cause introspection for network-level failures
//
// GET only — no side effects (the test fetch uses a marked diagnostic
// payload so Bubble can ignore/route it).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const REQUEST_TIMEOUT_MS = 12_000

interface FetchErrorDetail {
  message: string
  code?: string
  cause_name?: string
  cause_message?: string
}

function describeFetchError(err: unknown): FetchErrorDetail {
  if (!(err instanceof Error)) return { message: String(err) }
  const out: FetchErrorDetail = { message: err.message }
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; message?: string; name?: string }
    if (c.code) out.code = c.code
    if (c.message) out.cause_message = c.message
    if (c.name) out.cause_name = c.name
  }
  return out
}

interface ProbeResult {
  url: string
  variant: string
  ok: boolean
  status?: number
  duration_ms: number
  response_preview?: string
  error?: FetchErrorDetail
}

async function probeUrl(url: string, variant: string): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const startedAt = Date.now()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'rentmies-smoke-diagnose/1.0',
    Accept: 'application/json, text/plain, */*',
  }
  if (process.env.BUBBLE_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.BUBBLE_API_TOKEN}`
  }

  // Diagnostic payload: marked so Bubble can ignore / route differently.
  // Bubble workflows usually accept arbitrary JSON; this lets us see if the
  // workflow at least RECEIVES the request without actually triggering a
  // real template send.
  const body = JSON.stringify({
    __diagnostic: true,
    phone: '0',
    nombre: 'diagnose',
    proyecto: 'diagnose',
    correo: 'noreply@rentmies.com',
    id_hubspot: '0',
    unix: '0',
    owner: '',
  })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    let preview = ''
    try {
      const txt = await res.text()
      preview = txt.slice(0, 240)
    } catch {
      preview = '(no body)'
    }
    return {
      url,
      variant,
      ok: res.ok,
      status: res.status,
      duration_ms: Date.now() - startedAt,
      response_preview: preview,
    }
  } catch (err) {
    return {
      url,
      variant,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: describeFetchError(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function GET(_req: NextRequest) {
  // Auth: any logged-in user with empresa_id.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  if (!profile?.empresa_id) {
    return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })
  }

  // 1. Inspect env vars (presence only, never values).
  const envState = {
    BUBBLE_PRODESA_TEMPLATE_URL: {
      present: !!process.env.BUBBLE_PRODESA_TEMPLATE_URL,
      length: process.env.BUBBLE_PRODESA_TEMPLATE_URL?.length ?? 0,
      preview: process.env.BUBBLE_PRODESA_TEMPLATE_URL
        ? maskUrl(process.env.BUBBLE_PRODESA_TEMPLATE_URL)
        : null,
    },
    BUBBLE_API_TOKEN: {
      present: !!process.env.BUBBLE_API_TOKEN,
      length: process.env.BUBBLE_API_TOKEN?.length ?? 0,
    },
    WZAP_TOKEN: { present: !!process.env.WZAP_TOKEN },
    WZAP_DEVICE: { present: !!process.env.WZAP_DEVICE },
    CRON_SECRET: { present: !!process.env.CRON_SECRET },
  }

  if (!process.env.BUBBLE_PRODESA_TEMPLATE_URL) {
    return NextResponse.json({
      env: envState,
      probes: [],
      hint: 'BUBBLE_PRODESA_TEMPLATE_URL no está en Vercel. Agregá la env var y re-deploy.',
    })
  }

  // 2. Probe the configured URL + a couple of fallback variants so we can
  //    see if maybe the URL is wrong (e.g. test/dev path, /version-test).
  const url = process.env.BUBBLE_PRODESA_TEMPLATE_URL
  const variants: Array<{ url: string; label: string }> = [
    { url, label: 'configured' },
  ]
  // Bubble exposes a /version-test/ path for the dev branch:
  // https://app.example.com/version-test/api/1.1/wf/<workflow>
  if (!url.includes('/version-test/')) {
    try {
      const u = new URL(url)
      const testUrl = `${u.protocol}//${u.host}/version-test${u.pathname}${u.search}`
      variants.push({ url: testUrl, label: 'version-test' })
    } catch {
      /* malformed URL — skip */
    }
  }

  const probes = await Promise.all(
    variants.map((v) => probeUrl(v.url, v.label))
  )

  // 3. Useful hints based on results.
  const hints: string[] = []
  for (const p of probes) {
    if (p.error?.code === 'ENOTFOUND') {
      hints.push(`DNS no resuelve para ${maskUrl(p.url)} — confirmá que el dominio existe y apunta a Bubble.`)
    }
    if (p.error?.code === 'ECONNREFUSED') {
      hints.push(`Conexión rechazada en ${maskUrl(p.url)} — el servidor existe pero rechaza el puerto.`)
    }
    if (p.error?.code?.startsWith('UND_ERR_SOCKET') || p.error?.code === 'ECONNRESET') {
      hints.push('Socket cerrado por el servidor remoto — Bubble podría estar tirando 403/blocking.')
    }
    if (p.status === 401 || p.status === 403) {
      hints.push(`Bubble devolvió ${p.status} — workflow puede requerir BUBBLE_API_TOKEN.`)
    }
    if (p.status === 404) {
      hints.push(`Bubble devolvió 404 — revisá el nombre del workflow en la URL (case-sensitive).`)
    }
  }

  return NextResponse.json({
    env: envState,
    probes,
    hints: hints.length > 0 ? hints : ['No se detectaron problemas obvios. Revisá la respuesta arriba.'],
    logs_url: 'En Vercel: Project → Deployments → último → Runtime Logs. Filtrá por "smoke-bubble" o "smoke-webhook".',
  })
}

// Mask /wf/<workflow_name> path tail to avoid leaking workflow IDs in error
// reports if the user shares the diagnostic output.
function maskUrl(u: string): string {
  if (!u) return ''
  if (u.length <= 60) return u
  return `${u.slice(0, 60)}…(${u.length - 60} chars more)`
}
