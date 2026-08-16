-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · v2 — Motor de correo, activos y feed del President
-- ═══════════════════════════════════════════════════════════════════════════
-- Todo sigue viviendo en el schema `holaamigo` (ADR 0001). Idempotente.
--
-- Qué agrega:
--   · integrations      → credenciales por proveedor (SendGrid, Instantly)
--   · mailboxes         → las bandejas del cliente: varias, con caps y warmup
--   · email_threads     → la conversación, no el mensaje suelto
--   · campaigns (alter) → objetivo, secuencia, esperado, medición, iteración
--   · campaign_metrics  → rollup diario, la base de la observabilidad
--   · assets            → agendador y checkout brandeados (ADR 0010)
--   · bookings / orders → lo que esos activos producen, con atribución
--   · products          → inventario del cliente para los checkouts
--   · credit_ledger     → contabilidad de créditos (ADR 0011)
--   · feed_items        → cómo habla el President (ADR 0012)
--   · scheduled_actions → qué está programado, por qué y cómo se mide
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ INTEGRACIONES ═══════════════
-- Una fila por proveedor y organización. `credentials` guarda la API key.
-- v1 en claro: el schema es deny-by-default y solo se lee con service_role
-- desde código de servidor (ADR 0003). Cuando haya más de un operador con
-- acceso a la base, esto pasa a Vault. Está anotado en el runbook.

create table if not exists holaamigo.integrations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  provider text not null check (provider in ('sendgrid','instantly','whatsapp','payments')),
  status text not null default 'pending'
    check (status in ('pending','connected','failed','revoked')),
  credentials jsonb not null default '{}',
  meta jsonb not null default '{}',
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text
);
create unique index if not exists integrations_key
  on holaamigo.integrations (organization_id, provider);

-- ═══════════════ BANDEJAS ═══════════════
-- Un cliente tiene varias direcciones desde las que envía y recibe. La rotación
-- entre bandejas es lo que hace que 500 envíos/día no salgan todos del mismo
-- remitente, que es exactamente cómo se quema un dominio.

create table if not exists holaamigo.mailboxes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  address text not null,
  display_name text,
  provider text not null default 'sendgrid',
  purpose text not null default 'both' check (purpose in ('outbound','inbound','both')),
  status text not null default 'pending'
    check (status in ('pending','warming','active','paused','blocked')),
  -- Tope diario duro. El dispatcher nunca lo cruza, ni con una campaña aprobada.
  daily_cap int not null default 40,
  -- Calentamiento: el cap efectivo del día sale de warmup_started_at, no de un
  -- cron que "sube el número". Ver lib/email/mailboxes.ts
  warmup_started_at timestamptz,
  reply_to text,
  signature_html text,
  -- Dirección de la Inbound Parse de SendGrid que enruta a esta bandeja.
  inbound_address text,
  domain_auth jsonb not null default '{}',   -- {spf, dkim, dmarc, verified_at}
  sent_today int not null default 0,
  sent_today_date date not null default current_date,
  last_sent_at timestamptz,
  bounce_rate numeric not null default 0,
  complaint_rate numeric not null default 0,
  is_default boolean not null default false
);
create unique index if not exists mailboxes_address_key
  on holaamigo.mailboxes (organization_id, lower(address));
create index if not exists mailboxes_org_idx
  on holaamigo.mailboxes (organization_id, status);
create unique index if not exists mailboxes_inbound_key
  on holaamigo.mailboxes (lower(inbound_address)) where inbound_address is not null;

-- ═══════════════ HILOS DE CORREO ═══════════════
-- El producto de la bandeja es el HILO, no el mensaje. Lo que el cliente mira
-- es "esta conversación necesita que yo entre o no".

