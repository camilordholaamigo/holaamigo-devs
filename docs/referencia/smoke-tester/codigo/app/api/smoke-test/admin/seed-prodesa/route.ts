// ─── Smoke Tester — Admin: seed Prodesa projects ─────────────────────────
// POST /api/smoke-test/admin/seed-prodesa
//
// Idempotent upsert of the 29 Prodesa projects into prodesa_projects.
// Same payload as scripts/seed-prodesa-projects.mjs but invokable from the
// browser so we don't need shell access on the user's machine.
//
// Auth: any authenticated user with empresa_id can trigger it. The catalog
// is shared (not empresa-scoped) so this is safe — at worst someone re-runs
// the seed and the upsert is a no-op.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  PRODESA_CATALOG,
  buildSyntheticSubtipos,
} from '@/lib/smoke-tester/prodesa-catalog'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(_req: NextRequest) {
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

  const db = createAdminClient()
  let upserted = 0
  let failed = 0
  const errors: Array<{ proyecto: string; error: string }> = []

  for (const entry of PRODESA_CATALOG) {
    const subtipos = buildSyntheticSubtipos(
      entry.precio_min,
      entry.precio_max,
      entry.subtipos_count
    )
    const { error } = await db
      .from('prodesa_projects')
      .upsert(
        {
          nombre_proyecto: entry.nombre,
          ciudad: entry.ciudad,
          ubicacion: entry.ciudad,
          categoria: entry.categoria,
          precio_min: entry.precio_min,
          precio_max: entry.precio_max,
          precio_desde: entry.precio_min,
          subtipos,
          raw_data: {
            source: 'admin_api_seed_v1',
            subtipos_count: entry.subtipos_count,
            seeded_by: user.id,
          },
        },
        { onConflict: 'nombre_proyecto' }
      )
    if (error) {
      failed++
      errors.push({ proyecto: entry.nombre, error: error.message })
    } else {
      upserted++
    }
  }

  logger.info('smoke-seed', 'prodesa catalog seeded', {
    empresa_id: profile.empresa_id,
    context: {
      total: PRODESA_CATALOG.length,
      upserted,
      failed,
    },
  })

  return NextResponse.json({
    total: PRODESA_CATALOG.length,
    upserted,
    failed,
    errors: errors.slice(0, 10),
  })
}

// Convenience GET — list current count + return whether a seed is needed.
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const db = createAdminClient()
  const { count } = await db
    .from('prodesa_projects')
    .select('id', { count: 'exact', head: true })

  return NextResponse.json({
    catalog_size: PRODESA_CATALOG.length,
    db_count: count ?? 0,
    needs_seed: (count ?? 0) < PRODESA_CATALOG.length,
  })
}
