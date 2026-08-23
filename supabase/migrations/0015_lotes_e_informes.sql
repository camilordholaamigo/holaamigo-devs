-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 · El lote y el informe: de una prueba suelta a una herramienta
--
-- 0014 dejó el motor: le escribimos a UNA línea y calificamos la conversación.
-- Sirve para un prospecto. No sirve para las dos cosas que este producto tiene
-- que hacer ahora:
--
--   QA      · «¿cuál de mis treinta clientes tiene la IA rota esta semana?»
--   GROWTH  · «mandale a estos cuarenta prospectos lo que pasó cuando les
--             escribimos, y ofreceles algo mejor»
--
-- Las dos son el mismo motor con distinto destinatario, y necesitan dos
-- objetos que no existían: el LOTE y el INFORME.
--
-- CUATRO DECISIONES QUE EXPLICAN EL ARCHIVO:
--
--   1. EL LOTE ES UNA COLA CON TOPE, NO UN DISPARO MASIVO. Treinta clientes
--      por tres pruebas son noventa conversaciones desde UNA línea de
--      WhatsApp. Mandarlas juntas no es una feature: es la forma más rápida de
--      que Meta queme el número. `max_concurrentes` y `ritmo_segundos` no son
--      afinación, son la diferencia entre tener herramienta y no tenerla.
--
--   2. LA FRECUENCIA SE CUENTA SOBRE LOS CRITERIOS, NO SOBRE EL TEXTO DEL
--      MODELO. «Un error que aparece en 5 de 5 conversaciones es un problema
--      del prompt; uno que aparece 1 de 5 es ruido» — esa distinción es todo
--      el valor del análisis, y solo funciona con claves estables. Los
--      criterios de la rúbrica tienen `id`; las alucinaciones que devuelve el
--      modelo son texto libre y NUNCA van a agrupar. Por eso
--      `hallazgos_por_frecuencia()` agrupa por `id` de criterio, y las citas
--      textuales se listan aparte sin contar. Agruparlas perdería la cita, que
--      es lo único verificable que tenemos.
--
--   3. EL INFORME TIENE `share_token`. Es un link público, como el
--      diagnóstico, y por la misma razón: el cliente lo reenvía a su socio y
--      ese reenvío es distribución. Para WhatsApp un link le gana a un PDF —
--      se previsualiza, no pesa, y se puede medir si lo abrieron. Un PDF
--      adjunto es un agujero negro comercial.
--
--   4. `vistas` Y `visto_at` SON PARTE DEL PRODUCTO, NO TELEMETRÍA. Saber que
--      el prospecto abrió el informe tres veces es la señal de compra más
--      barata que vamos a tener nunca, y es lo que decide a quién llamar.
--
-- Ver docs/adr/0026-el-lote-y-el-informe.md
--
-- Idempotente. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 0 · LO QUE TIENE QUE ESTAR ANTES ═══════════════

do $$
begin
  if to_regclass('holaamigo.smoke_probes') is null then
    raise exception
      E'0015 no se puede aplicar todavía: falta correr 0014_smoke_tester.sql antes.\n\n'
      'El orden es 0013_agente_de_agendamiento.sql → 0014_smoke_tester.sql → 0015_lotes_e_informes.sql.\n'
      'Las tres son idempotentes: si alguna ya corrió, correrla de nuevo no hace daño.';
  end if;
end $$;

-- ═══════════════ 1 · EL LOTE ═══════════════

create table if not exists holaamigo.smoke_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  nombre text not null,

  -- Gobierna qué frenos aplican, y por eso no es cosmético.
  --   qa           · nuestros clientes. Nos dieron permiso al contratarnos.
  --   prospeccion  · gente que no nos conoce. Aplica todo lo de ADR 0025.
  proposito text not null default 'qa' check (proposito in ('qa', 'prospeccion')),

  estado text not null default 'running'
    check (estado in ('running', 'paused', 'done', 'cancelled')),

  -- Cuántas conversaciones vivas a la vez, en TODO el lote. Ver decisión 1.
  -- El techo de 12 no es arbitrario: por encima de eso una sola línea de
  -- WhatsApp empieza a parecerse a un emisor de spam para el clasificador de
  -- Meta, y lo que se pierde no es un lote, es el número.
  max_concurrentes int not null default 4 check (max_concurrentes between 1 and 12),

  -- Segundos entre dos arranques. Aunque haya cupo libre, no se abren dos
  -- conversaciones en el mismo segundo.
  ritmo_segundos int not null default 45 check (ritmo_segundos between 0 and 3600),

  creado_por text,
  notas text,
  progress_log jsonb not null default '[]',
  finished_at timestamptz
);
create index if not exists smoke_batches_estado_idx
  on holaamigo.smoke_batches (estado, created_at desc);

