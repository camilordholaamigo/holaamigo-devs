-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · P4 — El President como CRO: P&G, experimentos y pronóstico
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- El President sabe proponer y sabe decidir, pero no sabe cuánto entró, cuánto
-- salió y en qué se fue. Sin eso no puede contestar la única pregunta que un
-- dueño hace todas las semanas: **¿dónde está el próximo dólar mejor
-- invertido?**
--
-- Las cinco preguntas que esta migración hace contestables:
--   1. ¿Cuánto entró, cuánto salió y en qué se fue este mes?
--   2. ¿Cuánto cuesta un cliente por canal y en cuánto se paga solo?
--   3. ¿Dónde está el próximo dólar mejor invertido?
--   4. ¿Vamos a llegar a la meta del trimestre, y con qué probabilidad?
--   5. ¿Qué decisión de hace 60 días funcionó, y cómo lo sé?
--
-- La quinta es la que cierra el círculo de P1: el motor de experimentos escribe
-- el `outcome` de la decisión asociada, y de ahí sale la calibración que el
-- destilador convierte en lección.
--
-- LA REGLA DURA DE ESTE ARCHIVO — el pre-registro:
--
--   Ninguna acción consecuente se ejecuta sin declarar ANTES qué esperamos,
--   cómo lo mediremos y cuándo decidiremos.
--
-- Y no es una convención: un trigger impide cambiar la hipótesis, la métrica,
-- el efecto esperado o la regla de decisión una vez que el experimento arrancó.
-- Poder editarlas después es exactamente cómo un experimento se convierte en
-- una racionalización con formato de dato.
--
-- Ver docs/adr/0020-pre-registro-y-economia-por-canal.md
--     docs/wiki/18-el-president-como-cro.md
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · CANALES ═══════════════

create table if not exists holaamigo.channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  name text not null,
  kind text not null
    check (kind in ('outbound_email','whatsapp','ads','partnerships','content','referral','inbound','otro')),
  status text not null default 'active' check (status in ('active','paused','retired')),
  created_at timestamptz not null default now()
);
-- Clave plana para poder usarla de árbitro en upsert (ADR 0015).
create unique index if not exists channels_kind_key
  on holaamigo.channels (organization_id, kind);

-- ═══════════════ 2 · LO QUE ENTRA Y LO QUE SALE ═══════════════
--
-- Dos tablas de eventos y no una con signo: un ingreso y un gasto tienen
-- atributos distintos (uno tiene oportunidad y tipo de contrato, el otro tiene
-- categoría y proveedor), y meterlos juntos obliga a que la mitad de las
-- columnas estén siempre nulas.

create table if not exists holaamigo.revenue_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  opportunity_id uuid,
  channel_id uuid references holaamigo.channels(id) on delete set null,
  amount_usd numeric(14,2) not null,
  kind text not null check (kind in ('new','expansion','renewal','refund','churn')),
  occurred_at timestamptz not null,
  source text not null default 'manual'
    check (source in ('manual','hubspot','stripe','wompi','agent','import')),
  external_ref text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists revenue_events_org_idx
  on holaamigo.revenue_events (organization_id, occurred_at desc);
-- Sin esto, reimportar un mes de Stripe duplica la facturación entera.
create unique index if not exists revenue_events_externo_key
  on holaamigo.revenue_events (organization_id, source, external_ref)
  where external_ref is not null;

create table if not exists holaamigo.cost_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  channel_id uuid references holaamigo.channels(id) on delete set null,
  amount_usd numeric(14,2) not null,
  category text not null
    check (category in ('ads','tooling','data','agent_compute','human_ops','infra','credits','fee')),
  vendor text,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  occurred_at timestamptz not null,
  -- Qué decisión causó este gasto. Es lo que permite preguntar "¿cuánto nos
  -- costó aquella decisión de hace 60 días?" y tener una respuesta.
  decision_id uuid references holaamigo.decisions(id) on delete set null,
  source text not null default 'manual',
  external_ref text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists cost_events_org_idx
  on holaamigo.cost_events (organization_id, occurred_at desc);
create unique index if not exists cost_events_externo_key
  on holaamigo.cost_events (organization_id, source, external_ref)
  where external_ref is not null;

