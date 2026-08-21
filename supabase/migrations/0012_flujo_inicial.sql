-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 · El flujo inicial: medir lo que ya estábamos guardando
--
-- No crea ni una tabla. Todo lo que hace falta para entender el flujo inicial
-- ya está persistido desde 0001: `plg_events` con su índice por evento,
-- `quiz_responses.answered_at` y `intake_sessions.completed_at`. Lo que faltaba
-- era leerlo.
--
-- Por qué la agregación va en SQL y no en la página:
--
--   1. Son ventanas y percentiles sobre decenas de miles de filas. Traerlas al
--      Node de la página para contarlas en JavaScript es mover datos para
--      hacer aritmética que Postgres ya sabe hacer.
--   2. La página queda tonta. Una vista de admin que solo pinta lo que la base
--      le devuelve no se puede desincronizar de la definición del embudo.
--   3. Se puede probar. `scripts/test-flujo-inicial.mjs` corre estas funciones
--      contra Postgres real (PGlite) con datos sembrados a mano. Una agregación
--      escrita en el render de un Server Component no se prueba nunca.
--
-- Ver docs/adr/0023-mostrar-el-trabajo.md
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════ 1 · EL EMBUDO ═══════════════
--
-- Se cuenta por ORGANIZACIÓN y no por sesión, por dos razones. La primera es
-- de significado: la pregunta del embudo es "de los negocios que entraron,
-- cuántos llegaron hasta acá", y un negocio que hizo el quiz dos veces es un
-- negocio, no dos. La segunda es técnica: `leads_uploaded` se registra sin
-- `session_id` (se dispara desde la carga de base, que ya no tiene sesión), así
-- que un embudo por sesión perdería la última etapa o tendría que inventarse
-- una atribución.
--
-- La ventana se ancla al PRIMER `landing_submit` de cada organización, no al
-- `created_at` de cada evento: si alguien entró hace 40 días y volvió ayer, su
-- cohorte es la de hace 40 días. Un embudo que reasigna cohortes cada vez que
-- alguien vuelve no se puede comparar consigo mismo.

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
           bool_or(e.event = 'quiz_started')      as inicio_quiz,
           bool_or(e.event = 'quiz_completed')    as termino_quiz,
           bool_or(e.event = 'diagnostic_viewed') as vio_diagnostico,
           bool_or(e.event = 'assumption_edited') as discutio,
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
    select 'Conectó canal o cargó base', 6, count(*) filter (where h.activo)::bigint from hitos h
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
  'Embudo del flujo inicial por organización, anclado al primer landing_submit.';

-- ═══════════════ 2 · DÓNDE SE CAE LA GENTE, PREGUNTA POR PREGUNTA ═══════════
--
-- `abandonos` es el número que cambia una decisión: cuántas sesiones dieron
-- esta respuesta, no completaron el quiz, y no volvieron a responder nada. Esa
-- es LA pregunta que hay que reescribir. El conteo de sesiones solo dice
-- cuántos llegaron; el de abandonos dice dónde se rompió.
--
-- `mediana_segundos` es el tiempo desde la respuesta anterior (o desde el
-- inicio de la sesión, para la primera). Mediana y no promedio: una pestaña que
-- alguien dejó abierta toda la noche arrastra cualquier promedio a la basura.

create or replace function holaamigo.caida_por_pregunta(
  p_desde timestamptz default now() - interval '30 days'
)
returns table (
  clave text,
  orden numeric,
  sesiones bigint,
  mediana_segundos numeric,
  abandonos bigint
)
language sql
stable
as $$
  with respuestas as (
    select r.session_id,
           s.completed_at,
           coalesce(r.question_id, r.slot) as clave,
           row_number() over (partition by r.session_id order by r.answered_at) as pos,
           row_number() over (partition by r.session_id order by r.answered_at desc) as pos_inv,
           extract(
             epoch from (
               r.answered_at
               - coalesce(
                   lag(r.answered_at) over (partition by r.session_id order by r.answered_at),
                   s.created_at
                 )
             )
           )::numeric as segundos
    from holaamigo.quiz_responses r
    join holaamigo.intake_sessions s on s.id = r.session_id
    where s.created_at >= p_desde
      and coalesce(r.question_id, r.slot) is not null
  )
  select x.clave,
         round(avg(x.pos), 1) as orden,
         count(*)::bigint as sesiones,
         round(percentile_cont(0.5) within group (order by x.segundos)::numeric, 1) as mediana_segundos,
         count(*) filter (where x.pos_inv = 1 and x.completed_at is null)::bigint as abandonos
  from respuestas x
  group by x.clave
  order by avg(x.pos);
$$;

comment on function holaamigo.caida_por_pregunta(timestamptz) is
  'Por pregunta del quiz: cuántos llegaron, cuánto tardaron y cuántos se cayeron ahí.';

-- ═══════════════ 3 · QUÉ NÚMEROS NUESTROS NO SE CREEN ═══════════════
--
-- Un supuesto que el cliente sube todo el tiempo es un supuesto donde somos
-- demasiado conservadores; uno que baja todo el tiempo es uno donde no nos
-- creen. Las dos cosas cambian una decisión concreta: qué default de
-- `config/assumptions.ts` hay que mover.
--
-- Solo cuenta las ediciones que traen `from` y `to`. Las anteriores a la 3.6.0
-- guardaban el objeto completo de supuestos sin el valor previo, así que su
-- dirección es irrecuperable — y una dirección inventada sería peor que una
-- fila de menos.

create or replace function holaamigo.supuestos_discutidos(
  p_desde timestamptz default now() - interval '90 days'
)
returns table (
  supuesto text,
  ediciones bigint,
  organizaciones bigint,
  subieron bigint,
  bajaron bigint,
  cambio_mediano_pct numeric
)
language sql
stable
as $$
  with cambios as (
    select e.organization_id,
           e.props->>'changed' as supuesto,
           (e.props->>'from')::numeric as antes,
           (e.props->>'to')::numeric as despues
    from holaamigo.plg_events e
    where e.event = 'assumption_edited'
      and e.created_at >= p_desde
      and e.props->>'changed' is not null
      and jsonb_typeof(e.props->'from') = 'number'
      and jsonb_typeof(e.props->'to') = 'number'
  )
  select c.supuesto,
         count(*)::bigint,
         count(distinct c.organization_id)::bigint,
         count(*) filter (where c.despues > c.antes)::bigint,
         count(*) filter (where c.despues < c.antes)::bigint,
         round(
           percentile_cont(0.5) within group (
             order by 100.0 * (c.despues - c.antes) / nullif(c.antes, 0)
           )::numeric,
           1
         )
  from cambios c
  group by c.supuesto
  order by count(*) desc;
$$;

comment on function holaamigo.supuestos_discutidos(timestamptz) is
  'Qué supuestos edita el cliente y hacia dónde los mueve. Insumo para ajustar DEFAULTS.';

-- ═══════════════ PERMISOS ═══════════════
--
-- Se re-otorga: el grant masivo de 0001 y 0011 aplicó a las funciones que
-- existían en ese momento, no a las de este archivo.

grant execute on function holaamigo.embudo_inicial(timestamptz) to service_role;
grant execute on function holaamigo.caida_por_pregunta(timestamptz) to service_role;
grant execute on function holaamigo.supuestos_discutidos(timestamptz) to service_role;

revoke all on schema holaamigo from anon, authenticated;

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select * from holaamigo.embudo_inicial(now() - interval '90 days');
-- select * from holaamigo.caida_por_pregunta(now() - interval '90 days');
-- select * from holaamigo.supuestos_discutidos(now() - interval '365 days');
