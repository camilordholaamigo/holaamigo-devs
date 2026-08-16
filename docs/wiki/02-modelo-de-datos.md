# 02 · Modelo de datos

Todo vive en el schema `holaamigo` (ADR 0001). Las migraciones están en
`supabase/migrations/` y son **idempotentes**: se pueden correr varias veces.

## Los seis grupos

```
ORGANIZACIÓN          organizations ─┬─ intake_sessions
                                     ├─ briefs
                                     └─ prospect_scores

INVESTIGACIÓN         research_runs ── research_findings
                          └─ reused_from_run_id → research_runs (caché)

QUIZ                  quiz_questions (catálogo global)
                      quiz_generated (adaptativas por sesión)
                      quiz_responses (respuestas)

DIAGNÓSTICO           diagnostics ── recommendations

EJECUCIÓN             agents ── agent_runs
                      angles · campaigns · messages
                      leads ── lead_batches · suppressions
                      channel_connections

CONTROL               approvals · plg_events · rate_limits
```

## Las decisiones que hay que conocer

### `organizations.domain` es una columna generada

```sql
domain text generated always as (
  lower(regexp_replace(website_url, '^https?://(www\.)?([^/]+).*$', '\2'))
) stored
```

Con un índice único encima. Esto significa **una organización por dominio**, y
es lo que hace posible la caché de research sin una tabla extra (ADR 0004).
También significa que si dos personas de la misma empresa entran, comparten
organización — que es lo correcto: es la misma empresa.

### `briefs` tiene un índice único parcial

```sql
create unique index on briefs (organization_id) where is_current;
```

Postgres garantiza que solo puede haber **un** brief vigente por organización.
No es una convención que el código deba respetar: es imposible violarla. Por eso
`writeBrief()` primero pone `is_current = false` en el anterior y después
inserta.

### `leads` se deduplica por `coalesce(email, phone_e164)`

```sql
create unique index on leads (organization_id, coalesce(email, phone_e164));
```

Un contacto es único por correo, o por teléfono si no hay correo.

**Ojo:** PostgREST no puede apuntar un `ON CONFLICT` a un índice de expresión.
Por eso `persistBatch()` lee las claves existentes y filtra en la aplicación
antes de insertar. El índice queda como red de seguridad ante carreras, no como
mecanismo principal. Está comentado en el código.

### `diagnostics.share_token` no usa pgcrypto

```sql
default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
```

64 caracteres hex de dos UUID v4. Se podría haber usado
`encode(gen_random_bytes(16), 'hex')`, pero eso depende de que pgcrypto esté
instalado y en el `search_path` — cosa que varía entre proyectos de Supabase.
`gen_random_uuid()` es built-in desde Postgres 13. Cero dependencias, misma
imposibilidad práctica de adivinarlo.

### `quiz_responses.answer_key` es generada, y de ahí sale su única clave

```sql
answer_key text generated always as (coalesce(question_id, slot)) stored
create unique index quiz_responses_key on quiz_responses (session_id, answer_key)
```

Cubre los dos tipos de pregunta —fija con `question_id`, adaptativa con `slot`—
con **un** índice único plano, así que re-responder actualiza en vez de duplicar
y el `upsert` tiene un solo `onConflict`.

**Antes eran dos índices únicos parciales y no funcionaba ninguno.** Postgres no
puede usar un índice parcial como árbitro de un `ON CONFLICT` que no repite su
predicado: cada respuesta del quiz fallaba con `42P10`. La regla que salió de
ahí —una clave de upsert es siempre un índice único **plano** sobre columnas
reales— está en [ADR 0015](../adr/0015-claves-de-upsert-planas.md), y es la
razón de que `products` y `mailboxes` ya no indexen sobre `lower(...)`.

### `diagnostics(session_id)` sí es un índice parcial, y está bien

Es la excepción que confirma la regla: existe como **restricción**, no como
clave de upsert. Nadie apunta un `ON CONFLICT` ahí. Su trabajo es que dos
generaciones concurrentes no creen dos diagnósticos; la que pierde relee la de
la ganadora.

### `agent_runs` guarda `organization_id` y `role` además de `agent_id`

Es desnormalización deliberada. `agent_id` es null en las corridas que ocurren
**antes** de que los agentes existan — el research y el quiz adaptativo corren
durante el intake, y los agentes se instancian al generar el diagnóstico. Sin
las columnas redundantes no podríamos atribuir esos costos a nadie, y el costo
por diagnóstico de `/admin/runs` sería falso.