-- ═══════════════ 3 · ECONOMÍA POR CANAL ═══════════════
--
-- OJO CON EL JOIN. La versión ingenua —unir `revenue_events` con `cost_events`
-- por canal y agrupar— produce un producto cartesiano: cada ingreso se
-- multiplica por cada gasto del mismo canal y del mismo mes. Con 10 ingresos y
-- 8 gastos, la vista reporta 80 veces cada cifra y el CAC sale dividido por un
-- número inventado.
--
-- Por eso se agrega CADA lado por separado y después se unen los agregados.
-- Es la misma trampa que en `cost_rollup` (P1) y por eso el criterio de
-- aceptación es que la vista cuadre contra la suma cruda: no es una
-- formalidad, es la prueba de que este join está bien.

create or replace view holaamigo.channel_economics as
with ingresos as (
  select
    r.organization_id,
    r.channel_id,
    date_trunc('month', r.occurred_at)::date as mes,
    -- Los reembolsos y el churn restan. Meterlos como positivos hace que el
    -- mes en que se va un cliente se vea como el mejor mes del año.
    sum(case when r.kind in ('refund','churn') then -r.amount_usd else r.amount_usd end) as ingreso,
    count(distinct r.opportunity_id) filter (where r.kind = 'new') as clientes_nuevos
  from holaamigo.revenue_events r
  group by 1, 2, 3
),
gastos as (
  select
    k.organization_id,
    k.channel_id,
    date_trunc('month', k.occurred_at)::date as mes,
    sum(k.amount_usd) as costo
  from holaamigo.cost_events k
  group by 1, 2, 3
),
mezcla as (
  select organization_id, channel_id, mes from ingresos
  union
  select organization_id, channel_id, mes from gastos
)
select
  m.organization_id,
  m.channel_id,
  c.name as canal,
  c.kind as tipo,
  m.mes,
  coalesce(i.ingreso, 0)::numeric(14,2) as ingreso_usd,
  coalesce(g.costo, 0)::numeric(14,2) as costo_usd,
  (coalesce(i.ingreso, 0) - coalesce(g.costo, 0))::numeric(14,2) as margen_usd,
  coalesce(i.clientes_nuevos, 0)::int as clientes_nuevos,
  -- CAC: cuánto costó traer un cliente. `null` y no cero cuando no hubo
  -- clientes: un CAC de cero es una afirmación falsa y encima halagadora.
  round(coalesce(g.costo, 0) / nullif(i.clientes_nuevos, 0), 2) as cac_usd,
  round(coalesce(i.ingreso, 0) / nullif(g.costo, 0), 3) as roas
from mezcla m
left join ingresos i
  on i.organization_id = m.organization_id
 and i.channel_id is not distinct from m.channel_id
 and i.mes = m.mes
left join gastos g
  on g.organization_id = m.organization_id
 and g.channel_id is not distinct from m.channel_id
 and g.mes = m.mes
left join holaamigo.channels c on c.id = m.channel_id;

comment on view holaamigo.channel_economics is
  'Ingreso, costo, margen, CAC y ROAS por canal y mes. Cuadra exacto contra la suma cruda de eventos.';

-- ═══════════════ 4 · EL COSTO DE LOS AGENTES ENTRA AL P&G ═══════════════
--
-- Sin esto, el P&G miente por omisión: muestra lo que se gastó en anuncios y
-- herramientas, y no lo que costó pensar. Trae de `cost_rollup` (P1) el costo
-- de agente por día y lo deja como `cost_events` de categoría `agent_compute`.
--
-- Idempotente por el `external_ref` = 'agentes:AAAA-MM-DD': volver a correrlo
-- actualiza el monto del día en vez de sumarlo otra vez.

create or replace function holaamigo.importar_costos_de_agentes(
  p_org uuid,
  p_desde date default (current_date - 30)
)
returns int
language plpgsql
as $$
declare v_filas int;
begin
  insert into holaamigo.cost_events
    (organization_id, amount_usd, category, vendor, occurred_at, source, external_ref, note)
  select
    r.organization_id,
    round(sum(r.costo_usd), 2),
    'agent_compute',
    'openai',
    (r.dia + time '12:00')::timestamptz,
    'agent',
    'agentes:' || r.dia::text,
    format('%s pasos de agente', sum(r.pasos))
  from holaamigo.cost_rollup r
  where r.organization_id = p_org
    and r.dia >= p_desde
  group by r.organization_id, r.dia
  having sum(r.costo_usd) > 0
  on conflict (organization_id, source, external_ref)
    where external_ref is not null
  do update set amount_usd = excluded.amount_usd, note = excluded.note;

  get diagnostics v_filas = row_count;
  return v_filas;
end $$;

