-- ═══════════════════════════════════════════════════════════════════════════
-- 0013 · El agente de agendamiento: del diagnóstico a un agente que conversa
--
-- Lo que faltaba entre "el cliente leyó su diagnóstico" y "el cliente tiene un
-- agente que agenda citas por WhatsApp" no era un canal: era un OBJETO. Un
-- lugar donde viva, versionado y visible, todo lo que un setter necesita saber
-- para trabajar — qué vendemos, quién califica, qué objeciones llegan, cómo se
-- reserva, qué se contesta a las preguntas de siempre.
--
-- Ese objeto es el PLAYBOOK, y esta migración lo crea junto con las tres cosas
-- que lo rodean: la base de conocimiento que aterriza sus respuestas, la
-- conversación que lo ejercita, y el embudo que lo mide.
--
-- Tres decisiones que explican casi todo el archivo:
--
--   1. El playbook es DATOS, no un prompt. Por eso son columnas jsonb con
--      forma conocida y no un text. Un prompt no se puede mostrar campo por
--      campo, ni corregir con un tap, ni diffear entre versiones.
--      Ver docs/adr/0024-el-agente-se-compila-del-diagnostico.md
--
--   2. `cobertura` es parte del objeto, no un cálculo de la vista. Qué salió
--      del sitio con fuente y qué inferimos es lo primero que el cliente mira,
--      y es lo que convierte el onboarding en "confirmá estas tres cosas" en
--      vez de "llená esta ficha". Ver ADR 0023.
--
--   3. La conversación tiene DOS registros y no es duplicación:
--      `conversation_turns` es lo que el agente pensó e hizo (turnos,
--      herramientas, etapa); `messages` es lo que efectivamente salió por un
--      canal (id del proveedor, estado de entrega). Mismo argumento que
--      `agent_runs` vs `traces`: dos preguntas distintas con dos vidas
--      distintas.
--
-- Idempotente. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════ 1 · EL PLAYBOOK ═══════════════
--
-- `vertical` existe desde el día uno aunque hoy solo valga una cosa. El primer
-- mercado es appointment setting, pero el compilador es el mismo para
-- recuperación de carrito o para soporte, y una columna que se agrega después
-- obliga a rellenar filas viejas con una mentira.

create table if not exists holaamigo.agent_playbooks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  version int not null default 1,

  vertical text not null default 'appointment_setting'
    check (vertical in ('appointment_setting','recuperacion','soporte')),
  channel text not null default 'whatsapp'
    check (channel in ('whatsapp','email','simulador')),
  status text not null default 'active'
    check (status in ('draft','active','retired')),
  -- De dónde salió ESTA versión. `compilado` = lo armó el compilador desde el
  -- diagnóstico. `editado` = el cliente corrigió algo. `operador` = lo tocamos
  -- nosotros. Sin esta columna no se puede responder "¿esto lo dijo él o lo
  -- inferimos nosotros?" tres meses después.
  source text not null default 'compilado'
    check (source in ('compilado','editado','operador')),

  -- ── Lo que el setter necesita saber ──────────────────────────────────────
  --
  -- Cada bloque es jsonb y no una tabla propia a propósito: se leen SIEMPRE
  -- juntos (el playbook completo entra en una sola instrucción de sistema) y
  -- nunca se consultan por separado. Seis tablas para un objeto que solo se
  -- lee entero son seis joins por conversación.
  oferta jsonb not null default '{}',
  calificacion jsonb not null default '{}',
  objeciones jsonb not null default '[]',
  faq jsonb not null default '[]',
  agendamiento jsonb not null default '{}',
  guion jsonb not null default '{}',
  escalamiento jsonb not null default '{}',
  prohibiciones jsonb not null default '[]',
  tono jsonb not null default '{}',

  -- ── Trazabilidad y honestidad ────────────────────────────────────────────
  -- Qué campos vinieron con fuente, cuáles se infirieron y cuáles faltan.
  cobertura jsonb not null default '{}',
  -- Los ids de lo que se leyó para compilarlo: diagnóstico, brief, research.
  compiled_from jsonb not null default '{}',
  compile_cost_usd numeric(10,4),
  compile_ms int,

  is_current boolean not null default true,

  -- Un guion sin escalamiento no es un guion, es un riesgo: significa que el
  -- agente contesta TODO, incluida la pregunta legal que no debería contestar.
  -- Se hace cumplir en la base porque el compilador podría tener un bug y el
  -- cliente podría borrar el último disparador desde el editor.
  constraint playbook_escala_algo check (
    status <> 'active'
    or jsonb_array_length(coalesce(escalamiento->'disparadores', '[]'::jsonb)) > 0
  ),
  -- Un setter que no califica es un contestador automático. Si no hay ni una
  -- pregunta de calificación, esto no es lo que le vendimos al cliente.
  constraint playbook_califica check (
    status <> 'active'
    or jsonb_array_length(coalesce(calificacion->'preguntas', '[]'::jsonb)) > 0
  )
);

-- Un solo playbook vigente por organización.
create unique index if not exists agent_playbooks_current_key
  on holaamigo.agent_playbooks (organization_id) where is_current;
create index if not exists agent_playbooks_org_idx
  on holaamigo.agent_playbooks (organization_id, version desc);

-- El brief resuelve esto a mano (baja el vigente, después inserta) y funciona,
-- pero deja la ventana abierta: entre el update y el insert la organización no
-- tiene playbook vigente, y si el insert falla se queda sin ninguno. Un trigger
-- `before insert` lo hace en la misma transacción y en el orden correcto
-- siempre. Es la misma decisión, mejor implementada.
create or replace function holaamigo.retirar_playbook_anterior()
returns trigger language plpgsql as $$
begin
  if new.is_current then
    update holaamigo.agent_playbooks
       set is_current = false,
           status = case when status = 'active' then 'retired' else status end,
           updated_at = now()
     where organization_id = new.organization_id
       and is_current
       and id is distinct from new.id;

    -- La versión la calcula la base y no el llamador. Dos compilaciones
    -- concurrentes (el cliente le dio dos veces al botón) producirían la misma
    -- versión si el número se leyera antes de insertar.
    if new.version is null or new.version <= 1 then
      select coalesce(max(version), 0) + 1 into new.version
      from holaamigo.agent_playbooks
      where organization_id = new.organization_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists agent_playbooks_retiro on holaamigo.agent_playbooks;
