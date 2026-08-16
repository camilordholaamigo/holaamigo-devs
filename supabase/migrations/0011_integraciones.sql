-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · P6 — Habilidades, integraciones, lotes y CRM propio
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- P2 definió qué puede HACER un agente. Esto define qué puede USAR. Son dos
-- preguntas distintas y hasta ahora solo teníamos la primera: un agente con
-- permiso L4 para contactar partners y sin forma de buscarlos en LinkedIn tiene
-- una autorización que no puede ejercer.
--
-- Cuatro piezas:
--
--   skills          el catálogo de herramientas y quién las alcanza
--   integrations    la llave del cliente (HubSpot, Stripe…) y su cursor
--   analysis_batches lo que cuesta analizar una base y qué devuelve
--   opportunities   el CRM propio, con trazabilidad de ACTOR
--
-- LO QUE HACE QUE ESTO CREZCA SOLO — el "intraer":
--
--   Cuando un agente se topa con un muro, crea un `skill_request` con su
--   justificación y la decisión que quedó bloqueada. Aparece en nuestro admin
--   como tarjeta. Los agentes empujan capacidades hacia sí mismos y nosotros
--   decidimos cuáles existen.
--
-- LA REGLA DURA:
--
--   Ninguna habilidad de clase `spend` o `irreversible` se otorga
--   automáticamente. Exige acción explícita de un operador y un sobre propio.
--
-- Y lo que distingue a este CRM de los otros no es el pipeline: es que cada
-- toque sabe **quién** lo hizo —agente o humano—, qué decisión lo originó y
-- cuánto costó.
--
-- Ver docs/adr/0022-habilidades-y-crm-con-actor.md
--     docs/wiki/20-integraciones-crm-y-habilidades.md
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · EL REGISTRO DE HABILIDADES ═══════════════

create table if not exists holaamigo.skills (
  id text primary key,                      -- 'linkedin.search_people'
  provider text not null check (provider in ('mcp','rest','internal')),
  provider_config jsonb not null default '{}',
  display_name text not null,
  description text not null,
  -- Qué le decimos al cliente cuando pregunte por qué su agente puede esto.
  client_explanation text not null,
  input_schema jsonb not null default '{}',
  output_schema jsonb not null default '{}',
  risk_class text not null
    check (risk_class in ('read','write','external_comms','spend','irreversible')),
  -- El nivel de capacidad que hay que tener para poder usarla. Es el puente
  -- entre P2 y P6: no basta con que la habilidad esté habilitada, el agente
  -- tiene que tener permiso para acciones de ese riesgo.
  min_grant_level int not null check (min_grant_level between 0 and 5),
  min_plan text not null default 'starter',
  cost_model jsonb not null default '{}',   -- {unit:'call'|'credit', price_usd, credits}
  status text not null default 'available' check (status in ('available','beta','deprecated'))
);

comment on table holaamigo.skills is
  'Catálogo de herramientas. Nuestro: se versiona en la migración, no se edita en una tabla.';