comment on table holaamigo.smoke_batches is
  'Una tanda de pruebas sobre varias organizaciones, con tope de concurrencia.';

-- La prueba pertenece a un lote, o a ninguno si se disparó suelta.
alter table holaamigo.smoke_probes
  add column if not exists batch_id uuid references holaamigo.smoke_batches(id) on delete set null;
create index if not exists smoke_probes_batch_idx
  on holaamigo.smoke_probes (batch_id, estado);

-- ═══════════════ 2 · EL INFORME ═══════════════

create table if not exists holaamigo.smoke_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references holaamigo.organizations(id) on delete cascade,
  batch_id uuid references holaamigo.smoke_batches(id) on delete set null,

  -- Mismo mecanismo que el diagnóstico: enlace permanente y público, protegido
  -- por un token de 64 caracteres que no es enumerable. Ver decisión 3.
  share_token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),

  periodo_desde timestamptz not null,
  periodo_hasta timestamptz not null default now(),

  -- LAS CIFRAS. Las calcula el código restando timestamps y contando filas.
  -- {conversaciones, contestadas, sin_respuesta, mediana_segundos, p90_segundos,
  --  mas_rapida_segundos, mas_lenta_segundos, propusieron_paso, cerraron_cita}
  resumen jsonb not null default '{}',

  -- LOS HALLAZGOS, con su frecuencia. Salen de `hallazgos_por_frecuencia()`.
  -- [{id, criterio, dimension, fallo_en, de, ejemplos:[probe_id]}]
  hallazgos jsonb not null default '[]',

  -- LAS CITAS. Textuales, sin agrupar. [{texto, probe_id, plantilla}]
  citas jsonb not null default '[]',

  -- LAS RECOMENDACIONES. El código elige cuáles según los hallazgos; el modelo
  -- les pone las palabras. [{clave, titulo, porque, impacto}]
  recomendaciones jsonb not null default '[]',

  -- Lo único que escribe el modelo entero: dos o tres frases. Sin cifras.
  narrativa text,

  -- Borrador del correo de prospección. NO se manda solo: lo revisa una
  -- persona en /admin/pruebas. Misma disciplina que /admin/senales (ADR 0021).
  correo jsonb,

  publicado boolean not null default false,
  -- Ver decisión 4: esto es producto, no telemetría.
  vistas int not null default 0,
  visto_at timestamptz
);
create index if not exists smoke_reports_org_idx
  on holaamigo.smoke_reports (organization_id, created_at desc);
create index if not exists smoke_reports_batch_idx
  on holaamigo.smoke_reports (batch_id);

comment on table holaamigo.smoke_reports is
  'El informe compartible de una organización. Cifras del código, palabras del modelo.';

-- ═══════════════ 3 · updated_at ═══════════════

do $$
declare
  t text;
begin
  foreach t in array array['smoke_batches', 'smoke_reports']
  loop
    execute format('drop trigger if exists %I on holaamigo.%I', 't_' || t || '_updated_at', t);
    execute format(
      'create trigger %I before update on holaamigo.%I
         for each row execute function holaamigo.tocar_updated_at()',
      't_' || t || '_updated_at', t);
  end loop;
end $$;

-- ═══════════════ 4 · LA SALUD DE UNA LÍNEA ═══════════════
--
-- Las cifras del encabezado del informe. Todas salen de restar timestamps y
-- contar filas: ninguna la escribe un modelo (ADR 0007).
--
-- Se excluyen las canceladas —las cancelamos nosotros, no dicen nada del
-- cliente— y las que nunca salieron.

