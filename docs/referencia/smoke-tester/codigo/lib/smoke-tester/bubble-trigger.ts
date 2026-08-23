// ─── Smoke Tester — Bubble webhook trigger ─────────────────────────────────
// Calls the Bubble Workflow API endpoint that orchestrates the Prodesa
// template flow:
//   1. Bubble creates the contact in HubSpot.
//   2. Bubble waits 1-2 minutes (their internal timing logic).
//   3. Bubble triggers Meta WhatsApp Business to send the pre-approved
//      template message ("Gracias por dejar tus datos para conocer más
//      sobre [PROYECTO]…") to the buyer's phone.
//   4. The buyer's phone is the wzap device — meaning the template lands
//      on our webhook, where webhook-handler.ts picks it up.
//
// Env vars:
//   BUBBLE_PRODESA_TEMPLATE_URL — required, full Bubble workflow URL
//   BUBBLE_API_TOKEN            — optional, sent as Bearer auth if set

import { logger } from '../logger'
import type { BubbleTemplatePayload, BubbleTriggerResult } from './types'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Node's native fetch wraps low-level network errors in a generic
 * `TypeError: fetch failed`. The actual cause (ENOTFOUND, ECONNREFUSED,
 * UND_ERR_SOCKET, certificate issues, etc.) lives on `err.cause`. This
 * helper unwraps it so we can show the user actionable info instead of
 * just "fetch failed".
 */
function describeFetchError(err: unknown): {
  message: string
  code?: string
  cause_message?: string
  cause_name?: string
} {
  if (!(err instanceof Error)) {
    return { message: String(err) }
  }
  const out: ReturnType<typeof describeFetchError> = { message: err.message }
  // Node fetch puts the underlying network error on err.cause
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; message?: string; name?: string }
    if (c.code) out.code = c.code
    if (c.message) out.cause_message = c.message
    if (c.name) out.cause_name = c.name
  }
  return out
}

export async function triggerProdesaTemplate(
  payload: BubbleTemplatePayload
): Promise<BubbleTriggerResult> {
  const url = process.env.BUBBLE_PRODESA_TEMPLATE_URL
  if (!url) {
    return {
      ok: false,
      response: null,
      error: 'BUBBLE_PRODESA_TEMPLATE_URL no está configurada en Vercel',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  // Mask URL to first ~50 chars for safe logging.
  const urlPreview = url.length > 80 ? url.slice(0, 80) + '…' : url

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Send a UA so Bubble doesn't block "no UA" requests at the edge.
      'User-Agent': 'rentmies-smoke-tester/1.0',
      Accept: 'application/json, text/plain, */*',
    }
    if (process.env.BUBBLE_API_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.BUBBLE_API_TOKEN}`
    }

    logger.info('smoke-bubble', 'POST → Bubble', {
      context: {
        url_preview: urlPreview,
        proyecto: payload.proyecto,
        phone: payload.phone,
        has_token: !!process.env.BUBBLE_API_TOKEN,
      },
    })

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    let parsed: unknown = null
    let rawText: string | null = null
    try {
      rawText = await res.text()
      try {
        parsed = rawText ? JSON.parse(rawText) : null
      } catch {
        parsed = { raw_text: rawText?.slice(0, 500) ?? null }
      }
    } catch {
      parsed = null
    }

    if (!res.ok) {
      logger.warn('smoke-bubble', `Bubble responded ${res.status}`, {
        context: {
          status: res.status,
          proyecto: payload.proyecto,
          response_preview:
            typeof parsed === 'object' && parsed
              ? JSON.stringify(parsed).slice(0, 200)
              : rawText?.slice(0, 200),
        },
      })
      return {
        ok: false,
        status: res.status,
        response: parsed,
        error: `Bubble HTTP ${res.status}`,
      }
    }

    logger.info('smoke-bubble', 'Bubble template trigger ok', {
      context: { status: res.status, proyecto: payload.proyecto, phone: payload.phone },
    })
    return { ok: true, status: res.status, response: parsed }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError'
    if (isAbort) {
      const msg = `Timeout después de ${REQUEST_TIMEOUT_MS}ms`
      logger.warn('smoke-bubble', msg, {
        context: { proyecto: payload.proyecto, url_preview: urlPreview },
      })
      return {
        ok: false,
        response: null,
        error: msg,
      }
    }
    // Unwrap Node's "fetch failed" wrapper so the user sees ENOTFOUND /
    // ECONNREFUSED / TLS errors instead of the opaque outer message.
    const detail = describeFetchError(err)
    const friendly = detail.code
      ? `${detail.message} (${detail.code})${
          detail.cause_message ? ` — ${detail.cause_message}` : ''
        }`
      : detail.message
    logger.error('smoke-bubble', 'Bubble fetch threw', {
      context: {
        proyecto: payload.proyecto,
        url_preview: urlPreview,
        ...detail,
      },
    })
    return {
      ok: false,
      response: { fetch_error: detail },
      error: friendly,
    }
  } finally {
    clearTimeout(timer)
  }
}

// Defaults used by the form trigger UI. These are constants because the
// testing scenario always uses Camilo's HubSpot contact + WhatsApp number.
// The shape matches BubbleTemplatePayload exactly so the API route can
// merge { ...defaults, proyecto } without field-name juggling.
export const PRODESA_TEST_DEFAULTS: Omit<BubbleTemplatePayload, 'proyecto'> = {
  phone: '573332420484',
  nombre: 'camilo',
  correo: 'camiloprojectfi@gmail.com',
  id_hubspot: '216739342874',
  unix: '138383883',
  owner: '',
}
