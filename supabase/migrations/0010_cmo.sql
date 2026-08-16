-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · P5 — La CMO expandida
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- El valor de agentificar a una CMO no está en conectar canales —eso ya lo
-- tenemos y se configura en otro lado—. Está en **lo que hoy nadie hace porque
-- no da el tiempo**: vigilar a la competencia todas las semanas, notar que el
-- copy se alejó de lo que la marca dice ser, escribir el caso de estudio del
-- cliente que acaba de ganar, y darse cuenta de que un ángulo se quemó antes de
-- gastar tres semanas más en él.
--
-- Un hueco que este archivo cierra y hay que decir: **los ángulos existían pero
-- sus estadísticas estaban muertas.** `angles.sent` y `angles.replied` nunca se
-- escribían porque ningún mensaje guardaba de qué ángulo salía. Una fábrica de
-- ángulos que no puede medir un ángulo no es una fábrica.
--
-- LA DISCIPLINA QUE GOBIERNA LA MÁQUINA DE UPSELL:
--
--   Toda señal aparece primero en NUESTRO admin. Solo pasa al cliente con
--   visto bueno humano — y eso es un `check` constraint, no una costumbre.
--
-- Un agente que le vende servicios al cliente sin filtro destruye la confianza
-- que hace que todo lo demás funcione.
--
-- Ver docs/adr/0021-la-cmo-expandida.md
--     docs/wiki/19-la-cmo-expandida.md
--
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · POSICIONAMIENTO VIVO ═══════════════
--
-- Versionado y no editable en sitio: la pregunta "¿qué decíamos ser en marzo?"
-- es la que permite entender por qué el copy de marzo decía lo que decía. Un
-- documento de posicionamiento que se sobrescribe borra esa historia.

create table if not exists holaamigo.positioning (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  version int not null default 1,
  statement text not null,              -- "Para X que sufren Y, somos el Z que W"
  category text,                        -- la categoría en la que competimos
  icp text,
  differentiators jsonb not null default '[]',  -- ["24/7 sin turnos", "en 24 horas"]
  -- Lo que la marca NO dice. Es la mitad útil del documento: un posicionamiento
  -- que solo enumera virtudes no sirve para detectar deriva, porque todo copy
  -- las cumple de alguna forma.
  forbidden_claims jsonb not null default '[]',
  evidence jsonb not null default '[]',
  created_by text not null default 'cmo',
  reason text,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists positioning_current_key
  on holaamigo.positioning (organization_id) where is_current;
create index if not exists positioning_org_idx
  on holaamigo.positioning (organization_id, version desc);

-- ¿Este texto se aleja de lo que la marca dice ser?
--
-- Determinista y en SQL a propósito (ADR 0007): la deriva es una medición, no
-- una opinión. El modelo puede explicarla después; el número sale de acá y se
-- puede verificar con una consulta.
--
--   viola      → claims prohibidos que aparecen literalmente en el texto
--   cobertura  → qué porción de los diferenciadores aparece en el texto
--
-- La cobertura no tiene que ser 1: un correo de tres líneas no repite los
-- cinco diferenciadores. Lo que importa es la caída sostenida entre piezas.
--
-- DOS FORMAS DE COMPARAR, y la diferencia importa:
--
--   · Los claims PROHIBIDOS se buscan literales. Son frases que prometimos no
--     decir, y una prohibición difusa no es una prohibición.
--   · Los DIFERENCIADORES se buscan por raíz de palabra. El copy conjuga: el
--     posicionamiento dice "responde en 60 segundos" y el correo dice
--     "te respondemos en 60 segundos". Con comparación literal, esa pieza —que
--     está perfectamente alineada— marcaría deriva, y a la tercera falsa
--     alarma nadie vuelve a mirar la alerta.
--
-- El "stemmer" son los primeros 5 caracteres de cada palabra de 4 o más. Es
-- crudo y tiene falsos positivos entre palabras que comparten raíz ("competir"
-- y "competencia"). Para medir si una pieza habla de lo que la marca dice ser,
-- alcanza; para cualquier otra cosa, no serviría.
-- ¿El texto menciona esta idea?
--
-- Cuenta cuántas palabras significativas de la frase aparecen en el texto por
-- raíz, y pide al menos el 70%. Con "responde en 60 segundos" contra
-- "te respondemos en 60 segundos": «responde»→«respo» aparece, «segundos»
-- aparece, «60» aparece → 3 de 3.
create or replace function holaamigo.menciona(p_texto text, p_frase text)
returns boolean
language plpgsql
immutable
as $$
declare
  palabra text;
  v_total int := 0;
  v_encontradas int := 0;
  v_texto text := lower(p_texto);
begin
  foreach palabra in array regexp_split_to_array(lower(btrim(p_frase)), '\s+') loop
    -- Las palabras de 3 letras o menos son artículos y preposiciones: buscarlas
    -- daría coincidencias con cualquier texto en español.
    if length(palabra) < 4 then
      if palabra ~ '^\d+$' then
        v_total := v_total + 1;
        if position(palabra in v_texto) > 0 then v_encontradas := v_encontradas + 1; end if;
      end if;
      continue;
    end if;
    v_total := v_total + 1;
    if position(substr(palabra, 1, 5) in v_texto) > 0 then
      v_encontradas := v_encontradas + 1;
    end if;
  end loop;

  if v_total = 0 then return false; end if;
  return v_encontradas::numeric / v_total >= 0.7;
end $$;

create or replace function holaamigo.deriva_de_copy(p_org uuid, p_texto text)
returns jsonb
language plpgsql
stable
as $$
declare
  p holaamigo.positioning%rowtype;
  v_viola text[] := '{}';
  v_presentes int := 0;
  v_total int := 0;
  claim text;
begin
  select * into p from holaamigo.positioning
  where organization_id = p_org and is_current;

  if not found then
    return jsonb_build_object('sin_posicionamiento', true, 'viola', '[]'::jsonb, 'cobertura', null);
  end if;

  for claim in select jsonb_array_elements_text(p.forbidden_claims) loop
    if position(lower(claim) in lower(p_texto)) > 0 then
      v_viola := v_viola || claim;
    end if;
  end loop;

  for claim in select jsonb_array_elements_text(p.differentiators) loop
    v_total := v_total + 1;
    if holaamigo.menciona(p_texto, claim) then
      v_presentes := v_presentes + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'sin_posicionamiento', false,
    'version', p.version,
    'viola', to_jsonb(v_viola),
    'cobertura', case when v_total = 0 then null else round(v_presentes::numeric / v_total, 3) end,
    'diferenciadores', v_total
  );