create or replace function holaamigo.salud_de_linea(
  p_org uuid,
  p_desde timestamptz
)
returns table (
  conversaciones bigint,
  contestadas bigint,
  sin_respuesta bigint,
  mediana_segundos int,
  p90_segundos int,
  mas_rapida_segundos int,
  mas_lenta_segundos int,
  propusieron_paso bigint,
  cerraron_cita bigint,
  auditoria_promedio numeric,
  evaluacion_promedio numeric
)
language sql stable as $$
  with vivas as (
    select *
    from holaamigo.smoke_probes p
    where p.organization_id = p_org
      and p.created_at >= p_desde
      and p.estado <> 'cancelled'
      and p.enviado_at is not null
  )
  select
    count(*)::bigint,
    count(*) filter (where primera_respuesta_at is not null)::bigint,
    count(*) filter (where cerro_con = 'sin_respuesta')::bigint,
    percentile_cont(0.5) within group (order by segundos_primera_respuesta)
      filter (where segundos_primera_respuesta is not null)::int,
    percentile_cont(0.9) within group (order by segundos_primera_respuesta)
      filter (where segundos_primera_respuesta is not null)::int,
    min(segundos_primera_respuesta)::int,
    max(segundos_primera_respuesta)::int,
    -- «Propuso un paso siguiente» es el criterio que mejor separa una línea que
    -- atiende de una que vende. Se lee del resultado del auditor, que es
    -- determinístico, y no de una opinión del evaluador.
    count(*) filter (
      where exists (
        select 1 from jsonb_array_elements(coalesce(auditoria->'criterios', '[]'::jsonb)) c
        where c->>'id' = 'propuso' and (c->>'paso')::boolean
      )
    )::bigint,
    count(*) filter (where cerro_con in ('agendado', 'cotizacion'))::bigint,
    round(avg(auditoria_score) filter (where auditoria_score is not null), 1),
    round(avg(evaluacion_score) filter (where evaluacion_score is not null), 1)
  from vivas;
$$;

comment on function holaamigo.salud_de_linea(uuid, timestamptz) is
  'Las cifras del informe. Todas determinísticas: ninguna sale de un modelo.';

-- ═══════════════ 5 · LOS HALLAZGOS, POR FRECUENCIA ═══════════════
--
-- El corazón del análisis, y la razón por la que agrupa por `id` de criterio y
-- no por texto. Ver decisión 2 del encabezado.
--
-- `fallo_en` de `de` es la cifra que convierte una queja en un diagnóstico:
-- 4 de 5 es un problema sistemático del guion; 1 de 5 es una conversación mala.
-- Sin esa distinción, un informe es una lista de reclamos.
--
-- Los criterios con `paso = null` NO cuentan como fallo: son los que no se
-- pudieron verificar. Meterlos acá sería acusar al cliente de algo que en
-- realidad es un límite nuestro.

create or replace function holaamigo.hallazgos_por_frecuencia(
  p_org uuid,
  p_desde timestamptz
)
returns table (
  id text,
  criterio text,
  dimension text,
  peso int,
  fallo_en bigint,
  de bigint,
  ejemplos jsonb
)
language sql stable as $$
  with criterios as (
    select
      p.id as probe_id,
      c->>'id' as cid,
      c->>'criterio' as texto,
      c->>'dimension' as dim,
      coalesce((c->>'peso')::int, 1) as peso,
      (c->>'paso')::boolean as paso
    from holaamigo.smoke_probes p
    cross join lateral jsonb_array_elements(coalesce(p.auditoria->'criterios', '[]'::jsonb)) c
    where p.organization_id = p_org
      and p.created_at >= p_desde
      and p.estado <> 'cancelled'
      and c->>'paso' is not null
  )
  select
    cid,
    max(texto),
    max(dim),
    max(peso),
    count(*) filter (where not paso)::bigint,
    count(*)::bigint,
    coalesce(
      jsonb_agg(probe_id) filter (where not paso),
      '[]'::jsonb
    )
  from criterios
  group by cid
  having count(*) filter (where not paso) > 0
  -- Ordenado por lo que más mueve la aguja: primero lo que falla siempre, y
  -- entre dos que fallan igual, el criterio que más pesa.
  order by
    (count(*) filter (where not paso))::numeric / nullif(count(*), 0) desc,
    max(peso) desc;
