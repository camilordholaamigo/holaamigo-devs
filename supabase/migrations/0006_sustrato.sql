-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · P1 — El Sustrato: trazas, decisiones, lecciones y costos
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- Hasta hoy, lo que hacía un agente quedaba en `agent_runs`: un log. Un log
-- responde "¿qué pasó?" pero no responde ninguna de las preguntas que hacen
-- que esto sea una organización y no un chatbot:
--
--   · ¿Qué alternativas se consideraron y por qué se descartaron?
--   · ¿Qué esperaba el agente que pasara?  ← y esto es lo que no se puede
--   · ¿Pasó?                                  reconstruir después
--   · ¿Cuánto costó esa decisión en particular?
--
-- El par `prediction` / `outcome` es la razón de ser de esta migración. Sin
-- una predicción registrada ANTES del hecho no hay forma de distinguir un
-- agente que acierta de uno que racionaliza el resultado a posteriori. Y sin
-- esa distinción no hay aprendizaje: hay sesgo confirmado a escala.
--
-- Tres capas, tres vidas distintas:
--
--   traces      cada paso de ejecución    · enorme · 90 días
--   decisions   qué se decidió y por qué  · media  · permanente
--   lessons     regla destilada de N      · chica  · permanente, versionada
--
-- Ver docs/adr/0016-la-microdecision-como-unidad.md
--     docs/adr/0017-lecciones-sin-pgvector.md
--     docs/wiki/15-sustrato-decisiones-y-aprendizaje.md
--
-- Idempotente: se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · TRAZAS ═══════════════
--
-- El grano más fino: un paso de ejecución. Se escribe con `tryWrite` (perder
-- una traza es un dato menos; tumbar la corrida por no poder escribirla es una
-- venta menos). Es la única tabla del sustrato que se purga.

create table if not exists holaamigo.traces (
  id bigserial primary key,
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  role text check (role in ('president','cmo','sales')),
  -- Agrupa todos los pasos de una misma corrida. Es la clave con la que se le
  -- imputa costo a una decisión: no hay costo por paso que valga la pena
  -- perseguir, hay costo por corrida repartido entre lo que la corrida decidió.
  run_id uuid,
  parent_trace_id bigint references holaamigo.traces(id) on delete cascade,
  step_type text not null
    check (step_type in ('think','tool_call','tool_result','output','error')),
  name text,
  input jsonb,
  output jsonb,
  model text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(12,6) not null default 0,
  duration_ms int,
  created_at timestamptz not null default now()
);
create index if not exists traces_org_idx on holaamigo.traces (organization_id, created_at desc);
create index if not exists traces_run_idx on holaamigo.traces (run_id);
create index if not exists traces_purga_idx on holaamigo.traces (created_at);

comment on table holaamigo.traces is
  'Pasos de ejecución. 90 días calientes; holaamigo.purgar_trazas() los borra.';

-- ═══════════════ 2 · DECISIONES ═══════════════
--
-- La unidad atómica del sistema. Tres invariantes viven acá y no en el código
-- de aplicación, a propósito: el código se puede saltar, la tabla no.
--
--   1. Toda decisión enumera AL MENOS DOS opciones. "Hacerlo o no hacerlo" no
--      son dos alternativas (docs/PROCESO.md §1). Una decisión con una sola
--      opción no es una decisión, es una justificación.
--   2. Toda decisión predice algo. Las dos excepciones (`escalate`, `handoff`)
--      no predicen un resultado: transfieren el control a un humano. Cualquier
--      otra sin predicción se rechaza en la base.
--   3. La predicción tiene forma: métrica, valor esperado y horizonte. Sin los
--      tres no se puede medir después, y una predicción que no se puede medir
--      es una opinión con formato de dato.

