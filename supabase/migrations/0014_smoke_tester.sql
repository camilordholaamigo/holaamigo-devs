-- ═══════════════════════════════════════════════════════════════════════════
-- 0014 · El smoke tester: probarle la línea al cliente antes de venderle nada
--
-- El diagnóstico le dice al cliente cuánta plata se le está yendo. Se lo dice
-- con aritmética honesta sobre supuestos que él puede mover, y aun así es una
-- proyección. Esto es otra cosa: le escribimos a SU número de WhatsApp, desde
-- el nuestro, como si fuéramos un cliente, y le contamos qué pasó.
--
-- «Le escribimos a tu línea de ventas a las 2:03. Contestaron a las 2:19.
--  Dieciséis minutos.» Ese renglón no es una proyección. Es un hecho con hora.
--
-- CUATRO DECISIONES QUE EXPLICAN CASI TODO EL ARCHIVO:
--
--   1. `smoke_probes.target_phone` está DENORMALIZADO a propósito. El webhook
--      correlaciona un mensaje entrante contra la conversación que lo espera,
--      y para eso necesita el número sin hacer un join. El paquete del que
--      viene esto correlacionaba contra «el run activo más reciente» y esa
--      decisión le costó no poder correr dos pruebas a la vez nunca. Acá se
--      arregla desde el diseño, no como deuda.
--
--   2. `turno` y `turn_token` son COLUMNAS, no claves de un jsonb. El original
--      las guardaba adentro de `form_data` y las escribía con leer-modificar-
--      escribir; dos webhooks simultáneos se pisaban. Como columna, reclamar
--      un turno es un `update … where turn_token = $viejo`, que es atómico.
--
--   3. `segundos_primera_respuesta` es una columna que escribe el CÓDIGO desde
--      dos timestamps. Es la cifra que el cliente lee, y ninguna cifra que el
--      cliente lee sale de un modelo (ADR 0007). El modelo escribe la frase
--      que la acompaña; el número lo resta Postgres o lo resta TypeScript.
--
--   4. Las plantillas se siembran con `on conflict do nothing`, no con
--      `do update`. Son editables desde el admin y la migración se corre a
--      mano más de una vez: un `do update` le borraría al equipo el texto que
--      acaba de ajustar. La semilla existe para que un proyecto vacío arranque
--      con las tres pruebas, no para imponerlas.
--
-- Ver docs/adr/0025-el-smoke-tester-como-evidencia.md
--
-- Idempotente. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 0 · LO QUE TIENE QUE ESTAR ANTES ═══════════════
--
-- Depende de `0001_init.sql` (organizations, intake_sessions) y de
-- `0007_gobierno.sql` (el catálogo de capacidades, donde se registra
-- `smoketest.probe`). Falla acá, antes de crear nada, y dice qué correr.

do $$
declare
  v_faltan text[] := '{}';
begin
  if to_regclass('holaamigo.organizations') is null then
    v_faltan := v_faltan || '0001_init.sql (organizations, intake_sessions)'::text;
  end if;
  if to_regclass('holaamigo.capabilities') is null then
    v_faltan := v_faltan || '0007_gobierno.sql (capabilities)'::text;
  end if;

  if array_length(v_faltan, 1) > 0 then
    raise exception
      E'0014 no se puede aplicar todavía: falta correr % antes.\n\n'
      'El orden es 0001 → 0002 → … → 0013_agente_de_agendamiento.sql → 0014_smoke_tester.sql.\n'
      'Todas son idempotentes: si alguna ya corrió, correrla de nuevo no hace daño.',
      array_to_string(v_faltan, ' y ');
  end if;
end $$;

-- ═══════════════ 1 · NUESTRAS LÍNEAS ═══════════════
--
-- Desde dónde escribimos. Es configuración operativa, no código: el número y
-- su identificador en Callbell cambian sin que cambie una línea del producto,
-- y quien los cambia es alguien del equipo comercial desde /admin/pruebas.
-- Por eso viven en una tabla y no en variables de entorno. La llave de la API
-- sí es una variable de entorno: eso es un secreto, esto es un dato.

