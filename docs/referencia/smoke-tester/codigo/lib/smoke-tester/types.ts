// ─── Smoke Tester — shared types ────────────────────────────────────────────

export type ResultStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SequenceMessage {
  text: string
  delay?: number
}

export interface ConversationEntry {
  role: 'buyer' | 'agent'
  text: string
  timestamp: string
}

export interface SmokeTestSuite {
  id: string
  empresa_id: string
  agente_ia_id: string
  nombre: string
  descripcion: string | null
  test_phone: string
  metadata: Record<string, unknown>
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SmokeTestSequence {
  id: string
  suite_id: string
  nombre: string
  proyecto_ref: string | null
  messages: SequenceMessage[]
  ficha_tecnica: string | null
  propiedad_id: string | null
  orden: number
  metadata: Record<string, unknown>
  created_at: string
}

export interface SmokeTestRun {
  id: string
  suite_id: string
  empresa_id: string
  status: RunStatus
  started_at: string | null
  completed_at: string | null
  total_sequences: number
  completed_sequences: number
  overall_score: number | null
  summary: Record<string, unknown>
  created_by: string | null
  created_at: string
}

export interface EvaluationResult {
  accuracy: number
  tone: number
  completeness: number
  proactivity: number
  hallucination_risk: number
  overall_score: number
  hallucinations: string[]
  errors: string[]
  suggestions: string[]
  summary: string
}

export interface SmokeTestResult {
  id: string
  run_id: string
  sequence_id: string
  status: ResultStatus
  conversation: ConversationEntry[]
  score: number | null
  evaluation: Partial<EvaluationResult>
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface RunnerConfig {
  testPhone: string
  agentPhone: string
  channelUuid: string
  responseTimeoutMs?: number
  delayBetweenMessagesMs?: number
  pollIntervalMs?: number
  silenceWindowMs?: number
}

// ─── Phase 2 — Prodesa form-triggered flow ─────────────────────────────────

export type TriggerType = 'manual' | 'form_trigger' | 'webhook'

export interface ProdesaSubtipo {
  name: string
  price: number
  area?: number
  habitaciones?: number
  banos?: number
  plano_id?: string | null
}

export interface ProdesaProject {
  id: string
  nombre_proyecto: string
  ciudadela: string | null
  ubicacion: string | null
  ciudad: string | null
  categoria: 'VIS' | 'VIS Renovación' | 'NO VIS' | 'VIS+NO VIS' | null
  precio_min: number | null
  precio_max: number | null
  precio_desde: number | null
  ciudadela_id: string | null
  proyecto_id: string | null
  subtipos: ProdesaSubtipo[]
  raw_data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface BubbleTemplatePayload {
  phone: string
  nombre: string
  proyecto: string
  correo: string
  id_hubspot: string
  unix: string
  owner?: string
}

export interface BubbleTriggerResult {
  ok: boolean
  response: unknown
  error?: string
  status?: number
}

// ─── Phase 2 — 10-step deterministic auditor ───────────────────────────────

export type ClosedWith = 'agendado' | 'cotizacion' | 'timeout' | 'incomplete'

export interface StepAudit {
  step: number              // 1-10
  detected: boolean         // did we find an agent message that maps to this step?
  agent_message_text: string | null
  passed: boolean           // critical_errors.length === 0 && detected
  critical_errors: string[]
  warning_errors: string[]
  validations: Record<string, boolean>
}

export interface ProdesaAuditResult {
  steps: StepAudit[]
  critical_count: number
  warning_count: number
  overall_score: number       // 0-100
  flow_complete: boolean      // closed with agendado or cotizacion
  closed_with: ClosedWith
  agent_message_count: number
  buyer_message_count: number
  audited_at: string
}

// ─── Phase 2 — Serial campaign queue ───────────────────────────────────────

export type CampaignStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface CampaignQueue {
  id: string
  suite_id: string
  empresa_id: string
  status: CampaignStatus
  project_ids: string[]
  current_index: number
  current_run_id: string | null
  total_projects: number
  completed_projects: number
  failed_projects: number
  inter_run_delay_seconds: number
  started_at: string | null
  completed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
