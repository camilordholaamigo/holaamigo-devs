-- Integración opcional GTM Radar -> Smoke Tester.
-- Audit-GTM decide qué probar; Hola Amigo conserva toda la evidencia sensible.

set search_path = holaamigo, public;

do $$ begin
  if to_regclass('holaamigo.smoke_batches') is null then
    raise exception '0019 requiere 0015_lotes_e_informes.sql';
  end if;
end $$;

create table if not exists holaamigo.radar_smoke_requests (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique,
  radar_variant_id uuid not null,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  body_hash text not null check (body_hash ~ '^[a-f0-9]{64}$'),
  callback_url text not null check (callback_url ~ '^https://'),
  status text not null default 'queued' check (status in ('queued','running','completed','partial','failed')),
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists holaamigo.radar_smoke_request_targets (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references holaamigo.radar_smoke_requests(id) on delete cascade,
  external_brand_id uuid not null,
  brand_name text not null check (char_length(brand_name) between 1 and 160),
  role text not null check (role in ('primary','competitor')),
  candidate_id uuid not null,
  organization_id uuid references holaamigo.organizations(id) on delete set null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_url text not null check (whatsapp_url ~ '^https://(wa\.me|api\.whatsapp\.com)/'),
  source_page_url text not null check (source_page_url ~ '^https://'),
  source_evidence_hash text not null check (source_evidence_hash ~ '^[a-f0-9]{64}$'),
  batch_id uuid references holaamigo.smoke_batches(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','completed','partial','failed','blocked')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, external_brand_id),
  unique (request_id, candidate_id)
);

create index if not exists radar_smoke_targets_request_idx
  on holaamigo.radar_smoke_request_targets (request_id, status);

create table if not exists holaamigo.radar_smoke_callback_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references holaamigo.radar_smoke_requests(id) on delete cascade,
  idempotency_key text not null unique,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  body_hash text not null check (body_hash ~ '^[a-f0-9]{64}$'),
  attempts int not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table holaamigo.radar_smoke_requests enable row level security;
alter table holaamigo.radar_smoke_request_targets enable row level security;
alter table holaamigo.radar_smoke_callback_outbox enable row level security;
alter table holaamigo.radar_smoke_requests force row level security;
alter table holaamigo.radar_smoke_request_targets force row level security;
alter table holaamigo.radar_smoke_callback_outbox force row level security;

revoke all on holaamigo.radar_smoke_requests from anon, authenticated;
revoke all on holaamigo.radar_smoke_request_targets from anon, authenticated;
revoke all on holaamigo.radar_smoke_callback_outbox from anon, authenticated;
grant select, insert, update on holaamigo.radar_smoke_requests to service_role;
grant select, insert, update on holaamigo.radar_smoke_request_targets to service_role;
grant select, insert, update on holaamigo.radar_smoke_callback_outbox to service_role;

comment on table holaamigo.radar_smoke_callback_outbox is
  'Outbox durable. El cuerpo contiene solo el resumen publicable, nunca teléfonos ni transcripciones.';

create or replace function holaamigo.reserve_radar_smoke_target(
  p_phone_e164 text,
  p_organization_id uuid,
  p_name text,
  p_source_url text
) returns jsonb
language plpgsql
security definer
set search_path = holaamigo, public, pg_temp
as $$
declare
  v_target holaamigo.smoke_targets%rowtype;
begin
  if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' or p_source_url !~ '^https://' then
    return jsonb_build_object('ready', false, 'reason', 'invalid');
  end if;
  insert into holaamigo.smoke_targets (organization_id, nombre, phone_e164, origen, source_url, confianza)
  values (p_organization_id, p_name, p_phone_e164, 'manual', p_source_url, 1)
  on conflict (phone_e164) do nothing;

  select * into v_target from holaamigo.smoke_targets
   where phone_e164 = p_phone_e164 for update;
  if v_target.bloqueado then return jsonb_build_object('ready', false, 'reason', 'blocked'); end if;
  if v_target.ultima_prueba_at is not null and v_target.ultima_prueba_at > now() - interval '72 hours' then
    return jsonb_build_object('ready', false, 'reason', 'cooldown');
  end if;
  update holaamigo.smoke_targets set
    organization_id = coalesce(organization_id, p_organization_id),
    nombre = coalesce(nombre, p_name),
    source_url = coalesce(source_url, p_source_url),
    ultima_prueba_at = now(), updated_at = now()
  where id = v_target.id;
  return jsonb_build_object('ready', true, 'target_id', v_target.id);
end;
$$;

revoke all on function holaamigo.reserve_radar_smoke_target(text, uuid, text, text) from public, anon, authenticated;
grant execute on function holaamigo.reserve_radar_smoke_target(text, uuid, text, text) to service_role;

create or replace function holaamigo.accept_radar_smoke_request(
  p_connection_id uuid,
  p_radar_variant_id uuid,
  p_idempotency_key text,
  p_body_hash text,
  p_callback_url text,
  p_targets jsonb
) returns jsonb
language plpgsql
security definer
set search_path = holaamigo, public, pg_temp
as $$
declare
  v_request holaamigo.radar_smoke_requests%rowtype;
  v_target jsonb;
begin
  select * into v_request from holaamigo.radar_smoke_requests
   where idempotency_key = p_idempotency_key for update;
  if found then
    if v_request.body_hash <> p_body_hash then raise exception 'RADAR_SMOKE_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('id', v_request.id, 'connection_id', v_request.connection_id,
      'status', v_request.status, 'created_at', v_request.created_at);
  end if;
  if jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) not between 1 and 5 then
    raise exception 'RADAR_SMOKE_TARGETS_INVALID';
  end if;
  begin
    insert into holaamigo.radar_smoke_requests
      (connection_id, radar_variant_id, idempotency_key, body_hash, callback_url)
    values (p_connection_id, p_radar_variant_id, p_idempotency_key, p_body_hash, p_callback_url)
    returning * into v_request;
  exception when unique_violation then
    select * into v_request from holaamigo.radar_smoke_requests
     where idempotency_key = p_idempotency_key;
    if not found or v_request.body_hash <> p_body_hash then raise exception 'RADAR_SMOKE_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('id', v_request.id, 'connection_id', v_request.connection_id,
      'status', v_request.status, 'created_at', v_request.created_at);
  end;

  for v_target in select value from jsonb_array_elements(p_targets) loop
    insert into holaamigo.radar_smoke_request_targets
      (request_id, external_brand_id, brand_name, role, candidate_id, organization_id,
       phone_e164, whatsapp_url, source_page_url, source_evidence_hash)
    values
      (v_request.id, (v_target->>'brand_id')::uuid, v_target->>'brand_name', v_target->>'role',
       (v_target->>'candidate_id')::uuid, nullif(v_target->>'confirmed_organization_id','')::uuid,
       v_target->>'phone_e164', v_target->>'whatsapp_url', v_target->>'source_page_url',
       v_target->>'evidence_hash');
  end loop;
  return jsonb_build_object('id', v_request.id, 'connection_id', v_request.connection_id,
    'status', v_request.status, 'created_at', v_request.created_at);
end;
$$;

revoke all on function holaamigo.accept_radar_smoke_request(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function holaamigo.accept_radar_smoke_request(uuid, uuid, text, text, text, jsonb) to service_role;
