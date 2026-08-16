-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · P2 — Gobierno: flexibilidad con correa
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- La CMO puede buscar partnerships. No puede firmarlos. Entre "buscar" y
-- "firmar" hay cuatro escalones y hasta hoy no existía ninguno: los permisos
-- vivían como texto en `agents.permissions` —una lista de frases en español que
-- ningún código consultaba antes de actuar— y la única palanca real era
-- `agents.autonomy`, un dial de tres posiciones para el agente entero.
--
-- Un permiso que no se evalúa antes de ejecutar no es un permiso. Es una
-- promesa en la documentación.
--
-- Este archivo lo convierte en máquina:
--
--   capabilities       el catálogo: qué se puede hacer y hasta dónde jamás
--   capability_grants  hasta dónde en ESTA organización, con qué sobre
--   guard_events       qué se intentó, qué se permitió y qué se bloqueó
--   autorizar()        la única puerta. Ninguna herramienta se ejecuta sin pasar.
--
-- LA ESCALERA (seis niveles, iguales para toda capacidad de todo agente):
--
--   L0  Prohibida       ni la menciona
--   L1  Proponer        escribe una propuesta. No produce artefacto.
--   L2  Preparar        arma el artefacto completo. No lo envía.
--   L3  Con visto bueno ejecuta ítem por ítem, cada uno aprobado antes
--   L4  Dentro del sobre ejecuta libre DENTRO de límites declarados, y reporta
--   L5  Autónoma        ejecuta y se audita por muestreo
--
-- El patrón se repite en toda capacidad sensible:
-- **investigar es libre, comunicar es acotado, comprometer es humano.**
--
-- Ver docs/adr/0018-la-escalera-de-capacidades.md
--     docs/wiki/16-gobierno-capacidades-y-sobres.md
--
-- Idempotente: se puede correr varias veces.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · EL PLAN DE LA ORGANIZACIÓN ═══════════════
--
-- Tercer dial. L4 y L5 no existen en los tiers de abajo, y eso no es una
-- decisión comercial arbitraria: son los niveles donde el agente actúa sin que
-- un humano mire cada ítem, y eso exige un acompañamiento que solo existe a
-- partir de cierto tamaño de cuenta.

alter table holaamigo.organizations
  add column if not exists plan text not null default 'diagnostico';

alter table holaamigo.organizations drop constraint if exists organizations_plan_check;
alter table holaamigo.organizations add constraint organizations_plan_check
  check (plan in ('diagnostico','starter','growth','enterprise'));

-- El plan inicial se DERIVA del ciclo de vida, no se deja en el default.
--
-- Sin esta línea, el día del despliegue toda organización queda en
-- `diagnostico` (techo L2) y la correa frena en seco los envíos de los clientes
-- que ya estaban corriendo. Falla en la dirección segura —nadie manda de más—
-- pero falla, y dejarlo como un paso manual en el CHANGELOG es confiar en que
-- alguien lo lea el día correcto.
update holaamigo.organizations
   set plan = 'starter'
 where plan = 'diagnostico'
   and lifecycle in ('activated','trial','customer');

