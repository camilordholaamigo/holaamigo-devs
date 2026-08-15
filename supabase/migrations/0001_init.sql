-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · Motor de Ventas v1 — esquema inicial
-- ═══════════════════════════════════════════════════════════════════════════
-- Este proyecto Supabase es COMPARTIDO con Rentmies. Todo vive en el schema
-- `holaamigo` para no tocar `public`. Ver docs/adr/0001-schema-dedicado.md
--
-- Idempotente: se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists holaamigo;

set search_path = holaamigo, public;

-- ═══════════════ ORGANIZACIÓN E INTAKE ═══════════════

create table if not exists holaamigo.organizations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text,
  website_url text not null,
  domain text generated always as (
    lower(regexp_replace(website_url, '^https?://(www\.)?([^/]+).*$', '\2'))
  ) stored,
  country text,
  currency text not null default 'USD',
  industry text,
  employee_range text,
  lifecycle text not null default 'diagnostic'
    check (lifecycle in ('diagnostic','activated','trial','customer','churned')),
  owner_email text
);
create unique index if not exists organizations_domain_key
  on holaamigo.organizations (domain);

create table if not exists holaamigo.intake_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  contact_name text,
  contact_email text,
  status text not null default 'started'
    check (status in ('started','quiz','diagnosed','connected','leads_uploaded','activated','abandoned')),
  utm jsonb not null default '{}',
  referrer text,
  ip inet,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists intake_sessions_org_idx
  on holaamigo.intake_sessions (organization_id, created_at desc);

-- ═══════════════ INVESTIGACIÓN ═══════════════

create table if not exists holaamigo.research_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  session_id uuid references holaamigo.intake_sessions(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued','running','done','partial','failed')),
  -- [{t, step, detail}] — se lee por SSE desde el quiz. Ver docs/wiki/04.
  progress_log jsonb not null default '[]',
  -- Si el dominio ya se investigó hace <30 días, apuntamos al run original
  -- en vez de gastar tokens. Ver docs/adr/0004-cache-de-research.md
  reused_from_run_id uuid references holaamigo.research_runs(id) on delete set null,
  attempts int not null default 0,
  model text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(10,4),
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
create index if not exists research_runs_status_idx
  on holaamigo.research_runs (status, created_at);
create index if not exists research_runs_org_idx
  on holaamigo.research_runs (organization_id, created_at desc);

create table if not exists holaamigo.research_findings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  research_run_id uuid not null references holaamigo.research_runs(id) on delete cascade,
  -- offer | pricing | icp | competitors | positioning | channels | social_proof
  section text not null,
  payload jsonb not null,
  confidence numeric check (confidence between 0 and 1),
  sources jsonb not null default '[]'   -- [{url, title, retrieved_at}]
);
create index if not exists research_findings_run_idx
  on holaamigo.research_findings (research_run_id, section);

-- ═══════════════ QUIZ ═══════════════

create table if not exists holaamigo.quiz_questions (
  id text primary key,
  category text not null,
  prompt text not null,
  help_text text,
  input_type text not null
    check (input_type in ('single','multi','number','text','scale','upload')),
  options jsonb not null default '[]',
  required boolean not null default true,
  sort_order int,
  branch_rules jsonb not null default '{}',
  active boolean not null default true
);

create table if not exists holaamigo.quiz_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references holaamigo.intake_sessions(id) on delete cascade,
  question_id text,          -- null si la pregunta fue generada por el CMO
  generated_prompt text,
  slot text,                 -- clave semántica de la pregunta adaptativa
  answer jsonb not null,
  answered_at timestamptz not null default now()
);
create index if not exists quiz_responses_session_idx
  on holaamigo.quiz_responses (session_id, answered_at);
-- Una respuesta por pregunta fija: re-responder actualiza.
create unique index if not exists quiz_responses_fixed_key
  on holaamigo.quiz_responses (session_id, question_id)
  where question_id is not null;
create unique index if not exists quiz_responses_generated_key
  on holaamigo.quiz_responses (session_id, slot)
  where question_id is null and slot is not null;

-- Preguntas adaptativas ya generadas para una sesión (para no regenerarlas).
create table if not exists holaamigo.quiz_generated (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references holaamigo.intake_sessions(id) on delete cascade,
  slot text not null,
  prompt text not null,
  help_text text,
  input_type text not null,
  options jsonb not null default '[]',
  sort_order int not null,
  created_at timestamptz not null default now()
);
create unique index if not exists quiz_generated_key
  on holaamigo.quiz_generated (session_id, slot);

-- ═══════════════ BRIEF VIVO ═══════════════

create table if not exists holaamigo.briefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  version int not null default 1,
  created_at timestamptz not null default now(),
  created_by text not null default 'president',
  content jsonb not null,
  is_current boolean not null default true
);
create unique index if not exists briefs_current_key
  on holaamigo.briefs (organization_id) where is_current;