end $$;

-- ═══════════════ 2 · INTELIGENCIA COMPETITIVA ═══════════════
--
-- Se guarda un snapshot por sección y por competidor, con hash. El hash es lo
-- que hace barato el trabajo semanal: si no cambió, no hay diff que calcular ni
-- alerta que evaluar, y el 90% de las semanas no cambia nada.

create table if not exists holaamigo.competitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  competitor text not null,
  url text,
  section text not null check (section in ('pricing','offer','jobs','media','home')),
  content text not null,
  content_hash text not null,
  captured_at timestamptz not null default now()
);
create index if not exists competitor_snapshots_idx
  on holaamigo.competitor_snapshots (organization_id, competitor, section, captured_at desc);

create table if not exists holaamigo.competitor_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  competitor text not null,
  section text not null,
  before_hash text,
  after_hash text not null,
  -- Lo que cambió, en texto. Se guarda el diff y no los dos documentos enteros:
  -- lo que el cliente necesita ver es la línea que cambió, no la página.
  diff jsonb not null default '{}',
  -- Por qué importa. Lo escribe el modelo CITANDO el diff; si no hay modelo,
  -- queda la versión determinista.
  why_it_matters text,
  severity text not null default 'normal' check (severity in ('low','normal','high')),
  feed_item_id uuid references holaamigo.feed_items(id) on delete set null,
  detected_at timestamptz not null default now()
);
create index if not exists competitor_changes_idx
  on holaamigo.competitor_changes (organization_id, detected_at desc);

-- ═══════════════ 3 · LA FÁBRICA DE ÁNGULOS ═══════════════

alter table holaamigo.angles
  add column if not exists positioning_version int,
  add column if not exists parent_angle_id uuid references holaamigo.angles(id) on delete set null,
  add column if not exists retired_reason text,
  add column if not exists saturation_score numeric,
  add column if not exists last_evaluated_at timestamptz;

-- Sin esto, un mensaje no sabe de qué ángulo salió y el ángulo no sabe cómo le
-- fue. Es la columna que le da vida a las estadísticas que ya existían.
alter table holaamigo.messages
  add column if not exists angle_id uuid references holaamigo.angles(id) on delete set null;
create index if not exists messages_angle_idx
  on holaamigo.messages (angle_id, sent_at desc) where angle_id is not null;