create table if not exists holaamigo.smoke_channels (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  label text not null,
  provider text not null default 'callbell' check (provider in ('callbell')),
  -- El número desde el que escribe el comprador sintético. En E.164.
  phone_e164 text not null,
  -- El identificador del canal en el proveedor. En Callbell es el
  -- `channel_uuid` que va en el cuerpo del POST /messages/send.
  channel_uuid text not null,
  -- Si el canal es WhatsApp Business API oficial, el primer mensaje a un
  -- número con el que no hay conversación abierta tiene que ser una plantilla
  -- aprobada por Meta. Con la línea por QR esto queda en null y se abre con
  -- texto libre.
  template_uuid text,
  activo boolean not null default true,
  notas text
);

-- Clave plana: un canal por identificador de proveedor. Sin `where` y sin
-- funciones, para que sirva de árbitro en un upsert (ADR 0015).
create unique index if not exists smoke_channels_provider_key
  on holaamigo.smoke_channels (provider, channel_uuid);

comment on table holaamigo.smoke_channels is
  'Desde dónde escribe el smoke tester. Editable en caliente desde /admin/pruebas.';

-- ═══════════════ 2 · LAS PLANTILLAS DE PRUEBA ═══════════════
--
-- La estructura general de cada tipo de prueba. Lo que NO depende del cliente:
-- qué quiere medir, con qué identidad se escribe, cuándo se da por terminada,
-- y el esqueleto de la rúbrica con que se califica.
--
-- Lo que sí depende del cliente —qué producto nombrar, qué evento preguntar,
-- qué precio está publicado y por lo tanto tiene que decir bien— lo agrega el
-- compilador leyendo el research. Ver lib/pruebas/compilar.ts.

create table if not exists holaamigo.smoke_templates (
  -- Slug estable: 'servicio', 'faq', 'ventas', y los que agregue el equipo.
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  nombre text not null,
  -- Para el admin: para qué sirve esta prueba.
  descripcion text not null default '',
  -- Para el cliente: la frase que explica qué se midió. Va en el diagnóstico.
  que_mide text not null default '',
  -- A dónde tiene que llegar el comprador sintético. Es la palanca principal:
  -- cambiarlo cambia toda la prueba.
  objetivo text not null,
  -- Identidad fija del comprador. Si el negocio pide el correo tres veces,
  -- recibe el mismo correo tres veces — es lo que hace verificable la prueba.
  persona jsonb not null default '{}',
  -- El primer mensaje. Admite {negocio}, {producto}, {ciudad}.
  apertura text not null,
  -- Las preguntas base: [{id, pregunta, por_que}]. El compilador les suma las
  -- que salen del research y les pone el contexto real.
  sondas jsonb not null default '[]',
  -- El esqueleto de la calificación: [{id, dimension, criterio, peso, chequeo}].
  --
  -- `chequeo` es un mini-lenguaje de una línea que el compilador resuelve
  -- contra la ficha de verdad. Es editable desde el admin justamente porque la
  -- alternativa —un mapa de ids conocidos escondido en TypeScript— haría que
  -- agregar un criterio nuevo exija un despliegue.
  --
  --   hubo_respuesta            ¿contestaron algo?
  --   respondio_antes_de:300    ¿en menos de N segundos?
  --   dio_precio                ¿dijeron alguna cifra de dinero?
  --   propuso_paso_siguiente    ¿ofrecieron cita, visita, llamada o cotización?
  --   pregunto_al_menos:1       ¿preguntaron algo de vuelta?
  --   menciona:<clave>          ¿dijeron lo que la ficha dice en esa clave?
  --   no_menciona:a,b,c         ¿evitaron estas palabras?
  --
  -- Un `chequeo` en null, o uno que apunte a una clave que la ficha no tiene,
  -- deja el criterio para la capa 3. Es la respuesta honesta: no se pudo
  -- verificar solo, no «no cumplió».
  rubrica jsonb not null default '[]',
  -- Cuándo el comprador da la conversación por terminada. text[].
  criterios_cierre jsonb not null default '[]',
  max_turnos int not null default 10 check (max_turnos between 2 and 40),
  activo boolean not null default true,
  -- Marca las tres que trae el producto. Permite distinguir en la UI lo que
  -- vino de fábrica de lo que escribió el equipo, sin impedir editar ninguna.
  es_semilla boolean not null default false
);

comment on table holaamigo.smoke_templates is
  'La estructura general de cada tipo de prueba. El research la complementa; no la reemplaza.';

-- ═══════════════ 3 · A QUIÉN LE ESCRIBIMOS ═══════════════