create table if not exists holaamigo.decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  -- Nullable con `on delete set null` aunque el agente sea obligatorio en la
  -- práctica: una decisión sobrevive al agente que la tomó. Borrar un agente no
  -- puede borrar el historial que explica por qué la empresa está donde está.
  agent_id uuid references holaamigo.agents(id) on delete set null,
  role text check (role in ('president','cmo','sales')),
  run_id uuid,
  created_at timestamptz not null default now(),

  -- angle_select | budget_shift | segment_pick | outreach_send | pause |
  -- escalate | handoff | allocation | partnership_outreach | ...
  -- Sin `check`: la lista crece con cada parte del plan y una migración por
  -- cada tipo nuevo de decisión sería una fricción sin beneficio.
  kind text not null,
  question text not null,              -- en lenguaje natural, legible por el cliente
  context jsonb not null default '{}', -- {segment, channel, industry, ...} → clave de agrupación del destilador
  options_considered jsonb not null,   -- [{label, pros, cons, est_cost, est_impact}]
  chosen jsonb not null,               -- {label, payload}
  rationale text not null,

  evidence jsonb not null default '[]', -- [{type:'metric'|'lesson'|'human'|'source', ref, weight}]
  lesson_ids uuid[] not null default '{}',
  human_input_ids uuid[] not null default '{}',

  prediction jsonb,                    -- {metric, expected_value, horizon_days, confidence, direction}
  outcome jsonb,                       -- {metric, actual_value, measured_at}
  calibration numeric,                 -- 1 = clavado, 0 = errado. null hasta medir.

  reversible boolean not null default true,
  cost_usd numeric(12,6),              -- imputado desde traces por holaamigo.imputar_costos()
  experiment_id uuid,                  -- P4
  approval_id uuid references holaamigo.approvals(id) on delete set null,

  constraint decisions_dos_opciones check (
    jsonb_typeof(options_considered) = 'array'
    and jsonb_array_length(options_considered) >= 2
  ),
  constraint decisions_prediccion check (
    prediction is not null or kind in ('escalate', 'handoff')
  ),
  constraint decisions_prediccion_forma check (
    prediction is null or (
      prediction ? 'metric'
      and prediction ? 'expected_value'
      and prediction ? 'horizon_days'
    )
  )
);
create index if not exists decisions_org_idx on holaamigo.decisions (organization_id, created_at desc);
create index if not exists decisions_run_idx on holaamigo.decisions (run_id);
create index if not exists decisions_medidas_idx
  on holaamigo.decisions (organization_id, kind) where outcome is not null;
create index if not exists decisions_pendientes_idx
  on holaamigo.decisions (organization_id, created_at) where outcome is null;

comment on table holaamigo.decisions is
  'La unidad atómica: qué se decidió, por qué, qué se predijo y qué pasó.';

-- ═══════════════ 3 · LECCIONES ═══════════════
--
-- Regla destilada de N decisiones medidas. Cuatro alcances, en escalera:
--
--   agent         scope_ref = '<org_id>:<role>'   lo que aprendió ese agente
--   organization  scope_ref = '<org_id>'          lo que aprendió esa empresa
--   industry      scope_ref = '<slug>'            lo que aprendimos del sector
--   global        scope_ref = null                lo que aprendimos del producto
--
-- `lessons_alcance_amplio_requiere_humano` es la salvaguarda que impide que un
-- cliente raro envenene a los demás: una lección de alcance `industry` o
-- `global` no puede quedar activa sin que un humano nuestro firme. La regla
-- vive en la base porque un job mal escrito sí se puede equivocar.
--
-- `fingerprint` es un índice único PLANO sobre una columna real, para poder
-- usarlo como árbitro de `on conflict`. Ver ADR 0015 — el bug que dejó el quiz
-- muerto una semana fue exactamente esto.