create trigger agent_playbooks_retiro
  before insert on holaamigo.agent_playbooks
  for each row execute function holaamigo.retirar_playbook_anterior();

drop trigger if exists agent_playbooks_touch on holaamigo.agent_playbooks;
create trigger agent_playbooks_touch before update on holaamigo.agent_playbooks
  for each row execute function holaamigo.touch_updated_at();

comment on table holaamigo.agent_playbooks is
  'El manual de operación del setter: datos versionados, no un prompt.';
comment on column holaamigo.agent_playbooks.cobertura is
  'Qué se sostiene con fuente y qué se infirió. Es lo primero que ve el cliente.';

-- ═══════════════ 2 · LA BASE DE CONOCIMIENTO ═══════════════
--
-- Tabla aparte y no una columna del playbook porque tienen vidas distintas:
-- corregir una objeción versiona el playbook y no debería reindexar 40 páginas
-- del sitio, y reindexar el sitio no debería inventar una versión del guion.
--
-- `external_id` es el id del vector store en OpenAI. Guardamos el id y no el
-- contenido: el contenido ya está en `research_findings` y en el playbook, y
-- duplicarlo acá sería un tercer lugar donde puede desincronizarse.

create table if not exists holaamigo.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  provider text not null default 'openai' check (provider in ('openai')),
  external_id text,
  status text not null default 'building'
    check (status in ('building','ready','failed','expired')),
  file_count int not null default 0,
  bytes bigint not null default 0,
  -- Qué archivos la componen y de dónde salió cada uno. Es lo que permite
  -- responder "¿de dónde sacó eso el agente?" sin abrir OpenAI.
  sources jsonb not null default '[]',
  error text,
  built_at timestamptz,
  -- Los vector stores se cobran por GB/día pasado el primero. Sin vencimiento,
  -- cada prueba de un prospecto que nunca volvió cuesta plata para siempre.
  expires_at timestamptz,
  is_current boolean not null default true
);

create unique index if not exists knowledge_bases_current_key
  on holaamigo.knowledge_bases (organization_id) where is_current;
create index if not exists knowledge_bases_org_idx
  on holaamigo.knowledge_bases (organization_id, created_at desc);

create or replace function holaamigo.retirar_kb_anterior()
returns trigger language plpgsql as $$
begin
  if new.is_current then
    update holaamigo.knowledge_bases
       set is_current = false, updated_at = now()
     where organization_id = new.organization_id
       and is_current
       and id is distinct from new.id;
  end if;
  return new;
end $$;

drop trigger if exists knowledge_bases_retiro on holaamigo.knowledge_bases;
create trigger knowledge_bases_retiro
  before insert on holaamigo.knowledge_bases
  for each row execute function holaamigo.retirar_kb_anterior();

drop trigger if exists knowledge_bases_touch on holaamigo.knowledge_bases;
create trigger knowledge_bases_touch before update on holaamigo.knowledge_bases
  for each row execute function holaamigo.touch_updated_at();

comment on table holaamigo.knowledge_bases is
  'Vector store del cliente en OpenAI. Aterriza las respuestas; no sostiene los hechos.';

-- ═══════════════ 3 · LA CONVERSACIÓN ═══════════════
--
-- La unidad del appointment setting. `stage` no es decorativo: es lo que
-- permite responder "¿en qué escalón se nos caen?" — y en setting la respuesta
-- casi siempre es el mismo escalón, el de proponer la cita.
--
-- El simulador usa la MISMA tabla con `channel = 'simulador'` y sin lead. Un
-- banco de pruebas que corre por otro camino no prueba nada: prueba el banco.

create table if not exists holaamigo.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  lead_id uuid references holaamigo.leads(id) on delete cascade,
  playbook_id uuid references holaamigo.agent_playbooks(id) on delete set null,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  campaign_id uuid references holaamigo.campaigns(id) on delete set null,

  channel text not null default 'whatsapp'
    check (channel in ('whatsapp','email','simulador')),
  status text not null default 'open'
    check (status in ('open','booked','escalated','disqualified','no_reply','opted_out','closed')),
  -- Los siete escalones del setter. `oferta_de_cita` es el que importa: es
  -- donde un setter humano promedio pierde la mitad de las conversaciones por
  -- ponerse a explicar el producto en vez de proponer un horario.
  stage text not null default 'apertura'
    check (stage in ('apertura','descubrimiento','calificacion','objecion',
                     'oferta_de_cita','agendamiento','confirmado','cerrado')),

  -- Lo que se fue capturando: encaje, momento, decisor, dolor. Cada campo con
  -- su valor y con el turno en el que se capturó.
  qualification jsonb not null default '{}',
  -- Continuidad de la Responses API. Guardar el id y no el historial completo
  -- es lo que hace que el turno 12 cueste lo mismo que el turno 2.
  last_response_id text,

  turns int not null default 0,
  -- Cuántos seguimientos sin respuesta llevamos. Tope duro en el runtime: tres
  -- y se cierra. Un cuarto mensaje sin respuesta no consigue citas, consigue
  -- bloqueos.
  followups int not null default 0,
  booking_id uuid references holaamigo.bookings(id) on delete set null,
  escalation_reason text,
  closed_reason text,
  opened_at timestamptz not null default now(),
  last_turn_at timestamptz,
  closed_at timestamptz
);

create index if not exists conversations_org_idx
  on holaamigo.conversations (organization_id, status, updated_at desc);
create index if not exists conversations_lead_idx
  on holaamigo.conversations (lead_id, created_at desc);
-- Un lead no puede tener dos conversaciones abiertas: dos agentes escribiéndole
-- a la misma persona es la peor cara que puede dar este producto.
create unique index if not exists conversations_lead_abierta_key
  on holaamigo.conversations (lead_id)
  where status = 'open' and lead_id is not null;

drop trigger if exists conversations_touch on holaamigo.conversations;
create trigger conversations_touch before update on holaamigo.conversations
  for each row execute function holaamigo.touch_updated_at();