create table if not exists holaamigo.smoke_targets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null cuando el admin crea una prueba suelta, sin diagnóstico detrás.
  organization_id uuid references holaamigo.organizations(id) on delete set null,
  nombre text,
  phone_e164 text not null,
  origen text not null default 'research' check (origen in ('research', 'manual')),
  -- De dónde salió el número. Toda afirmación sobre el negocio del cliente
  -- lleva fuente o se marca como inferida (§13.4), y «este es tu WhatsApp de
  -- ventas» es una afirmación sobre su negocio.
  source_url text,
  confianza numeric check (confianza between 0 and 1),
  -- Enfriamiento: no le volvemos a escribir al mismo número todos los días
  -- porque alguien recargó la landing. Lo consulta lib/pruebas/lanzar.ts.
  ultima_prueba_at timestamptz,
  -- Si el negocio pidió que no le escribamos más, se apaga acá y no hay
  -- camino que lo vuelva a prender solo.
  bloqueado boolean not null default false,
  bloqueado_motivo text
);

-- Un número, una fila. Clave plana y global —no por organización— a propósito:
-- el enfriamiento y el bloqueo tienen que valer aunque el mismo número aparezca
-- en el sitio de dos organizaciones distintas.
create unique index if not exists smoke_targets_phone_key
  on holaamigo.smoke_targets (phone_e164);
create index if not exists smoke_targets_org_idx
  on holaamigo.smoke_targets (organization_id, created_at desc);

-- ═══════════════ 4 · LA CORRIDA ═══════════════

create table if not exists holaamigo.smoke_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid references holaamigo.organizations(id) on delete cascade,
  session_id uuid references holaamigo.intake_sessions(id) on delete set null,
  origen text not null default 'diagnostico' check (origen in ('diagnostico', 'manual')),
  estado text not null default 'running'
    check (estado in ('running', 'done', 'cancelled')),
  -- [{t, step, detail}] — mismo formato que research_runs.progress_log, y por
  -- la misma razón: el cliente lo lee en vivo y cada línea corresponde a algo
  -- que de verdad pasó (ADR 0023).
  progress_log jsonb not null default '[]',
  finished_at timestamptz
);
create index if not exists smoke_runs_org_idx
  on holaamigo.smoke_runs (organization_id, created_at desc);
create index if not exists smoke_runs_estado_idx
  on holaamigo.smoke_runs (estado, created_at desc);

-- ═══════════════ 5 · LA CONVERSACIÓN ═══════════════
--
-- Una fila = una conversación completa contra un número, con una plantilla.
-- Trae la transcripción, el estado terminal, la auditoría y la evaluación.

create table if not exists holaamigo.smoke_probes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid not null references holaamigo.smoke_runs(id) on delete cascade,
  target_id uuid not null references holaamigo.smoke_targets(id) on delete cascade,
  template_id text not null references holaamigo.smoke_templates(id),
  channel_id uuid not null references holaamigo.smoke_channels(id),

  -- Denormalizado desde el run, y no por comodidad: cada turno hace una llamada
  -- al modelo y `runStructured` imputa el costo a la organización que recibe.
  -- Sin esta columna, el motor tendría que hacer un join contra `smoke_runs` en
  -- cada turno solo para saber a quién cobrarle — o, peor, pasar null y dejar
  -- todo el gasto del smoke tester sin imputar. Null en las pruebas manuales
  -- que no tienen organización detrás.
  organization_id uuid references holaamigo.organizations(id) on delete set null,

  -- Denormalizado. Ver decisión 1 del encabezado.
  target_phone text not null,

  -- El test compilado: objetivo instanciado, sondas con el contexto real,
  -- ficha de verdad con fuentes, y la rúbrica con sus chequeos. Es al smoke
  -- tester lo que el playbook es al agente de agendamiento: datos, no prompt.
  plan jsonb not null default '{}',

  -- [{role: 'comprador'|'negocio', text, timestamp}]. Formato canónico y nada
  -- más adentro: el paquete original sobrevivió tres rediseños sin cambiarlo,
  -- y meterle metadata al array habría sido la muerte.
  conversation jsonb not null default '[]',

  estado text not null default 'pending'
    check (estado in ('pending', 'running', 'completed', 'timeout', 'failed', 'cancelled')),
  -- El veredicto de negocio, separado de la salud técnica de la corrida.
  cerro_con text
    check (cerro_con in ('agendado', 'cotizacion', 'objetivo_cumplido',
                         'incompleto', 'sin_respuesta', 'bloqueado')),

  turno int not null default 0,
  max_turnos int not null default 10,
  -- Guarda de concurrencia. Columna propia para poder reclamarla con un
  -- update condicional, que es atómico. Ver decisión 2 del encabezado.
  turn_token text,
  awaiting_reply boolean not null default false,

  enviado_at timestamptz,
  primera_respuesta_at timestamptz,
  -- Lo escribe el código restando los dos timestamps de arriba. Ver decisión 3.
  segundos_primera_respuesta int,
  ultimo_entrante_at timestamptz,

  -- Capa 2 · auditoría determinística contra la rúbrica compilada.
  auditoria jsonb,
  auditoria_score int check (auditoria_score between 0 and 100),
  -- Capa 3 · evaluación con modelo, contra la ficha de verdad.
  evaluacion jsonb,
  evaluacion_score int check (evaluacion_score between 0 and 100),
  -- Dos columnas y no una: el auditor escribe al cerrar y el evaluador
  -- califica después. Con una sola, el segundo pisa al primero y se pierde
  -- la única de las dos que es determinística.

  motivo_cierre text,
  error text,
  provider_message_id text,

  finished_at timestamptz
);