create table if not exists holaamigo.email_threads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  mailbox_id uuid references holaamigo.mailboxes(id) on delete set null,
  lead_id uuid references holaamigo.leads(id) on delete set null,
  campaign_id uuid references holaamigo.campaigns(id) on delete set null,
  subject text,
  contact_email text,
  -- Message-ID del primer correo saliente. Es lo que permite emparejar la
  -- respuesta con el hilo cuando el cliente responde desde su propio cliente
  -- de correo y el In-Reply-To es lo único que llega.
  root_message_id text,
  status text not null default 'open'
    check (status in ('open','waiting','won','lost','snoozed','closed')),
  intent text,
  needs_human boolean not null default false,
  human_reason text,
  last_direction text check (last_direction in ('in','out')),
  last_message_at timestamptz,
  snippet text,
  handled_at timestamptz,
  handled_by text
);
create index if not exists email_threads_org_idx
  on holaamigo.email_threads (organization_id, needs_human desc, last_message_at desc);
create index if not exists email_threads_root_idx
  on holaamigo.email_threads (root_message_id);
create index if not exists email_threads_contact_idx
  on holaamigo.email_threads (organization_id, lower(contact_email));

-- ═══════════════ CAMPAÑAS: DE "LISTA DE ENVÍOS" A "PLAN" ═══════════════
-- Una campaña sin resultado esperado y sin criterio de iteración no es una
-- campaña: es un envío. Estas columnas son las que la vuelven auditable.

alter table holaamigo.campaigns
  add column if not exists playbook text,
  add column if not exists objective text,
  add column if not exists hypothesis text,
  add column if not exists segment_name text,
  add column if not exists segment_rules jsonb not null default '{}',
  add column if not exists sequence jsonb not null default '[]',
  add column if not exists mailbox_ids uuid[] not null default '{}',
  add column if not exists asset_id uuid,
  add column if not exists expected jsonb not null default '{}',
  add column if not exists measurement jsonb not null default '{}',
  add column if not exists iteration jsonb not null default '{}',
  add column if not exists audience_size int not null default 0,
  add column if not exists credits_estimate int not null default 0,
  add column if not exists credits_spent int not null default 0,
  add column if not exists proposed_by text,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists scheduled_for timestamptz,
  add column if not exists timezone text not null default 'America/Bogota',
  add column if not exists paused_reason text,
  add column if not exists iteration_round int not null default 1,
  add column if not exists parent_campaign_id uuid;

-- `scheduled` es un estado real: aprobada pero todavía no arrancó.
alter table holaamigo.campaigns drop constraint if exists campaigns_status_check;
alter table holaamigo.campaigns add constraint campaigns_status_check
  check (status in ('draft','proposed','pending_approval','scheduled','active','paused','done','rejected'));

create index if not exists campaigns_org_status_idx
  on holaamigo.campaigns (organization_id, status, created_at desc);

create table if not exists holaamigo.campaign_metrics (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references holaamigo.campaigns(id) on delete cascade,
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  day date not null default current_date,
  sent int not null default 0,
  delivered int not null default 0,
  bounced int not null default 0,
  opened int not null default 0,
  clicked int not null default 0,
  replied int not null default 0,
  positive int not null default 0,
  booked int not null default 0,
  orders int not null default 0,
  revenue_usd numeric(12,2) not null default 0,
  credits int not null default 0
);
create unique index if not exists campaign_metrics_key
  on holaamigo.campaign_metrics (campaign_id, day);
create index if not exists campaign_metrics_org_idx
  on holaamigo.campaign_metrics (organization_id, day desc);

-- ═══════════════ MENSAJES: LO QUE FALTABA PARA CORREO ═══════════════

alter table holaamigo.messages
  add column if not exists organization_id uuid references holaamigo.organizations(id) on delete cascade,
  add column if not exists mailbox_id uuid references holaamigo.mailboxes(id) on delete set null,
  add column if not exists thread_id uuid references holaamigo.email_threads(id) on delete cascade,
  add column if not exists subject text,
  add column if not exists from_address text,
  add column if not exists to_address text,
  add column if not exists headers jsonb not null default '{}',
  add column if not exists step_index int not null default 0,
  add column if not exists scheduled_for timestamptz,
  add column if not exists classification jsonb,
  add column if not exists needs_human boolean not null default false,
  add column if not exists credits int not null default 0;

