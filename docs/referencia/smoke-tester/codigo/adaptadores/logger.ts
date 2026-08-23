// ─── Adaptador 2 — logger ──────────────────────────────────────────────────
// Reemplaza `lib/logger`.
//
// El logger NO es decorativo en este sistema: es la única ventana al motor.
// Todo lo interesante pasa dentro de un webhook que devolvió 200 hace rato
// (waitUntil), así que si no quedó en el log, no pasó.
//
// El original escribe a consola Y a una tabla `admin_logs`, para que el
// endpoint /api/smoke-test/diagnose pueda mostrar los últimos 30 eventos sin
// dar acceso a los logs de Vercel. Recomendado: conservá las dos salidas.

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
  empresa_id?: string
  context?: Record<string, unknown>
  [key: string]: unknown
}

// Poné aquí tu inserción a la tabla de logs. Debe ser fire-and-forget y NUNCA
// lanzar: un throw dentro del logger tumba el turno del comprador.
async function persist(_entry: Record<string, unknown>): Promise<void> {
  // Ejemplo Supabase:
  // const { createAdminClient } = await import('./db')
  // await createAdminClient().from('admin_logs').insert(_entry)
}

function log(level: Level, source: string, message: string, ctx?: LogContext) {
  const entry = {
    level,
    source,
    message,
    timestamp: new Date().toISOString(),
    ...(ctx ?? {}),
  }
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  void persist(entry).catch(() => {
    /* nunca dejar que el log rompa el flujo */
  })
}

export const logger = {
  debug: (s: string, m: string, c?: LogContext) => log('debug', s, m, c),
  info: (s: string, m: string, c?: LogContext) => log('info', s, m, c),
  warn: (s: string, m: string, c?: LogContext) => log('warn', s, m, c),
  error: (s: string, m: string, c?: LogContext) => log('error', s, m, c),
}

// Fuentes (`source`) que usa el smoke tester, para filtrar:
//   smoke-runner · smoke-webhook · smoke-engine · smoke-buyer
//   smoke-bubble · smoke-campaign · smoke-watchdog · smoke-evaluate
//   smoker-tester-webhook