-- El webhook busca «la conversación que espera respuesta de este número» en
-- cada mensaje entrante. Casi todas las filas tienen awaiting_reply = false;
-- indexar solo las true mantiene esa búsqueda en O(conversaciones activas).
create index if not exists smoke_probes_awaiting_idx
  on holaamigo.smoke_probes (awaiting_reply) where awaiting_reply;
create index if not exists smoke_probes_awaiting_phone_idx
  on holaamigo.smoke_probes (target_phone) where awaiting_reply;
create index if not exists smoke_probes_run_idx
  on holaamigo.smoke_probes (run_id, created_at);
create index if not exists smoke_probes_vivas_idx
  on holaamigo.smoke_probes (estado, updated_at)
  where estado in ('pending', 'running');
create index if not exists smoke_probes_target_idx
  on holaamigo.smoke_probes (target_id, created_at desc);
create index if not exists smoke_probes_org_idx
  on holaamigo.smoke_probes (organization_id, created_at desc);

comment on table holaamigo.smoke_probes is
  'Una conversación de prueba contra un número real. Transcripción + veredicto.';

-- ═══════════════ 6 · updated_at ═══════════════
--
-- El watchdog necesita saber cuándo fue la última actividad de una prueba. En
-- el paquete original esa columna no existía y había que inferirla desde el
-- último mensaje del comprador — frágil, y le costó un caso entero de
-- recuperación. Acá está desde el principio.

create or replace function holaamigo.tocar_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['smoke_channels', 'smoke_templates', 'smoke_targets',
                           'smoke_runs', 'smoke_probes']
  loop
    execute format(
      'drop trigger if exists %I on holaamigo.%I',
      't_' || t || '_updated_at', t);
    execute format(
      'create trigger %I before update on holaamigo.%I
         for each row execute function holaamigo.tocar_updated_at()',
      't_' || t || '_updated_at', t);
  end loop;
end $$;

-- ═══════════════ 7 · LAS TRES PRUEBAS DE FÁBRICA ═══════════════
--
-- `do nothing` y no `do update`: ver decisión 4 del encabezado.

insert into holaamigo.smoke_templates
  (id, nombre, descripcion, que_mide, objetivo, persona, apertura,
   sondas, rubrica, criterios_cierre, max_turnos, es_semilla)
