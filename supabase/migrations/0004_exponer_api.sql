-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · exponer el schema `holaamigo` a la API de Supabase
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- ADR 0001 decidió que todo viva en el schema `holaamigo` y no en `public`,
-- porque el proyecto de Supabase es compartido con Rentmies. Lo que ese ADR NO
-- dijo —y costó una tarde de producción caída— es que PostgREST solo atiende
-- los schemas que estén en su lista de expuestos. Por defecto esa lista es
-- `public, graphql_public`.
--
-- El síntoma es engañoso: las tablas existen, los permisos están bien, el
-- service_role es correcto, y toda consulta falla con
--
--     Error: Invalid schema: holaamigo        (PostgREST PGRST106)
--
-- que en la app se ve como "Algo se rompió de nuestro lado".
--
-- ───────────────────────────────────────────────────────────────────────────
-- LA FORMA DURADERA DE ARREGLARLO ES EL DASHBOARD:
--   Project Settings → API → Data API → Exposed schemas
--   agregar `holaamigo` a la lista y guardar.
--
-- Este archivo hace lo mismo por SQL para que quede en el repo y para poder
-- levantar un proyecto nuevo sin pasar por la interfaz. Si Supabase reescribe
-- la configuración del rol en un mantenimiento, el valor del dashboard es el
-- que manda — por eso el dashboard sigue siendo el paso oficial.
-- ───────────────────────────────────────────────────────────────────────────
--
-- Idempotente. Si el rol no se puede alterar (permisos), NO revienta: avisa.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  current_schemas text;
  new_schemas text;
begin
  -- Lo que PostgREST tiene configurado hoy para el rol que atiende la API.
  select coalesce(
           (select option_value
            from pg_options_to_table(rolconfig)
            where option_name = 'pgrst.db_schemas'),
           'public, graphql_public')
    into current_schemas
  from pg_roles
  where rolname = 'authenticator';

  if current_schemas is null then
    raise notice 'No se encontró el rol authenticator. Expón el schema desde el dashboard.';
    return;
  end if;

  if current_schemas like '%holaamigo%' then
    raise notice 'El schema holaamigo ya está expuesto: %', current_schemas;
    return;
  end if;

  new_schemas := current_schemas || ', holaamigo';

  execute format('alter role authenticator set pgrst.db_schemas = %L', new_schemas);
  raise notice 'Schemas expuestos actualizados a: %', new_schemas;

exception when others then
  -- Falta de permisos es el caso esperado en algunos proyectos. No abortamos
  -- la migración por esto: el paso del dashboard resuelve lo mismo.
  raise notice 'No se pudo alterar el rol authenticator (%). Agrega `holaamigo` a Exposed schemas desde Project Settings → API.', sqlerrm;
end $$;

-- PostgREST relee su configuración con esta señal. Sin esto el cambio no toma
-- efecto hasta el siguiente reinicio del servicio.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
-- Después de correr esto, la consulta de abajo debe devolver una fila con
-- `holaamigo` adentro. Si no, hay que hacerlo desde el dashboard.

-- select option_value as schemas_expuestos
-- from pg_roles, pg_options_to_table(rolconfig)
-- where rolname = 'authenticator' and option_name = 'pgrst.db_schemas';