alter table holaamigo.messages drop constraint if exists messages_status_check;
alter table holaamigo.messages add constraint messages_status_check
  check (status in ('scheduled','queued','sent','delivered','read','clicked','replied','failed','bounced','skipped'));

create index if not exists messages_thread_idx on holaamigo.messages (thread_id, created_at);
create index if not exists messages_due_idx
  on holaamigo.messages (status, scheduled_for) where status = 'scheduled';
create index if not exists messages_external_idx on holaamigo.messages (external_id);

-- ═══════════════ ACTIVOS BRANDEADOS (ADR 0010) ═══════════════
-- El agendador y el checkout son nuestros mini-productos. Cada uno vive en un
-- link con slug propio, y CADA interacción se registra: sin eso no podemos
-- decir "estas 100 ventas son nuestras" y el modelo de fee no existe.

create table if not exists holaamigo.assets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  kind text not null check (kind in ('scheduler','checkout')),
  slug text not null,
  name text not null,
  headline text,
  description text,
  config jsonb not null default '{}',
  status text not null default 'active' check (status in ('draft','active','paused')),
  -- % que cobramos sobre lo que este activo genere. 0 = sin fee (agendador).
  revenue_share_pct numeric(5,2) not null default 0,
  created_by text not null default 'holaamigo'
);
create unique index if not exists assets_slug_key on holaamigo.assets (lower(slug));
create index if not exists assets_org_idx on holaamigo.assets (organization_id, kind, status);

create table if not exists holaamigo.asset_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  asset_id uuid not null references holaamigo.assets(id) on delete cascade,
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  type text not null check (type in ('view','start','submit','converted','abandoned')),
  lead_id uuid references holaamigo.leads(id) on delete set null,
  campaign_id uuid references holaamigo.campaigns(id) on delete set null,
  message_id uuid references holaamigo.messages(id) on delete set null,
  props jsonb not null default '{}'
);
create index if not exists asset_events_asset_idx
  on holaamigo.asset_events (asset_id, created_at desc);
create index if not exists asset_events_org_idx
  on holaamigo.asset_events (organization_id, type, created_at desc);

-- ── Agendamientos ──────────────────────────────────────────────────────────

create table if not exists holaamigo.bookings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  asset_id uuid references holaamigo.assets(id) on delete set null,
  lead_id uuid references holaamigo.leads(id) on delete set null,
  campaign_id uuid references holaamigo.campaigns(id) on delete set null,
  thread_id uuid references holaamigo.email_threads(id) on delete set null,
  contact_name text,
  contact_email text not null,
  contact_phone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/Bogota',
  status text not null default 'booked'
    check (status in ('booked','rescheduled','cancelled','completed','no_show')),
  -- link (el mini-calendly), reply (el agente lo agendó desde una respuesta),
  -- manual (lo puso una persona).
  source text not null default 'link' check (source in ('link','reply','manual','whatsapp')),
  notes text,
  answers jsonb not null default '{}',
  -- Token del enlace de gestión que va en el correo de confirmación.
  manage_token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  cancelled_reason text
);
create index if not exists bookings_org_idx
  on holaamigo.bookings (organization_id, starts_at desc);
create index if not exists bookings_asset_idx
  on holaamigo.bookings (asset_id, starts_at);
-- Un mismo correo no puede tener dos citas vivas en el mismo horario.
create unique index if not exists bookings_slot_key
  on holaamigo.bookings (asset_id, starts_at)
  where status in ('booked','rescheduled');

-- ── Inventario y checkout ──────────────────────────────────────────────────

