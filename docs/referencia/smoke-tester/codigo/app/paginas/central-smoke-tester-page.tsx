export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { SmokeTesterView } from '@/components/terminal/smoke-tester-view'

export default async function CentralSmokeTesterPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  const empresaId = profile?.empresa_id || ''
  if (!empresaId) redirect('/central')

  const db = createAdminClient()
  const [{ data: suites }, { data: agents }, { data: lastRuns }, { data: sequences }] =
    await Promise.all([
      db
        .from('smoke_test_suites')
        .select('id, nombre, descripcion, test_phone, agente_ia_id, created_at, updated_at')
        .eq('empresa_id', empresaId)
        .order('created_at', { ascending: false }),
      db
        .from('agentes_ia')
        .select('id, nombre, canal, numero_whatsapp, assistant_id, activo')
        .eq('empresa_id', empresaId)
        .order('created_at', { ascending: false }),
      db
        .from('smoke_test_runs')
        .select('id, suite_id, status, overall_score, completed_at, created_at')
        .eq('empresa_id', empresaId)
        .order('created_at', { ascending: false })
        .limit(200),
      db
        .from('smoke_test_sequences')
        .select('suite_id'),
    ])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto px-8 pt-6 pb-8">
        <SmokeTesterView
          suites={(suites || []) as any[]}
          agents={(agents || []) as any[]}
          lastRuns={(lastRuns || []) as any[]}
          sequences={(sequences || []) as any[]}
        />
      </div>
    </div>
  )
}