create or replace function holaamigo.rango_de_plan(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'diagnostico' then 0
    when 'starter'     then 1
    when 'growth'      then 2
    when 'enterprise'  then 3
    else 0
  end
$$;

create or replace function holaamigo.techo_de_plan(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'diagnostico' then 2   -- puede preparar; nada sale
    when 'starter'     then 3   -- ejecuta con visto bueno ítem por ítem
    when 'growth'      then 4   -- ejecuta dentro de sobres
    when 'enterprise'  then 5
    else 2
  end
$$;

-- El dial grueso que ya existía (`agents.autonomy`) sigue vivo y ahora es parte
-- del techo del cliente, en vez de un sistema paralelo que lo contradice.
--
-- **El dial grueso gobierna lo que sale del edificio.** Leer, investigar,
-- puntuar y escribir en objetos propios (el Brief, el CRM, un borrador) no es
-- ejecutar: no toca a ningún tercero y se deshace editando. Sin esta distinción
-- la CMO en `propose` no podría ni mirar el sitio de un competidor.
--
-- `sampled` es la cuarta posición y NO está en el formulario del cliente: es
-- L5, ejecutar sin sobre con auditoría por muestreo, y solo la abre un operador
-- nuestro a mano. Nada se automatiza antes de haberse hecho tres veces a mano
-- (§13.3); cuando lo hayamos hecho tres veces, entra al formulario.
create or replace function holaamigo.techo_de_autonomia(p_autonomy text, p_risk_class text)
returns int language sql immutable as $$
  select case
    when p_risk_class in ('read','write') then 5
    when p_autonomy = 'propose'            then 1
    when p_autonomy = 'approve_each'       then 3
    when p_autonomy = 'auto_within_limits' then 4
    when p_autonomy = 'sampled'            then 5
    else 1
  end
$$;

alter table holaamigo.agents drop constraint if exists agents_autonomy_check;
alter table holaamigo.agents add constraint agents_autonomy_check
  check (autonomy in ('propose','approve_each','auto_within_limits','sampled'));

-- ═══════════════ 2 · EL CATÁLOGO DE CAPACIDADES ═══════════════

create table if not exists holaamigo.capabilities (
  id text primary key,                    -- 'partnership.send_outreach'
  agent_role text not null check (agent_role in ('president','cmo','sales','todos')),
  display_name text not null,
  description text not null,
  -- Lo que lee el cliente al lado del slider. En español simple y diciendo qué
  -- se abre Y qué se arriesga: un control cuyo texto solo vende lo bueno es un
  -- control que se sube sin entender.
  client_explanation text not null,
  risk_class text not null
    check (risk_class in ('read','write','external_comms','spend','irreversible')),
  platform_ceiling int not null check (platform_ceiling between 0 and 5),
  default_level int not null check (default_level between 0 and 5),
  min_plan text not null default 'diagnostico',
  -- Cuántas horas cuesta deshacer esto. `null` = reversible al instante.
  -- El payload puede sobrescribirlo en runtime: mandar 50 correos no se deshace
  -- aunque la capacidad en abstracto sea reversible.
  default_reversibility_hours numeric,
  approval_kind text,                     -- qué tarjeta se crea cuando hace falta
  default_envelope jsonb not null default '{}',
  status text not null default 'active' check (status in ('active','beta','retired')),
  constraint capabilities_default_bajo_techo check (default_level <= platform_ceiling)
);

comment on table holaamigo.capabilities is
  'Catálogo de lo que un agente puede intentar. platform_ceiling NO es negociable por cliente.';

-- ═══════════════ 3 · LO QUE ESTA ORGANIZACIÓN OTORGÓ ═══════════════

create table if not exists holaamigo.capability_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  capability_id text not null references holaamigo.capabilities(id) on delete cascade,
  granted_level int not null check (granted_level between 0 and 5),
  envelope jsonb not null default '{}',
  granted_by text not null,
  granted_by_type text not null check (granted_by_type in ('client','operator','system')),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, capability_id)
);
create index if not exists capability_grants_org_idx
  on holaamigo.capability_grants (organization_id);

-- Subir el techo del cliente por encima del de plataforma no tiene efecto. Se
-- recorta AL ESCRIBIR además de al evaluar, para que la base no guarde un
-- número que miente: si el panel muestra L5 y el motor aplica L3, el cliente
-- cree que autorizó algo que nunca pasó.
create or replace function holaamigo.recortar_grant()
returns trigger language plpgsql as $$
declare v_techo int;
begin
  select platform_ceiling into v_techo
  from holaamigo.capabilities where id = new.capability_id;

  if v_techo is not null and new.granted_level > v_techo then
    new.granted_level := v_techo;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists capability_grants_recorte on holaamigo.capability_grants;
create trigger capability_grants_recorte
  before insert or update on holaamigo.capability_grants
  for each row execute function holaamigo.recortar_grant();

-- ═══════════════ 4 · LA AUDITORÍA ═══════════════
--
-- Cada intento deja fila, se haya permitido o no. Lo que se bloqueó vale tanto
-- como lo que pasó: es la evidencia de que la correa existe, y es de donde sale
-- el conteo de volumen de los sobres.