-- ═══════════════ 5 · EL MOTOR DE EXPERIMENTOS ═══════════════
--
-- `decision_rule` es un objeto, no una frase. Una regla en prosa —"si mejora
-- bastante, seguimos"— no se puede aplicar literalmente, y una regla que no se
-- aplica literalmente no es un pre-registro: es una intención.
--
--   {"comparador": ">=", "umbral": 0.06, "gana": "won", "pierde": "lost"}
--
-- El vocabulario es cerrado (>=, >, <=, <) a propósito. Un DSL más rico se
-- convierte en un intérprete, y un intérprete de reglas de decisión escrito en
-- una tarde es la peor pieza posible para tener en el camino del dinero.

create table if not exists holaamigo.experiments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  decision_id uuid references holaamigo.decisions(id) on delete set null,
  deliberation_id uuid references holaamigo.deliberations(id) on delete set null,
  channel_id uuid references holaamigo.channels(id) on delete set null,

  -- ── Pre-registro. Inmutable una vez que arranca. ──────────────────────
  hypothesis text not null,
  primary_metric text not null,
  expected_effect numeric not null,
  decision_rule jsonb not null,
  min_sample int not null check (min_sample > 0),
  -- Lo que NO puede empeorar aunque la métrica principal mejore. Sin esto, un
  -- experimento puede "ganar" subiendo la tasa de respuesta un 20% mientras
  -- triplica las quejas de spam.
  guardrail_metric text,
  guardrail_threshold numeric,

  -- ── Resultado ─────────────────────────────────────────────────────────
  status text not null default 'draft'
    check (status in ('draft','running','won','lost','inconclusive','aborted')),
  actual_effect numeric,
  actual_sample int,
  guardrail_actual numeric,
  readout_note text,
  cost_usd numeric(12,4),

  created_at timestamptz not null default now(),
  started_at timestamptz,
  readout_at timestamptz,

  constraint experiments_regla_valida check (
    decision_rule ? 'comparador' and decision_rule ? 'umbral'
  )
);
create index if not exists experiments_org_idx
  on holaamigo.experiments (organization_id, created_at desc);
create index if not exists experiments_corriendo_idx
  on holaamigo.experiments (organization_id, status) where status = 'running';

-- El pre-registro, hecho cumplir.
--
-- Es la pieza que hace que un experimento signifique algo. Un agente (o un
-- humano) que puede ajustar el efecto esperado después de ver el resultado
-- siempre acierta, y una racionalización con formato de dato es peor que no
-- tener dato: contamina el aprendizaje de P1 con calibraciones perfectas y
-- falsas.
create or replace function holaamigo.proteger_pre_registro()
returns trigger language plpgsql as $$
begin
  if old.status = 'draft' then
    return new;   -- todavía no arrancó: se puede corregir
  end if;

  if new.hypothesis is distinct from old.hypothesis
     or new.primary_metric is distinct from old.primary_metric
     or new.expected_effect is distinct from old.expected_effect
     or new.decision_rule is distinct from old.decision_rule
     or new.min_sample is distinct from old.min_sample
     or new.guardrail_metric is distinct from old.guardrail_metric
     or new.guardrail_threshold is distinct from old.guardrail_threshold then
    raise exception
      'el experimento % ya arrancó: la hipótesis, la métrica, el efecto esperado y la regla de decisión no se pueden cambiar. Abortalo y abrí uno nuevo.',
      old.id;
  end if;

  return new;
end $$;

drop trigger if exists experiments_pre_registro on holaamigo.experiments;
create trigger experiments_pre_registro
  before update on holaamigo.experiments
  for each row execute function holaamigo.proteger_pre_registro();

-- El readout: aplica la regla LITERALMENTE y cierra el ciclo de P1.
--
-- Devuelve el veredicto y, si el experimento tiene decisión asociada, escribe
-- su `outcome` con `cerrar_decision` — que es lo que calcula la calibración y
-- lo que alimenta al destilador. Ese encadenamiento es todo el sistema de
-- aprendizaje en una función.
create or replace function holaamigo.readout_experimento(
  p_id uuid,
  p_actual numeric,
  p_sample int,
  p_guardrail numeric default null
)
returns jsonb
language plpgsql
as $$
declare
  e holaamigo.experiments%rowtype;
  v_comparador text;
  v_umbral numeric;
  v_pasa boolean;
  v_guardrail_roto boolean := false;
  v_status text;
  v_nota text;
  v_calibracion numeric;