create table if not exists holaamigo.skill_grants (
  id uuid primary key default gen_random_uuid(),
  -- `null` = habilitada para ese rol en TODAS las organizaciones. Es como se
  -- enciende una habilidad nueva para todo el mundo sin escribir N filas.
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  agent_role text not null check (agent_role in ('president','cmo','sales','todos')),
  skill_id text not null references holaamigo.skills(id) on delete cascade,
  enabled boolean not null default true,
  envelope jsonb not null default '{}',
  granted_by text not null,
  granted_by_type text not null default 'operator'
    check (granted_by_type in ('operator','system')),
  created_at timestamptz not null default now(),

  -- Misma solución que `quiz_responses.answer_key` (ADR 0015): un índice único
  -- con `coalesce` adentro es un índice de EXPRESIÓN y no puede arbitrar un
  -- `on conflict`. La columna generada colapsa "esta organización" y "todas" en
  -- un valor real, y así hay UN índice plano y UN solo camino de upsert.
  --
  -- El UUID cero no puede ser el default de `organization_id` porque hay una
  -- clave foránea a `organizations`: la fila global tiene `null` de verdad.
  scope_key uuid generated always as (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored
);
create unique index if not exists skill_grants_key
  on holaamigo.skill_grants (scope_key, agent_role, skill_id);

-- La regla dura, hecha cumplir.
--
-- Una habilidad que gasta plata o hace algo irreversible no se enciende sola ni
-- por un job ni por un default: la enciende una persona. El sobre propio es
-- obligatorio porque "puede gastar" sin tope no es un permiso, es una firma en
-- blanco.
create or replace function holaamigo.proteger_habilidad_riesgosa()
returns trigger language plpgsql as $$
declare v_clase text;
begin
  select risk_class into v_clase from holaamigo.skills where id = new.skill_id;

  if v_clase in ('spend','irreversible') and new.enabled then
    if new.granted_by_type <> 'operator' then
      raise exception
        'la habilidad % es de clase %: solo la enciende un operador, nunca el sistema',
        new.skill_id, v_clase;
    end if;
    if new.envelope = '{}'::jsonb then
      raise exception
        'la habilidad % es de clase % y exige un sobre con límites: sin tope no es un permiso, es una firma en blanco',
        new.skill_id, v_clase;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists skill_grants_riesgo on holaamigo.skill_grants;
create trigger skill_grants_riesgo
  before insert or update on holaamigo.skill_grants
  for each row execute function holaamigo.proteger_habilidad_riesgosa();

-- El "intraer": el agente pide lo que le falta.
create table if not exists holaamigo.skill_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  agent_role text,
  skill_id text,                            -- puede no existir todavía en el catálogo
  requested_capability text,                -- lo que pidió, en sus palabras
  justification text not null,              -- "necesito X para lograr Y"
  blocked_decision_id uuid references holaamigo.decisions(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','granted','rejected','duplicate')),
  resolved_by text,
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists skill_requests_pendientes_idx
  on holaamigo.skill_requests (status, created_at desc);
-- Un pedido vivo por habilidad y organización: si el agente choca contra el
-- mismo muro cada corrida, no queremos cien tarjetas idénticas.
create unique index if not exists skill_requests_viva_key
  on holaamigo.skill_requests (organization_id, agent_role, coalesce(skill_id, requested_capability))
  where status = 'pending';

-- ═══════════════ 2 · EL TOOL LIST EN RUNTIME ═══════════════
--
-- La intersección de cuatro conjuntos, tal cual el plan:
--
--   habilidades = otorgadas_al_rol
--               ∩ habilitadas_para_esta_org
--               ∩ permitidas_por_el_plan
--               ∩ alcanzables_con_el_nivel_de_capacidad_actual
--
-- El cuarto conjunto es el que une P2 con P6, y es el que hace que esto no sea
-- una lista de herramientas más: de nada sirve tener LinkedIn habilitado si el
-- agente no tiene permiso para acciones de esa clase de riesgo. El nivel
-- disponible se calcula con las MISMAS funciones del motor de permisos.

create or replace function holaamigo.habilidades_activas(
  p_org uuid,
  p_role text
)
returns table (
  skill_id text,
  display_name text,
  provider text,
  risk_class text,
  min_grant_level int,
  nivel_disponible int,
  envelope jsonb,
  cost_model jsonb
)
language sql
stable
as $$
  with plan as (
    select coalesce(plan, 'diagnostico') as tier from holaamigo.organizations where id = p_org
  ),
  autonomia as (
    select coalesce(autonomy, 'propose') as valor
    from holaamigo.agents where organization_id = p_org and role = p_role
    limit 1
  ),
  -- El techo real que este rol alcanza HOY para cada clase de riesgo: el mayor
  -- nivel efectivo entre sus capacidades de esa clase.
  techo_por_clase as (
    select
      c.risk_class,
      max(least(
        c.platform_ceiling,
        least(
          coalesce(g.granted_level, c.default_level),
          holaamigo.techo_de_autonomia((select valor from autonomia), c.risk_class)
        ),
        case
          when holaamigo.rango_de_plan((select tier from plan))
             < holaamigo.rango_de_plan(c.min_plan) then 0
          else holaamigo.techo_de_plan((select tier from plan))
        end
      )) as nivel
    from holaamigo.capabilities c
    left join holaamigo.capability_grants g
      on g.capability_id = c.id and g.organization_id = p_org
    where c.agent_role in (p_role, 'todos')
      and c.status = 'active'
    group by c.risk_class
  ),
  otorgadas as (
    select distinct on (sg.skill_id)
      sg.skill_id, sg.envelope, sg.enabled
    from holaamigo.skill_grants sg
    where sg.agent_role in (p_role, 'todos')
      and (sg.organization_id = p_org or sg.organization_id is null)
    -- La fila específica de la organización gana sobre la global: así se puede
    -- apagar para un cliente una habilidad encendida para todos.
    order by sg.skill_id, (sg.organization_id is not null) desc
  )
  select
    s.id,
    s.display_name,
    s.provider,
    s.risk_class,
    s.min_grant_level,
    coalesce(t.nivel, 0) as nivel_disponible,
    o.envelope,
    s.cost_model
  from otorgadas o
  join holaamigo.skills s on s.id = o.skill_id
  left join techo_por_clase t on t.risk_class = s.risk_class
  where o.enabled
    and s.status in ('available','beta')
    and holaamigo.rango_de_plan((select tier from plan)) >= holaamigo.rango_de_plan(s.min_plan)
    and coalesce(t.nivel, 0) >= s.min_grant_level
$$;

-- ═══════════════ 3 · INTEGRACIONES Y STAGING ═══════════════
--
-- `integrations` YA EXISTE desde 0003 (SendGrid, Instantly, WhatsApp). Se
-- extiende, no se recrea: un `create table if not exists` sobre una tabla con
-- otra forma no falla, simplemente no hace nada — y el error aparece después,
-- en la primera escritura, con un mensaje que no dice por qué.
--
-- La diferencia que se agrega: `credentials_ref` en vez de `credentials`. La
-- columna vieja guarda el secreto en la tabla, que es lo que había; la nueva
-- guarda el NOMBRE de dónde está (variable de entorno o secreto externo). Una
-- tabla con tokens de HubSpot en texto plano es una fuga esperando a que
-- alguien haga un `select *` durante un soporte. Los proveedores viejos se
-- migran cuando se toquen; los nuevos ya nacen bien.

alter table holaamigo.integrations
  add column if not exists credentials_ref text,
  add column if not exists config jsonb not null default '{}',
  add column if not exists cursor text,
  add column if not exists connected_by text;

alter table holaamigo.integrations drop constraint if exists integrations_provider_check;
alter table holaamigo.integrations add constraint integrations_provider_check
  check (provider in ('sendgrid','instantly','whatsapp','payments',
                      'hubspot','stripe','wompi','apollo','calcom','otro'));

alter table holaamigo.integrations drop constraint if exists integrations_status_check;
alter table holaamigo.integrations add constraint integrations_status_check
  check (status in ('pending','connected','syncing','failed','error','revoked'));

-- Los contactos que llegan de afuera aterrizan acá y **no entran a operación**
-- hasta que se corra un lote de análisis. Es deliberado: obliga a pasar por el
-- paso que paga, y además evita que 8.000 contactos crudos y sin segmentar
-- aparezcan como si fueran leads trabajables.
create table if not exists holaamigo.staging_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  integration_id uuid references holaamigo.integrations(id) on delete set null,
  external_id text,
  raw jsonb not null default '{}',
  mapped jsonb not null default '{}',       -- {full_name, email, phone, company, title, last_interaction_at}
  status text not null default 'staged'
    check (status in ('staged','analyzed','promoted','rejected','duplicate')),
  batch_id uuid,
  lead_id uuid references holaamigo.leads(id) on delete set null,
  analysis jsonb not null default '{}',     -- {temperatura, segmento, motivo, plan}
  created_at timestamptz not null default now()
);
create index if not exists staging_contacts_org_idx
  on holaamigo.staging_contacts (organization_id, status);
-- Reimportar no duplica: la clave es el id externo del proveedor.
create unique index if not exists staging_contacts_externo_key
  on holaamigo.staging_contacts (organization_id, integration_id, external_id)
  where external_id is not null;

-- ═══════════════ 4 · LOTES DE ANÁLISIS Y REACTIVACIÓN ═══════════════
--
-- **El sistema propone el tamaño del lote, no el cliente.** El President mira
-- volumen, ticket y presupuesto y recomienda por dónde empezar. Un cliente al
-- que se le pide "elegí cuántos contactos analizar" elige mal en las dos
-- direcciones: o mil para probar sin señal, o los ocho mil de una.
--
-- Cotización primero, aprobación, después se cobra. En ese orden.

create table if not exists holaamigo.analysis_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  integration_id uuid references holaamigo.integrations(id) on delete set null,
  source text not null default 'hubspot'
    check (source in ('hubspot','upload','apollo','instantly','manual')),
  contact_count int not null,
  depth text not null default 'segment'
    check (depth in ('segment','enrich','reactivate')),
  credits_quoted int not null,
  credits_charged int,
  status text not null default 'quoted'
    check (status in ('quoted','approved','running','done','failed','cancelled')),
  quote_reason text,                        -- por qué ESTE tamaño y no otro
  results jsonb not null default '{}',      -- {by_temperature, by_segment, top_opportunities, projected_value}
  reactivation_plan jsonb not null default '{}',
  approval_id uuid references holaamigo.approvals(id) on delete set null,
  decision_id uuid references holaamigo.decisions(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,

  constraint analysis_batches_cobro_exige_aprobacion check (
    credits_charged is null or status in ('running','done','failed')
  )
);
create index if not exists analysis_batches_org_idx
  on holaamigo.analysis_batches (organization_id, status, created_at desc);

-- Tarifa de referencia (plan §6C): 1 crédito por contacto analizado y
-- segmentado, 3 por enriquecido, 5 por contacto con plan de reactivación.
create or replace function holaamigo.tarifa_de_lote(p_depth text)
returns int language sql immutable as $$
  select case p_depth
    when 'segment'    then 1
    when 'enrich'     then 3
    when 'reactivate' then 5
    else 1
  end
$$;

/*
 * Cobra el lote contra el saldo, en una sola transacción.
 *
 * Va en SQL y no en la aplicación por una razón: entre leer el saldo y escribir
 * el débito, dos aprobaciones simultáneas del mismo lote dejarían el saldo en
 * negativo. Acá el saldo se lee y se escribe en la misma sentencia, y el estado
 * del lote es el candado — un lote que ya no está en `approved` no se cobra dos
 * veces.
 */
create or replace function holaamigo.cobrar_lote(p_batch uuid, p_por text)
returns jsonb
language plpgsql
as $$
declare
  b holaamigo.analysis_batches%rowtype;
  v_saldo int;
begin
  select * into b from holaamigo.analysis_batches where id = p_batch for update;
  if not found then
    raise exception 'el lote % no existe', p_batch;
  end if;

  if b.status <> 'approved' then
    return jsonb_build_object('ok', false, 'motivo', format('el lote está en %s, no en approved', b.status));
  end if;

  select holaamigo.credit_balance(b.organization_id) into v_saldo;

  if v_saldo < b.credits_quoted then
    return jsonb_build_object(
      'ok', false,
      'motivo', format('hacen falta %s créditos y hay %s', b.credits_quoted, v_saldo),
      'faltan', b.credits_quoted - v_saldo
    );
  end if;

  insert into holaamigo.credit_ledger
    (organization_id, delta, kind, reference_table, reference_id, note, created_by)
  values (b.organization_id, -b.credits_quoted, 'analysis_batch', 'analysis_batches', p_batch,
          format('%s contactos, profundidad %s', b.contact_count, b.depth), p_por);

  update holaamigo.analysis_batches
     set status = 'running', credits_charged = b.credits_quoted, started_at = now()
   where id = p_batch;

  return jsonb_build_object('ok', true, 'cobrado', b.credits_quoted, 'saldo_despues', v_saldo - b.credits_quoted);
end $$;

-- ═══════════════ 5 · EL CRM PROPIO ═══════════════
--
-- Lo que lo hace distinto no es el pipeline: es la **trazabilidad de actor**.
-- Cada toque sabe quién lo hizo —agente o humano—, qué decisión lo originó y
-- cuánto costó. La vista de un lead es una línea de tiempo intercalada:
--
--   la CMO propuso el ángulo → SALES envió → el lead respondió →
--   el agente calificó → EL HUMANO ENTRÓ ACÁ → se agendó → se cerró
--
-- Ningún CRM del mercado puede pintar esa línea, porque ninguno tiene el
-- concepto de "esta acción la tomó un agente por esta decisión".

create table if not exists holaamigo.opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  lead_id uuid references holaamigo.leads(id) on delete set null,
  name text not null,
  value_usd numeric(14,2),
  currency text not null default 'USD',
  stage text not null default 'nuevo'
    check (stage in ('nuevo','contactado','interesado','reunion','propuesta','ganada','perdida')),
  probability numeric check (probability between 0 and 1),
  channel_id uuid references holaamigo.channels(id) on delete set null,
  -- Qué decisión de agente originó esta oportunidad. Es la columna que conecta
  -- el CRM con el P&G y con el aprendizaje: "¿qué decisión de hace 60 días
  -- funcionó?" se contesta siguiendo esto.
  origin_decision_id uuid references holaamigo.decisions(id) on delete set null,
  owner_type text not null default 'agent' check (owner_type in ('agent','human')),
  owner_ref text,
  expected_close date,
  outcome text check (outcome in ('won','lost')),
  lost_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,

  constraint opportunities_cierre_coherente check (
    (outcome is null and closed_at is null)
    or (outcome is not null and closed_at is not null)
  )
);
create index if not exists opportunities_org_idx
  on holaamigo.opportunities (organization_id, stage, updated_at desc);