-- ¿Se quemó este ángulo?
--
-- Compara la tasa de respuesta de la ventana reciente contra la anterior. Todo
-- determinista: la caída, la muestra y el veredicto salen de acá. Lo único que
-- hace el agente es escribir el ángulo nuevo.
--
-- `min_muestra` existe porque con 12 envíos una respuesta de más o de menos
-- mueve la tasa 8 puntos, y ese ruido dispararía una propuesta de ángulo nuevo
-- todas las semanas.
create or replace function holaamigo.saturacion_de_angulos(
  p_org uuid,
  p_dias int default 14,
  p_min_muestra int default 30,
  p_caida numeric default 0.4
)
returns table (
  angle_id uuid,
  nombre text,
  enviados_recientes int,
  respuestas_recientes int,
  tasa_reciente numeric,
  enviados_previos int,
  respuestas_previas int,
  tasa_previa numeric,
  caida numeric,
  saturado boolean
)
language sql
stable
as $$
  with ventanas as (
    select
      m.angle_id,
      count(*) filter (where m.sent_at > now() - make_interval(days => p_dias))::int as env_rec,
      count(*) filter (
        where m.sent_at > now() - make_interval(days => p_dias)
          and m.status = 'replied')::int as resp_rec,
      count(*) filter (
        where m.sent_at <= now() - make_interval(days => p_dias)
          and m.sent_at > now() - make_interval(days => p_dias * 2))::int as env_prev,
      count(*) filter (
        where m.sent_at <= now() - make_interval(days => p_dias)
          and m.sent_at > now() - make_interval(days => p_dias * 2)
          and m.status = 'replied')::int as resp_prev
    from holaamigo.messages m
    where m.organization_id = p_org
      and m.angle_id is not null
      and m.direction = 'out'
      and m.sent_at is not null
    group by m.angle_id
  )
  select
    v.angle_id,
    a.name,
    v.env_rec,
    v.resp_rec,
    round(v.resp_rec::numeric / nullif(v.env_rec, 0), 4) as tasa_reciente,
    v.env_prev,
    v.resp_prev,
    round(v.resp_prev::numeric / nullif(v.env_prev, 0), 4) as tasa_previa,
    round(
      1 - (v.resp_rec::numeric / nullif(v.env_rec, 0))
        / nullif(v.resp_prev::numeric / nullif(v.env_prev, 0), 0), 4) as caida,
    (
      v.env_rec >= p_min_muestra
      and v.env_prev >= p_min_muestra
      and v.resp_prev > 0
      and (1 - (v.resp_rec::numeric / nullif(v.env_rec, 0))
             / nullif(v.resp_prev::numeric / nullif(v.env_prev, 0), 0)) >= p_caida
    ) as saturado
  from ventanas v
  join holaamigo.angles a on a.id = v.angle_id
  where a.organization_id = p_org
$$;

-- ═══════════════ 4 · PRUEBA SOCIAL INDUSTRIALIZADA ═══════════════
--
-- La función más subestimada del plan: es puro trabajo humano que nunca se hace
-- porque nadie tiene tiempo, y agentificado compone. Cada cliente que cierra
-- deja un activo que ayuda a cerrar al siguiente.
--
-- La escalera de estados es la disciplina: **nada se publica sin que el cliente
-- final lo apruebe.** Un caso de estudio con los números de alguien que no dijo
-- que sí no es marketing, es un problema legal.

create table if not exists holaamigo.case_studies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  lead_id uuid references holaamigo.leads(id) on delete set null,
  opportunity_id uuid,
  revenue_event_id uuid references holaamigo.revenue_events(id) on delete set null,
  deal_value_usd numeric(14,2),
  cliente_nombre text,
  draft jsonb not null default '{}',    -- {titulo, situacion, que_hicimos, resultado, cita}
  numbers jsonb not null default '{}',  -- las cifras reales, del CRM, no del modelo
  status text not null default 'detected'
    check (status in ('detected','drafted','awaiting_client','approved','published','rejected')),
  approved_by text,
  approved_at timestamptz,
  asset_id uuid references holaamigo.assets(id) on delete set null,
  angle_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint case_studies_publicado_exige_aprobacion check (
    status <> 'published' or (approved_by is not null and approved_at is not null)
  )
);
create index if not exists case_studies_org_idx
  on holaamigo.case_studies (organization_id, status, created_at desc);
-- Un caso de estudio por ingreso: sin esto, el job diario redetecta el mismo
-- deal todas las noches y el cliente recibe el mismo borrador siete veces.
create unique index if not exists case_studies_revenue_key
  on holaamigo.case_studies (revenue_event_id) where revenue_event_id is not null;