-- ── El escalón MÁS ALTO al que llegó ───────────────────────────────────────
--
-- `stage` dice dónde está la conversación AHORA. Eso no alcanza para el embudo
-- y el bug es fácil de no ver: `cerrar_conversacion()` pone `stage = 'cerrado'`,
-- así que una conversación que llegó a proponer horario y después escaló queda
-- registrada como si nunca hubiera pasado de la apertura. El embudo contaba de
-- menos exactamente en las conversaciones que más interesan — las que llegaron
-- lejos y se cayeron.
--
-- `stage_alcanzado` es monótono: solo sube. Lo mantiene un trigger y no la
-- aplicación porque la aplicación no es el único que escribe acá (el RPC de
-- cierre también), y una marca de agua que dependa de que todos los escritores
-- se acuerden de subirla no es una marca de agua.

create or replace function holaamigo.escalon_del_setter(p_stage text)
returns int language sql immutable as $$
  select case p_stage
    when 'apertura'       then 1
    when 'descubrimiento' then 2
    when 'calificacion'   then 3
    when 'objecion'       then 3
    when 'oferta_de_cita' then 4
    when 'agendamiento'   then 5
    when 'confirmado'     then 6
    else 0                          -- 'cerrado' no es un escalón, es un final
  end
$$;

alter table holaamigo.conversations
  add column if not exists stage_alcanzado text not null default 'apertura';

create or replace function holaamigo.subir_escalon()
returns trigger language plpgsql as $$
begin
  if holaamigo.escalon_del_setter(new.stage)
     > holaamigo.escalon_del_setter(coalesce(new.stage_alcanzado, 'apertura')) then
    new.stage_alcanzado := new.stage;
  end if;
  return new;
end $$;

drop trigger if exists conversations_escalon on holaamigo.conversations;
create trigger conversations_escalon
  before insert or update on holaamigo.conversations
  for each row execute function holaamigo.subir_escalon();

create table if not exists holaamigo.conversation_turns (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  conversation_id uuid not null references holaamigo.conversations(id) on delete cascade,
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  turn int not null,
  role text not null check (role in ('contacto','agente','sistema','herramienta')),
  body text,
  -- Qué herramientas usó el agente en este turno y con qué resultado. Es la
  -- diferencia entre "el agente dijo que hay cupo el jueves" y "el agente
  -- consultó la agenda y hay cupo el jueves".
  tool_calls jsonb not null default '[]',
  stage text,
  model text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(10,4),
  duration_ms int,
  -- El mensaje real que salió por el canal, si salió alguno.
  message_id uuid references holaamigo.messages(id) on delete set null
);

create index if not exists conversation_turns_conv_idx
  on holaamigo.conversation_turns (conversation_id, turn);
create unique index if not exists conversation_turns_key
  on holaamigo.conversation_turns (conversation_id, turn, role);

-- ═══════════════ 4 · CERRAR UNA CONVERSACIÓN ═══════════════
--
-- Mismo patrón que `cerrar_decision()`: el estado final NO se escribe con un
-- update suelto desde la app. Se cierra por acá, con motivo, y la fecha de
-- cierre la pone la base. Un `closed_at` que escribe el llamador es un
-- `closed_at` que algún día va a estar antes del `opened_at`.

create or replace function holaamigo.cerrar_conversacion(
  p_conversation uuid,
  p_status text,
  p_motivo text default null,
  p_booking uuid default null
)
returns holaamigo.conversations
language plpgsql
as $$
declare v_row holaamigo.conversations;
begin
  if p_status not in ('booked','escalated','disqualified','no_reply','opted_out','closed') then
    raise exception 'estado de cierre inválido: %', p_status;
  end if;

  if p_status = 'booked' and p_booking is null then
    raise exception 'una conversación no se cierra como agendada sin la cita que la cerró';
  end if;

  update holaamigo.conversations
     set status = p_status,
         stage = case when p_status = 'booked' then 'confirmado' else 'cerrado' end,
         booking_id = coalesce(p_booking, booking_id),
         escalation_reason = case when p_status = 'escalated' then p_motivo else escalation_reason end,
         closed_reason = p_motivo,
         closed_at = now()
   where id = p_conversation
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no existe la conversación %', p_conversation;
  end if;

  return v_row;
end $$;

comment on function holaamigo.cerrar_conversacion(uuid, text, text, uuid) is
  'Única puerta para cerrar una conversación. Exige motivo, y la cita si cerró agendando.';

-- ═══════════════ 5 · EL EMBUDO DEL SETTER ═══════════════
--
-- La agregación va en SQL por lo mismo que la del flujo inicial (ADR 0023):
-- la vista queda tonta y la definición del embudo se puede probar.
--
-- Los escalones son los del oficio, no los de la base de datos. Un embudo que
-- dice "open → closed" no le sirve a nadie para decidir nada; uno que dice
-- "de 100 que contestaron, 60 llegaron a que les propusiéramos horario y 12
-- agendaron" señala exactamente qué frase hay que reescribir.

create or replace function holaamigo.embudo_del_setter(
  p_org uuid,
  p_desde timestamptz default now() - interval '30 days'
)
returns table (
  etapa text,
  orden int,
  conversaciones bigint,
  del_anterior numeric
)
language sql
stable
as $$
  with base as (
    -- `stage_alcanzado` y no `stage`: la pregunta del embudo es hasta dónde
    -- llegó, no dónde quedó. Una conversación que propuso horario y después
    -- escaló tiene hoy `stage = 'cerrado'`, y contarla como apertura escondería
    -- justo el escalón que hay que arreglar.
    select c.*,
           holaamigo.escalon_del_setter(c.stage_alcanzado) as escalon
    from holaamigo.conversations c
    where c.organization_id = p_org
      and c.created_at >= p_desde
      and c.channel <> 'simulador'
  ),
  conteo as (
    select 'Conversaciones abiertas'::text as etapa, 1 as orden,
           count(*)::bigint as conversaciones from base
    union all
    select 'Contestaron', 2, count(*) filter (where turns > 1)::bigint from base
    union all
    select 'Calificaron', 3, count(*) filter (where escalon >= 3)::bigint from base
    union all
    select 'Les propusimos horario', 4, count(*) filter (where escalon >= 4)::bigint from base
    union all
    select 'Agendaron', 5, count(*) filter (where status = 'booked')::bigint from base
  )
  select c.etapa,
         c.orden,
         c.conversaciones,
         round(
           100.0 * c.conversaciones / nullif(lag(c.conversaciones) over (order by c.orden), 0),
           1
         ) as del_anterior
  from conteo c
  order by c.orden;
