// ─── Adaptador 3 — teléfonos ───────────────────────────────────────────────
// Reemplaza `lib/phone-utils`.
//
// Regla del sistema: en la BASE se guardan SOLO DÍGITOS ("573001234567").
// El "+" se agrega al momento de mandar, porque cada proveedor lo pide
// distinto. Mezclar formatos es la causa #1 de "el webhook no encontró el
// run": comparás "+573001234567" contra "573001234567" y no matchea nunca.

export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '')
}

export function formatE164(phone: string): string {
  const digits = normalizePhone(phone)
  return digits.startsWith('+') ? digits : `+${digits}`
}