create table if not exists holaamigo.products (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  sku text not null,
  name text not null,
  description text,
  kind text not null default 'other'
    check (kind in ('ticket','course','service','subscription','physical','other')),
  price_usd numeric(12,2) not null default 0,
  currency text not null default 'USD',
  price_local numeric(14,2),
  -- null = inventario ilimitado (un curso). Un número = entradas de un evento.
  inventory int,
  sold int not null default 0,
  active boolean not null default true,
  image_url text,
  metadata jsonb not null default '{}'
);
create unique index if not exists products_sku_key
  on holaamigo.products (organization_id, lower(sku));
create index if not exists products_org_idx
  on holaamigo.products (organization_id, active);

create table if not exists holaamigo.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  asset_id uuid references holaamigo.assets(id) on delete set null,
  lead_id uuid references holaamigo.leads(id) on delete set null,
  campaign_id uuid references holaamigo.campaigns(id) on delete set null,
  message_id uuid references holaamigo.messages(id) on delete set null,
  thread_id uuid references holaamigo.email_threads(id) on delete set null,
  buyer jsonb not null default '{}',        -- {name, email, phone}
  items jsonb not null default '[]',        -- [{product_id, sku, name, qty, unit_usd}]
  subtotal_usd numeric(12,2) not null default 0,
  currency text not null default 'USD',
  total_local numeric(14,2),
  status text not null default 'pending'
    check (status in ('pending','paid','failed','refunded','cancelled')),
  -- v1: 'placeholder'. La integración real con la pasarela va después (ADR 0013).
  provider text not null default 'placeholder',
  external_id text,
  -- Lo que cobramos por haber generado esta venta. Se calcula al crear la orden
  -- y se congela: cambiar el % después no puede reescribir lo ya facturado.
  fee_pct numeric(5,2) not null default 0,
  fee_usd numeric(12,2) not null default 0,
  attribution jsonb not null default '{}',  -- por qué decimos que es nuestra
  paid_at timestamptz
);
create index if not exists orders_org_idx
  on holaamigo.orders (organization_id, created_at desc);
create index if not exists orders_campaign_idx
  on holaamigo.orders (campaign_id, status);

-- ═══════════════ CRÉDITOS (ADR 0011) ═══════════════
-- Contabilidad de partida simple: solo se inserta, nunca se actualiza. El saldo
-- es la suma. Un saldo que se guarda en una columna se desincroniza; una suma
-- sobre un ledger inmutable se puede auditar línea por línea.

create table if not exists holaamigo.credit_ledger (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  delta int not null,
  kind text not null,        -- grant | email_send | whatsapp | ai_run | refund | adjustment
  reference_table text,
  reference_id uuid,
  note text,
  created_by text not null default 'system'
);
create index if not exists credit_ledger_org_idx
  on holaamigo.credit_ledger (organization_id, created_at desc);

create or replace function holaamigo.credit_balance(org uuid)
returns int language sql stable as $$
  select coalesce(sum(delta), 0)::int
  from holaamigo.credit_ledger
  where organization_id = org;
$$;

-- ═══════════════ FEED DEL PRESIDENT (ADR 0012) ═══════════════
-- `approvals` sigue siendo el registro de decisiones. `feed_items` es cómo el
-- President le habla al humano: propone, pide, reporta y alerta. Un item de
-- tipo `proposal` SIEMPRE tiene su approval_id: la decisión se audita en un
-- solo lugar.