$$;

comment on function holaamigo.embudo_del_setter(uuid, timestamptz) is
  'Embudo de agendamiento por escalón alcanzado. Excluye el simulador.';

-- Dónde se cae: la objeción que más conversaciones mata. Es el insumo directo
-- de la siguiente versión del playbook — y por eso devuelve el texto de la
-- objeción y no un conteo por categoría.
create or replace function holaamigo.objeciones_que_matan(
  p_org uuid,
  p_desde timestamptz default now() - interval '30 days'
)
returns table (
  ultima_etapa text,
  conversaciones bigint,
  agendaron bigint,
  tasa numeric
)
language sql
stable
as $$
  select c.stage_alcanzado as ultima_etapa,
         count(*)::bigint as conversaciones,
         count(*) filter (where c.status = 'booked')::bigint as agendaron,
         round(100.0 * count(*) filter (where c.status = 'booked') / nullif(count(*), 0), 1) as tasa
  from holaamigo.conversations c
  where c.organization_id = p_org
    and c.created_at >= p_desde
    and c.channel <> 'simulador'
  group by c.stage_alcanzado
  order by count(*) desc;
$$;

-- ═══════════════ 6 · LAS CAPACIDADES NUEVAS ═══════════════
--
-- Regla de AGENTS.md: capacidad nueva = fila en el catálogo, en el mismo PR.
-- Lo que no está en el catálogo se bloquea, así que sin estas filas el
-- compilador no compila y el setter no contesta.

insert into holaamigo.capabilities
  (id, agent_role, display_name, description, client_explanation, risk_class,
   platform_ceiling, default_level, min_plan, default_reversibility_hours, approval_kind, default_envelope)
values
  ('playbook.compile', 'cmo', 'Armar el guion del agente',
   'Compilar el manual de operación del setter desde el diagnóstico, el Brief y el research.',
   'La CMO arma sola el guion de tu agente con lo que ya leímos de tu negocio. Es un borrador tuyo: no sale nada hacia afuera y lo podés corregir campo por campo.',
   'write', 5, 5, 'diagnostico', null, null, '{}'),

  ('knowledge.index', 'cmo', 'Indexar tu información',
   'Construir la base de conocimiento del agente con el sitio, la oferta y las preguntas frecuentes.',
   'Guardamos lo que dice tu sitio para que el agente conteste con tus palabras y no con las suyas. Solo usamos páginas públicas.',
   'write', 5, 5, 'diagnostico', null, null, '{}'),

  -- Conversar en el simulador es `read` a propósito: no hay tercero humano del
  -- otro lado. Lo que llega a una persona real pasa por `outreach.reply` y
  -- `outreach.send_whatsapp`, que ya existen y siguen mandando.
  ('setter.simulate', 'sales', 'Probar el agente',
   'Sostener una conversación de prueba contra el playbook vigente, sin canal.',
   'Hablás vos con tu agente antes de que le hable a nadie. Nadie afuera recibe nada.',
   'read', 5, 5, 'diagnostico', null, null, '{"max_volume_per_day": 200}'),

  -- Proponer horarios NO es agendar. Se separa de `meeting.book` porque es lo
  -- que el agente hace cincuenta veces por cada vez que reserva, y meterlas en
  -- la misma capacidad haría que el sobre de reservas se gastara consultando.
  ('meeting.offer_slots', 'sales', 'Proponer horarios',
   'Consultar la agenda real y ofrecer horarios concretos.',
   'El agente mira tu agenda de verdad y propone horarios que existen. No reserva nada con esto.',
   'read', 5, 5, 'diagnostico', null, null, '{}')

on conflict (id) do update set
  agent_role = excluded.agent_role,
  display_name = excluded.display_name,
  description = excluded.description,
  client_explanation = excluded.client_explanation,
  risk_class = excluded.risk_class,
  platform_ceiling = excluded.platform_ceiling,
  default_level = excluded.default_level,
  min_plan = excluded.min_plan,
  default_reversibility_hours = excluded.default_reversibility_hours,
  approval_kind = excluded.approval_kind,
  default_envelope = excluded.default_envelope;

-- ═══════════════ 7 · LAS HABILIDADES DEL SETTER ═══════════════
--
-- `internal` y no `mcp`: son herramientas nuestras contra nuestras propias
-- tablas. Están en el catálogo igual que las externas porque el tool list del
-- runtime es UNA intersección, no dos listas — si la agenda viviera fuera del
-- catálogo, apagarla exigiría desplegar.

insert into holaamigo.skills
  (id, provider, provider_config, display_name, description, client_explanation,
   risk_class, min_grant_level, min_plan, cost_model, status)
values
  ('agenda.consultar', 'internal', '{"handler":"consultar_horarios"}',
   'Agenda · consultar horarios',
   'Leer los cupos libres del agendador del cliente en su zona horaria.',
   'El agente mira tu agenda antes de proponer un horario, así no ofrece cupos que no existen.',
   'read', 3, 'diagnostico', '{"unit":"call","credits":0}', 'available'),

  ('agenda.reservar', 'internal', '{"handler":"agendar_cita"}',
   'Agenda · reservar',
   'Crear la cita, mandar la confirmación y dejarla en el CRM.',
   'El agente deja la cita puesta y le manda la confirmación al contacto. Se puede cancelar.',
   'write', 4, 'diagnostico', '{"unit":"call","credits":0}', 'available'),

  ('kb.buscar', 'internal', '{"handler":"file_search"}',
   'Base de conocimiento · buscar',
   'Buscar en el vector store de la organización para contestar con sus palabras.',
   'Cuando le preguntan algo puntual de tu negocio, el agente lo busca en lo que dice tu sitio en vez de inventarlo.',
   'read', 2, 'diagnostico', '{"unit":"call","credits":0}', 'available'),

  ('crm.registrar_calificacion', 'internal', '{"handler":"registrar_calificacion"}',
   'CRM · registrar calificación',
   'Guardar encaje, momento, decisor y dolor a medida que se descubren.',
   'Lo que el contacto te cuenta queda anotado solo, para que no tengas que releer el chat.',
   'write', 3, 'diagnostico', '{"unit":"call","credits":0}', 'available')

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