values
  -- ── 1 · Servicio al cliente ────────────────────────────────────────────
  --
  -- La prueba más barata y la que más vende. Con un solo turno ya produce el
  -- dato que el cliente no puede discutir: cuánto tardaron en contestar.
  ('servicio',
   'Servicio al cliente',
   'Un cliente escribe con una duda sencilla. Mide si contestan, en cuánto, y si la respuesta sirve.',
   'Le escribimos como un cliente con una duda simple y medimos cuánto tardaron en responder.',
   'Obtener una respuesta útil a una duda sencilla y confirmar el horario de atención.',
   '{"nombre": "Camila Restrepo", "correo": "camila.restrepo.pruebas@gmail.com", "telefono": "3054182637", "ciudad": "Bogotá"}',
   'Hola, buenas. Vi {negocio} y quería preguntar una cosa 🙂',
   '[{"id": "responde", "pregunta": "¿Todavía atienden?", "por_que": "Es la pregunta que hace un cliente real antes de cualquier otra."},
     {"id": "horario", "pregunta": "¿Cuál es el horario de atención?", "por_que": "Un dato que tiene que estar y que se puede verificar contra el sitio."},
     {"id": "humano", "pregunta": "¿Con quién estoy hablando?", "por_que": "Distingue entre un bot que no se identifica y una persona."}]',
   '[{"id": "contesto", "dimension": "respuesta", "criterio": "Contestaron algo", "peso": 3, "chequeo": "hubo_respuesta"},
     {"id": "tiempo", "dimension": "respuesta", "criterio": "Contestaron en menos de 5 minutos", "peso": 3, "chequeo": "respondio_antes_de:300"},
     {"id": "utilidad", "dimension": "contenido", "criterio": "La respuesta resuelve la duda, no la esquiva", "peso": 2, "chequeo": null},
     {"id": "horario_correcto", "dimension": "exactitud", "criterio": "El horario que dijeron coincide con el del sitio", "peso": 2, "chequeo": "menciona:horario"},
     {"id": "cierre", "dimension": "iniciativa", "criterio": "Preguntaron algo de vuelta o propusieron un paso siguiente", "peso": 2, "chequeo": "pregunto_al_menos:1"}]',
   '["Contestaron la duda y dijeron el horario",
     "Dijeron que un humano se contacta después y no hay nada más que hacer",
     "La conversación empezó a dar vueltas"]',
   8, true),

  -- ── 2 · Preguntas frecuentes ───────────────────────────────────────────
  --
  -- Acá es donde el research se paga solo: las preguntas salen del sitio del
  -- cliente, así que la respuesta correcta es verificable palabra por palabra.
  ('faq',
   'Preguntas frecuentes',
   'Un cliente hace tres o cuatro preguntas puntuales que el sitio ya responde. Mide si la línea sabe lo que dice el sitio.',
   'Le hicimos las preguntas que tu propio sitio ya responde, para ver si tu línea contesta lo mismo.',
   'Hacer las preguntas puntuales del negocio y verificar que las respuestas coincidan con lo publicado.',
   '{"nombre": "Camila Restrepo", "correo": "camila.restrepo.pruebas@gmail.com", "telefono": "3054182637", "ciudad": "Bogotá"}',
   'Hola 👋 Estaba viendo {negocio} y tengo unas dudas, ¿me pueden ayudar?',
   '[{"id": "cobertura", "pregunta": "¿Dónde atienden / a dónde llegan?", "por_que": "Es la primera objeción real de cualquier servicio."},
     {"id": "precio", "pregunta": "¿Cuánto cuesta?", "por_que": "Si el sitio publica precio, la línea tiene que decir el mismo."},
     {"id": "tiempos", "pregunta": "¿Cuánto se demora?", "por_que": "Segunda objeción más común y la que más se improvisa."}]',
   '[{"id": "contesto", "dimension": "respuesta", "criterio": "Contestaron algo", "peso": 3, "chequeo": "hubo_respuesta"},
     {"id": "precio_coincide", "dimension": "exactitud", "criterio": "El precio que dijeron coincide con el publicado", "peso": 4, "chequeo": "menciona:precio"},
     {"id": "cobertura_coincide", "dimension": "exactitud", "criterio": "La cobertura que dijeron coincide con la publicada", "peso": 3, "chequeo": "menciona:cobertura"},
     {"id": "sin_inventar", "dimension": "exactitud", "criterio": "No inventó ningún dato que no esté en el sitio", "peso": 4, "chequeo": null},
     {"id": "completitud", "dimension": "contenido", "criterio": "Contestó todas las preguntas, no solo la última", "peso": 2, "chequeo": null},
     {"id": "tiempo", "dimension": "respuesta", "criterio": "Contestaron en menos de 5 minutos", "peso": 2, "chequeo": "respondio_antes_de:300"}]',
   '["Contestaron todas las preguntas",
     "Dijeron que no manejan esa información y remitieron a otro lado",
     "La conversación empezó a dar vueltas"]',
   10, true),

  -- ── 3 · Ventas ─────────────────────────────────────────────────────────
  --
  -- La prueba cara y la que más duele leer: un comprador con plata y con
  -- intención, a ver si alguien lo agarra.
  ('ventas',
   'Ventas',
   'Un comprador con intención real empuja hasta pedir cita o cotización. Mide si la línea cierra o deja la venta en el aire.',
   'Le escribimos como un comprador listo para comprar y vimos hasta dónde llegó la conversación.',
   'Conocer la oferta y sus precios, y terminar con una cita agendada con fecha y hora, o con una cotización enviada.',
   '{"nombre": "Camila Restrepo", "correo": "camila.restrepo.pruebas@gmail.com", "telefono": "3054182637", "ciudad": "Bogotá", "presupuesto": "el que haga falta, dentro de lo razonable"}',
   'Hola, buenas. Estoy interesada en {producto}, ¿me puedes dar información?',
   '[{"id": "oferta", "pregunta": "¿Qué opciones manejan?", "por_que": "Un vendedor que no enumera opciones no está vendiendo, está atendiendo."},
     {"id": "precio", "pregunta": "¿Cuánto vale?", "por_que": "El momento donde se cae la mitad de las conversaciones."},
     {"id": "siguiente_paso", "pregunta": "¿Cómo seguimos?", "por_que": "Si el negocio no propone el paso siguiente, no hay venta."},
     {"id": "cita", "pregunta": "¿Cuándo nos podemos ver / cuándo me mandan la cotización?", "por_que": "El cierre. Es lo único que convierte una charla en plata."}]',
   '[{"id": "contesto", "dimension": "respuesta", "criterio": "Contestaron algo", "peso": 3, "chequeo": "hubo_respuesta"},
     {"id": "califico", "dimension": "proceso", "criterio": "Preguntó algo para calificar antes de cotizar", "peso": 2, "chequeo": "pregunto_al_menos:2"},
     {"id": "dio_precio", "dimension": "contenido", "criterio": "Dio un precio o un rango, o explicó por qué no puede", "peso": 3, "chequeo": "dio_precio"},
     {"id": "propuso", "dimension": "iniciativa", "criterio": "Propuso el paso siguiente sin que se lo pidieran", "peso": 3, "chequeo": "propuso_paso_siguiente"},
     {"id": "cerro", "dimension": "cierre", "criterio": "Llegó a una cita con fecha y hora, o a una cotización", "peso": 4, "chequeo": null},
     {"id": "tiempo", "dimension": "respuesta", "criterio": "Contestaron en menos de 5 minutos", "peso": 2, "chequeo": "respondio_antes_de:300"},
     {"id": "sin_inventar", "dimension": "exactitud", "criterio": "No inventó precios ni condiciones que no estén publicadas", "peso": 3, "chequeo": null}]',
   '["El negocio confirmó una cita con fecha y hora",
     "El negocio dijo que envía la cotización y pidió los datos para hacerlo",
     "El negocio dijo que un humano se contacta después y no hay nada más que hacer",
     "La conversación empezó a dar vueltas"]',
   14, true)
