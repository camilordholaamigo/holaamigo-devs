// ─── Smoke Tester — WZAP sender ─────────────────────────────────────────────
// Sends a real WhatsApp message via the wzap.chat API. The wzap device's
// WhatsApp number is the "from" — replies arrive at the device's number and
// fire the wzap webhook, which we capture in /api/webhook/smoker-tester.

const WZAP_URL = process.env.WZAP_URL || 'https://api.wzap.chat/v1/messages'
const TIMEOUT_MS = 15_000

export interface WzapSendParams {
  phone: string   // destination, e.g. "+573103565492"
  message: string
}

export interface WzapSendResult {
  ok: boolean
  status: number
  body: string
  id?: string
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return digits.startsWith('+') ? digits : `+${digits}`
}

export async function sendWzapMessage(
  params: WzapSendParams
): Promise<WzapSendResult> {
  const token = process.env.WZAP_TOKEN
  const device = process.env.WZAP_DEVICE
  if (!token) throw new Error('WZAP_TOKEN no configurado')
  if (!device) throw new Error('WZAP_DEVICE no configurado')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(WZAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Token: token,
      },
      body: JSON.stringify({
        phone: formatPhone(params.phone),
        message: params.message,
        device,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  const body = await res.text().catch(() => '')
  let id: string | undefined
  try {
    const json = JSON.parse(body)
    if (json && typeof json === 'object') {
      id = (json.id as string) ?? (json._id as string) ?? undefined
    }
  } catch {
    /* non-JSON body */
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
    id,
  }
}