### `prospect_scores.total_score` es generada

```sql
total_score int generated always as (fit_score + intent_score) stored
```

Con índice. Ordenar prospectos por score no calcula nada en tiempo de consulta.

## Los estados y sus transiciones

**`intake_sessions.status`**
```
started → quiz → diagnosed → connected → leads_uploaded → activated
   └──────────────→ abandoned  (cron, tras 6 h sin actividad)
```
Volver a una sesión abandonada la reactiva y registra `returned_48h`, que vale
5 puntos de intent.

**`research_runs.status`**
```
queued → running → done | partial | failed
            └─→ queued  (reintento del cron, máx. 2)
```
`partial` significa "tenemos algo y sirve". `failed` significa "no pudimos leer
nada", y aun así el diagnóstico se genera con las respuestas del quiz.

**`agents.status`**
```
draft → active → degraded → active
          └──→ paused
```
SALES nace en `draft` a propósito: es el único que ejecuta, y no ejecuta nada
hasta que haya canal conectado y aprobación registrada.

**`leads.status`**
```
new → queued → contacted → replied → qualified → booked
                    └────→ lost
  cualquiera ────────────→ suppressed  (opt-out, rebote duro, queja)
```
`suppressed` es terminal. Nunca se sale de ahí automáticamente.

## Modelo de seguridad

RLS habilitado **y forzado** en todas las tablas, con **cero políticas**. Efecto:
denegación total para `anon` y `authenticated`. Todo pasa por `service_role`
desde código de servidor. El razonamiento completo está en ADR 0003.

---

## v2 · Las tablas del motor de correo

`supabase/migrations/0003_motor_de_correo.sql`. Mismo schema, mismas reglas: RLS
deny-by-default sobre todas, acceso solo con `service_role` desde servidor.

| Tabla | Qué guarda | Explicada en |
|---|---|---|
| `integrations` | Credenciales por proveedor (SendGrid, Instantly) | [10](./10-correo-y-bandejas.md) |
| `mailboxes` | Las bandejas del cliente, con topes y calentamiento | [10](./10-correo-y-bandejas.md) |
| `email_threads` | La conversación, no el mensaje suelto | [10](./10-correo-y-bandejas.md) |
| `campaign_metrics` | Rollup diario por campaña | [11](./11-campanas.md) |
| `assets` · `asset_events` | Agendador y checkout, y cada interacción | [12](./12-activos-agenda-y-checkout.md) |
| `bookings` | Las citas | [12](./12-activos-agenda-y-checkout.md) |
| `products` · `orders` | Inventario y ventas atribuidas | [12](./12-activos-agenda-y-checkout.md) |
| `credit_ledger` | Contabilidad de créditos, solo inserts | [ADR 0011](../adr/0011-creditos.md) |
| `feed_items` | Cómo habla el President | [13](./13-feed-y-autonomia.md) |
| `scheduled_actions` | Qué está programado, por qué y cómo se mide | [14](./14-observabilidad.md) |

### Columnas nuevas sobre tablas de v1

- **`campaigns`** — dejó de ser una lista de envíos: `objective`, `hypothesis`,
  `segment_rules`, `sequence`, `expected`, `measurement`, `iteration`,
  `credits_estimate`, `mailbox_ids`, `asset_id`.
- **`messages`** — `thread_id`, `mailbox_id`, `subject`, `from_address`,
  `to_address`, `headers`, `step_index`, `scheduled_for`, `classification`.
- **`agents`** — `config` y `autonomy`. El contrato (objetivo, presupuesto,
  permisos, escalamiento) sigue en sus columnas originales y **no es editable**.
- **`leads`** — `source`, `external_ref`, `timezone`.

### Índices que importan

- `messages_due_idx` — parcial sobre `status = 'scheduled'`. Es la consulta del
  despachador, cada 5 minutos, sobre una tabla que crece con cada envío.
- `bookings_slot_key` — único parcial sobre `(asset_id, starts_at)` para citas
  vivas. La última red contra dos personas tomando el mismo cupo.
- `feed_items_dedupe_key` — único parcial. Es lo que garantiza un digest por día
  y una alerta por regla por día.
- `mailboxes_inbound_key` — único sobre el alias de recepción: es la llave por
  la que entra cada respuesta.
