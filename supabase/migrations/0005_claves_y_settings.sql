-- ═══════════════════════════════════════════════════════════════════════════
-- Hola Amigo · claves de upsert utilizables + settings en caliente
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ EXISTE ESTE ARCHIVO:
--
-- El quiz nunca guardó una sola respuesta. La causa no estaba en el código de
-- la aplicación sino acá: `quiz_responses` tenía dos índices únicos PARCIALES
--
--     unique (session_id, question_id) where question_id is not null
--     unique (session_id, slot)        where question_id is null and slot is not null
--
-- y la aplicación hacía `upsert(..., { onConflict: 'session_id,question_id' })`.
-- PostgREST traduce eso a `ON CONFLICT (session_id, question_id) DO UPDATE`
-- SIN cláusula WHERE, y Postgres solo puede usar un índice parcial como
-- árbitro si el WHERE del INSERT implica el predicado del índice. Como no lo
-- hay, la sentencia falla siempre con
--
--     42P10: there is no unique or exclusion constraint matching
--            the ON CONFLICT specification
--
-- El mismo error, por la variante de índices de EXPRESIÓN, rompía la creación
-- de productos (`lower(sku)`) y de bandejas (`lower(address)`).
--
-- La lección, y la razón de que esto sea una migración y no un parche: un
-- índice único que no se puede nombrar en un ON CONFLICT no sirve como clave
-- de upsert. Si la aplicación va a hacer upsert sobre una tabla, la clave
-- tiene que ser un índice único PLANO sobre columnas reales.
-- Ver docs/adr/0015-claves-de-upsert-planas.md
--
-- Idempotente: se puede correr varias veces.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 1 · QUIZ_RESPONSES: UNA SOLA CLAVE ═══════════════
--
-- `answer_key` colapsa los dos casos (pregunta fija con `question_id`,
-- adaptativa con `slot`) en una única columna generada. Con eso hay UN índice
-- único plano y UN solo `onConflict` en el código, en vez de dos caminos que
-- ninguno de los dos funcionaba. Es exactamente la clave que `getAnswers()` ya
-- usaba en memoria: `question_id ?? slot`.

alter table holaamigo.quiz_responses
  add column if not exists answer_key text
  generated always as (coalesce(question_id, slot)) stored;

-- Antes de poner el índice único hay que dejar una sola fila por clave. En una
-- base donde el upsert nunca funcionó no debería haber duplicados, pero si
-- alguien corrió inserts a mano, esto los resuelve en vez de abortar.
delete from holaamigo.quiz_responses a
using holaamigo.quiz_responses b
where a.session_id = b.session_id
  and a.answer_key is not null
  and a.answer_key = b.answer_key
  and (a.answered_at, a.id) < (b.answered_at, b.id);

drop index if exists holaamigo.quiz_responses_fixed_key;
drop index if exists holaamigo.quiz_responses_generated_key;

create unique index if not exists quiz_responses_key
  on holaamigo.quiz_responses (session_id, answer_key);

-- Una respuesta saltada se guarda como cadena vacía, no como NULL: el NOT NULL
-- de `answer` es lo que garantiza que "respondió y saltó" y "no respondió" sean
-- estados distinguibles. El código lo normaliza antes de escribir.

-- ═══════════════ 2 · PRODUCTS: CLAVE PLANA ═══════════════
-- El SKU se normaliza a minúsculas en `lib/commerce/catalog.ts` antes de
-- escribir, así que el índice plano protege lo mismo que protegía `lower(sku)`
-- y además sirve de árbitro en el upsert.

update holaamigo.products set sku = lower(sku) where sku <> lower(sku);

delete from holaamigo.products a
using holaamigo.products b
where a.organization_id = b.organization_id
  and a.sku = b.sku
  and a.id < b.id;

drop index if exists holaamigo.products_sku_key;
create unique index if not exists products_sku_key
  on holaamigo.products (organization_id, sku);

-- ═══════════════ 3 · MAILBOXES: CLAVE PLANA ═══════════════

update holaamigo.mailboxes set address = lower(address) where address <> lower(address);

delete from holaamigo.mailboxes a
using holaamigo.mailboxes b
where a.organization_id = b.organization_id
  and a.address = b.address
  and a.id < b.id;

drop index if exists holaamigo.mailboxes_address_key;
create unique index if not exists mailboxes_address_key
  on holaamigo.mailboxes (organization_id, address);

-- ═══════════════ 4 · DIAGNOSTICS: IDEMPOTENCIA CON RESPALDO ═══════════════
--
-- `generateDiagnostic()` decía ser idempotente por sesión, pero la idempotencia
-- vivía solo en un `select` previo. Dos llamadas concurrentes —el doble efecto
-- de React en desarrollo, un reintento del navegador— generaban dos
-- diagnósticos, dos corridas del modelo cobradas, y a partir de ahí el
-- `maybeSingle()` de la comprobación fallaba para siempre con "multiple rows".
--
-- Este índice es parcial a propósito y NO se usa como árbitro de ningún upsert:
-- solo existe para que la segunda inserción falle y el código relea la primera.

delete from holaamigo.diagnostics a
using holaamigo.diagnostics b
where a.session_id is not null
  and a.session_id = b.session_id
  and (a.created_at, a.id) < (b.created_at, b.id);

create unique index if not exists diagnostics_session_key
  on holaamigo.diagnostics (session_id)
  where session_id is not null;

-- ═══════════════ 5 · SETTINGS: CONFIGURACIÓN EN CALIENTE ═══════════════
--
-- Tabla llave-valor para lo que hay que poder cambiar sin desplegar. Hoy
-- guarda el ruteo de modelos de IA (`ai.models`): cambiar de gpt-5 a un mini
-- barato mientras se prueba el producto no puede exigir un deploy de tres
-- minutos ni tocar variables de entorno en Vercel.
--
-- Precedencia, de mayor a menor: esta tabla → variable de entorno → default en
-- código. Ver docs/adr/0014-configuracion-en-caliente.md

create table if not exists holaamigo.settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table holaamigo.settings is
  'Configuración editable desde /admin sin desplegar. Precedencia: settings > env > default.';

-- ═══════════════ RLS Y GRANTS PARA LO NUEVO ═══════════════
-- Mismo bloque de 0001: deny-by-default y service_role explícito. Se repite
-- porque `settings` no existía cuando corrió 0001.

alter table holaamigo.settings enable row level security;
alter table holaamigo.settings force row level security;

grant usage on schema holaamigo to service_role;
grant all privileges on all tables in schema holaamigo to service_role;
grant all privileges on all sequences in schema holaamigo to service_role;

revoke all on schema holaamigo from anon, authenticated;

notify pgrst, 'reload schema';

-- ═══════════════ VERIFICACIÓN ═══════════════
-- Después de correr esto, las cuatro filas de abajo deben existir:
--
-- select indexname from pg_indexes
-- where schemaname = 'holaamigo'
--   and indexname in ('quiz_responses_key','products_sku_key',
--                     'mailboxes_address_key','diagnostics_session_key');