create table if not exists holaamigo.lessons (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('agent','organization','industry','global')),
  scope_ref text,
  statement text not null,
  applies_to jsonb not null default '{}',  -- {kinds:[], channels:[], segments:[], metric}
  supporting_decisions uuid[] not null default '{}',
  n_support int not null default 0,
  confidence numeric not null default 0 check (confidence between 0 and 1),
  -- La opción ganadora del grupo. Se guarda para detectar la inversión: si
  -- cambia, la lección vuelve a `candidate` y sube de versión en vez de
  -- reescribirse en silencio bajo el mismo id.
  best_option text,
  lift numeric,
  -- Cuándo se dio vuelta la evidencia. Una lección contradicha deja de ser ley
  -- en el acto y necesita una noche más de evidencia sostenida para volver a
  -- serlo: si no, el mismo job que detecta la contradicción reactiva la regla
  -- contraria en la misma pasada, y el cliente vería su organización cambiando
  -- de ley sin que nadie mirara.
  contradicted_at timestamptz,
  status text not null default 'candidate'
    check (status in ('candidate','active','retired','rejected')),
  promoted_by text,
  promoted_at timestamptz,
  retired_reason text,
  version int not null default 1,
  -- Vector del enunciado como arreglo JSON. No es pgvector a propósito:
  -- ver docs/adr/0017-lecciones-sin-pgvector.md
  embedding jsonb,
  embedding_model text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lessons_alcance_amplio_requiere_humano check (
    status <> 'active'
    or scope in ('agent','organization')
    or promoted_by is not null
  )
);
create unique index if not exists lessons_fingerprint_key on holaamigo.lessons (fingerprint);
create index if not exists lessons_scope_idx on holaamigo.lessons (scope, scope_ref, status);

comment on table holaamigo.lessons is
  'Reglas destiladas de decisiones medidas. Se inyectan en runtime, no se hornean en el prompt.';

-- ═══════════════ 4 · LO QUE DICE EL HUMANO ═══════════════
--
-- El cliente (o nosotros) mete contexto que el sistema no puede observar:
-- "el competidor X quebró", "no quiero que nos vean como los baratos".
-- `weight > 1` significa que pesa MÁS que la evidencia del sistema. Es la
-- palanca del titiritero, y es deliberada: el humano puede contradecir a los
-- datos y el sistema tiene que obedecer y dejar registro de que obedeció.

create table if not exists holaamigo.human_inputs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  author text not null,
  author_type text not null check (author_type in ('client','operator')),
  body text not null,
  attachments jsonb not null default '[]',
  scope jsonb not null default '{}',   -- {agents:[], kinds:[], until:'2026-12-31'}
  weight numeric not null default 1.0 check (weight >= 0),
  status text not null default 'active' check (status in ('active','expired','revoked')),
  created_at timestamptz not null default now()
);
create index if not exists human_inputs_org_idx
  on holaamigo.human_inputs (organization_id, status, created_at desc);

-- ═══════════════ 5 · CALIBRACIÓN ═══════════════
--
-- Una sola definición, en SQL, porque tenerla también en TypeScript garantiza
-- que en seis meses las dos digan cosas distintas y nadie sepa cuál manda.
--
-- Normalizada y simétrica: el denominador es el mayor de los dos valores, así
-- que quedarse corto y pasarse se castigan igual. Sin eso, predecir siempre
-- cero daría una calibración excelente.
--
--   esperado 100, real 100  → 1.0     clavado
--   esperado 100, real  80  → 0.8
--   esperado 100, real 200  → 0.5     pasarse al doble ≠ gratis
--   esperado 100, real   0  → 0.0
--   esperado   0, real   0  → 1.0     predecir "nada" y que no pase nada acierta

