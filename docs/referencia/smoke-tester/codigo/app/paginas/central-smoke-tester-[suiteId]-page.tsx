export const dynamic = 'force-dynamic'

import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { SmokeSuiteView } from '@/components/terminal/smoke-suite-view'
import {
  SmokeProdesaTriggerForm,
  type ProdesaProjectLite,
} from '@/components/terminal/smoke-prodesa-trigger-form'
import { SmokeProdesaCampaignRunner } from '@/components/terminal/smoke-prodesa-campaign-runner'
import { SmokeProdesaLiveAudit } from '@/components/terminal/smoke-prodesa-live-audit'
import { SmokeProdesaReport } from '@/components/terminal/smoke-prodesa-report'
import type {
  ConversationEntry,
  ProdesaAuditResult,
  ProdesaProject,
} from '@/lib/smoke-tester/types'

export default async function CentralSmokeSuiteDetailPage({
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
  if (!empresaId) redirect('/central/empresa')

  const db = createAdminClient()
  const { data: suite } = await db
    .from('smoke_test_suites')
    .select('*')
    .eq('id', params.suiteId)
    .eq('empresa_id', empresaId)
    .single()

  if (!suite) notFound()

  const [
    { data: sequences },
    { data: runs },
    { data: agent },
    { data: prodesaProjects },
    { data: activeQueue },
    { data: latestFormRun },
  ] = await Promise.all([
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
    db
      .from('prodesa_projects')
      .select('id, nombre_proyecto, categoria, precio_min, precio_max, precio_desde, ciudad')
      .order('nombre_proyecto'),
    db
      .from('smoke_campaign_queues')
      .select('*')
      .eq('suite_id', params.suiteId)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('smoke_test_runs')
      .select('id, status, closed_with, audit_result, form_data, trigger_type')
      .eq('suite_id', params.suiteId)
      .eq('trigger_type', 'form_trigger')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  // Resolve the run to render in the live/report panels.
  const focusRun = (latestFormRun || null) as {
    id: string
    status: string
    closed_with: string | null
    audit_result: ProdesaAuditResult | Record<string, never>
    form_data: { proyecto?: string } | null
    trigger_type: string
  } | null

  // For the report (only when terminal): pull the conversation + project ficha.
  let reportData:
    | {
        audit: ProdesaAuditResult
        project: ProdesaProject | null
        conversation: ConversationEntry[]
        runId: string
      }
    | null = null

  if (
    focusRun &&
    ['completed', 'failed', 'cancelled'].includes(focusRun.status) &&
    focusRun.audit_result &&
    typeof focusRun.audit_result === 'object' &&
    'overall_score' in focusRun.audit_result
  ) {
    const proyectoName = focusRun.form_data?.proyecto || null
    const [{ data: focusResult }, { data: focusProject }] = await Promise.all([
      db
        .from('smoke_test_results')
        .select('conversation')
        .eq('run_id', focusRun.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      proyectoName
        ? db
            .from('prodesa_projects')
            .select('*')
            .eq('nombre_proyecto', proyectoName)
            .maybeSingle()
        : Promise.resolve({ data: null as ProdesaProject | null }),
    ])

    reportData = {
      audit: focusRun.audit_result as ProdesaAuditResult,
      project: (focusProject as ProdesaProject | null) ?? null,
      conversation:
        ((focusResult as { conversation: ConversationEntry[] | null } | null)
          ?.conversation || []) as ConversationEntry[],
      runId: focusRun.id,
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 pt-10 pb-4">
        <span className="rm-page-eyebrow">Smoke Tester</span>
        <h1 className="rm-display-h1">{(suite as { nombre: string }).nombre}</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-8 pb-8 space-y-5">
        {/* Primary flow: pick a project, fire one Bubble template. */}
        <SmokeProdesaTriggerForm
          suiteId={params.suiteId}
          projects={(prodesaProjects || []) as ProdesaProjectLite[]}
        />

        {/* Live audit appears only while a form-trigger run is mid-flight. */}
        {focusRun && focusRun.status === 'running' ? (
          <div id="current-run">
            <SmokeProdesaLiveAudit runId={focusRun.id} />
          </div>
        ) : null}

        {/* Report shows after a form-trigger run reaches a terminal state. */}
        {reportData ? (
          <SmokeProdesaReport
            audit={reportData.audit}
            project={reportData.project}
            conversation={reportData.conversation}
            runId={reportData.runId}
          />
        ) : null}

        {/* Advanced flow: serial campaign across multiple projects. Collapsed
            by default to keep the primary single-shot flow front-and-center. */}
        <details
          style={{
            background: 'var(--rm-surface)',
            borderRadius: 18,
            padding: '14px 18px',
          }}
        >
          <summary
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--rm-muted)',
              cursor: 'pointer',
            }}
          >
            Modo avanzado · Campaña serial (múltiples proyectos)
          </summary>
          <div className="mt-4">
            <SmokeProdesaCampaignRunner
              suiteId={params.suiteId}
              projects={(prodesaProjects || []) as ProdesaProjectLite[]}
              initialQueue={(activeQueue as any) ?? null}
            />
          </div>
        </details>

        {/* Legacy manual sequences view at the bottom. */}
        <details
          style={{
            background: 'var(--rm-surface)',
            borderRadius: 18,
            padding: '14px 18px',
          }}
        >
          <summary
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--rm-muted)',
              cursor: 'pointer',
            }}
          >
            Configuración de la suite · secuencias y runs anteriores
          </summary>
          <div className="mt-4">
            <SmokeSuiteView
              suite={suite as any}
              agent={agent as any}
              sequences={(sequences || []) as any[]}
              runs={(runs || []) as any[]}
            />
          </div>
        </details>
      </div>
    </div>
  )
}
