// ─── Adaptador 1 — cliente de base de datos ────────────────────────────────
// Reemplaza `lib/supabase/admin`.
//
// El smoke tester escribe SIEMPRE con service-role (salta RLS) porque corre
// en webhooks y crons donde no hay sesión de usuario. La autorización se hace
// arriba, en las rutas de API, contra la sesión del usuario.
//
// REGLA QUE APRENDIMOS A LOS GOLPES: si el cliente lleva cookies, la RLS
// aplica y el webhook "no encuentra" filas que sí existen. Para el motor y el
// webhook, service-role siempre.

import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export type AdminClient = ReturnType<typeof createAdminClient>

// ─── Si NO usás Supabase ───────────────────────────────────────────────────
//
// Todo el código toca la base con este subconjunto del query builder:
//
//   db.from(tabla).select(cols).eq(col, val).in(col, vals).lt(col, val)
//     .order(col, {ascending}).limit(n).single()
//   db.from(tabla).insert(row).select(cols).single()
//   db.from(tabla).update(patch).eq(col, val)
//
// Con Prisma/Drizzle/pg el port es mecánico. Los únicos puntos delicados:
//
//   • select('a, b, tabla_hija!inner(x, y)') es un INNER JOIN con la fila
//     hija anidada como objeto. Aparece en webhook-handler.ts, runner.ts y
//     conversation-engine.ts. En SQL plano: JOIN + mapear a objeto anidado.
//   • form_data / conversation / metadata son columnas JSONB. Necesitás un
//     tipo JSON nativo; con MySQL < 8 esto no funciona bien.
