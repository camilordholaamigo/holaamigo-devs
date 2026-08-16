-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · P3 — La Sala: deliberación visible, el feed y el Capítulo
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- Hasta acá los agentes decidían (P1) dentro de una correa (P2), pero el
-- cliente veía el resultado, no el proceso. Un resultado sin proceso es un
-- oráculo: se cree o no se cree, y no hay nada que hacer al respecto.
--
-- Tres superficies, tres ritmos, tres verbos distintos:
--
--   El Feed      DECIDIR    cola de tarjetas que esperan al humano
--   La Sala      LEER       la conversación entre agentes, cronológica
--   El Capítulo  ENTENDER   150–250 palabras cada mañana
--
-- DOS DECISIONES DE DISEÑO QUE NO SE NEGOCIAN, y por eso viven en `check`
-- constraints y no en la capa de render:
--
--   1. `what_would_change_my_mind` es OBLIGATORIO para resolver. Es lo que
--      convierte al agente en asesor y no en oráculo, y es donde el cliente sabe
--      exactamente qué evidencia aportar para cambiar el rumbo.
--
--   2. Si el humano habló, la recomendación tiene que CITARLO. No alcanza con
--      "considerarlo": una recomendación que ignora lo que el cliente escribió y
--      llega a la misma conclusión es peor que no haber preguntado, porque
--      parece que escuchó.
--
-- Ver docs/adr/0019-la-deliberacion-como-objeto.md
--     docs/wiki/17-la-sala-el-feed-y-el-capitulo.md
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · LA DELIBERACIÓN ═══════════════

create table if not exists holaamigo.deliberations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  opened_by uuid references holaamigo.agents(id) on delete set null,
  opened_by_role text check (opened_by_role in ('president','cmo','sales','system')),
  question text not null,
  context jsonb not null default '{}',
  status text not null default 'open'
    check (status in ('open','resolved','escalated','abandoned')),

  -- {option, summary, evidence:[{type, ref, note}]}
  recommendation jsonb,
  confidence numeric check (confidence is null or confidence between 0 and 1),

  -- El campo que convierte al agente en asesor. 20 caracteres de mínimo no es
  -- un número mágico: es el umbral debajo del cual sale "más datos" y eso no le
  -- sirve a nadie para saber qué aportar.
  what_would_change_my_mind text,

  -- [{agent, position, argument}] — el desacuerdo se muestra, no se resuelve en
  -- silencio. Si la CMO quiere subir marca y SALES quiere más buzones, las dos
  -- posiciones quedan acá y el President explica por qué escogió.
  dissent jsonb not null default '[]',

  decision_id uuid references holaamigo.decisions(id) on delete set null,
  feed_item_id uuid references holaamigo.feed_items(id) on delete set null,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Cuántas veces el humano la reabrió. Es una métrica de producto: una
  -- deliberación reabierta tres veces es un agente que no está escuchando.
  reopened_count int not null default 0,

  constraint deliberations_resuelta_exige_cambio_de_opinion check (
    status <> 'resolved'
    or (
      recommendation is not null
      and what_would_change_my_mind is not null
      and length(btrim(what_would_change_my_mind)) >= 20
    )
  )
);
create index if not exists deliberations_org_idx
  on holaamigo.deliberations (organization_id, opened_at desc);
create index if not exists deliberations_abiertas_idx
  on holaamigo.deliberations (organization_id, status) where status = 'open';

comment on table holaamigo.deliberations is
  'La conversación entre agentes sobre una pregunta. Resolverla exige decir qué la cambiaría.';