create table if not exists holaamigo.guard_events (
  id bigserial primary key,
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  agent_id uuid references holaamigo.agents(id) on delete set null,
  capability_id text,
  requested_level int,
  effective_level int,
  verdict text not null check (verdict in ('allowed','downgraded','blocked')),
  reason text,
  envelope_check jsonb not null default '{}',
  payload jsonb not null default '{}',
  decision_id uuid references holaamigo.decisions(id) on delete set null,
  approval_id uuid references holaamigo.approvals(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists guard_events_org_idx
  on holaamigo.guard_events (organization_id, created_at desc);
-- El índice del conteo de volumen: se consulta en CADA autorización de nivel 4.
create index if not exists guard_events_volumen_idx
  on holaamigo.guard_events (organization_id, capability_id, created_at desc);

-- ═══════════════ 5 · LAS TARJETAS Y SU VENCIMIENTO ═══════════════
--
-- Cada tipo de aprobación declara qué pasa cuando el humano no contesta. Sin
-- esto el sistema se congela cuando el cliente está de vacaciones, que es
-- justamente cuando más falta hace que siga funcionando.
--
-- La regla para elegir la acción por defecto: **si no contestar puede hacer
-- daño, se rechaza; si no contestar es lo que hace daño, se aprueba.** Lanzar
-- una campaña sin respuesta es riesgo; dejar corriendo una campaña que está
-- perdiendo plata porque nadie autorizó pausarla también lo es, y peor.

create table if not exists holaamigo.approval_kinds (
  kind text primary key,
  display_name text not null,
  description text,
  sla_minutes int not null,
  on_expiry text not null check (on_expiry in ('approve','reject')),
  severity text not null default 'normal' check (severity in ('low','normal','high'))
);

alter table holaamigo.approvals
  add column if not exists expires_at timestamptz,
  add column if not exists capability_id text,
  add column if not exists decision_id uuid;

create index if not exists approvals_vencimiento_idx
  on holaamigo.approvals (status, expires_at) where status = 'pending';

insert into holaamigo.approval_kinds (kind, display_name, description, sla_minutes, on_expiry, severity) values
  ('angle_new',              'Ángulo nuevo',                'La CMO propone un ángulo para que SALES lo use.',                     2880, 'reject',  'normal'),
  ('campaign_launch',        'Lanzar campaña',              'Sale plata y salen correos a terceros. Sin respuesta, no sale.',      2880, 'reject',  'high'),
  ('budget_change',          'Mover presupuesto',           'Reasignación entre canales.',                                         4320, 'reject',  'normal'),
  ('escalation',             'Escalamiento del President',  'Algo no cierra y hace falta una decisión humana.',                    1440, 'reject',  'high'),
  ('template_submit',        'Plantilla a Meta',            'Enviar plantillas a aprobación de Meta.',                             2880, 'reject',  'low'),
  ('envelope_exceeded',      'Se salió del sobre',          'El agente pidió hacer algo fuera de los límites que le diste.',       1440, 'reject',  'high'),
  ('capability_step',        'Ejecución con visto bueno',   'Nivel 3: cada ítem se aprueba antes de ejecutarse.',                  1440, 'reject',  'normal'),
  ('partnership_outreach',   'Contactar a un partner',      'Primer acercamiento a una empresa. Sin compromisos.',                 2880, 'reject',  'normal'),
  ('pause_losing_campaign',  'Pausar campaña que pierde',   'Sin respuesta se pausa igual: seguir gastando es el daño mayor.',      240, 'approve', 'high'),
  ('pause_agent',            'Pausar un agente',            'Frenar a un agente que se está portando raro.',                        240, 'approve', 'high'),
  ('suppression_add',        'Suprimir contacto',           'Sacar a alguien de todo contacto futuro. Nunca se niega por silencio.', 240, 'approve', 'low'),
  ('skill_request',          'Habilidad nueva',             'Un agente pide una herramienta que hoy no tiene (P6).',               4320, 'reject',  'low')
on conflict (kind) do update set
  display_name = excluded.display_name,
  description  = excluded.description,
  sla_minutes  = excluded.sla_minutes,
  on_expiry    = excluded.on_expiry,
  severity     = excluded.severity;

-- ═══════════════ 6 · EL CATÁLOGO SEMBRADO ═══════════════
--
-- Nuestro, no del cliente: por eso se actualiza en cada corrida de la migración.
-- El ejemplo trabajado del plan —partnerships de la CMO— está completo, y el
-- resto cubre lo que el producto ya ejecuta hoy.
--
-- Léase la columna `platform_ceiling` como "el máximo que este producto va a
-- permitir jamás, para cualquier cliente, en cualquier plan".

insert into holaamigo.capabilities
  (id, agent_role, display_name, description, client_explanation, risk_class,
   platform_ceiling, default_level, min_plan, default_reversibility_hours, approval_kind, default_envelope)
values
  -- ── PRESIDENT ──────────────────────────────────────────────────────────
  ('brief.write', 'president', 'Mantener el Brief',
   'Escribir y versionar el objeto de contexto que leen los tres agentes.',
   'Deja que el President mantenga al día la ficha de tu negocio. No sale nada hacia afuera.',
   'write', 5, 5, 'diagnostico', null, null, '{}'),

  ('plan.propose', 'president', 'Proponer el plan',
   'Priorizar rutas, proponer objetivos y marcar la recomendada.',
   'El President arma la estrategia y te la propone. Decidís vos.',
   'read', 5, 5, 'diagnostico', null, null, '{}'),

  -- Techo de plataforma L2 y no L4, y esto no se negocia con ningún plan: el
  -- agente que razona sobre dinero no toca dinero (§13.1). El President deja la
  -- reasignación preparada con su evidencia; moverla es de un humano. En P4 esa
  -- preparación es un `allocation_proposal` con su deliberación.
  ('budget.shift', 'president', 'Preparar una reasignación de presupuesto',
   'Armar la propuesta de mover inversión entre canales, con evidencia.',
   'El President deja lista la reasignación y te muestra por qué. Mover la plata lo hacés vos: ningún agente nuestro toca dinero.',
   'spend', 2, 2, 'growth', 48, 'budget_change',
   '{"max_amount_usd": 0, "max_shift_pct": 15, "requires_disclosure": true}'),

  ('agent.pause', 'president', 'Pausar a otro agente',
   'Frenar a un agente que se está portando mal.',
   'Deja que el President apague a un agente que se descarriló, sin esperarte.',
   'write', 5, 5, 'diagnostico', null, 'pause_agent', '{}'),

  ('escalate', 'todos', 'Escalar a un humano',
   'Levantar la mano cuando algo no cierra.',
   'Siempre encendido. Un agente nunca pierde la capacidad de pedir ayuda.',
   'read', 5, 5, 'diagnostico', null, 'escalation', '{}'),

  -- ── CMO · investigar es libre ──────────────────────────────────────────
  ('competitor.research', 'cmo', 'Vigilar competidores',
   'Revisar sitios, precios, ofertas de empleo y presencia en medios.',
   'La CMO mira qué hacen tus competidores y te avisa solo cuando algo cambia.',
   'read', 5, 5, 'diagnostico', null, null, '{}'),

  ('angle.propose', 'cmo', 'Proponer ángulos',
   'Generar hipótesis de mensaje con su segmento.',
   'La CMO propone formas nuevas de contar lo que vendés. Vos aprobás cuáles se usan.',
   'read', 5, 5, 'diagnostico', null, 'angle_new', '{}'),

  ('angle.activate', 'cmo', 'Activar un ángulo',
   'Dejar un ángulo disponible para que SALES lo use en campañas.',
   'Deja que la CMO habilite ángulos nuevos sin tu visto bueno. Lo que se envía sigue pasando por vos.',
   'write', 4, 3, 'starter', null, 'angle_new', '{"max_volume_per_week": 3}'),

  ('content.draft', 'cmo', 'Redactar contenido',
   'Escribir piezas, guiones y borradores de caso de estudio.',
   'La CMO escribe. Nada se publica: quedan borradores para que los revises.',
   'write', 5, 4, 'diagnostico', null, null, '{}'),

  ('content.publish', 'cmo', 'Publicar contenido',
   'Publicar una pieza en un canal público a nombre de la marca.',
   'Lo que se publica a nombre de tu marca no se puede despublicar de verdad. Por eso este control no pasa de "preparar".',
   'irreversible', 2, 2, 'growth', 720, 'capability_step', '{}'),

  -- ── CMO · partnerships: el ejemplo trabajado del plan ──────────────────
  ('partnership.research', 'cmo', 'Buscar partners',
   'Identificar y perfilar empresas candidatas a alianza.',
   'La CMO busca empresas con las que valdría la pena aliarse. Solo mira y arma la lista.',
   'read', 5, 5, 'diagnostico', null, null, '{}'),

  ('partnership.score', 'cmo', 'Puntuar partners',
   'Rankear candidatos por encaje estratégico.',
   'Ordena los candidatos por qué tanto sentido tienen para tu negocio.',
   'read', 5, 5, 'diagnostico', null, null, '{}'),

  ('partnership.draft_outreach', 'cmo', 'Redactar el primer contacto',
   'Escribir el correo de acercamiento, sin enviarlo.',
   'La CMO deja escrito el mensaje para cada candidato. No se envía nada todavía.',
   'write', 4, 2, 'diagnostico', null, null, '{}'),

  ('partnership.send_outreach', 'cmo', 'Contactar partners',
   'Enviar el primer acercamiento a una empresa candidata.',
   'Deja que la CMO escriba a empresas candidatas por su cuenta. Nunca promete plata, exclusividad ni uso de tu marca, y como máximo escribe a 10 por semana.',
   'external_comms', 4, 3, 'starter', 72, 'partnership_outreach',
   '{"max_amount_usd": 0, "max_volume_per_week": 10, "forbidden_commitments": ["exclusividad","uso_de_marca","descuento","plazo_mayor_90d","precio_cerrado"], "forbidden_counterparties": ["competidores_directos","lista_negra_cliente"], "requires_disclosure": true}'),

  ('partnership.negotiate', 'cmo', 'Preparar un term sheet',
   'Armar los términos de una alianza. NUNCA enviarlos.',
   'La CMO prepara la propuesta de acuerdo para que la leas. Enviarla es tuyo, siempre.',
   'irreversible', 2, 2, 'growth', 720, 'capability_step', '{}'),

  ('partnership.commit', 'cmo', 'Firmar una alianza',
   'Comprometer marca, dinero o exclusividad.',
   'Ningún agente firma nada a tu nombre. Este control existe para que veas que está apagado y no se puede encender.',
   'irreversible', 0, 0, 'enterprise', null, null, '{}'),

  -- ── SALES · comunicar es acotado ───────────────────────────────────────
  ('lead.qualify', 'sales', 'Calificar leads',
   'Leer respuestas y clasificar intención.',
   'SALES lee lo que contestan y los ordena por interés real.',
   'read', 5, 5, 'diagnostico', null, null, '{}'),

  ('outreach.send_email', 'sales', 'Enviar correo',
   'Mandar un correo de campaña a un contacto.',
   'Un correo enviado no se puede retirar. Con el sobre activado, SALES envía dentro de los topes que le pongas y te reporta.',
   'external_comms', 4, 3, 'starter', 72, 'campaign_launch',
   '{"max_volume_per_day": 300, "requires_disclosure": true, "forbidden_commitments": ["descuento","precio_cerrado","garantia_de_resultados"]}'),

  ('outreach.send_whatsapp', 'sales', 'Enviar WhatsApp',
   'Mandar un mensaje de WhatsApp a un contacto.',
   'Igual que el correo, pero llega al teléfono. Los topes valen doble acá.',
   'external_comms', 4, 3, 'starter', 72, 'campaign_launch',
   '{"max_volume_per_day": 200, "requires_disclosure": true}'),

  ('outreach.reply', 'sales', 'Responder inbound',
   'Contestarle a alguien que escribió primero.',
   'Contestar a quien te escribió es lo menos riesgoso que hace un agente, y lo que más se nota si no pasa.',
   'external_comms', 5, 4, 'diagnostico', 24, null,
   '{"max_volume_per_day": 200, "requires_disclosure": true}'),

  ('campaign.launch', 'sales', 'Lanzar una campaña',
   'Activar una secuencia completa contra un segmento.',
   'Lanzar una campaña compromete envíos, créditos y la reputación de tu dominio de una sola vez.',
   'irreversible', 3, 3, 'starter', 72, 'campaign_launch', '{}'),

  ('meeting.book', 'sales', 'Agendar reuniones',
   'Poner una cita en la agenda con un interesado.',
   'La cita queda puesta sin que nadie intervenga. Se puede cancelar, así que el riesgo es bajo.',
   'write', 4, 4, 'diagnostico', 24, null, '{"max_volume_per_day": 20}'),

  ('suppression.add', 'sales', 'Suprimir un contacto',
   'Sacar a alguien de todo contacto futuro.',
   'Siempre encendido. Cuando alguien pide que no le escriban más, no hace falta autorizar nada.',
   'write', 5, 5, 'diagnostico', null, 'suppression_add', '{}'),

  ('price.quote', 'sales', 'Cotizar un precio',
   'Decir un precio concreto a un prospecto.',
   'SALES puede preparar la cotización, pero el precio que sale por escrito lo confirmás vos.',
   'irreversible', 2, 2, 'growth', 168, 'capability_step', '{}'),

  ('crm.write', 'sales', 'Escribir en el CRM',
   'Actualizar etapas, notas y oportunidades.',
   'SALES mantiene el pipeline al día solo. Todo queda con su rastro.',
   'write', 5, 4, 'starter', null, null, '{}'),

  -- ── Transversal (P6) ───────────────────────────────────────────────────
  ('skill.request', 'todos', 'Pedir una habilidad nueva',
   'Un agente pide una herramienta que hoy no tiene.',
   'Siempre encendido. El agente pide; nosotros decidimos si esa herramienta existe.',
   'read', 5, 5, 'diagnostico', null, 'skill_request', '{}')

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

-- Si en esta corrida bajamos un techo de plataforma, los grants que quedaron por
-- encima se recortan. Sin esta línea, bajar un techo no tendría efecto sobre
-- quien ya lo tenía otorgado — que es justamente el caso en el que urge.
update holaamigo.capability_grants g
   set granted_level = c.platform_ceiling
  from holaamigo.capabilities c
 where g.capability_id = c.id
   and g.granted_level > c.platform_ceiling;

-- ═══════════════ 7 · EL MOTOR DE PERMISOS ═══════════════
--
-- Una sola función, llamada antes de cada acción. Está en SQL y no en
-- TypeScript por tres razones, en orden de importancia:
--
--   1. Es imposible de saltar. Una función de aplicación se puede olvidar en el
--      llamador nuevo; una que además ESCRIBE la auditoría deja hueco visible.
--   2. El conteo de volumen del sobre es una consulta. En TypeScript serían dos
--      viajes a la base con una carrera en el medio.
--   3. Se prueba contra Postgres real en PGlite, como todo lo demás del plan.
--
-- Devuelve jsonb y no una fila porque el resultado es un objeto con listas
-- adentro, y porque el llamador de TypeScript lo consume tal cual.
--
-- FALLA CERRADO: capacidad desconocida → bloqueado. Es lo contrario de lo
-- cómodo y es lo correcto: un `capability_id` mal escrito no puede convertirse
-- en permiso total.

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
    else holaamigo.techo_de_plan(v_plan)
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

-- ═══════════════ 8 · EL VENCIMIENTO DE LAS TARJETAS ═══════════════
--
-- Corre en el barrido de cada 2 minutos. Aplica lo que declaró el tipo de
-- aprobación: fail-safe para lo que puede hacer daño, fail-open para lo que
-- hace daño NO haciéndose.

create or replace function holaamigo.expirar_aprobaciones()
returns jsonb
language plpgsql
as $$
declare
  v_aprobadas int := 0;
  v_rechazadas int := 0;
begin
  update holaamigo.approvals a
     set status = 'approved',
         decided_by = 'sistema:sla',
         decided_at = now(),
         decision_note = format('Nadie respondió en %s minutos. Este tipo se aprueba solo: no hacerlo hace más daño que hacerlo.', k.sla_minutes)
    from holaamigo.approval_kinds k
   where a.kind = k.kind
     and a.status = 'pending'
     and a.expires_at is not null
     and a.expires_at <= now()
     and k.on_expiry = 'approve';
  get diagnostics v_aprobadas = row_count;

  update holaamigo.approvals a
     set status = 'expired',
         decided_by = 'sistema:sla',
         decided_at = now(),
         decision_note = format('Nadie respondió en %s minutos. Este tipo se rechaza solo: sin respuesta no se ejecuta.', k.sla_minutes)
    from holaamigo.approval_kinds k
   where a.kind = k.kind
     and a.status = 'pending'
     and a.expires_at is not null
     and a.expires_at <= now()
     and k.on_expiry = 'reject';
  get diagnostics v_rechazadas = row_count;

  return jsonb_build_object('aprobadas', v_aprobadas, 'rechazadas', v_rechazadas);
end $$;

-- ═══════════════ 9 · RLS Y GRANTS ═══════════════

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'holaamigo'
      and tablename in ('capabilities','capability_grants','guard_events','approval_kinds')
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
-- select holaamigo.autorizar('<org>'::uuid, 'partnership.commit');
--   → {"verdict":"blocked","effective_level":0,...}   siempre, sin excepción
--
-- select count(*) from holaamigo.capabilities;   → 25
-- select holaamigo.expirar_aprobaciones();       → {"aprobadas":0,"rechazadas":0}