on conflict (id) do nothing;

-- ═══════════════ 8 · LA LÍNEA DE CALLBELL ═══════════════
--
-- Se siembra la que ya está operativa para que un proyecto recién migrado
-- pueda probar sin pasar antes por el admin. `do nothing` por la misma razón
-- que las plantillas: el número y el canal se editan desde /admin/pruebas y
-- una migración corrida dos veces no puede revertir ese cambio.

insert into holaamigo.smoke_channels
  (label, provider, phone_e164, channel_uuid, activo, notas)
values
  ('Callbell · línea de pruebas', 'callbell', '+573054182637',
   '124902a5f0fa43289fe1fa7a4c23fe0d', true,
   'Línea conectada por QR. Abre conversación con texto libre; no requiere plantilla de Meta.')
on conflict (provider, channel_uuid) do nothing;

-- ═══════════════ 9 · LA CAPACIDAD ═══════════════
--
-- Escribirle por WhatsApp a un negocio que no nos escribió primero es
-- `external_comms`, y lo que es external_comms pasa por el catálogo o no
-- pasa (ADR 0018). Acá sí se usa `do update`: el catálogo es NUESTRO, no del
-- cliente, y se actualiza en cada corrida como el resto de las filas de 0007.
--
-- Techo de plataforma 4 y no 5: el smoke tester manda mensajes reales desde
-- nuestro número, y un número quemado por Meta no se recupera con un rollback.
-- L4 significa que puede ejecutar sin aprobación previa pero queda registrado
-- y es reversible dentro de la ventana; L5 sería «hacelo y ni lo cuentes».
--
-- OJO: la `risk_class` de acá está MAL y `0016` la corrige a `self_outreach`.
-- Se deja como estaba porque en este punto de la historia esa clase todavía no
-- existe y el CHECK la rechazaría. Con `external_comms`, el plan del prospecto
-- y la autonomía de sus agentes dejaban la capacidad en nivel 1 — o sea
-- inalcanzable en el único escenario donde se usa. Ver el encabezado de 0016.