create or replace function holaamigo.calibracion(p_esperado numeric, p_real numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_esperado is null or p_real is null then null
    when p_esperado = 0 and p_real = 0 then 1
    else round(
      greatest(
        0,
        1 - abs(p_real - p_esperado) / greatest(abs(p_esperado), abs(p_real))
      ),
      4)
  end
$$;

-- Cierra el ciclo: escribe el resultado medido y calcula la calibración en la
-- misma sentencia. Es una función y no un `update` desde la aplicación para que
-- sea imposible escribir un `outcome` sin su calibración — un outcome sin
-- calibración no alimenta al destilador y desaparece del aprendizaje sin ruido.
create or replace function holaamigo.cerrar_decision(
  p_decision_id uuid,
  p_real numeric,
  p_medido_en timestamptz default now()
)
returns numeric
language plpgsql
as $$
declare
  v_esperado numeric;
  v_metric text;
  v_cal numeric;
begin
  select (prediction->>'expected_value')::numeric, coalesce(prediction->>'metric', '—')
    into v_esperado, v_metric
  from holaamigo.decisions
  where id = p_decision_id;

  if not found then
    raise exception 'decisión % no existe', p_decision_id;
  end if;

  if v_esperado is null then
    raise exception 'la decisión % no tiene predicción medible', p_decision_id;
  end if;

  v_cal := holaamigo.calibracion(v_esperado, p_real);

  update holaamigo.decisions
     set outcome = jsonb_build_object(
           'metric', v_metric,
           'actual_value', p_real,
           'measured_at', p_medido_en
         ),
         calibration = v_cal
   where id = p_decision_id;

  return v_cal;
end $$;

-- ═══════════════ 6 · EL NÚCLEO DEL DESTILADOR ═══════════════
--
-- Devuelve los grupos (tipo de decisión × contexto × métrica) donde hay señal
-- consistente. Es SQL y no una llamada al modelo por la razón de siempre:
-- ninguna cifra que el cliente lee sale de un modelo (ADR 0007). El modelo, más
-- adelante, podrá reescribir la frase; los números —n, lift, confianza— salen
-- de acá y se pueden verificar con una consulta.
--
-- La confianza es determinista y tiene dos factores que se multiplican:
--
--   volumen  (1 - 1/√n)              con n=8 → 0,65 · n=16 → 0,75 · n=50 → 0,86
--   fuerza   min(1, (lift-1)/0,5)    lift 1,25 → 0,5 · lift ≥1,5 → 1
--
-- Consecuencia buscada: hacen falta ~16 decisiones medidas con 50% de ventaja
-- para pasar el umbral de 0,7 que activa una lección sola. Menos que eso queda
-- en `candidate` esperando evidencia o un humano.
--
-- LÍMITE CONOCIDO DE v1: solo destila métricas donde más es mejor y los
-- promedios son positivos (`direction = 'up'`). Las métricas de costo —donde
-- bajar es ganar— quedan para P4, junto con el motor de experimentos.

create or replace function holaamigo.destilar_candidatas(
  p_org uuid,
  p_min_n int default 8,
  p_min_lift numeric default 1.2
)
returns table (
  kind text,
  contexto text,
  metric text,
  n_total int,
  mejor_opcion text,
  media_mejor numeric,
  media_resto numeric,
  lift numeric,
  n_mejor int,
  confianza numeric,
  decision_ids uuid[]
)
language sql
stable
as $$
  with medidas as (
    select
      d.id,
      d.kind,
      coalesce(d.context->>'segment', '—') || '·' || coalesce(d.context->>'channel', '—') as contexto,
      coalesce(d.prediction->>'metric', '—') as metric,
      d.chosen->>'label' as opcion,
      (d.outcome->>'actual_value')::numeric as valor
    from holaamigo.decisions d
    where d.organization_id = p_org
      and d.outcome is not null
      and d.chosen ? 'label'
      and (d.outcome->>'actual_value') is not null
      and coalesce(d.prediction->>'direction', 'up') = 'up'
  ),
  por_opcion as (
    select m.kind, m.contexto, m.metric, m.opcion,
           count(*)::int as n,
           avg(m.valor) as media
    from medidas m
    group by 1, 2, 3, 4
  ),
  grupos as (
    select p.kind, p.contexto, p.metric,
           sum(p.n)::int as n_total,
           count(*)::int as n_opciones
    from por_opcion p
    group by 1, 2, 3
  ),
  ids_grupo as (
    select m.kind, m.contexto, m.metric, array_agg(m.id) as ids
    from medidas m
    group by 1, 2, 3
  ),
  mejores as (
    select distinct on (p.kind, p.contexto, p.metric)
           p.kind, p.contexto, p.metric, p.opcion, p.media, p.n
    from por_opcion p
    order by p.kind, p.contexto, p.metric, p.media desc, p.n desc, p.opcion
  ),
  restos as (
    select p.kind, p.contexto, p.metric,
           sum(p.media * p.n) / nullif(sum(p.n), 0) as media_resto
    from por_opcion p
    join mejores b
      on b.kind = p.kind and b.contexto = p.contexto and b.metric = p.metric
    where p.opcion is distinct from b.opcion
    group by 1, 2, 3
  )
  select
    g.kind,
    g.contexto,
    g.metric,
    g.n_total,
    b.opcion as mejor_opcion,
    round(b.media, 4) as media_mejor,
    round(r.media_resto, 4) as media_resto,
    round(b.media / r.media_resto, 3) as lift,
    b.n as n_mejor,
    round(
      least(0.95, greatest(0,
        (1 - 1 / sqrt(g.n_total::numeric))
        * least(1, (b.media / r.media_resto - 1) / 0.5)
      )), 3) as confianza,
    i.ids
  from grupos g
  join mejores b on b.kind = g.kind and b.contexto = g.contexto and b.metric = g.metric
  join restos  r on r.kind = g.kind and r.contexto = g.contexto and r.metric = g.metric
  join ids_grupo i on i.kind = g.kind and i.contexto = g.contexto and i.metric = g.metric
  where g.n_total >= p_min_n
    and g.n_opciones >= 2
    and b.media > 0
    and r.media_resto > 0
    and b.media / r.media_resto >= p_min_lift
$$;

-- El destilador completo: escribe, actualiza, activa y retira. Corre de noche
-- por organización desde /api/cron/destilar.
--
-- Las lecciones de alcance `organization` con confianza > 0,7 se activan solas.
-- Las de `industry` y `global` no las produce este job: nacen de promover una
-- lección de organización a mano, y la base exige `promoted_by` para dejarlas
-- activas.
create or replace function holaamigo.destilar(
  p_org uuid,
  p_min_n int default 8,
  p_min_lift numeric default 1.2,
  p_umbral_activacion numeric default 0.7
)
returns jsonb
language plpgsql
as $$
declare
  v_creadas int := 0;
  v_actualizadas int := 0;
  v_activadas int := 0;
  v_retiradas int := 0;
begin
  with c as (
    select * from holaamigo.destilar_candidatas(p_org, p_min_n, p_min_lift)
  ),
  ins as (
    insert into holaamigo.lessons (
      scope, scope_ref, statement, applies_to, supporting_decisions,
      n_support, confidence, best_option, lift, fingerprint, status
    )
    select
      'organization',
      p_org::text,
      format(
        'En %s, la opción «%s» rinde %sx sobre las demás en %s (n=%s).',
        case when c.contexto = '—·—' then 'esta organización' else c.contexto end,
        c.mejor_opcion,
        c.lift,
        c.metric,
        c.n_total
      ),
      jsonb_build_object(
        'kinds', jsonb_build_array(c.kind),
        'contexto', c.contexto,
        'metric', c.metric
      ),
      c.decision_ids,
      c.n_total,
      c.confianza,
      c.mejor_opcion,
      c.lift,
      concat_ws('|', 'organization', p_org::text, c.kind, c.contexto, c.metric),
      'candidate'
    from c
    on conflict (fingerprint) do update set
      -- Si cambió la opción ganadora, la evidencia se dio vuelta: sube de
      -- versión y vuelve a `candidate`. Reescribir el enunciado dejando la
      -- lección activa sería cambiarle la ley al sistema sin avisar.
      statement = excluded.statement,
      applies_to = excluded.applies_to,
      supporting_decisions = excluded.supporting_decisions,
      n_support = excluded.n_support,
      confidence = excluded.confidence,
      lift = excluded.lift,
      version = case
        when holaamigo.lessons.best_option is distinct from excluded.best_option
        then holaamigo.lessons.version + 1
        else holaamigo.lessons.version
      end,
      status = case
        when holaamigo.lessons.best_option is distinct from excluded.best_option then 'candidate'
        when holaamigo.lessons.status = 'retired' then 'candidate'
        else holaamigo.lessons.status
      end,
      retired_reason = case
        when holaamigo.lessons.best_option is distinct from excluded.best_option
        then format('la evidencia se dio vuelta: ahora gana «%s»', excluded.best_option)
        else holaamigo.lessons.retired_reason
      end,
      contradicted_at = case
        when holaamigo.lessons.best_option is distinct from excluded.best_option
        then now() else holaamigo.lessons.contradicted_at
      end,
      best_option = excluded.best_option,
      -- El enunciado cambió: el vector viejo ya no lo representa. Se borra para
      -- que el job de embeddings lo vuelva a calcular y la recuperación por
      -- similitud no siga apuntando a una frase que ya no existe.
      embedding = case
        when holaamigo.lessons.statement is distinct from excluded.statement
        then null else holaamigo.lessons.embedding
      end,
      updated_at = now()
    returning (xmax = 0) as creada
  )
  select
    count(*) filter (where ins.creada)::int,
    count(*) filter (where not ins.creada)::int
  into v_creadas, v_actualizadas
  from ins;

  update holaamigo.lessons
     set status = 'active', updated_at = now()
   where scope = 'organization'
     and scope_ref = p_org::text
     and status = 'candidate'
     and confidence > p_umbral_activacion
     -- `now()` es el inicio de la transacción, así que una lección contradicha
     -- en esta misma pasada nunca cumple la condición. Se activa mañana, si la
     -- evidencia nueva aguanta una noche más.
     and (contradicted_at is null or contradicted_at < now() - interval '20 hours');
  get diagnostics v_activadas = row_count;

  -- Retiro por evidencia invertida: la lección sigue activa pero su grupo ya no
  -- muestra ventaja (lift < 1). Se recalcula sin filtro de lift para poder ver
  -- justamente los grupos que dejaron de calificar.
  with actual as (
    select
      concat_ws('|', 'organization', p_org::text, kind, contexto, metric) as fingerprint,
      lift, mejor_opcion
    from holaamigo.destilar_candidatas(p_org, p_min_n, 0)
  )
  update holaamigo.lessons l
     set status = 'retired',
         retired_reason = format(
           'la evidencia se invirtió: la ventaja cayó a %sx y ahora gana «%s»',
           a.lift, a.mejor_opcion),
         updated_at = now()
    from actual a
   where l.fingerprint = a.fingerprint
     and l.status = 'active'
     and a.lift < 1.0;
  get diagnostics v_retiradas = row_count;

  return jsonb_build_object(
    'creadas', v_creadas,
    'actualizadas', v_actualizadas,
    'activadas', v_activadas,
    'retiradas', v_retiradas
  );
end $$;

-- ═══════════════ 7 · COSTOS ═══════════════
--
-- Regla de imputación: el costo de una corrida se reparte en partes iguales
-- entre las decisiones que esa corrida produjo. Es una atribución, no una
-- medición, y se dice explícito: no existe forma honesta de saber qué parte de
-- los tokens de una corrida fue "por" cada decisión. Lo que sí garantiza esta
-- regla es que la suma cuadre — sin eso, el P&G de P4 nace mintiendo.

create or replace function holaamigo.imputar_costos(p_org uuid default null)
returns int
language plpgsql
as $$
declare
  v_filas int;
begin
  with costo_corrida as (
    select t.run_id, sum(t.cost_usd) as costo
    from holaamigo.traces t
    where t.run_id is not null
      and (p_org is null or t.organization_id = p_org)
    group by t.run_id
  ),
  reparto as (
    select d.id,
           c.costo / count(*) over (partition by d.run_id) as costo_decision
    from holaamigo.decisions d
    join costo_corrida c on c.run_id = d.run_id
    where p_org is null or d.organization_id = p_org
  )
  update holaamigo.decisions d
     set cost_usd = round(r.costo_decision, 6)
    from reparto r
   where d.id = r.id
     and d.cost_usd is distinct from round(r.costo_decision, 6);
  get diagnostics v_filas = row_count;
  return v_filas;
end $$;

-- Costo por organización / agente / día / tipo de decisión.
--
-- El `join` con decisiones NO se hace directo: una corrida puede producir
-- varias decisiones y el join multiplicaría las trazas, inflando el costo. Se
-- colapsa primero a una fila por corrida —el tipo de la PRIMERA decisión de la
-- corrida—, y por eso la vista cuadra exactamente con la suma cruda de trazas.
create or replace view holaamigo.cost_rollup as
with tipo_de_corrida as (
  select run_id, (array_agg(kind order by created_at, id))[1] as kind
  from holaamigo.decisions
  where run_id is not null
  group by run_id
)
select
  t.organization_id,
  t.agent_id,
  t.role,
  date_trunc('day', t.created_at)::date as dia,
  coalesce(c.kind, 'sin_decision') as decision_kind,
  count(*)::int as pasos,
  sum(t.tokens_in)::bigint as tokens_in,
  sum(t.tokens_out)::bigint as tokens_out,
  round(sum(t.cost_usd), 6) as costo_usd
from holaamigo.traces t
left join tipo_de_corrida c on c.run_id = t.run_id
group by 1, 2, 3, 4, 5;

comment on view holaamigo.cost_rollup is
  'Costo por org/agente/día/tipo de decisión. Cuadra exacto contra sum(traces.cost_usd).';

-- Purga de trazas. 90 días es el default y no está en una variable de entorno a
-- propósito: cambiarlo es una decisión de retención de datos, no de despliegue.
create or replace function holaamigo.purgar_trazas(p_dias int default 90)
returns int
language plpgsql
as $$
declare v_filas int;
begin
  delete from holaamigo.traces where created_at < now() - make_interval(days => p_dias);
  get diagnostics v_filas = row_count;
  return v_filas;
end $$;

-- ═══════════════ 8 · RLS, GRANTS Y TRIGGERS ═══════════════
-- Mismo bloque de 0001: deny-by-default y service_role explícito. Se repite
-- porque estas tablas no existían cuando corrió 0001.

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'holaamigo'
      and tablename in ('traces','decisions','lessons','human_inputs')
  loop
    execute format('alter table holaamigo.%I enable row level security', t.tablename);
    execute format('alter table holaamigo.%I force row level security', t.tablename);
  end loop;
end $$;

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
-- Nuevo respecto a 0001: ahora el schema tiene funciones y se llaman por RPC
-- desde la aplicación. Sin este grant, `cerrar_decision` y `destilar` dan
-- 42501 y el ciclo de aprendizaje se queda mudo.
grant execute on all functions in schema holaamigo to service_role;
alter default privileges in schema holaamigo grant execute on functions to service_role;

revoke all on schema holaamigo from anon, authenticated;

drop trigger if exists lessons_touch on holaamigo.lessons;
create trigger lessons_touch before update on holaamigo.lessons
  for each row execute function holaamigo.touch_updated_at();

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
-- Después de correr esto:
--
-- select count(*) from holaamigo.traces;         -- 0, pero responde
-- select holaamigo.calibracion(100, 80);         -- 0.8000
-- select * from holaamigo.cost_rollup limit 1;   -- vacío, pero existe
-- select holaamigo.destilar('<org_id>'::uuid);   -- {"creadas":0,...}
