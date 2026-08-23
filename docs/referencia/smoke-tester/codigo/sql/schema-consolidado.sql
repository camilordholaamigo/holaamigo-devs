-- ============================================================================
-- SMOKE TESTER — esquema consolidado y portable
--
-- Las 3 migraciones originales (014, 015, 022) aplicadas en orden, aplanadas
-- en un solo archivo y anotadas para portarlo a otra aplicación.
--
-- BLOQUE 1 (obligatorio)  — suites, secuencias, runs, resultados.
-- BLOQUE 2 (obligatorio)  — columnas del transporte asíncrono.
-- BLOQUE 3 (opcional)     — auditoría por pasos + colas seriales.
-- BLOQUE 4 (opcional)     — catálogo de proyectos (ejemplo específico de un
--                           cliente; probablemente NO lo necesitás).
-- BLOQUE 5 (obligatorio)  — RLS.
--
-- MULTI-TENANT: todo cuelga de `empresa_id`. Si tu app es de un solo tenant,
-- borrá esa columna, sus índices y las políticas "empresa_*" — nada más
-- depende de ella.
--
-- DEPENDENCIAS EXTERNAS que tenés que sustituir por las tuyas:
--   public.empresas(id)     → tu tabla de tenants
--   public.agentes_ia(id)   → tu tabla de agentes/bots bajo prueba
--   public.propiedades(id)  → opcional, el objeto de negocio del que se habla
--   public.profiles(id, empresa_id) → tu tabla de usuarios
--   auth.users(id)          → tu tabla de auth
--   public.update_updated_at() → trigger genérico de updated_at
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 0 · función de updated_at (si no la tenés ya)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 · el núcleo — 4 tablas
--
-- Modelo mental:
--   SUITE      = "qué agente pruebo y contra qué número"
--   SECUENCIA  = "qué le digo" (guion fijo) o "de dónde arranco" (autónomo)
--   RUN        = una ejecución de la suite
--   RESULTADO  = una conversación dentro del run (transcripción + nota)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1.1 Suites ─────────────────────────────────────────────────────────────
create table if not exists public.smoke_test_suites (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  agente_ia_id  uuid not null references public.agentes_ia(id) on delete cascade,
  nombre        text not null,
  descripcion   text,

  -- test_phone   = el número DESDE el que escribe el comprador (tu device).
  -- target_phone = el número DEL AGENTE bajo prueba (a dónde escribís).
  -- Los dos en solo dígitos. Confundirlos es el error clásico del setup.
  test_phone    text not null,
  target_phone  text,          -- (venía de la migración 015)
  channel_uuid  text,          -- id de canal del proveedor, si aplica

  metadata      jsonb not null default '{}'::jsonb,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_smoke_suites_empresa     on public.smoke_test_suites (empresa_id);
create index if not exists idx_smoke_suites_agent       on public.smoke_test_suites (agente_ia_id);
create index if not exists idx_smoke_suites_test_phone  on public.smoke_test_suites (test_phone);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_smoke_suites_updated') then
    create trigger trg_smoke_suites_updated before update on public.smoke_test_suites
      for each row execute function public.update_updated_at();
  end if;
end $$;

-- ─── 1.2 Secuencias ─────────────────────────────────────────────────────────
-- En modo guion: la lista completa de mensajes del comprador.
-- En modo autónomo: solo se usan messages[0] (arranque) y ficha_tecnica
-- (contexto que el comprador conoce). El resto lo escribe la IA.
create table if not exists public.smoke_test_sequences (
  id            uuid primary key default gen_random_uuid(),
  suite_id      uuid not null references public.smoke_test_suites(id) on delete cascade,
  nombre        text not null,
  proyecto_ref  text,

  -- [{ "text": "...", "delay": 8000 }, ...]  delay en ms ANTES del siguiente
  messages      jsonb not null default '[]'::jsonb,

  -- Verdad de referencia contra la que el evaluador mide alucinaciones.
  -- Sin esto el evaluador califica estilo, no exactitud.
  ficha_tecnica text,

  propiedad_id  uuid references public.propiedades(id) on delete set null,
  orden         integer not null default 0,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_smoke_sequences_suite on public.smoke_test_sequences (suite_id, orden);

-- ─── 1.3 Runs ───────────────────────────────────────────────────────────────
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

  -- RECOMENDACIÓN: agregá `updated_at timestamptz not null default now()` con
  -- su trigger. En el original NO existe, y por eso el watchdog tiene que
  -- inferir "última actividad" desde smoke_test_results.last_buyer_at, que es
  -- frágil y le costó un caso entero (el "caso D — runs zombis").
);

create index if not exists idx_smoke_runs_suite   on public.smoke_test_runs (suite_id, created_at desc);
create index if not exists idx_smoke_runs_empresa on public.smoke_test_runs (empresa_id, created_at desc);

-- ─── 1.4 Resultados ─────────────────────────────────────────────────────────
create table if not exists public.smoke_test_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.smoke_test_runs(id) on delete cascade,
  sequence_id   uuid not null references public.smoke_test_sequences(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending','running','completed','failed','timeout')),

  -- LA TRANSCRIPCIÓN. Formato canónico, no lo cambies:
  -- [{ "role": "buyer"|"agent", "text": "...", "timestamp": "ISO" }, ...]
  conversation  jsonb not null default '[]'::jsonb,

  score         numeric,
  evaluation    jsonb not null default '{}'::jsonb,
  error_message text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_smoke_results_run on public.smoke_test_results (run_id);
create index if not exists idx_smoke_results_seq on public.smoke_test_results (sequence_id);


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 · transporte asíncrono (migración 015)
--
-- Estas dos columnas son TODA la máquina de correlación: cuando llega un
-- mensaje por webhook, el sistema busca la fila con awaiting_reply=true más
-- reciente y le cuelga la respuesta.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.smoke_test_results
  add column if not exists awaiting_reply boolean not null default false,
  add column if not exists last_buyer_at  timestamptz;

-- Índice PARCIAL: casi todas las filas tienen awaiting_reply=false, así que
-- indexar solo las true mantiene la búsqueda del webhook en O(activas).
create index if not exists idx_smoke_results_awaiting
  on public.smoke_test_results (awaiting_reply) where awaiting_reply = true;

-- RECOMENDACIÓN FUERTE (no está en el original): agregá el teléfono a la fila
-- y filtrá el webhook por él. Hoy la correlación asume "un solo run activo a
-- la vez" y con dos suites corriendo en paralelo las conversaciones se
-- mezclan. Ver 05-QUE-FUNCIONO-Y-QUE-NO.md §"La deuda que queda".
--
--   alter table public.smoke_test_results
--     add column if not exists target_phone text;
--   create index if not exists idx_smoke_results_target
--     on public.smoke_test_results (target_phone) where awaiting_reply = true;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 · modo autónomo, auditoría y colas (migración 022)
-- ════════════════════════════════════════════════════════════════════════════

alter table public.smoke_test_runs
  -- OJO: este CHECK es el que impidió agregar un valor 'autonomo'. Por eso el
  -- modo autónomo del PRD 52 vive en form_data.modo y no aquí. Si arrancás de
  -- cero, poné 'autonomo' en la lista desde el principio.
  add column if not exists trigger_type text not null default 'manual'
    check (trigger_type in ('manual','form_trigger','webhook','autonomo')),

  -- form_data es el saco de estado del run. En modo autónomo guarda:
  --   { modo:'autonomo', objetivo, persona, contexto, max_turnos,
  --     turno, turn_token, motivo_cierre, ultimo_motivo, fuente_comprador }
  add column if not exists form_data jsonb not null default '{}'::jsonb,

  add column if not exists template_received_at timestamptz,
  add column if not exists bubble_response      jsonb not null default '{}'::jsonb,
  add column if not exists waiting_for_template boolean not null default false,

  -- El veredicto de una línea: cómo terminó.
  add column if not exists closed_with text
    check (closed_with is null or closed_with in ('agendado','cotizacion','timeout','incomplete')),

  add column if not exists audit_result      jsonb not null default '{}'::jsonb,
  add column if not exists campaign_queue_id uuid;

create index if not exists idx_smoke_runs_waiting_template
  on public.smoke_test_runs (waiting_for_template) where waiting_for_template = true;

alter table public.smoke_test_results
  add column if not exists audit_steps      jsonb not null default '[]'::jsonb,
  add column if not exists critical_errors  jsonb not null default '[]'::jsonb,
  add column if not exists warning_errors   jsonb not null default '[]'::jsonb,
  add column if not exists step_validations jsonb not null default '{}'::jsonb;

alter table public.smoke_test_sequences
  add column if not exists trigger_type text not null default 'manual'
    check (trigger_type in ('manual','prodesa_template')),
  add column if not exists expected_steps jsonb not null default '[]'::jsonb;

-- ─── Colas seriales ─────────────────────────────────────────────────────────
-- Un solo número de pruebas ⇒ las conversaciones DEBEN correr de a una. La
-- cola guarda la lista de escenarios y avanza cuando el run anterior llega a
-- un estado terminal.
create table if not exists public.smoke_campaign_queues (
  id                       uuid primary key default gen_random_uuid(),
  suite_id                 uuid not null references public.smoke_test_suites(id) on delete cascade,
  empresa_id               uuid not null references public.empresas(id) on delete cascade,
  status                   text not null default 'pending'
    check (status in ('pending','running','completed','cancelled','failed')),
  project_ids              uuid[] not null,   -- renombralo a scenario_ids en tu app
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
  on public.smoke_campaign_queues (status) where status in ('pending','running');
create index if not exists idx_campaign_queues_suite
  on public.smoke_campaign_queues (suite_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'smoke_test_runs_campaign_queue_id_fkey') then
    alter table public.smoke_test_runs
      add constraint smoke_test_runs_campaign_queue_id_fkey
      foreign key (campaign_queue_id) references public.smoke_campaign_queues(id) on delete set null;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_campaign_queues_updated') then
    create trigger trg_campaign_queues_updated before update on public.smoke_campaign_queues
      for each row execute function public.update_updated_at();
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 · catálogo de escenarios (OPCIONAL — ejemplo de un cliente)
--
-- Esta tabla es "los 29 proyectos de una constructora". Existe para que el
-- generador de secuencias arme mensajes coherentes (presupuesto = mediana de
-- los precios reales) y para que el auditor sepa qué #ID esperar.
--
-- En tu app: reemplazala por la tabla que describe TUS escenarios de prueba,
-- o borrala si el comprador IA no necesita datos de referencia.
-- ════════════════════════════════════════════════════════════════════════════
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
  ciudadela_id    text,
  proyecto_id     text,
  subtipos        jsonb not null default '[]'::jsonb,
  raw_data        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_prodesa_projects_categoria on public.prodesa_projects (categoria);
create index if not exists idx_prodesa_projects_nombre    on public.prodesa_projects (nombre_proyecto);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_prodesa_projects_updated') then
    create trigger trg_prodesa_projects_updated before update on public.prodesa_projects
      for each row execute function public.update_updated_at();
  end if;
end $$;

alter table public.smoke_test_sequences
  add column if not exists prodesa_project_id uuid references public.prodesa_projects(id) on delete set null;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 5 · RLS
--
-- Dos capas:
--   service_role → acceso total. Es el que usan el motor, el webhook y el
--                  cron, que corren SIN sesión de usuario.
--   empresa      → los usuarios ven solo lo de su empresa.
--
-- El bug que esto previene: si el webhook lee con un cliente que lleva
-- cookies, la RLS aplica, no encuentra el run y el mensaje entrante se pierde
-- en silencio. En el motor: SIEMPRE service-role.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.smoke_test_suites    enable row level security;
alter table public.smoke_test_sequences enable row level security;
alter table public.smoke_test_runs      enable row level security;
alter table public.smoke_test_results   enable row level security;
alter table public.smoke_campaign_queues enable row level security;
alter table public.prodesa_projects     enable row level security;

do $$
begin
  -- service_role: todo
  if not exists (select 1 from pg_policies where tablename='smoke_test_suites' and policyname='service_all_smoke_suites') then
    create policy "service_all_smoke_suites" on public.smoke_test_suites for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_test_sequences' and policyname='service_all_smoke_sequences') then
    create policy "service_all_smoke_sequences" on public.smoke_test_sequences for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_test_runs' and policyname='service_all_smoke_runs') then
    create policy "service_all_smoke_runs" on public.smoke_test_runs for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_test_results' and policyname='service_all_smoke_results') then
    create policy "service_all_smoke_results" on public.smoke_test_results for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_campaign_queues' and policyname='service_all_campaign_queues') then
    create policy "service_all_campaign_queues" on public.smoke_campaign_queues for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='prodesa_projects' and policyname='service_all_prodesa_projects') then
    create policy "service_all_prodesa_projects" on public.prodesa_projects for all to service_role using (true) with check (true);
  end if;

  -- empresa: solo lo suyo
  if not exists (select 1 from pg_policies where tablename='smoke_test_suites' and policyname='empresa_smoke_suites') then
    create policy "empresa_smoke_suites" on public.smoke_test_suites for all
      using (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null))
      with check (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null));
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_test_sequences' and policyname='empresa_smoke_sequences') then
    create policy "empresa_smoke_sequences" on public.smoke_test_sequences for all
      using (suite_id in (select id from public.smoke_test_suites
        where empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null)));
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_test_runs' and policyname='empresa_smoke_runs') then
    create policy "empresa_smoke_runs" on public.smoke_test_runs for all
      using (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null));
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_test_results' and policyname='empresa_smoke_results') then
    create policy "empresa_smoke_results" on public.smoke_test_results for all
      using (run_id in (select id from public.smoke_test_runs
        where empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null)));
  end if;
  if not exists (select 1 from pg_policies where tablename='smoke_campaign_queues' and policyname='empresa_campaign_queues') then
    create policy "empresa_campaign_queues" on public.smoke_campaign_queues for all
      using (empresa_id in (select empresa_id from public.profiles where id = auth.uid() and empresa_id is not null));
  end if;
  if not exists (select 1 from pg_policies where tablename='prodesa_projects' and policyname='read_prodesa_projects') then
    create policy "read_prodesa_projects" on public.prodesa_projects for select to authenticated using (true);
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- CONSULTAS ÚTILES PARA OPERAR
-- ════════════════════════════════════════════════════════════════════════════

-- ¿Qué está vivo ahora mismo?
--   select r.id, r.status, r.trigger_type, r.form_data->>'modo' as modo,
--          r.form_data->>'turno' as turno, res.awaiting_reply, res.last_buyer_at,
--          jsonb_array_length(res.conversation) as mensajes
--   from smoke_test_runs r
--   join smoke_test_results res on res.run_id = r.id
--   where r.status in ('running','pending')
--   order by r.created_at desc;

-- Matar zombis a mano (los que envenenan la correlación del webhook):
--   update smoke_test_runs set status='cancelled', completed_at=now()
--   where status='running' and created_at < now() - interval '2 hours';
--   update smoke_test_results set status='failed', awaiting_reply=false,
--          completed_at=now(), error_message='cancelado a mano'
--   where run_id in (...) and status in ('pending','running');

-- Cómo cerraron los últimos 20 runs:
--   select closed_with, count(*) from smoke_test_runs
--   where completed_at > now() - interval '7 days' group by 1;