create table if not exists holaamigo.feed_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  kind text not null check (kind in ('proposal','ask','digest','alert','win')),
  role text not null default 'president' check (role in ('president','cmo','sales','system')),
  title text not null,
  body text not null,
  rationale text,
  -- Cifras y fuentes que sostienen lo que dice el body. Las calcula el código.
  evidence jsonb not null default '{}',
  requires text not null default 'nothing'
    check (requires in ('approval','input','nothing')),
  input_kind text,           -- video | copy | dato | decision
  approval_id uuid references holaamigo.approvals(id) on delete set null,
  campaign_id uuid references holaamigo.campaigns(id) on delete set null,
  thread_id uuid references holaamigo.email_threads(id) on delete set null,
  payload jsonb not null default '{}',
  status text not null default 'open'
    check (status in ('open','approved','rejected','answered','dismissed','expired')),
  severity text not null default 'normal' check (severity in ('low','normal','high')),
  response jsonb,
  responded_by text,
  responded_at timestamptz,
  expires_at timestamptz,
  -- Clave de deduplicación del digest diario: un resumen por día por org.
  dedupe_key text
);
create index if not exists feed_items_org_idx
  on holaamigo.feed_items (organization_id, status, created_at desc);
create unique index if not exists feed_items_dedupe_key
  on holaamigo.feed_items (organization_id, dedupe_key) where dedupe_key is not null;

-- ═══════════════ LO QUE ESTÁ PROGRAMADO ═══════════════
-- "Qué va a pasar, por qué, y cómo vamos a saber si sirvió" — en una tabla,
-- no en la cabeza del operador. Es la mitad de la observabilidad (§14).

create table if not exists holaamigo.scheduled_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  kind text not null,        -- campaign_send | campaign_step | digest | warmup_step | review
  title text not null,
  why text not null,
  how_measured text not null,
  run_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','running','done','failed','cancelled')),
  campaign_id uuid references holaamigo.campaigns(id) on delete cascade,
  feed_item_id uuid references holaamigo.feed_items(id) on delete set null,
  approval_id uuid references holaamigo.approvals(id) on delete set null,
  payload jsonb not null default '{}',
  result jsonb,
  executed_at timestamptz,
  error text
);
create index if not exists scheduled_actions_due_idx
  on holaamigo.scheduled_actions (status, run_at);
create index if not exists scheduled_actions_org_idx
  on holaamigo.scheduled_actions (organization_id, run_at desc);

-- ═══════════════ AGENTES CONFIGURABLES ═══════════════
-- El contrato (objetivo/presupuesto/permisos/escalamiento) no se toca: es lo
-- que gobierna. `config` es lo que el cliente SÍ puede ajustar sin romperlo.

alter table holaamigo.agents
  add column if not exists config jsonb not null default '{}',
  add column if not exists autonomy text not null default 'propose',
  add column if not exists updated_at timestamptz not null default now();

alter table holaamigo.agents drop constraint if exists agents_autonomy_check;
alter table holaamigo.agents add constraint agents_autonomy_check
  check (autonomy in ('propose','approve_each','auto_within_limits'));

-- ═══════════════ LEADS: DE DÓNDE VINIERON ═══════════════

alter table holaamigo.lead_batches drop constraint if exists lead_batches_source_check;
alter table holaamigo.lead_batches add constraint lead_batches_source_check
  check (source in ('upload','apollo','apify','instantly','manual','inbound'));

alter table holaamigo.leads
  add column if not exists source text,
  add column if not exists external_ref text,
  add column if not exists timezone text;
create index if not exists leads_email_idx on holaamigo.leads (organization_id, lower(email));

-- ═══════════════ RLS: DENY BY DEFAULT SOBRE LO NUEVO ═══════════════
-- Mismo bloque de 0001: recorre TODAS las tablas del schema, así que las
-- nuevas quedan cubiertas sin enumerarlas.

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

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
grant execute on function holaamigo.credit_balance(uuid) to service_role;
revoke all on schema holaamigo from anon, authenticated;

-- ═══════════════ TRIGGERS DE updated_at ═══════════════

do $$
declare t text;
begin
  foreach t in array array[
    'integrations','mailboxes','email_threads','assets','bookings','products','orders','agents'
  ]
  loop
    execute format('drop trigger if exists %I_touch on holaamigo.%I', t, t);
    execute format(
      'create trigger %I_touch before update on holaamigo.%I
       for each row execute function holaamigo.touch_updated_at()', t, t);
  end loop;
end $$;