-- Encendidas para SALES en todas las organizaciones. `organization_id` nulo es
-- la fila global; `scope_key` la colapsa al UUID cero para que el `on conflict`
-- tenga un índice plano que arbitrar (ADR 0015).
insert into holaamigo.skill_grants
  (organization_id, agent_role, skill_id, enabled, envelope, granted_by, granted_by_type)
values
  (null, 'sales', 'agenda.consultar', true, '{}', 'migracion_0013', 'system'),
  (null, 'sales', 'agenda.reservar', true, '{"max_volume_per_day": 20}', 'migracion_0013', 'system'),
  (null, 'sales', 'kb.buscar', true, '{}', 'migracion_0013', 'system'),
  (null, 'sales', 'crm.registrar_calificacion', true, '{}', 'migracion_0013', 'system')
on conflict (scope_key, agent_role, skill_id) do update set
  enabled = excluded.enabled,
  envelope = excluded.envelope;

-- ═══════════════ 8 · EL PLAYBOOK VIGENTE, EN UNA LLAMADA ═══════════════
--
-- Existe para que el runtime no tenga que saber que "vigente" significa
-- `is_current and status = 'active'`. Esa definición vive en un solo lugar y
-- cambiarla no obliga a buscar todos los `.eq('is_current', true)` de la app.

create or replace function holaamigo.playbook_vigente(p_org uuid)
returns holaamigo.agent_playbooks
language sql
stable
as $$
  select p.*
  from holaamigo.agent_playbooks p
  where p.organization_id = p_org
    and p.is_current
    and p.status = 'active'
  limit 1;
$$;

-- ═══════════════ 9 · EL EMBUDO INICIAL, CON EL ESCALÓN DEL AGENTE ═══════════
--
-- Se redefine `holaamigo.embudo_inicial()` acá y no editando 0012 porque las
-- migraciones son de solo agregar: 0012 puede haber corrido ya en producción, y
-- una migración que cambia de contenido después de haberse aplicado es una
-- migración que nadie puede auditar. `create or replace` es idempotente y el
-- archivo que la define es siempre el último que la tocó.
--
-- Los dos escalones nuevos son los que P7 hizo posibles y son los que ahora
-- deciden si el producto funciona: "armó su agente" y "habló con él". El
-- segundo es la señal de activación más fuerte que tenemos — quien le escribe a
-- su agente entiende qué compró, y quien no, no.

create or replace function holaamigo.embudo_inicial(
  p_desde timestamptz default now() - interval '30 days'
)
returns table (
  etapa text,
  orden int,
  organizaciones bigint,
  del_anterior numeric
)
language sql
stable
as $$
  with base as (
    select e.organization_id, min(e.created_at) as entro
    from holaamigo.plg_events e
    where e.event = 'landing_submit'
      and e.organization_id is not null
    group by e.organization_id
    having min(e.created_at) >= p_desde
  ),
  hitos as (
    select b.organization_id,
           bool_or(e.event = 'quiz_started')       as inicio_quiz,
           bool_or(e.event = 'quiz_completed')     as termino_quiz,
           bool_or(e.event = 'diagnostic_viewed')  as vio_diagnostico,
           bool_or(e.event = 'assumption_edited')  as discutio,
           bool_or(e.event = 'playbook_compiled')  as armo_agente,
           bool_or(e.event = 'agent_tested')       as lo_probo,
           bool_or(e.event in ('channel_connected', 'leads_uploaded')) as activo
    from base b
    join holaamigo.plg_events e on e.organization_id = b.organization_id
    group by b.organization_id
  ),
  conteo as (
    select 'Entró por la landing'::text as etapa, 1 as orden,
           count(*)::bigint as organizaciones
    from hitos
    union all
    select 'Abrió el quiz', 2, count(*) filter (where h.inicio_quiz)::bigint from hitos h
    union all
    select 'Terminó el quiz', 3, count(*) filter (where h.termino_quiz)::bigint from hitos h
    union all
    select 'Vio el diagnóstico', 4, count(*) filter (where h.vio_diagnostico)::bigint from hitos h
    union all
    select 'Discutió un número', 5, count(*) filter (where h.discutio)::bigint from hitos h
    union all
    select 'Armó su agente', 6, count(*) filter (where h.armo_agente)::bigint from hitos h
    union all
    select 'Habló con su agente', 7, count(*) filter (where h.lo_probo)::bigint from hitos h
    union all
    select 'Conectó canal o cargó base', 8, count(*) filter (where h.activo)::bigint from hitos h
  )
  select c.etapa,
         c.orden,
         c.organizaciones,
         round(
           100.0 * c.organizaciones / nullif(lag(c.organizaciones) over (order by c.orden), 0),
           1
         ) as del_anterior
  from conteo c
  order by c.orden;
$$;

comment on function holaamigo.embudo_inicial(timestamptz) is
  'Embudo del flujo inicial por organización, con los escalones del agente (P7).';


-- ═══════════════ 11 · EL TECHO DEL PLAN, POR CLASE DE RIESGO ═══════════════
--
-- EL BUG QUE ENCONTRÓ ESTA MIGRACIÓN, y es de los buenos: un cliente en el plan
-- `diagnostico` no podía compilar su propio playbook.
--
-- `techo_de_plan()` devolvía L2 para el plan gratis, y ese L2 se aplicaba por
-- igual a TODAS las clases de riesgo. Compilar un guion es clase `write` sobre
-- un objeto propio —no sale nada del edificio— y aun así quedaba en L2, o sea
-- "preparar", o sea: una tarjeta de aprobación por cada compilación. El
-- onboarding que estábamos colapsando a cero terminaba en una cola.
--
-- LA REGLA CORRECTA YA ESTABA ESCRITA, en `techo_de_autonomia()`:
--
--     "El dial grueso gobierna lo que sale del edificio. Investigar, puntuar y
--      escribir en objetos propios no lo toca."
--
-- El plan es un dial comercial y le aplica exactamente el mismo razonamiento.
-- Un plan es una puerta sobre lo que le llega a un tercero —correos, WhatsApp,
-- plata, publicaciones—, no sobre si el agente puede pensar y escribir en sus
-- propias tablas. Cobrar por lo segundo sería cobrar por el borrador.
--
-- Lo que NO cambia, y hay que decirlo porque es lo que hace segura esta línea:
--
--   · `external_comms`, `spend` e `irreversible` siguen con el techo del plan.
--     Contestar un WhatsApp de verdad en el plan gratis sigue tocando L2.
--   · `min_plan` sigue mandando por encima de todo: una capacidad cuyo plan
--     mínimo es `starter` sigue en 0 para un cliente en `diagnostico`, sea de
--     la clase que sea.
--   · `platform_ceiling` no se toca jamás. Firmar sigue en L0.
--
-- `autorizar` y `habilidades_activas` se redefinen acá enteras porque en
-- PL/pgSQL no hay forma de inyectar el argumento nuevo sin tocar la llamada.
-- Los cuerpos son idénticos a los de 0007 y 0011 salvo esa línea; la versión
-- vigente es SIEMPRE la del número de migración más alto.
-- Ver docs/adr/0024-el-agente-se-compila-del-diagnostico.md §"El techo del plan"

