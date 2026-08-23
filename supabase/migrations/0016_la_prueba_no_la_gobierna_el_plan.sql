-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 · La prueba de línea no la gobierna el plan del prospecto
--
-- BUG DE PRODUCCIÓN. El smoke tester automático NUNCA corría. Ni una vez.
--
-- El log lo dijo textualmente y hubo que ir a buscarlo:
--
--   [research] sin pruebas de línea: gobierno: blocked —
--   techo del plan diagnostico · autonomía del agente en propose
--
-- La aritmética, para `smoketest.probe` con `risk_class = 'external_comms'`:
--
--   techo_de_plan('diagnostico', 'external_comms')   = 2
--   techo_de_autonomia('propose', 'external_comms')  = 1
--   ⇒ nivel efectivo 1  ⇒  bloqueado
--
-- Y ése es EXACTAMENTE el escenario para el que se diseñó la capacidad: un
-- prospecto que acaba de escribir su URL en la landing, en plan `diagnostico`
-- porque todavía no nos compró nada, con la autonomía por defecto porque nunca
-- configuró un agente. La capacidad era inalcanzable por construcción.
--
-- ── POR QUÉ ES UN ERROR DE MODELADO Y NO UN NÚMERO MAL PUESTO ──────────────
--
-- Los dos diales gobiernan **lo que los agentes DEL CLIENTE hacen en nombre
-- del cliente**. Eso es correcto para `outreach.reply`: el agente del cliente
-- le escribe a los contactos del cliente, y cuánto puede hacer solo depende de
-- lo que el cliente contrató y de cuánta correa le soltó.
--
-- `smoketest.probe` es otra cosa: **Hola Amigo le escribe a la línea que ese
-- mismo negocio publica en su propio sitio**. El que recibe el mensaje no es un
-- tercero de la organización — es la organización. Cobrarle esa acción al plan
-- del prospecto es un error de categoría, y encima uno circular: no puede
-- pagarnos antes de ver el diagnóstico que esta prueba produce.
--
-- Es el mismo error que ADR 0024 ya documentó una vez, cuando `techo_de_plan`
-- dejaba L2 para todas las clases y el plan gratis no podía ni compilar su
-- propio guion. La regla que se escribió entonces sigue siendo la buena:
--
--   > El dial grueso gobierna lo que sale del edificio. Investigar, puntuar y
--   > escribir en objetos propios no lo toca.
--
-- Acá sale algo del edificio, sí — pero vuelve a la misma puerta.
--
-- ── LA SOLUCIÓN, Y LAS QUE SE DESCARTARON ──────────────────────────────────
--
-- Se agrega una clase de riesgo, `self_outreach`: sale del edificio y el
-- destinatario es la propia organización.
--
--   ✗ Cambiarla a `write`. Mentira: un mensaje llega a un teléfono real.
--     Además abriría el techo de plataforma a 5, y el techo de plataforma es
--     justamente el que SÍ tiene que seguir apretando.
--   ✗ Saltearse `authorize()` en el código. Perdía el registro en
--     `guard_events`, que es lo que hace auditable el subsistema, y el poder
--     apagarlo por organización con un `capability_grant`.
--   ✗ Subirle el plan al prospecto. Sería mentirle a la tabla de facturación
--     para conseguir un permiso.
--
-- Lo que NO se toca, y es lo que sigue frenando:
--
--   · `platform_ceiling` = 4. Sigue siendo el dial que manda, y sigue siendo
--     nuestro: L5 sería «hacelo y ni lo cuentes».
--   · `capability_grants` sigue funcionando: se puede apagar por organización.
--   · Los otros tres frenos de ADR 0025 —número publicado en su propio sitio,
--     enfriamiento de 72 h, bloqueo irreversible— viven en el código y no se
--     tocan acá.
--
-- Ver docs/adr/0025-el-smoke-tester-como-evidencia.md §«Los cuatro frenos».
--
-- Idempotente. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

do $$
begin
  if to_regclass('holaamigo.capabilities') is null then
    raise exception
      E'0016 no se puede aplicar todavía: falta correr 0007_gobierno.sql antes.\n'
      'El orden es 0007 → … → 0014_smoke_tester.sql → 0015 → 0016.';
  end if;
