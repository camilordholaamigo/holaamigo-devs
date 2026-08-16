# ADR 0015 · Una clave de upsert tiene que ser un índice único plano

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Nace de un bug que dejó el producto sin su pantalla principal**

## Contexto

El quiz nunca guardó una sola respuesta. El síntoma: se contesta la primera
pregunta, la pantalla se queda igual, no aparece ningún error, no hay nada en
los logs. La ruta devolvía `200`.

La causa estaba en `0001_init.sql`:

```sql
create unique index quiz_responses_fixed_key
  on holaamigo.quiz_responses (session_id, question_id)
  where question_id is not null;                            -- ← parcial
```

y en `lib/quiz/service.ts`:

```ts
.upsert(row, { onConflict: 'session_id,question_id' })
```

PostgREST traduce eso a `ON CONFLICT (session_id, question_id) DO UPDATE`, **sin
cláusula `WHERE`**. Postgres solo puede usar un índice parcial como árbitro si
el `WHERE` de la sentencia implica el predicado del índice. Como no hay ninguno,
falla siempre:

```
42P10: there is no unique or exclusion constraint matching
       the ON CONFLICT specification
```

El mismo error, por la variante de **índices de expresión**, rompía otras dos
cosas: crear un producto (`unique (organization_id, lower(sku))` contra
`onConflict: 'organization_id,sku'`) y crear una bandeja de correo.

Los tres índices eran correctos como *restricción*. Ninguno servía como *clave
de upsert*, y esa distinción no estaba escrita en ninguna parte.

## Alternativas consideradas

**A · Dejar los índices y cambiar el código a select-then-insert/update.**
Descartada: introduce una carrera en cada escritura que hoy es atómica, y hay
diez lugares con el mismo patrón. Cambiar diez llamadores para conservar tres
índices es el trueque al revés.

**B · Emitir el `WHERE` del índice parcial en la sentencia.** PostgREST no lo
permite: `on_conflict` acepta una lista de columnas, no un predicado. Habría que
bajar a una función RPC por tabla. Es mucha máquina para el problema.

**C · Índices únicos planos sobre columnas reales, y normalizar en el código lo
que antes normalizaba la expresión.** Elegida.

## Decisión

**Si la aplicación hace `upsert` sobre una tabla, la clave de conflicto es un
índice único plano sobre columnas reales.** Sin predicado y sin expresiones.

Cuando el caso lo pide, la columna se genera:

```sql
alter table holaamigo.quiz_responses
  add column answer_key text
  generated always as (coalesce(question_id, slot)) stored;

create unique index quiz_responses_key
  on holaamigo.quiz_responses (session_id, answer_key);
```

`answer_key` es exactamente la clave que el código ya usaba en memoria
(`question_id ?? slot`). Ahora existe también en la base, hay **un** índice y
**un** `onConflict` en vez de dos caminos que ninguno funcionaba.

Lo que hacía `lower()` lo hace ahora el código antes de escribir: el SKU y la
dirección de correo se guardan siempre en minúsculas. La protección es la misma;
la diferencia es que la clave se puede nombrar.

Los índices parciales siguen siendo válidos **como restricción**, siempre que
nadie los use de árbitro. `diagnostics_session_key` es justo eso: existe para
que una segunda inserción concurrente falle y el código relea la primera.

## Consecuencias

- `supabase/migrations/0005_claves_y_settings.sql` migra las tres tablas, con
  deduplicación previa por si alguien insertó a mano.
- El código normaliza a minúsculas antes de escribir, y el comentario en cada
  sitio dice por qué. Si alguien lo borra, vuelve el duplicado.
- Regla para lo que venga: **el `onConflict` del código y el índice de la
  migración se escriben en el mismo PR.** Un índice único nuevo sin su llamador
  —o al revés— es un 42P10 esperando.
- `GET /api/health` verifica que la columna `answer_key` exista. La pregunta
  "¿corrió la migración?" se responde con un curl.

## Lo que este ADR prohíbe

Un `onConflict` que apunte a columnas que no formen, exactamente, un índice
único plano. Antes de escribirlo, se busca el `create unique index`
correspondiente en `supabase/migrations/`. Si tiene `where` o un paréntesis con
una función adentro, no sirve.