$$;

comment on function holaamigo.hallazgos_por_frecuencia(uuid, timestamptz) is
  'Qué falla y en cuántas conversaciones de cuántas. Agrupa por id de criterio, que es estable.';

-- ═══════════════ 6 · LAS CITAS TEXTUALES ═══════════════
--
-- Las alucinaciones NO se agrupan y NO se cuentan. Cada una es una cita
-- literal de lo que el negocio escribió, y es lo único de todo el informe que
-- el cliente puede verificar abriendo su propio WhatsApp. Resumirlas o
-- contarlas las convertiría en una acusación sin prueba.

create or replace function holaamigo.citas_del_periodo(
  p_org uuid,
  p_desde timestamptz,
  p_limite int default 12
)
returns table (
  texto text,
  probe_id uuid,
  plantilla text,
  telefono text
)
language sql stable as $$
  select
    a #>> '{}',
    p.id,
    p.template_id,
    p.target_phone
  from holaamigo.smoke_probes p
  cross join lateral jsonb_array_elements(coalesce(p.evaluacion->'alucinaciones', '[]'::jsonb)) a
  where p.organization_id = p_org
    and p.created_at >= p_desde
    and p.estado <> 'cancelled'
    and length(a #>> '{}') > 3
  order by p.created_at desc
  limit p_limite;
$$;

comment on function holaamigo.citas_del_periodo(uuid, timestamptz, int) is
  'Alucinaciones textuales, sin agrupar. Es la única prueba verificable del informe.';

-- ═══════════════ 7 · EL TABLERO DEL LOTE ═══════════════
--
-- Lo que la pantalla del lote pinta, y lo que el avanzador consulta para saber
-- si le queda cupo. Una sola consulta en vez de cuatro: el avanzador corre en
-- cada cierre de prueba y en cada refresco de pantalla.

create or replace function holaamigo.estado_del_lote(p_batch uuid)
returns table (
  total bigint,
  pendientes bigint,
  corriendo bigint,
  cerradas bigint,
  sin_respuesta bigint,
  fallidas bigint,
  organizaciones bigint,
  ultimo_arranque timestamptz
)
language sql stable as $$
  select
    count(*)::bigint,
    count(*) filter (where estado = 'pending')::bigint,
    count(*) filter (where estado = 'running')::bigint,
    count(*) filter (where estado in ('completed', 'timeout'))::bigint,
    count(*) filter (where cerro_con = 'sin_respuesta')::bigint,
    count(*) filter (where estado in ('failed', 'cancelled'))::bigint,
    count(distinct organization_id)::bigint,
    max(enviado_at)
  from holaamigo.smoke_probes
  where batch_id = p_batch;
$$;

comment on function holaamigo.estado_del_lote(uuid) is
  'Contadores del lote en una sola consulta. Lo usan el avanzador y la pantalla.';

-- ═══════════════ 8 · PERMISOS Y RECARGA ═══════════════

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;
grant execute on all functions in schema holaamigo to service_role;
grant execute on function holaamigo.salud_de_linea(uuid, timestamptz) to service_role;
grant execute on function holaamigo.hallazgos_por_frecuencia(uuid, timestamptz) to service_role;
grant execute on function holaamigo.citas_del_periodo(uuid, timestamptz, int) to service_role;
grant execute on function holaamigo.estado_del_lote(uuid) to service_role;

revoke all on schema holaamigo from anon, authenticated;

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
--
-- select * from holaamigo.salud_de_linea('<org>'::uuid, now() - interval '30 days');
-- select * from holaamigo.hallazgos_por_frecuencia('<org>'::uuid, now() - interval '30 days');
-- select * from holaamigo.citas_del_periodo('<org>'::uuid, now() - interval '30 days');
-- select * from holaamigo.estado_del_lote('<lote>'::uuid);