-- ═══════════════ AGENTES ═══════════════

create table if not exists holaamigo.agents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  role text not null check (role in ('president','cmo','sales')),
  status text not null default 'draft'
    check (status in ('draft','active','paused','degraded')),
  objective jsonb not null,
  budget jsonb not null,
  permissions jsonb not null,
  escalation_rules jsonb not null,
  health_score numeric not null default 1.0,
  health_reasons jsonb not null default '[]',
  last_run_at timestamptz,
  unique (organization_id, role)
);

create table if not exists holaamigo.agent_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_id uuid references holaamigo.agents(id) on delete cascade,
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  role text,
  step text,                 -- research | extract | adaptive_q | diagnosis | angles | classify
  trigger text,              -- intake | cron | approval | inbound
  input jsonb,
  output jsonb,
  model text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(10,4),
  duration_ms int,
  status text check (status in ('ok','escalated','failed','degraded')),
  error text
);
create index if not exists agent_runs_org_idx
  on holaamigo.agent_runs (organization_id, created_at desc);
create index if not exists agent_runs_agent_idx
  on holaamigo.agent_runs (agent_id, created_at desc);

-- ═══════════════ DIAGNÓSTICO Y RUTAS ═══════════════

create table if not exists holaamigo.diagnostics (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  session_id uuid references holaamigo.intake_sessions(id) on delete set null,
  identity jsonb,          -- §7.1 quién eres
  brand jsonb,
  competitors jsonb,
  market_position jsonb,
  leaks jsonb,             -- [{key, name, monthly_value, evidence, confidence, assumptions}]
  assumptions jsonb,       -- supuestos editables por el usuario
  inverse_math jsonb,      -- §7.4
  research_quality text
    check (research_quality in ('full','partial','none')),
  share_token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
create index if not exists diagnostics_org_idx
  on holaamigo.diagnostics (organization_id, created_at desc);

create table if not exists holaamigo.recommendations (
  id uuid primary key default gen_random_uuid(),
  diagnostic_id uuid not null references holaamigo.diagnostics(id) on delete cascade,
  route text not null check (route in ('whatsapp','email','brand_content')),
  rank int,
  rationale text,
  roadmap jsonb,           -- [{milestone, eta_days, eta_date, owner}]
  cost_infra_usd numeric(10,2),
  cost_fee_usd numeric(10,2),
  prerequisites jsonb not null default '[]',
  projected_impact jsonb,
  is_recommended boolean not null default false
);
create unique index if not exists recommendations_key
  on holaamigo.recommendations (diagnostic_id, route);

-- ═══════════════ CANALES Y LEADS ═══════════════

create table if not exists holaamigo.channel_connections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','email_inbox','email_outbound')),
  status text not null default 'pending'
    check (status in ('pending','connected','failed','revoked')),
  provider text,
  external_id text,
  meta jsonb not null default '{}',
  connected_at timestamptz
);
create unique index if not exists channel_connections_key
  on holaamigo.channel_connections (organization_id, channel);

create table if not exists holaamigo.lead_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  source text not null check (source in ('upload','apollo','apify','manual','inbound')),
  filename text,
  raw_count int not null default 0,
  valid_count int not null default 0,
  dup_count int not null default 0,
  invalid_count int not null default 0,
  phone_count int not null default 0,
  column_mapping jsonb not null default '{}',
  segments jsonb not null default '{}',
  consent_basis text not null,
  consent_ip inet,
  consent_at timestamptz not null default now()
);

create table if not exists holaamigo.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  batch_id uuid references holaamigo.lead_batches(id) on delete set null,
  full_name text,
  email text,
  phone_e164 text,
  company text,
  title text,
  last_interaction_at timestamptz,
  temperature text check (temperature in ('hot','warm','cold','dead')),
  segment text,
  status text not null default 'new'
    check (status in ('new','queued','contacted','replied','qualified','booked','lost','suppressed')),
  enrichment jsonb not null default '{}'
);
create index if not exists leads_org_status_idx
  on holaamigo.leads (organization_id, status);
create unique index if not exists leads_identity_key
  on holaamigo.leads (organization_id, coalesce(email, phone_e164));

-- Supresión global: nunca se contacta a nadie que esté aquí.
create table if not exists holaamigo.suppressions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  email text,
  phone_e164 text,
  reason text not null,     -- opt_out | complaint | legal | bounce | manual
  source text
);
create index if not exists suppressions_email_idx on holaamigo.suppressions (lower(email));
create index if not exists suppressions_phone_idx on holaamigo.suppressions (phone_e164);

-- ═══════════════ ÁNGULOS, CAMPAÑAS, MENSAJES ═══════════════

