-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 · UN SEGUNDO TRANSPORTE, Y UN ORDEN DE PREFERENCIA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ver docs/adr/0028-dos-transportes.md
--
-- El smoke tester nació con un solo proveedor —Callbell— y con la tabla de
-- canales ya preparada para más de uno: el índice único es
-- `(provider, channel_uuid)` y no `channel_uuid` solo. Esta migración cobra esa
-- previsión: agrega `wzap` al `check` y siembra la primera línea suya.
--
-- Lo único genuinamente nuevo es `prioridad`. Hasta hoy «la línea» era la más
-- antigua (`order by created_at`), que funcionaba porque había una. Con dos
-- proveedores el orden de creación es un accidente: la línea preferida es una
-- decisión de operación, y una decisión de operación necesita una columna que
-- se pueda cambiar sin desplegar (ADR 0014).
--
-- Idempotente: se puede correr dos veces. El `check` se recrea, la columna usa
-- `if not exists`, la siembra usa `on conflict do nothing`, y el `update` que
-- degrada Callbell solo toca lo que todavía está en el valor por defecto — así
-- un reordenamiento hecho a mano en el admin sobrevive a volver a correr esto.

-- ── 1 · el proveedor nuevo ─────────────────────────────────────────────────
--
-- El `check` era inline, así que Postgres lo nombró `<tabla>_<columna>_check`.
-- Se dropea por ese nombre y se recrea con uno explícito para que la próxima
-- vez que haya que ampliarlo no haya que adivinar cómo se llama.

alter table holaamigo.smoke_channels
  drop constraint if exists smoke_channels_provider_check;

alter table holaamigo.smoke_channels
  add constraint smoke_channels_provider_check
  check (provider in ('callbell', 'wzap'));

-- ── 2 · la preferencia ─────────────────────────────────────────────────────

alter table holaamigo.smoke_channels
  add column if not exists prioridad int not null default 100;

comment on column holaamigo.smoke_channels.prioridad is
  'Menor gana. La línea que el camino automático usa cuando nadie eligió una. '
  'Existe porque con dos proveedores el orden de creación es un accidente.';

-- ── 3 · la primera línea de wzap ───────────────────────────────────────────
--
-- `channel_uuid` guarda el `device` de wzap: un id de 24 hex que identifica la
-- sesión de WhatsApp dentro de la cuenta. NO es opcional en el envío, y esa es
-- la razón de que se guarde acá y no en una variable de entorno: la misma llave
-- de API ve TODAS las líneas de la cuenta —incluidas las de otros negocios— y
-- un POST sin `device` sale desde la que el proveedor elija. Es la diferencia
-- entre escribirle a un prospecto desde nuestra línea de pruebas y escribirle
-- desde la línea de atención de un cliente.
--
-- `template_uuid` va en null: wzap conecta por QR y abre con texto libre. Y los
-- botones nativos no son una opción por ningún proveedor no oficial desde que
-- WhatsApp los dejó de aceptar (2023-05-10); llegan convertidos a texto plano.

insert into holaamigo.smoke_channels (label, provider, phone_e164, channel_uuid, prioridad, notas)
values (
  'wzap · Rentmies D2C',
  'wzap',
  '+573332420353',
  '69e62a9b0b653ef3ef32e965',
  10,
  'Línea preferida. Conectada por QR (connector web). El device es el de la '
  || 'sesión "Rentmies Propio D2C y Not". Las respuestas entran por '
  || '/api/webhooks/wzap.'
)
on conflict (provider, channel_uuid) do nothing;

-- ── 4 · Callbell pasa a suplente ───────────────────────────────────────────
--
-- No se desactiva. Dos proveedores distintos contra el mismo negocio son dos
-- hilos de WhatsApp y los dos miden (ADR 0027): Callbell deja de ser la línea
-- por defecto y sigue siendo una línea elegible.

update holaamigo.smoke_channels
   set prioridad = 200, updated_at = now()
 where provider = 'callbell'
   and prioridad = 100;

comment on table holaamigo.smoke_channels is
  'Desde dónde escribe el smoke tester. Dos proveedores: wzap y Callbell. '
  'Editable en caliente desde /admin/pruebas; `prioridad` decide la preferida.';
