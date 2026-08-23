-- ============================================================
-- 014_smoke_tester.sql
-- Smoke Tester: end-to-end QA harness for AI agents.
-- Sends scripted buyer messages via the existing WhatsApp pipeline,
-- captures agent responses, and grades each conversation with Claude.
--
-- Strictly additive. RLS scoped to empresa via profiles.empresa_id.
-- ============================================================

-- ─── 1. Test suites ────────────────────────────────────────────────────────
-- A suite groups N test sequences for one agente_ia.
create table if not exists public.smoke_test_suites (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  agente_ia_id  uuid not null references public.agentes_ia(id) on delete cascade,
  nombre        text not null,
  descripcion   text,
  test_phone    text not null,
  metadata      jsonb not null default '{}'::jsonb,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_smoke_suites_empresa
  on public.smoke_test_suites (empresa_id);
create index if not exists idx_smoke_suites_agent
  on public.smoke_test_suites (agente_ia_id);

-- ─── 2. Test sequences ────────────────────────────────────────────────────
-- A scripted conversation: array of buyer messages + the ground-truth ficha
-- the agent should be answering against.
create table if not exists public.smoke_test_sequences (
  id            uuid primary key default gen_random_uuid(),
  suite_id      uuid not null references public.smoke_test_suites(id) on delete cascade,
  nombre        text not null,
  proyecto_ref  text,
  messages      jsonb not null default '[]'::jsonb,
  -- messages: [{ "text": "...", "delay": 8000 }, ...]
  ficha_tecnica text,
  propiedad_id  uuid references public.propiedades(id) on delete set null,
  orden         integer not null default 0,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_smoke_sequences_suite
  on public.smoke_test_sequences (suite_id, orden);

-- ─── 3. Test runs ─────────────────────────────────────────────────────────
-- One run = one execution of a suite (all its sequences in order).
create table if not exists public.smoke_test_runs (
  id                  uuid primary key default gen_random_uuid(),
  suite_id            uuid not null references public.smoke_test_suites(id) on delete cascade,
  empresa_id          uuid not null references public.empresas(id) on delete cascade,
  status              text not null default 'pending'
                      check (status in ('pending','running','completed','failed','cancelled')),
  started_at          timestamptz,
  completed_at        timestamptz,
  total_sequences     integer not null default 0,
  completed_sequences integer not null default 0,
  overall_score       numeric,
  summary             jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now()
);

create index if not exists idx_smoke_runs_suite
  on public.smoke_test_runs (suite_id, created_at desc);
create index if not exists idx_smoke_runs_empresa
  on public.smoke_test_runs (empresa_id, created_at desc);

-- ─── 4. Test results ──────────────────────────────────────────────────────
-- Per-sequence row inside a run: full transcript + Claude evaluation.
create table if not exists public.smoke_test_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.smoke_test_runs(id) on delete cascade,
  sequence_id   uuid not null references public.smoke_test_sequences(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending','running','completed','failed','timeout')),
  conversation  jsonb not null default '[]'::jsonb,
  -- conversation: [{ "role": "buyer"|"agent", "text": "...", "timestamp": "..." }, ...]
  score         numeric,
  evaluation    jsonb not null default '{}'::jsonb,
  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_smoke_results_run
  on public.smoke_test_results (run_id);
create index if not exists idx_smoke_results_seq
  on public.smoke_test_results (sequence_id);

-- ─── 5. updated_at trigger for suites ─────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_smoke_suites_updated'
      and tgrelid = 'public.smoke_test_suites'::regclass
  ) then
    create trigger trg_smoke_suites_updated
      before update on public.smoke_test_suites
      for each row
      execute function public.update_updated_at();
  end if;
end $$;

-- ─── 6. RLS ───────────────────────────────────────────────────────────────
alter table public.smoke_test_suites    enable row level security;
alter table public.smoke_test_sequences enable row level security;
alter table public.smoke_test_runs      enable row level security;
alter table public.smoke_test_results   enable row level security;

-- Service role: full access (used by API routes)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_suites' and policyname='service_all_smoke_suites') then
    create policy "service_all_smoke_suites" on public.smoke_test_suites for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_sequences' and policyname='service_all_smoke_sequences') then
    create policy "service_all_smoke_sequences" on public.smoke_test_sequences for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_runs' and policyname='service_all_smoke_runs') then
    create policy "service_all_smoke_runs" on public.smoke_test_runs for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_results' and policyname='service_all_smoke_results') then
    create policy "service_all_smoke_results" on public.smoke_test_results for all to service_role using (true) with check (true);
  end if;
end $$;

-- Empresa members: read/write rows for their empresa
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_suites' and policyname='empresa_smoke_suites') then
    create policy "empresa_smoke_suites"
      on public.smoke_test_suites for all
      using (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null))
      with check (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_sequences' and policyname='empresa_smoke_sequences') then
    create policy "empresa_smoke_sequences"
      on public.smoke_test_sequences for all
      using (suite_id in (
        select id from public.smoke_test_suites
        where empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null)
      ));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_runs' and policyname='empresa_smoke_runs') then
    create policy "empresa_smoke_runs"
      on public.smoke_test_runs for all
      using (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='smoke_test_results' and policyname='empresa_smoke_results') then
    create policy "empresa_smoke_results"
      on public.smoke_test_results for all
      using (run_id in (
        select id from public.smoke_test_runs
        where empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null)
      ));
  end if;
end $$;