-- ═══════════════ 5 · MEDIA PLAY (enterprise) ═══════════════

create table if not exists holaamigo.media_plays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  data_asset text not null,             -- qué data propietaria tiene el cliente
  thesis text not null,                 -- qué diría un reporte con esa data
  brief jsonb not null default '{}',    -- {titulo, hallazgos, angulos_de_prensa, podcasts, escenarios}
  -- El brief, no la publicación. La CMO prepara; publicar es humano y su techo
  -- de plataforma es L2 (`content.publish`).
  status text not null default 'proposed'
    check (status in ('proposed','approved','in_progress','published','dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists media_plays_org_idx
  on holaamigo.media_plays (organization_id, status);

-- ═══════════════ 6 · LA MÁQUINA DE UPSELL ═══════════════
--
-- La CMO no vende: **detecta restricciones y genera propuestas con evidencia.**
--
-- La escalera de estados NO es decorativa:
--
--   detected → proposed_internal → proposed_client → won | lost | dismissed
--
-- El salto a `proposed_client` exige `internal_approved_by`, y eso es un
-- `check`. Un agente que le ofrece servicios al cliente sin que un humano
-- nuestro lo haya mirado destruye la confianza que hace que el resto del
-- producto funcione — y esa confianza es lo único que no se puede reconstruir
-- con una migración.

create table if not exists holaamigo.upsell_signals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  signal text not null,
  evidence jsonb not null default '{}',
  constraint_type text not null
    check (constraint_type in ('volume','conversion','brand','proof','positioning','capacity','operation')),
  proposed_service text
    check (proposed_service in ('agency_brand','agency_content','agency_reposition','media_play','fdo','credits')),
  estimated_value_usd numeric(12,2),
  confidence numeric check (confidence between 0 and 1),
  status text not null default 'detected'
    check (status in ('detected','proposed_internal','proposed_client','won','lost','dismissed')),
  internal_approved_by text,
  internal_approved_at timestamptz,
  internal_note text,
  feed_item_id uuid references holaamigo.feed_items(id) on delete set null,
  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint upsell_al_cliente_exige_visto_bueno check (
    status not in ('proposed_client','won','lost')
    or internal_approved_by is not null
  )
);
create index if not exists upsell_signals_org_idx
  on holaamigo.upsell_signals (organization_id, status, detected_at desc);
-- Una señal viva por tipo de restricción: sin esto, el job semanal apila la
-- misma señal hasta que alguien la atiende y nuestro admin se vuelve ilegible.
create unique index if not exists upsell_signals_viva_key
  on holaamigo.upsell_signals (organization_id, constraint_type)
  where status in ('detected','proposed_internal','proposed_client');

-- El único camino para mover una señal por la escalera.
create or replace function holaamigo.promover_senal(
  p_id uuid,
  p_por text,
  p_nota text default null
)
returns jsonb
language plpgsql
as $$
declare s holaamigo.upsell_signals%rowtype;
begin
  select * into s from holaamigo.upsell_signals where id = p_id;
  if not found then
    raise exception 'la señal % no existe', p_id;
  end if;

  if s.status = 'detected' then
    update holaamigo.upsell_signals
       set status = 'proposed_internal',
           internal_approved_by = p_por,
           internal_approved_at = now(),
           internal_note = coalesce(p_nota, internal_note),
           updated_at = now()
     where id = p_id;
    return jsonb_build_object('status', 'proposed_internal');
  end if;

  if s.status = 'proposed_internal' then
    update holaamigo.upsell_signals
       set status = 'proposed_client',
           internal_note = coalesce(p_nota, internal_note),
           updated_at = now()
     where id = p_id;
    return jsonb_build_object('status', 'proposed_client');
  end if;

  raise exception 'la señal ya está en %: solo se puede promover desde detected o proposed_internal', s.status;
end $$;

-- ═══════════════ 7 · RLS Y GRANTS ═══════════════

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'holaamigo'
      and tablename in ('positioning','competitor_snapshots','competitor_changes',
                        'case_studies','media_plays','upsell_signals')
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

drop trigger if exists case_studies_touch on holaamigo.case_studies;
create trigger case_studies_touch before update on holaamigo.case_studies
  for each row execute function holaamigo.touch_updated_at();

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select holaamigo.deriva_de_copy('<org>'::uuid, 'el mejor precio del mercado');
--   → {"viola": ["el mejor precio"], "cobertura": 0.0, ...}
--
-- update holaamigo.upsell_signals set status = 'proposed_client' where id = '<id>';
--   → error: upsell_al_cliente_exige_visto_bueno