-- SIN valor por defecto en `p_risk_class`, y no es un descuido. 0007 vuelve a
-- crear la versión de un argumento cada vez que se corre —las migraciones se
-- aplican a mano y correr una dos veces es martes—, así que un default haría
-- ambiguas todas las llamadas de un argumento que quedan en el archivo viejo:
-- `function holaamigo.techo_de_plan(text) is not unique`. Con dos firmas
-- distintas conviven sin pisarse, y la de dos argumentos es la que usan las
-- versiones vigentes de `autorizar` y `habilidades_activas` — o sea, las de
-- abajo, que son las que mandan por ser de la migración más alta.
create or replace function holaamigo.techo_de_plan(
  p_plan text,
  p_risk_class text
)
returns int language sql immutable as $$
  select case
    -- Leer y escribir en objetos propios no lo gobierna el plan: es el mismo
    -- criterio de `techo_de_autonomia`. Sin esta línea, el plan gratis no puede
    -- ni armar su guion.
    when p_risk_class in ('read','write') then 5
    when p_plan = 'diagnostico' then 2   -- puede preparar; nada sale
    when p_plan = 'starter'     then 3   -- ejecuta con visto bueno ítem por ítem
    when p_plan = 'growth'      then 4   -- ejecuta dentro de sobres
    when p_plan = 'enterprise'  then 5
    else 2
  end
$$;

comment on function holaamigo.techo_de_plan(text, text) is
  'Techo comercial. Solo aplica a lo que sale del edificio; read y write van libres.';

-- ── `autorizar`, con la clase de riesgo en el techo del plan ───────────────