create table if not exists holaamigo.angles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  name text not null,
  hypothesis text,
  target_segment text,
  variants jsonb not null default '[]',
  status text not null default 'proposed'
    check (status in ('proposed','approved','paused','retired')),
  sent int not null default 0,
  replied int not null default 0,
  positive int not null default 0,
  booked int not null default 0
);
create index if not exists angles_org_idx on holaamigo.angles (organization_id, status);

create table if not exists holaamigo.campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  name text,
  channel text check (channel in ('whatsapp','email')),
  status text not null default 'draft'
    check (status in ('draft','pending_approval','active','paused','done')),
  angle_ids uuid[] not null default '{}',
  segment_filter jsonb not null default '{}',
  daily_cap int not null default 200,
  started_at timestamptz
);

create table if not exists holaamigo.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  campaign_id uuid references holaamigo.campaigns(id) on delete cascade,
  lead_id uuid references holaamigo.leads(id) on delete cascade,
  angle_id uuid references holaamigo.angles(id) on delete set null,
  channel text,
  direction text check (direction in ('out','in')),
  template_name text,
  body text,
  status text check (status in ('queued','sent','delivered','read','replied','failed','bounced')),
  sent_at timestamptz,
  external_id text,
  error text
);
create index if not exists messages_lead_idx on holaamigo.messages (lead_id, sent_at desc);
create index if not exists messages_campaign_idx on holaamigo.messages (campaign_id, created_at desc);

-- ═══════════════ COLA DE DECISIONES ═══════════════

create table if not exists holaamigo.approvals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  -- angle_new | campaign_launch | budget_change | escalation | template_submit
  kind text not null,
  title text not null,
  rationale text,
  if_approved text,
  if_rejected text,
  payload jsonb not null default '{}',
  severity text not null default 'normal' check (severity in ('low','normal','high')),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired')),
  decided_by text,
  decided_at timestamptz,
  decision_note text
);
create index if not exists approvals_queue_idx
  on holaamigo.approvals (status, severity, created_at desc);
create index if not exists approvals_org_idx
  on holaamigo.approvals (organization_id, status, created_at desc);

-- ═══════════════ SCORING PARA ADMIN ═══════════════

create table if not exists holaamigo.prospect_scores (
  organization_id uuid primary key references holaamigo.organizations(id) on delete cascade,
  fit_score int not null default 0,
  intent_score int not null default 0,
  total_score int generated always as (fit_score + intent_score) stored,
  band text not null default 'auto' check (band in ('auto','assist','attack')),
  manual_band text check (manual_band in ('auto','assist','attack')),
  manual_note text,
  manual_by text,
  reasons jsonb not null default '[]',
  alerted_at timestamptz,
  computed_at timestamptz not null default now()
);
create index if not exists prospect_scores_band_idx
  on holaamigo.prospect_scores (band, total_score desc);

create table if not exists holaamigo.plg_events (
  id bigserial primary key,
  organization_id uuid,
  session_id uuid,
  event text not null,
  props jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists plg_events_org_idx
  on holaamigo.plg_events (organization_id, created_at desc);
create index if not exists plg_events_event_idx
  on holaamigo.plg_events (event, created_at desc);

-- ═══════════════ RATE LIMIT (§10 · costo del research) ═══════════════

create table if not exists holaamigo.rate_limits (
  bucket text primary key,          -- ip:1.2.3.4 | domain:acme.com
  count int not null default 0,
  window_start timestamptz not null default now()
);

-- ═══════════════ RLS: DENY BY DEFAULT ═══════════════
-- Todo el acceso pasa por rutas de servidor con service_role, que ignora RLS.
-- Sin políticas => anon y authenticated no leen ni escriben nada.
-- Ver docs/adr/0003-rls-deny-by-default.md

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables where schemaname = 'holaamigo'
  loop
    execute format('alter table holaamigo.%I enable row level security', t.tablename);
    execute format('alter table holaamigo.%I force row level security', t.tablename);
  end loop;
end $$;

-- El rol service_role necesita permisos explícitos sobre el schema nuevo.
grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
alter default privileges in schema holaamigo
  grant all privileges on tables to service_role;
alter default privileges in schema holaamigo
  grant all privileges on sequences to service_role;

-- anon / authenticated: sin acceso. Explícito para que quede en el registro.
revoke all on schema holaamigo from anon, authenticated;

-- ═══════════════ TRIGGERS DE updated_at ═══════════════

create or replace function holaamigo.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists organizations_touch on holaamigo.organizations;
create trigger organizations_touch before update on holaamigo.organizations
  for each row execute function holaamigo.touch_updated_at();

drop trigger if exists diagnostics_touch on holaamigo.diagnostics;
create trigger diagnostics_touch before update on holaamigo.diagnostics
  for each row execute function holaamigo.touch_updated_at();
