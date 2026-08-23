export const dynamic = 'force-dynamic'

import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { SmokeSuiteView } from '@/components/terminal/smoke-suite-view'

export default async function SmokeSuiteDetailPage({
  params,
}: {
  params: { suiteId: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('empresa_id')
    .eq('id', user.id)
    .single()
  const empresaId = profile?.empresa_id || ''
  if (!empresaId) redirect('/terminal/empresa')

  const db = createAdminClient()
  const { data: suite } = await db
    .from('smoke_test_suites')
    .select('*')
    .eq('id', params.suiteId)
    .eq('empresa_id', empresaId)
    .single()

  if (!suite) notFound()

  const [{ data: sequences }, { data: runs }, { data: agent }] = await Promise.all([
    db
      .from('smoke_test_sequences')
      .select('*')
      .eq('suite_id', params.suiteId)
      .order('orden', { ascending: true }),
    db
      .from('smoke_test_runs')
      .select('*')
      .eq('suite_id', params.suiteId)
      .order('created_at', { ascending: false })
      .limit(20),
    db
      .from('agentes_ia')
      .select('id, nombre, canal, numero_whatsapp, assistant_id, instrucciones')
      .eq('id', (suite as { agente_ia_id: string }).agente_ia_id)
      .single(),
  ])

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 pt-8 pb-4">
        <span className="rm-eyebrow">Smoke Tester</span>
        <h1 className="rm-h1 mt-1">{(suite as { nombre: string }).nombre}</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-auto terminal-scroll px-8 pb-8">
        <SmokeSuiteView
          suite={suite as any}
          agent={agent as any}
          sequences={(sequences || []) as any[]}
          runs={(runs || []) as any[]}
        />
      </div>
    </div>
  )
}
