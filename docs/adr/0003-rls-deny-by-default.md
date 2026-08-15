# ADR 0003 · RLS deny-by-default, sin cliente de Supabase en el navegador

- **Fecha:** 2026-08-15
- **Estado:** aceptada

## Contexto

El PRD (§5) pide "RLS activo en todas las tablas. El admin usa `service_role`
desde rutas de servidor; el cliente ve solo su `organization_id`."

La parte difícil es "el cliente ve solo su `organization_id`". En v1 **no hay
autenticación de cliente**: alguien llega a la landing, deja tres campos, y
recorre quiz → diagnóstico → leads sin crear cuenta. Eso es deliberado y es lo
que sostiene la métrica de conversión de §11.

Sin sesión, no hay `auth.uid()`. Sin `auth.uid()`, una política RLS no puede
distinguir a un visitante de otro. Cualquier política que escribamos para
`anon` sería, en la práctica, `using (true)` con un UUID como contraseña.

## Decisión

**RLS habilitado y forzado en las 20 tablas, con cero políticas.** El efecto es
denegación total para `anon` y `authenticated`.

Todo el acceso pasa por código de servidor con `service_role`, que ignora RLS
por diseño. Concretamente:

- No existe `lib/supabase/browser.ts`. No hay cliente de Supabase en el bundle.
- No se publica `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Cada página que muestra datos es un Server Component que consulta con
  `db()`; cada mutación es una ruta de API que valida antes de escribir.

La autorización, entonces, no vive en políticas SQL: vive en que las URLs
llevan identificadores no enumerables (`session_id` uuid v4, `share_token` de
64 hex) y en las validaciones de cada ruta.

## Consecuencias

**Lo bueno:** superficie de ataque mínima. No hay una anon key circulando que
alguien pueda usar contra PostgREST directamente. Un error en una política —el
modo más común de filtrar datos en Supabase— es imposible porque no hay
políticas.

**Lo que hay que cuidar:** cada ruta nueva es responsable de su propia
autorización. No hay red de seguridad debajo. Por eso `/api/approvals/[id]/decide`
y `/api/admin/band` llaman a `currentAdmin()` en la primera línea.

**El límite:** esto funciona porque no hay multi-usuario por organización. En
cuanto un cliente quiera invitar a su equipo, hay que introducir Supabase Auth
y **entonces sí** escribir políticas RLS reales por `organization_id`. Este ADR
se revisa ese día, no antes.

**Sobre `force row level security`:** lo habilitamos además de `enable` para
que RLS aplique incluso al dueño de la tabla. Es cinturón sobre tirantes, pero
cuesta una línea.