create table if not exists holaamigo.deliberation_turns (
  id bigserial primary key,
  deliberation_id uuid not null references holaamigo.deliberations(id) on delete cascade,
  speaker text not null,
  speaker_type text not null check (speaker_type in ('agent','human')),
  body text not null,
  evidence jsonb not null default '[]',
  stance text not null check (stance in ('propose','support','object','question','concede','decide')),
  -- Cuando el turno es del humano, apunta a su `human_input`: así el peso que
  -- ese texto tiene en la próxima corrida del agente y el texto que se ve en la
  -- pantalla son literalmente la misma fila.
  human_input_id uuid references holaamigo.human_inputs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists deliberation_turns_idx
  on holaamigo.deliberation_turns (deliberation_id, created_at);

-- ═══════════════ 2 · EL CAPÍTULO ═══════════════
--
-- Serie, no notificación. Se archiva y se puede leer de corrido tres meses
-- después: "¿qué estaba pasando en septiembre?" es una pregunta que un dueño se
-- hace, y hoy la única respuesta es abrir doce pantallas.

create table if not exists holaamigo.chapters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  dia date not null,
  numero int not null default 1,
  titulo text not null,
  body text not null,
  -- Los números del capítulo salen de acá y NO del modelo (ADR 0007). El modelo
  -- los narra; si inventa uno, la comparación contra este objeto lo delata.
  stats jsonb not null default '{}',
  needs_from_human jsonb not null default '[]',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists chapters_dia_key
  on holaamigo.chapters (organization_id, dia);

alter table holaamigo.feed_items
  add column if not exists deliberation_id uuid;

-- ═══════════════ 3 · EL LÍMITE DE SIETE ═══════════════
--
-- Máximo 7 tarjetas activas por organización. El límite es COGNITIVO, no
-- técnico: una cola de veinte no se prioriza, se abandona. Con siete, el trabajo
-- del día se ve completo en una pantalla y se termina.
--
-- La prioridad es determinista y se puede explicar en una frase por tarjeta,
-- que es el requisito de verdad: "el feed muestra 7" sin decir por qué esas
-- siete es una caja negra que el cliente no puede discutir.
--
--   severidad     alta 300 · normal 200 · baja 100
--   vencimiento   <6 h +150 · <24 h +75      (lo que se va a decidir solo)
--   decidir       requires='approval' +50    (decidir manda sobre informar)
--   antigüedad    +2/hora, tope 50           (lo viejo sube despacio, no se olvida)

create or replace function holaamigo.priorizar_feed(
  p_org uuid,
  p_limite int default 7
)
returns table (
  feed_item_id uuid,
  puesto int,
  puntaje int,
  motivo text,
  mostrado boolean
)
language sql
stable
as $$
  with abiertos as (
    select
      f.id,
      f.title,
      f.severity,
      f.requires,
      f.created_at,
      a.expires_at,
      (case f.severity when 'high' then 300 when 'normal' then 200 else 100 end)
      + (case
          when a.expires_at is null then 0
          when a.expires_at < now() + interval '6 hours' then 150
          when a.expires_at < now() + interval '24 hours' then 75
          else 0
        end)
      + (case when f.requires = 'approval' then 50 else 0 end)
      + least(50, (extract(epoch from now() - f.created_at) / 3600 * 2)::int)
      as puntaje
    from holaamigo.feed_items f
    left join holaamigo.approvals a on a.id = f.approval_id
    where f.organization_id = p_org
      and f.status = 'open'
      and f.requires in ('approval','input')
  ),
  ordenados as (
    select *, row_number() over (order by puntaje desc, created_at) as puesto
    from abiertos
  )
  select
    o.id,
    o.puesto::int,
    o.puntaje,
    case
      when o.expires_at is not null and o.expires_at < now() + interval '6 hours'
        then format('se decide solo en menos de %s h si no respondes',
                    greatest(1, round(extract(epoch from o.expires_at - now()) / 3600)))
      when o.severity = 'high' then 'es de las que pueden costar caro'
      when o.requires = 'approval' then 'no avanza hasta que decidas'
      when o.created_at < now() - interval '2 days' then 'lleva más de dos días esperándote'
      else 'entra cuando se despeje la cola'
    end,
    o.puesto <= p_limite
  from ordenados o
  order by o.puesto
$$;

-- ═══════════════ 4 · RESOLVER, CON LAS DOS REGLAS ═══════════════
--
-- Que esto sea una función y no un `update` desde la aplicación es lo que hace
-- que las dos reglas sean inevitables. La segunda —citar al humano— es
-- imposible de expresar como `check` constraint porque depende de otra tabla.

create or replace function holaamigo.resolver_deliberacion(
  p_id uuid,
  p_recommendation jsonb,
  p_confidence numeric,
  p_what_would_change text,
  p_decision_id uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_org uuid;
  v_sin_citar text[];
begin
  select organization_id into v_org from holaamigo.deliberations where id = p_id;
  if not found then
    raise exception 'la deliberación % no existe', p_id;
  end if;

  if p_what_would_change is null or length(btrim(p_what_would_change)) < 20 then
    raise exception
      'no se puede resolver sin decir qué te haría cambiar de opinión: es lo que convierte una recomendación en algo discutible';
  end if;

  -- Todo `human_input` que haya entrado al hilo tiene que aparecer en la
  -- evidencia de la recomendación. Ignorar lo que el cliente escribió y llegar a
  -- la misma conclusión es peor que no haber preguntado.
  select array_agg(t.human_input_id::text)
    into v_sin_citar
  from holaamigo.deliberation_turns t
  where t.deliberation_id = p_id
    and t.human_input_id is not null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_recommendation->'evidence', '[]'::jsonb)) e
      where e->>'ref' = t.human_input_id::text
    );

  if v_sin_citar is not null and array_length(v_sin_citar, 1) > 0 then
    raise exception
      'la recomendación no cita lo que escribió el humano (%). Si su aporte no cambió nada, decilo en la evidencia con esa nota.',
      array_to_string(v_sin_citar, ', ');
  end if;

  update holaamigo.deliberations
     set status = 'resolved',
         recommendation = p_recommendation,
         confidence = p_confidence,
         what_would_change_my_mind = p_what_would_change,
         decision_id = coalesce(p_decision_id, decision_id),
         resolved_at = now()
   where id = p_id;

  return jsonb_build_object('id', p_id, 'status', 'resolved');