create or replace function holaamigo.autorizar(
  p_org uuid,
  p_capability text,
  p_payload jsonb default '{}',
  p_agent uuid default null,
  p_registrar boolean default true,
  p_titulo text default null,
  p_decision_id uuid default null,
  -- La aprobación que el llamador YA tiene en la mano. Es lo que cierra el
  -- círculo de L3: "ejecuta ítem por ítem, cada uno con aprobación previa" no
  -- significa nada si el motor no puede ver esa aprobación y sigue pidiendo
  -- otra. Sin esto, activar una campaña ya aprobada por el cliente generaría
  -- una segunda tarjeta pidiendo permiso para lo que acaba de autorizar.
  --
  -- LÍMITE CONSCIENTE: una aprobación desbloquea mientras esté `approved` y no
  -- vencida; no es de un solo uso. Quien evita el doble consumo es la máquina de
  -- estados del llamador (una campaña se activa una vez, un item del feed se
  -- responde una vez). Si algún día hay un llamador sin esa garantía, acá hace
  -- falta un `consumed_at`.
  p_approval_id uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  c holaamigo.capabilities%rowtype;
  v_aprobacion_valida boolean := false;
  v_plan text;
  v_autonomy text;
  v_grant_level int;
  v_envelope jsonb;
  v_techo_cliente int;
  v_techo_plan int;
  v_techo_autonomia int;
  v_solicitado int;
  v_efectivo int;
  v_reversibilidad numeric;
  v_violaciones jsonb := '[]'::jsonb;
  v_volumen int;
  v_usado_dia int;
  v_usado_semana int;
  v_monto numeric;
  v_verdict text;
  v_requiere_aprobacion boolean := false;
  v_accion text := 'ejecutar';
  v_motivos text[] := '{}';
  v_approval_id uuid := null;
  v_guard_id bigint;
  v_kind text;
  v_sla int;
  v_severidad text;
begin
  select * into c from holaamigo.capabilities where id = p_capability;

  if not found then
    if p_registrar then
      insert into holaamigo.guard_events
        (organization_id, agent_id, capability_id, requested_level, effective_level,
         verdict, reason, payload)
      values (p_org, p_agent, p_capability, null, 0, 'blocked',
              'capacidad desconocida: no está en el catálogo', coalesce(p_payload, '{}'));
    end if;
    return jsonb_build_object(
      'verdict', 'blocked',
      'effective_level', 0,
      'requested_level', null,
      'requires_approval', false,
      'accion_permitida', 'nada',
      'envelope_violations', '[]'::jsonb,
      'reason', format('capacidad desconocida: %s', p_capability),
      'capability_id', p_capability
    );
  end if;

  select plan into v_plan from holaamigo.organizations where id = p_org;
  v_plan := coalesce(v_plan, 'diagnostico');

  select autonomy into v_autonomy
  from holaamigo.agents
  where organization_id = p_org
    and (id = p_agent or (p_agent is null and role = c.agent_role))
  limit 1;
  v_autonomy := coalesce(v_autonomy, 'propose');

  select granted_level, envelope into v_grant_level, v_envelope
  from holaamigo.capability_grants
  where organization_id = p_org and capability_id = c.id
    and (expires_at is null or expires_at > now());

  v_grant_level := coalesce(v_grant_level, c.default_level);
  -- El sobre del grant se superpone al del catálogo: el cliente puede apretar un
  -- límite, y las llaves que no toque conservan el default nuestro.
  v_envelope := c.default_envelope || coalesce(v_envelope, '{}'::jsonb);

  -- ── Los tres diales ────────────────────────────────────────────────────
  v_techo_autonomia := holaamigo.techo_de_autonomia(v_autonomy, c.risk_class);
  v_techo_cliente := least(v_grant_level, v_techo_autonomia);
  v_techo_plan := case
    when holaamigo.rango_de_plan(v_plan) < holaamigo.rango_de_plan(c.min_plan) then 0
    else holaamigo.techo_de_plan(v_plan, c.risk_class)
  end;

  v_solicitado := v_grant_level;
  v_efectivo := least(c.platform_ceiling, v_techo_cliente, v_techo_plan);

  if v_efectivo < v_solicitado then
    -- El `::text` no es decorativo: `text[] || 'literal'` sin tipo hace que
    -- Postgres elija la sobrecarga array||array e intente leer la frase como
    -- literal de arreglo. Falla en runtime, y solo en la rama que se ejecute.
    if c.platform_ceiling < v_solicitado then
      v_motivos := v_motivos || 'techo de plataforma'::text;
    end if;
    if v_techo_plan < v_solicitado then
      v_motivos := v_motivos || format('techo del plan %s', v_plan);
    end if;
    if v_techo_autonomia < v_solicitado then
      v_motivos := v_motivos || format('autonomía del agente en %s', v_autonomy);
    end if;
  end if;

  -- ── La regla maestra de reversibilidad ─────────────────────────────────
  --
  -- Se evalúa en runtime y no en configuración: la MISMA capacidad puede ser
  -- reversible o no según el payload. Pausar una campaña se deshace en un clic;
  -- mandarle un correo a 50 personas no se deshace nunca.
  --
  -- La regla es **tope en L4**, no "resta uno", y la diferencia importa. L5 es
  -- el único nivel sin sobre: ejecutar libre y auditar por muestreo. Una acción
  -- que no se puede deshacer no puede correr así. Pero restar un nivel la
  -- llevaría a L3 —visto bueno ítem por ítem— y entonces NINGUNA acción hacia
  -- afuera podría delegarse jamás dentro de un sobre, porque casi todas son
  -- irreversibles. Eso vaciaría de sentido a L4 y al sobre entero.
  --
  -- Lo que sí protege contra lo demasiado irreversible es el techo de
  -- plataforma: publicar, cotizar un precio y firmar un term sheet están en L2
  -- y L0 en el catálogo, y ningún runtime los sube.
  v_reversibilidad := coalesce(
    (p_payload->>'reversibility_hours')::numeric,
    c.default_reversibility_hours,
    0
  );

  if v_reversibilidad > 24 and v_efectivo > 4 then
    v_efectivo := 4;
    v_motivos := v_motivos ||
      format('deshacerlo toma %s h: nunca corre sin sobre, tope L4', round(v_reversibilidad));
  end if;

  -- ── El sobre ───────────────────────────────────────────────────────────
  --
  -- Solo tiene sentido evaluarlo cuando el nivel efectivo permite ejecutar sin
  -- aprobación previa. En L3 cada ítem ya pasa por un humano, que es un límite
  -- más estricto que cualquier sobre.
  v_volumen := greatest(1, coalesce((p_payload->>'volume')::int, 1));
  v_monto := coalesce((p_payload->>'amount_usd')::numeric, 0);

  if v_efectivo >= 4 then
    if v_envelope ? 'expires_at'
       and (v_envelope->>'expires_at')::timestamptz < now() then
      v_violaciones := v_violaciones || jsonb_build_object(
        'rule', 'expires_at',
        'detail', format('el sobre venció el %s', v_envelope->>'expires_at'));
    end if;

    if v_envelope ? 'max_amount_usd'
       and v_monto > (v_envelope->>'max_amount_usd')::numeric then
      v_violaciones := v_violaciones || jsonb_build_object(
        'rule', 'max_amount_usd',
        'detail', format('pide USD %s y el sobre permite USD %s',
                         v_monto, v_envelope->>'max_amount_usd'));
    end if;

    if v_envelope ? 'max_volume_per_day' then
      select coalesce(sum(greatest(1, coalesce((payload->>'volume')::int, 1))), 0)
        into v_usado_dia
      from holaamigo.guard_events
      where organization_id = p_org and capability_id = c.id
        and verdict in ('allowed','downgraded')
        and created_at > now() - interval '1 day';

      if v_usado_dia + v_volumen > (v_envelope->>'max_volume_per_day')::int then
        v_violaciones := v_violaciones || jsonb_build_object(
          'rule', 'max_volume_per_day',
          'detail', format('lleva %s hoy y pide %s más; el sobre permite %s',
                           v_usado_dia, v_volumen, v_envelope->>'max_volume_per_day'),
          'used', v_usado_dia);
      end if;
    end if;

    if v_envelope ? 'max_volume_per_week' then
      select coalesce(sum(greatest(1, coalesce((payload->>'volume')::int, 1))), 0)
        into v_usado_semana
      from holaamigo.guard_events
      where organization_id = p_org and capability_id = c.id
        and verdict in ('allowed','downgraded')
        and created_at > now() - interval '7 days';

      if v_usado_semana + v_volumen > (v_envelope->>'max_volume_per_week')::int then
        v_violaciones := v_violaciones || jsonb_build_object(
          'rule', 'max_volume_per_week',
          'detail', format('lleva %s esta semana y pide %s más; el sobre permite %s',
                           v_usado_semana, v_volumen, v_envelope->>'max_volume_per_week'),
          'used', v_usado_semana);
      end if;
    end if;

    if v_envelope ? 'forbidden_commitments' and exists (
      select 1 from jsonb_array_elements_text(coalesce(p_payload->'commitments', '[]'::jsonb)) x
      where x in (select jsonb_array_elements_text(v_envelope->'forbidden_commitments'))
    ) then
      v_violaciones := v_violaciones || jsonb_build_object(
        'rule', 'forbidden_commitments',
        'detail', 'el artefacto compromete algo que el sobre prohíbe');
    end if;

    if v_envelope ? 'forbidden_counterparties' and exists (
      select 1 from jsonb_array_elements_text(coalesce(p_payload->'counterparty_tags', '[]'::jsonb)) x
      where x in (select jsonb_array_elements_text(v_envelope->'forbidden_counterparties'))
    ) then
      v_violaciones := v_violaciones || jsonb_build_object(
        'rule', 'forbidden_counterparties',
        'detail', 'la contraparte está en una lista prohibida');
    end if;

    if v_envelope ? 'allowed_counterparties'
       and jsonb_array_length(v_envelope->'allowed_counterparties') > 0
       and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p_payload->'counterparty_tags', '[]'::jsonb)) x
      where x in (select jsonb_array_elements_text(v_envelope->'allowed_counterparties'))
    ) then
      v_violaciones := v_violaciones || jsonb_build_object(
        'rule', 'allowed_counterparties',
        'detail', 'la contraparte no está en la lista de permitidas');
    end if;

    if coalesce((v_envelope->>'requires_disclosure')::boolean, false)
       and not coalesce((p_payload->>'discloses_agent')::boolean, false) then
      v_violaciones := v_violaciones || jsonb_build_object(
        'rule', 'requires_disclosure',
        'detail', 'el mensaje no dice que lo escribe un agente');
    end if;
  end if;

  -- ── El veredicto ───────────────────────────────────────────────────────
  if jsonb_array_length(v_violaciones) > 0 then
    -- Un sobre violado bloquea Y pide. La tarjeta es la forma de desbloquear:
    -- degradar en silencio a "pedir permiso" haría que el sobre pareciera una
    -- sugerencia, y el punto del sobre es que sea un límite.
    v_verdict := 'blocked';
    v_requiere_aprobacion := true;
    v_accion := 'pedir';
    v_kind := 'envelope_exceeded';
  elsif v_efectivo >= 4 then
    v_verdict := case when v_efectivo < v_solicitado then 'downgraded' else 'allowed' end;
    v_accion := 'ejecutar';
  elsif v_efectivo = 3 then
    v_verdict := case when v_efectivo < v_solicitado then 'downgraded' else 'allowed' end;
    v_requiere_aprobacion := true;
    v_accion := 'ejecutar_con_visto_bueno';
    v_kind := coalesce(c.approval_kind, 'capability_step');
  else
    v_verdict := 'blocked';
    v_accion := case v_efectivo when 2 then 'preparar' when 1 then 'proponer' else 'nada' end;
    -- En L2 y L1 el agente TIENE algo que hacer (dejar el artefacto listo,
    -- escribir la propuesta) y ese algo termina en una tarjeta. En L0 no: una
    -- capacidad prohibida no genera cola de trabajo.
    if v_efectivo between 1 and 2 then
      v_requiere_aprobacion := true;
      v_kind := coalesce(c.approval_kind, 'capability_step');
    end if;
  end if;

  -- ── ¿Ya hay un humano que dijo que sí? ─────────────────────────────────
  if v_requiere_aprobacion and p_approval_id is not null then
    select true into v_aprobacion_valida
    from holaamigo.approvals
    where id = p_approval_id
      and organization_id = p_org
      and status = 'approved';

    if coalesce(v_aprobacion_valida, false) then
      v_requiere_aprobacion := false;
      v_accion := 'ejecutar';
      v_verdict := case when v_efectivo < v_solicitado then 'downgraded' else 'allowed' end;
      v_motivos := v_motivos || 'ejecuta con la aprobación humana que ya tenía'::text;
      v_approval_id := p_approval_id;
      v_kind := null;
    end if;
  end if;

  if p_registrar then
    insert into holaamigo.guard_events
      (organization_id, agent_id, capability_id, requested_level, effective_level,
       verdict, reason, envelope_check, payload, decision_id, approval_id)
    values (
      p_org, p_agent, c.id, v_solicitado, v_efectivo, v_verdict,
      nullif(array_to_string(v_motivos, ' · '), ''),
      jsonb_build_object('envelope', v_envelope, 'violations', v_violaciones),
      coalesce(p_payload, '{}'), p_decision_id, v_approval_id)
    returning id into v_guard_id;

    -- La tarjeta se crea acá, en la misma transacción que el bloqueo. Si se
    -- creara en el llamador, un `return` olvidado dejaría al agente frenado sin
    -- que nadie se entere de que está esperando algo.
    if v_requiere_aprobacion and v_kind is not null then
      select sla_minutes, severity into v_sla, v_severidad
      from holaamigo.approval_kinds where kind = v_kind;

      insert into holaamigo.approvals
        (organization_id, agent_id, kind, title, rationale, if_approved, if_rejected,
         payload, severity, capability_id, decision_id, expires_at)
      values (
        p_org, p_agent, v_kind,
        coalesce(p_titulo, format('%s necesita tu visto bueno', c.display_name)),
        coalesce(
          nullif(array_to_string(v_motivos, ' · '), ''),
          case when jsonb_array_length(v_violaciones) > 0
               then 'La acción se sale de los límites que le diste al agente.'
               else c.description end),
        format('El agente ejecuta: %s', c.description),
        'La acción no se ejecuta y el agente propone otra cosa.',
        jsonb_build_object(
          'capability_id', c.id,
          'accion_permitida', v_accion,
          'violations', v_violaciones,
          'request', coalesce(p_payload, '{}')),
        coalesce(v_severidad, 'normal'), c.id, p_decision_id,
        now() + make_interval(mins => coalesce(v_sla, 1440)))
      returning id into v_approval_id;

      update holaamigo.guard_events set approval_id = v_approval_id where id = v_guard_id;
    end if;
  end if;

  return jsonb_build_object(
    'verdict', v_verdict,
    'capability_id', c.id,
    'requested_level', v_solicitado,
    'effective_level', v_efectivo,
    'ceilings', jsonb_build_object(
      'platform', c.platform_ceiling,
      'client', v_techo_cliente,
      'plan', v_techo_plan,
      'autonomy', v_techo_autonomia),
    'requires_approval', v_requiere_aprobacion,
    'approval_kind', v_kind,
    'approval_id', v_approval_id,
    'accion_permitida', v_accion,
    'envelope_violations', v_violaciones,
    'reason', nullif(array_to_string(v_motivos, ' · '), ''),
    'guard_event_id', v_guard_id
  );
end $$;

-- ── `habilidades_activas`, con el mismo cambio ─────────────────────────────

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
          else holaamigo.techo_de_plan((select tier from plan), c.risk_class)
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

-- ═══════════════ 12 · PERMISOS Y RECARGA ═══════════════

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
grant execute on all functions in schema holaamigo to service_role;

revoke all on schema holaamigo from anon, authenticated;

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select * from holaamigo.playbook_vigente('<org>'::uuid);
-- select * from holaamigo.embudo_del_setter('<org>'::uuid);
-- select * from holaamigo.objeciones_que_matan('<org>'::uuid);
-- select * from holaamigo.habilidades_activas('<org>'::uuid, 'sales');