end $$;

-- ═══════════════ 1 · LA CLASE NUEVA ═══════════════

alter table holaamigo.capabilities
  drop constraint if exists capabilities_risk_class_check;

alter table holaamigo.capabilities
  add constraint capabilities_risk_class_check
  check (risk_class in ('read', 'write', 'external_comms', 'self_outreach', 'spend', 'irreversible'));

comment on column holaamigo.capabilities.risk_class is
  'read/write: objetos propios. external_comms: le llega a un tercero DEL cliente. '
  'self_outreach: sale del edificio pero el destinatario es la propia organización. '
  'spend/irreversible: plata y lo que no se deshace.';

-- ═══════════════ 2 · LOS DOS DIALES ═══════════════
--
-- Idénticas a las de 0007 y 0013 salvo por una línea cada una. Se redefinen
-- enteras porque en SQL no hay forma de agregarle un caso a un `case`.
--
-- **La versión vigente es siempre la del número de migración más alto.**

create or replace function holaamigo.techo_de_autonomia(p_autonomy text, p_risk_class text)
returns int language sql immutable as $$
  select case
    when p_risk_class in ('read','write') then 5
    -- La autonomía que el CLIENTE le soltó a SUS agentes no gobierna lo que
    -- nosotros hacemos sobre su propia línea. Un prospecto recién llegado tiene
    -- `propose` porque nunca configuró nada, no porque haya decidido algo.
    when p_risk_class = 'self_outreach' then 5
    when p_autonomy = 'propose'            then 1
    when p_autonomy = 'approve_each'       then 3
    when p_autonomy = 'auto_within_limits' then 4
    when p_autonomy = 'sampled'            then 5
    else 1
  end
$$;

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
    -- Y tampoco lo gobierna cuando el destinatario es la propia organización.
    -- El plan es una puerta comercial sobre lo que le llega a los contactos DEL
    -- cliente; cobrarle el mensaje que le mandamos a él mismo, antes de que nos
    -- haya comprado nada, es circular: la prueba existe para que compre.
    when p_risk_class = 'self_outreach' then 5
    when p_plan = 'diagnostico' then 2   -- puede preparar; nada sale
    when p_plan = 'starter'     then 3   -- ejecuta con visto bueno ítem por ítem
    when p_plan = 'growth'      then 4   -- ejecuta dentro de sobres
    when p_plan = 'enterprise'  then 5
    else 2
  end
$$;

-- ═══════════════ 3 · RECLASIFICAR LA CAPACIDAD ═══════════════
--
-- `0014` la sembró como `external_comms` porque en ese momento la clase nueva
-- no existía todavía y el CHECK la habría rechazado. Se corrige acá, que es lo
-- que hace que una instalación desde cero y una ya existente terminen iguales.

update holaamigo.capabilities
   set risk_class = 'self_outreach',
       description =
         'Escribirle por WhatsApp al número que el propio negocio publica en su sitio, '
         'como comprador sintético, y calificar la conversación. El destinatario es la '
         'organización, no un contacto suyo: por eso no lo gobierna su plan.',
       client_explanation =
         'Le escribimos a tu propia línea como si fuéramos un cliente, para mostrarte qué '
         'pasa cuando alguien te busca. Nunca le escribimos a tus clientes.'
 where id = 'smoketest.probe';

-- ═══════════════ 4 · PERMISOS Y RECARGA ═══════════════

grant execute on function holaamigo.techo_de_autonomia(text, text) to service_role;
grant execute on function holaamigo.techo_de_plan(text, text) to service_role;

revoke all on schema holaamigo from anon, authenticated;

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- El caso que estaba roto, y que ahora tiene que dar 'ejecutar':
--
--   select accion_permitida, effective_level, reason
--     from holaamigo.autorizar('<org-en-diagnostico>'::uuid, 'smoketest.probe');
--
-- Y el que NO tiene que haber cambiado — contestarle a un contacto del cliente
-- con el plan gratis sigue bloqueado:
--
--   select accion_permitida from holaamigo.autorizar('<org>'::uuid, 'outreach.reply');