create index if not exists opportunities_lead_idx on holaamigo.opportunities (lead_id);

create table if not exists holaamigo.touchpoints (
  id bigserial primary key,
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  lead_id uuid references holaamigo.leads(id) on delete cascade,
  opportunity_id uuid references holaamigo.opportunities(id) on delete cascade,
  actor_type text not null check (actor_type in ('agent','human','system')),
  actor_ref text not null,                  -- 'cmo' | 'sales' | 'camilo@…' | 'cron'
  action text not null,                     -- angle_proposed | email_sent | replied | qualified | booked | note | stage_change
  channel text,
  decision_id uuid references holaamigo.decisions(id) on delete set null,
  cost_usd numeric(12,6),
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index if not exists touchpoints_lead_idx on holaamigo.touchpoints (lead_id, occurred_at);
create index if not exists touchpoints_opp_idx on holaamigo.touchpoints (opportunity_id, occurred_at);

-- La línea de tiempo de un lead, con el costo de cada paso ya resuelto.
--
-- El costo sale de la decisión que originó el toque (P1 lo imputó ahí). Se
-- resuelve en la vista y no en el llamador porque es la pregunta que se hace
-- SIEMPRE al mirar un lead: "¿cuánto nos costó perseguir a este?".
create or replace view holaamigo.lead_timeline as
select
  t.id,
  t.organization_id,
  t.lead_id,
  t.opportunity_id,
  t.actor_type,
  t.actor_ref,
  t.action,
  t.channel,
  t.occurred_at,
  t.payload,
  t.decision_id,
  coalesce(t.cost_usd, d.cost_usd) as costo_usd,
  d.question as decision_question,
  d.kind as decision_kind
from holaamigo.touchpoints t
left join holaamigo.decisions d on d.id = t.decision_id;

-- ═══════════════ 6 · EL CATÁLOGO SEMBRADO ═══════════════
--
-- Nuestro, versionado acá. `min_grant_level` es el puente con P2: la habilidad
-- solo aparece si el agente además tiene permiso para acciones de esa clase.

insert into holaamigo.skills
  (id, provider, provider_config, display_name, description, client_explanation,
   risk_class, min_grant_level, min_plan, cost_model, status)
values
  ('linkedin.search_people', 'mcp', '{"server":"linkedin","tool":"search_people"}',
   'LinkedIn · buscar personas',
   'Buscar y perfilar personas por cargo, empresa y sector.',
   'Tu agente puede buscar en LinkedIn a quién le conviene escribirle. Solo mira perfiles públicos.',
   'read', 3, 'starter', '{"unit":"call","credits":1}', 'beta'),

  ('apollo.build_list', 'rest', '{"base":"https://api.apollo.io"}',
   'Apollo · construir listas',
   'Armar listas de contactos con filtros de ICP.',
   'Construye listas nuevas de gente que se parece a tus mejores clientes.',
   'read', 4, 'growth', '{"unit":"credit","credits":2}', 'available'),

  ('elevenlabs.voice', 'rest', '{"base":"https://api.elevenlabs.io"}',
   'ElevenLabs · voz',
   'Generar audio para contenido y seguimientos.',
   'Convierte un guion en un audio con voz natural, para notas de voz y contenido.',
   'external_comms', 3, 'growth', '{"unit":"call","credits":4}', 'available'),

  ('hubspot.read_contacts', 'rest', '{"base":"https://api.hubapi.com"}',
   'HubSpot · leer',
   'Leer contactos, empresas y negocios.',
   'Trae tus contactos de HubSpot para que el agente sepa con quién ya hablaste.',
   'read', 4, 'starter', '{"unit":"call","credits":0}', 'available'),

  ('hubspot.write_contacts', 'rest', '{"base":"https://api.hubapi.com"}',
   'HubSpot · escribir',
   'Actualizar propiedades y etapas en HubSpot.',
   'Deja que el agente mantenga tu HubSpot al día. Todo lo que escriba queda con su rastro.',
   'write', 3, 'growth', '{"unit":"call","credits":0}', 'available'),

  ('stripe.read_revenue', 'rest', '{"base":"https://api.stripe.com"}',
   'Stripe · leer ingresos',
   'Leer cobros y suscripciones para el P&G.',
   'El President lee tus ingresos para poder decirte cuánto cuesta traer un cliente por canal.',
   'read', 5, 'starter', '{"unit":"call","credits":0}', 'available'),

  ('stripe.charge', 'rest', '{"base":"https://api.stripe.com"}',
   'Stripe · cobrar',
   'Ejecutar un cobro.',
   'Ningún agente nuestro cobra a tus clientes. Este control existe para que veas que está apagado.',
   'spend', 5, 'enterprise', '{"unit":"call","credits":0}', 'deprecated'),

  ('n8n.trigger', 'rest', '{"base":"https://n8n.example"}',
   'n8n · disparar automatización',
   'Ejecutar un flujo de automatización externo.',
   'Dispara automatizaciones que ya tengas armadas. Como no sabemos qué hacen, el agente solo puede dejarlas preparadas.',
   'irreversible', 2, 'growth', '{"unit":"call","credits":1}', 'available'),

  ('calcom.book', 'rest', '{"base":"https://api.cal.com"}',
   'Cal.com · agendar',
   'Poner una reunión en la agenda.',
   'El agente agenda directo en tu calendario. Se puede cancelar, así que el riesgo es bajo.',
   'write', 4, 'starter', '{"unit":"call","credits":0}', 'available')

on conflict (id) do update set
  provider = excluded.provider,
  provider_config = excluded.provider_config,
  display_name = excluded.display_name,
  description = excluded.description,
  client_explanation = excluded.client_explanation,
  risk_class = excluded.risk_class,
  min_grant_level = excluded.min_grant_level,
  min_plan = excluded.min_plan,
  cost_model = excluded.cost_model,
  status = excluded.status;

-- Las de lectura arrancan encendidas para todos los roles que las necesitan.
-- Las de escritura, comunicación, gasto o irreversibles NO: esas las enciende
-- un operador, cliente por cliente, con su sobre.
insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, enabled, granted_by, granted_by_type)
values
  (null, 'sales',     'linkedin.search_people', true, 'catalogo', 'system'),
  (null, 'cmo',       'linkedin.search_people', true, 'catalogo', 'system'),
  (null, 'todos',     'hubspot.read_contacts',  true, 'catalogo', 'system'),
  (null, 'president', 'stripe.read_revenue',    true, 'catalogo', 'system')
on conflict (scope_key, agent_role, skill_id) do nothing;

-- ═══════════════ 7 · RLS Y GRANTS ═══════════════

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'holaamigo'
      and tablename in ('skills','skill_grants','skill_requests','integrations',
                        'staging_contacts','analysis_batches','opportunities','touchpoints')
  loop
    execute format('alter table holaamigo.%I enable row level security', t.tablename);
    execute format('alter table holaamigo.%I force row level security', t.tablename);
  end loop;
end $$;

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
grant execute on all functions in schema holaamigo to service_role;

revoke all on schema holaamigo from anon, authenticated;

drop trigger if exists opportunities_touch on holaamigo.opportunities;
create trigger opportunities_touch before update on holaamigo.opportunities
  for each row execute function holaamigo.touch_updated_at();

drop trigger if exists integrations_touch on holaamigo.integrations;
create trigger integrations_touch before update on holaamigo.integrations
  for each row execute function holaamigo.touch_updated_at();

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select * from holaamigo.habilidades_activas('<org>'::uuid, 'sales');
-- select holaamigo.cobrar_lote('<batch>'::uuid, 'camilo@rentmies.com');
-- select * from holaamigo.lead_timeline where lead_id = '<lead>' order by occurred_at;
