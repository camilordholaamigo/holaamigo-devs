-- ============================================================
-- 022_smoke_tester_form_trigger.sql
-- Smoke Tester Phase 2: Prodesa template flow.
--
-- Adds form-trigger mode so the smoke tester can replicate the
-- real production funnel where a Meta Ads form → Bubble workflow
-- → Meta WhatsApp template message starts the conversation.
--
-- Strictly additive. Existing manual-trigger flow keeps working
-- unchanged (default trigger_type='manual').
-- ============================================================

-- ─── 1. Form trigger state on runs ─────────────────────────────────────────
alter table public.smoke_test_runs
  add column if not exists trigger_type text not null default 'manual'
    check (trigger_type in ('manual','form_trigger','webhook')),
  add column if not exists form_data jsonb not null default '{}'::jsonb,
  add column if not exists template_received_at timestamptz,
  add column if not exists bubble_response jsonb not null default '{}'::jsonb,
  add column if not exists waiting_for_template boolean not null default false,
  add column if not exists closed_with text
    check (closed_with is null or closed_with in ('agendado','cotizacion','timeout','incomplete')),
  add column if not exists audit_result jsonb not null default '{}'::jsonb,
  add column if not exists campaign_queue_id uuid;

-- Webhook handler queries waiting_for_template runs frequently;
-- partial index keeps the lookup O(active form-runs) instead of O(all runs).
create index if not exists idx_smoke_runs_waiting_template
  on public.smoke_test_runs (waiting_for_template)
  where waiting_for_template = true;

-- ─── 2. Audit results on per-sequence rows ─────────────────────────────────
alter table public.smoke_test_results
  add column if not exists audit_steps jsonb not null default '[]'::jsonb,
  add column if not exists critical_errors jsonb not null default '[]'::jsonb,
  add column if not exists warning_errors jsonb not null default '[]'::jsonb,
  add column if not exists step_validations jsonb not null default '{}'::jsonb;

-- ─── 3. Prodesa project metadata ───────────────────────────────────────────
-- One row per project from the Prodesa CSV. Used to:
--   • Populate the form trigger dropdown
--   • Generate buyer message sequences (price ladder, subtipos, ciudad)
--   • Drive the auditor's expected #ID and pricing checks
create table if not exists public.prodesa_projects (
  id              uuid primary key default gen_random_uuid(),
  nombre_proyecto text not null unique,
  ciudadela       text,
  ubicacion       text,
  ciudad          text,
  categoria       text check (categoria in ('VIS','VIS Renovación','NO VIS','VIS+NO VIS')),
  precio_min      bigint,
  precio_max      bigint,
  precio_desde    bigint,
  ciudadela_id    text,         -- "#ID353535446"
  proyecto_id     text,         -- distinct from ciudadela_id
  subtipos        jsonb not null default '[]'::jsonb,
  -- subtipos: [{ name, price, area, habitaciones, banos, plano_id }]
  raw_data        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_prodesa_projects_categoria
  on public.prodesa_projects (categoria);
create index if not exists idx_prodesa_projects_nombre
  on public.prodesa_projects (nombre_proyecto);

-- updated_at trigger
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_prodesa_projects_updated'
      and tgrelid = 'public.prodesa_projects'::regclass
  ) then
    create trigger trg_prodesa_projects_updated
      before update on public.prodesa_projects
      for each row
      execute function public.update_updated_at();
  end if;
end $$;

-- ─── 4. Sequence trigger metadata ──────────────────────────────────────────
-- A sequence can now be tied to a Prodesa project + describe which audit
-- steps must show up in the conversation transcript.
alter table public.smoke_test_sequences
  add column if not exists trigger_type text not null default 'manual'
    check (trigger_type in ('manual','prodesa_template')),
  add column if not exists prodesa_project_id uuid references public.prodesa_projects(id) on delete set null,
  add column if not exists expected_steps jsonb not null default '[]'::jsonb;

-- ─── 5. RLS ────────────────────────────────────────────────────────────────
alter table public.prodesa_projects enable row level security;

-- prodesa_projects is shared catalog data, not empresa-scoped.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='prodesa_projects' and policyname='service_all_prodesa_projects') then
    create policy "service_all_prodesa_projects"
      on public.prodesa_projects for all
      to service_role
      using (true)
      with check (true);
  end if;

  -- Authenticated users can read the catalog (needed to populate the form
  -- dropdown from the client). No write access from authenticated.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='prodesa_projects' and policyname='read_prodesa_projects') then
    create policy "read_prodesa_projects"
      on public.prodesa_projects for select
      to authenticated
      using (true);
  end if;
end $$;

-- ─── 6. Serial campaign queues ─────────────────────────────────────────────
-- One queue = one batch of projects to test sequentially. The advancer in
-- lib/smoke-tester/campaign-advancer.ts moves to the next project when each
-- run reaches a terminal state (#agendado, #cotizacion, timeout, failed).
create table if not exists public.smoke_campaign_queues (
  id                       uuid primary key default gen_random_uuid(),
  suite_id                 uuid not null references public.smoke_test_suites(id) on delete cascade,
  empresa_id               uuid not null references public.empresas(id) on delete cascade,
  status                   text not null default 'pending'
    check (status in ('pending','running','completed','cancelled','failed')),
  project_ids              uuid[] not null,
  current_index            integer not null default 0,
  current_run_id           uuid references public.smoke_test_runs(id) on delete set null,
  total_projects           integer not null,
  completed_projects       integer not null default 0,
  failed_projects          integer not null default 0,
  inter_run_delay_seconds  integer not null default 60,
  started_at               timestamptz,
  completed_at             timestamptz,
  created_by               uuid references auth.users(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_campaign_queues_status
  on public.smoke_campaign_queues (status)
  where status in ('pending','running');

create index if not exists idx_campaign_queues_suite
  on public.smoke_campaign_queues (suite_id, created_at desc);

-- Backfill the FK on smoke_test_runs.campaign_queue_id
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'smoke_test_runs_campaign_queue_id_fkey'
  ) then
    alter table public.smoke_test_runs
      add constraint smoke_test_runs_campaign_queue_id_fkey
      foreign key (campaign_queue_id)
      references public.smoke_campaign_queues(id)
      on delete set null;
  end if;
end $$;

-- updated_at trigger
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_campaign_queues_updated'
      and tgrelid = 'public.smoke_campaign_queues'::regclass
  ) then
    create trigger trg_campaign_queues_updated
      before update on public.smoke_campaign_queues
      for each row
      execute function public.update_updated_at();
  end if;
end $$;

alter table public.smoke_campaign_queues enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_campaign_queues' and policyname='service_all_campaign_queues') then
    create policy "service_all_campaign_queues"
      on public.smoke_campaign_queues for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_campaign_queues' and policyname='empresa_campaign_queues') then
    create policy "empresa_campaign_queues"
      on public.smoke_campaign_queues for all
      using (empresa_id in (
        select empresa_id from public.profiles
        where id = auth.uid() and empresa_id is not null
      ));
  end if;
end $$;