begin
  select * into e from holaamigo.experiments where id = p_id;
  if not found then
    raise exception 'el experimento % no existe', p_id;
  end if;

  if e.status not in ('running', 'draft') then
    return jsonb_build_object('status', e.status, 'nota', 'ya tenía readout');
  end if;

  v_comparador := e.decision_rule->>'comparador';
  v_umbral := (e.decision_rule->>'umbral')::numeric;

  v_pasa := case v_comparador
    when '>=' then p_actual >= v_umbral
    when '>'  then p_actual >  v_umbral
    when '<=' then p_actual <= v_umbral
    when '<'  then p_actual <  v_umbral
    else null
  end;

  if v_pasa is null then
    raise exception 'comparador desconocido en la regla de decisión: %', v_comparador;
  end if;

  -- El guardrail manda sobre el resultado principal. Un experimento que sube la
  -- métrica que mirábamos y rompe la que prometimos no cuidar no ganó.
  if e.guardrail_metric is not null and e.guardrail_threshold is not null
     and p_guardrail is not null and p_guardrail > e.guardrail_threshold then
    v_guardrail_roto := true;
  end if;

  if p_sample < e.min_sample then
    v_status := 'inconclusive';
    v_nota := format('%s de %s de muestra mínima: no alcanza para concluir', p_sample, e.min_sample);
  elsif v_guardrail_roto then
    v_status := 'lost';
    v_nota := format('la métrica principal pasó (%s %s %s) pero %s llegó a %s y el tope era %s',
                     p_actual, v_comparador, v_umbral, e.guardrail_metric, p_guardrail, e.guardrail_threshold);
  elsif v_pasa then
    v_status := 'won';
    v_nota := format('%s %s %s con n=%s', p_actual, v_comparador, v_umbral, p_sample);
  else
    v_status := 'lost';
    v_nota := format('%s no cumple %s %s con n=%s', p_actual, v_comparador, v_umbral, p_sample);
  end if;

  update holaamigo.experiments
     set status = v_status,
         actual_effect = p_actual,
         actual_sample = p_sample,
         guardrail_actual = p_guardrail,
         readout_note = v_nota,
         readout_at = now()
   where id = p_id;

  -- Cierra el ciclo de P1: el resultado del experimento ES el resultado de la
  -- decisión que lo originó, y de ahí sale la calibración.
  if e.decision_id is not null then
    begin
      v_calibracion := holaamigo.cerrar_decision(e.decision_id, p_actual);
    exception when others then
      -- Una decisión sin predicción medible (un `escalate`, por ejemplo) no
      -- puede cerrarse. No es un error del experimento y no lo tumba.
      v_calibracion := null;
    end;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'nota', v_nota,
    'calibracion', v_calibracion,
    'guardrail_roto', v_guardrail_roto
  );
end $$;

-- ═══════════════ 6 · REASIGNACIÓN Y PRONÓSTICO ═══════════════

create table if not exists holaamigo.allocation_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  period text not null,                  -- '2026-09'
  current_allocation jsonb not null,     -- {channel_id: usd}
  proposed_allocation jsonb not null,
  expected_delta jsonb not null,         -- {revenue, cac, payback_days}
  confidence numeric check (confidence between 0 and 1),
  reasoning text not null,
  supporting_experiments uuid[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','superseded')),
  deliberation_id uuid references holaamigo.deliberations(id) on delete set null,
  decision_id uuid references holaamigo.decisions(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists allocation_proposals_periodo_key
  on holaamigo.allocation_proposals (organization_id, period)
  where status = 'pending';

create table if not exists holaamigo.forecasts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  horizon_end date not null,
  scenario text not null check (scenario in ('conservative','base','aggressive')),
  metric text not null,
  value numeric not null,
  probability numeric check (probability between 0 and 1),
  -- Los supuestos van con el pronóstico, no aparte: un número proyectado sin
  -- sus supuestos es una adivinanza con autoridad.
  assumptions jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists forecasts_org_idx
  on holaamigo.forecasts (organization_id, created_at desc);

-- ═══════════════ 7 · RLS Y GRANTS ═══════════════

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'holaamigo'
      and tablename in ('channels','revenue_events','cost_events','experiments',
                        'allocation_proposals','forecasts')
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

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select * from holaamigo.channel_economics where organization_id = '<org>';
-- select holaamigo.importar_costos_de_agentes('<org>'::uuid);
-- update holaamigo.experiments set expected_effect = 999 where status = 'running';
--   → error: el experimento ya arrancó