insert into holaamigo.capabilities
  (id, agent_role, display_name, description, client_explanation, risk_class,
   platform_ceiling, default_level, min_plan, default_reversibility_hours,
   approval_kind, default_envelope)
values
  ('smoketest.probe', 'cmo', 'Probarle la línea a un prospecto',
   'Escribirle por WhatsApp al número publicado de un negocio, como comprador sintético, y calificar la conversación.',
   'Le escribimos a tu propia línea como si fuéramos un cliente, para mostrarte qué pasa cuando alguien te busca. Nunca le escribimos a tus clientes.',
   'external_comms', 4, 4, 'diagnostico', 24, null,
   '{"max_numeros_por_organizacion": 3, "max_pruebas_por_numero_por_dia": 3, "enfriamiento_horas": 72}')
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
  default_envelope = excluded.default_envelope;

-- ═══════════════ 10 · EL RESUMEN QUE DECIDE ═══════════════
--
-- La agregación vive en SQL y no en el render, por las tres razones de
-- ADR 0023: se puede probar, deja la página tonta, y son percentiles que
-- Postgres ya sabe hacer.
--
-- Cada columna cambia una decisión:
--   contestaron / enviadas       → ¿el canal sirve o estamos hablando solos?
--   mediana_segundos             → la cifra que se le dice al cliente
--   sin_respuesta                → cuántos prospectos tienen la línea muerta
--   score                        → contra qué plantilla comparar la próxima

create or replace function holaamigo.resumen_de_pruebas(p_desde timestamptz)
returns table (
  template_id text,
  enviadas bigint,
  contestaron bigint,
  sin_respuesta bigint,
  mediana_segundos int,
  p90_segundos int,
  auditoria_promedio numeric,
  evaluacion_promedio numeric
)
language sql stable as $$
  select
    p.template_id,
    count(*)::bigint,
    count(*) filter (where p.primera_respuesta_at is not null)::bigint,
    count(*) filter (where p.cerro_con = 'sin_respuesta')::bigint,
    percentile_cont(0.5) within group (
      order by p.segundos_primera_respuesta
    ) filter (where p.segundos_primera_respuesta is not null)::int,
    percentile_cont(0.9) within group (
      order by p.segundos_primera_respuesta
    ) filter (where p.segundos_primera_respuesta is not null)::int,
    round(avg(p.auditoria_score) filter (where p.auditoria_score is not null), 1),
    round(avg(p.evaluacion_score) filter (where p.evaluacion_score is not null), 1)
  from holaamigo.smoke_probes p
  where p.created_at >= p_desde
    -- Las canceladas no se cuentan: una prueba que reemplazamos nosotros no
    -- dice nada del negocio del cliente, y meterla en la mediana la ensucia.
    and p.estado <> 'cancelled'
    and p.enviado_at is not null
  group by p.template_id
  order by count(*) desc;
$$;

comment on function holaamigo.resumen_de_pruebas(timestamptz) is
  'Qué tan viva está la línea de los prospectos, por tipo de prueba. Insumo de /admin/pruebas.';

-- ═══════════════ 11 · PERMISOS Y RECARGA ═══════════════

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
grant execute on all functions in schema holaamigo to service_role;
grant execute on function holaamigo.resumen_de_pruebas(timestamptz) to service_role;

revoke all on schema holaamigo from anon, authenticated;

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select id, nombre, max_turnos from holaamigo.smoke_templates order by id;
-- select label, phone_e164, channel_uuid, activo from holaamigo.smoke_channels;
-- select * from holaamigo.resumen_de_pruebas(now() - interval '30 days');
-- select id, estado, cerro_con, segundos_primera_respuesta
--   from holaamigo.smoke_probes order by created_at desc limit 10;