end $$;

-- ═══════════════ 5 · EL TITIRITERO ENTRA A LA SALA ═══════════════
--
-- El cliente puede interponerse en cualquier punto del hilo. No está mandando
-- una orden a un formulario: está entrando a la sala.
--
-- Tres cosas pasan a la vez, y por eso es una función y no tres llamadas:
--   1. Se guarda como `human_input` con peso 2.0 → pesa MÁS que la evidencia
--      del sistema en la próxima corrida (P1).
--   2. Entra al hilo como turno visible.
--   3. La deliberación vuelve a `open`, aunque estuviera resuelta.

create or replace function holaamigo.interponer(
  p_deliberation_id uuid,
  p_author text,
  p_author_type text,
  p_body text,
  p_stance text default 'object',
  p_weight numeric default 2.0
)
returns jsonb
language plpgsql
as $$
declare
  v_org uuid;
  v_status text;
  v_input_id uuid;
  v_turn_id bigint;
begin
  select organization_id, status into v_org, v_status
  from holaamigo.deliberations where id = p_deliberation_id;

  if not found then
    raise exception 'la deliberación % no existe', p_deliberation_id;
  end if;

  insert into holaamigo.human_inputs
    (organization_id, author, author_type, body, weight, scope)
  values (v_org, p_author, p_author_type, p_body, p_weight,
          jsonb_build_object('deliberation_id', p_deliberation_id))
  returning id into v_input_id;

  insert into holaamigo.deliberation_turns
    (deliberation_id, speaker, speaker_type, body, stance, human_input_id)
  values (p_deliberation_id, p_author, 'human', p_body, p_stance, v_input_id)
  returning id into v_turn_id;

  update holaamigo.deliberations
     set status = 'open',
         resolved_at = null,
         -- La recomendación anterior NO se borra: queda en el hilo como lo que
         -- el agente pensaba antes de escuchar. Borrarla haría que la próxima
         -- pareciera la primera, y el cliente no podría ver que lo movió.
         reopened_count = reopened_count + case when v_status = 'resolved' then 1 else 0 end
   where id = p_deliberation_id;

  return jsonb_build_object(
    'human_input_id', v_input_id,
    'turn_id', v_turn_id,
    'reabierta', v_status = 'resolved'
  );
end $$;

-- ═══════════════ 6 · RLS Y GRANTS ═══════════════

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'holaamigo'
      and tablename in ('deliberations','deliberation_turns','chapters')
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
-- select * from holaamigo.priorizar_feed('<org>'::uuid);
--   → 7 con mostrado=true y el resto en false, cada una con su motivo
--
-- select holaamigo.resolver_deliberacion('<id>'::uuid, '{}'::jsonb, 0.7, 'corto');
--   → error: no se puede resolver sin decir qué te haría cambiar de opinión
