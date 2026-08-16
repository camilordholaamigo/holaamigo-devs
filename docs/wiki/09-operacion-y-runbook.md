# 09 · Operación y runbook

## Desplegar por primera vez

### 1 · Exponer el schema en Supabase — **este paso se olvida siempre**

Dashboard → Project Settings → **Data API** → *Exposed schemas* → agregar
`holaamigo` → Save.

Sin esto, PostgREST devuelve 404 en todas las tablas y **nada funciona**. Es el
primer sitio donde mirar si toda la app falla a la vez.

### 2 · Correr las migraciones

SQL Editor, en orden:

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_seed_quiz.sql`
3. `supabase/migrations/0003_motor_de_correo.sql`
4. `supabase/migrations/0004_exponer_api.sql`
5. `supabase/migrations/0005_claves_y_settings.sql`

Son idempotentes: se pueden correr varias veces sin romper nada.

**La 0005 no es opcional ni en una base ya en producción.** Es la que arregla
las claves de upsert: sin ella el quiz no guarda una sola respuesta y no avanza
de la primera pregunta, sin mostrar ningún error. Ver
[ADR 0015](../adr/0015-claves-de-upsert-planas.md).

Verificación:
```sql
select count(*) from holaamigo.quiz_questions;  -- debe dar 7
select tablename from pg_tables where schemaname = 'holaamigo';  -- 21 tablas
-- las cuatro claves de la 0005:
select indexname from pg_indexes where schemaname = 'holaamigo'
  and indexname in ('quiz_responses_key','products_sku_key',
                    'mailboxes_address_key','diagnostics_session_key');
```

O, sin abrir el SQL Editor: `curl https://TU_DOMINIO/api/health` y mirar que
`db:v3` esté en verde.

### 3 · Variables de entorno

```bash
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add OPENAI_API_KEY production
vercel env add ADMIN_PASSWORD production
vercel env add CRON_SECRET production
vercel env add NEXT_PUBLIC_SITE_URL production
```

Opcionales, que degradan a log si faltan: `RESEND_API_KEY`, `SLACK_WEBHOOK_URL`,
`NEXT_PUBLIC_CALCOM_URL`.

**El producto corre entero sin Resend y sin Slack.** Que falte una notificación
no puede impedir que alguien termine su diagnóstico.

### 4 · Verificar el plan de Vercel

`vercel.json` declara el cron cada 2 minutos. **Eso exige plan Pro.** En Hobby
solo hay crons diarios: hay que cambiar el schedule a `0 0 * * *`.

El cron es una red de seguridad, no el camino principal — el research corre por
`after()`. Con cron diario el producto funciona; lo que se pierde es la
recuperación rápida de corridas atascadas.

### 5 · Desplegar

```bash
vercel --prod
```

## Antes de desplegar

```bash
npx tsc --noEmit && npm run lint && npm run build   # nada roto
npm test                                            # Postgres real, sin Docker
```

`npm test` corre sobre PGlite (Postgres compilado a WASM). Hace dos cosas:

- **`test-claves.mjs`** reproduce el bug de las claves de upsert con el esquema
  viejo y prueba que el nuevo funciona. La primera prueba está escrita para
  *fallar como falla producción*: si algún día deja de fallar, Postgres cambió
  esa regla y hay que revisar el [ADR 0015](../adr/0015-claves-de-upsert-planas.md).
- **`test-migraciones.mjs`** corre las cinco migraciones en orden, **dos veces**,
  sobre una base limpia. Es la única forma honesta de decir "es idempotente":
  acá las migraciones se pegan a mano en el SQL Editor y correr una dos veces
  por accidente no es hipotético.

## La primera prueba de humo

**Automática, y es la que hay que correr siempre primero:**

```bash
node scripts/smoke.mjs https://TU_DOMINIO
```

Recorre el flujo real —intake → quiz → diagnóstico → panel— sin mocks. Falla si
una pregunta del quiz se repite después de responderla, que es exactamente el
bug de la v2.0.1. Tarda un par de minutos porque espera al research de verdad.
Con `CRON_SECRET` en el entorno, además imprime el detalle de `/api/health`.

**Manual, para mirar el producto con ojos de cliente:**

1. Abrir la landing, poner un dominio real y sencillo (evitar SPAs pesadas la
   primera vez).
2. El quiz debe aparecer en menos de un segundo.
3. **El ticker debe empezar a moverse a los 5–10 segundos.** Si no se mueve:
   revisar logs de `/api/intake`.
4. Terminar el quiz. Debe llegar al diagnóstico en menos de 90 segundos.
5. Mover un supuesto: el número tiene que cambiar **al instante**, sin spinner.
6. Entrar a `/admin-login`, después `/admin/runs`: la corrida debe estar ahí con
   su costo. **Debe ser menos de USD 1,20.**

## Cuando algo se rompe

### Todo falla, cualquier ruta que toque la base

→ El schema no está expuesto (paso 1) o `SUPABASE_SERVICE_ROLE_KEY` está mal.
Los logs de Vercel muestran `relation "..." does not exist` o un 404 de
PostgREST.

### El ticker no se mueve

1. `/admin/runs` — ¿hay una corrida `research`?
2. Si dice `failed`: el campo `error` tiene el motivo (hover sobre el estado).
3. Si no hay corrida: `after()` no se ejecutó. Revisar logs de `/api/intake`.
4. Consulta directa:
   ```sql
   select status, attempts, error, progress_log
   from holaamigo.research_runs order by created_at desc limit 5;
   ```
5. El cron lo recoge a los 5 minutos igual.

### El quiz no avanza de una pregunta

Es el bug de la v2.0.1 y ya no debería poder pasar en silencio: hoy la ruta
devuelve 500 y la pantalla muestra un mensaje. Si vuelve a aparecer:

1. `curl https://TU_DOMINIO/api/health?key=$CRON_SECRET` → mirar `db:v3`.
   Si está en rojo, falta correr `0005_claves_y_settings.sql`.
2. Logs de `/api/quiz/answer`. El error trae contexto: `[db:quiz_responses.upsert]`.
3. Si dice `42P10` o *no unique or exclusion constraint*: el índice
   `quiz_responses_key` no existe o alguien lo cambió por uno parcial. Ver
   [ADR 0015](../adr/0015-claves-de-upsert-planas.md).

### Corridas `failed` con `model_not_found`

El nombre de modelo no existe en tu cuenta. La cadena de fallback ya degradó a
la alternativa, así que el producto sigue vivo — pero con menos calidad.

Arreglo, sin desplegar y sin tocar Vercel: **`/admin/modelos`**, cambiar la
cadena del paso afectado y guardar. Toma efecto en menos de 30 segundos.

### Corridas `failed` con respuesta vacía o cortada

El mensaje lo dice: *"devolvió una respuesta vacía o cortada con
max_output_tokens=N"*. Es un modelo de razonamiento que gastó el presupuesto
pensando y no alcanzó a escribir. En `/admin/modelos`: subir el tope de tokens
de ese paso, o bajar el esfuerzo a `minimal`.

### Quiero subir o bajar la calidad del análisis

`/admin/modelos`. Los pasos que se notan son `diagnosis` (el texto que el
cliente lee) y `research` (la calidad del análisis competitivo). Los demás son
mecánicos.

Se puede bajar sin miedo: ninguna cifra del diagnóstico sale del modelo
([ADR 0007](../adr/0007-numeros-deterministas.md)). La misma pantalla muestra
cuánto costó cada paso los últimos 30 días.

### Costo por diagnóstico por encima de USD 1,20

`/admin/runs` desglosa el costo por paso. Casi siempre es `research`.

- Bajar el tope de tokens de `research` desde `/admin/modelos`.
- Bajar el modelo de `research` a la familia mini/nano.
- Reducir el tope de subpáginas del crawler (`pickSubpages(..., 3)`).
- Verificar que la caché por dominio esté funcionando: si ves muchas corridas
  del mismo dominio, algo está mal con `reused_from_run_id`.

### El diagnóstico sale vacío o muy pobre

Mirar `research_quality` en la tabla `diagnostics`:

- `full` → el research funcionó; el problema es el prompt de diagnóstico.
- `partial` → el crawl leyó poco. Normal en SPAs sin SSR.
- `none` → no se leyó nada. El diagnóstico se generó solo con el quiz, que es el
  comportamiento correcto.

### No llegan correos

Sin `RESEND_API_KEY`, `sendDiagnosticEmail()` registra la URL en el log y
devuelve `{ sent: false, reason: 'sin_credencial' }`. **No es un error.** Con la
clave puesta, verificar el dominio en Resend.

### No llegan alertas de Slack

Igual: sin `SLACK_WEBHOOK_URL` van al log. Buscar `[slack]` en los logs de
Vercel.

### No puedo entrar al admin

- ¿`ADMIN_PASSWORD` está en el entorno correcto (production vs preview)?
- ¿Diez intentos fallidos en la última hora? El rate limit por IP corta.
  Reset manual: `delete from holaamigo.rate_limits where bucket like 'admin:login:%';`

## Mantenimiento periódico

| Cada | Qué |
|---|---|
| Diario | `/admin/prospects` — ¿algún ATTACK sin contactar? |
| Diario | `/admin/approvals` — vaciar la cola |
| Semanal | `/admin/runs` — costo por diagnóstico contra la meta |
| Semanal | `/admin/agents` — ¿alguno degradado? |
| Mensual | Limpiar `rate_limits` (crece sin tope) |
| Mensual | Revisar la tasa FX en `config/assumptions.ts` (ADR 0006) |

Limpieza de rate limits:
```sql
delete from holaamigo.rate_limits where window_start < now() - interval '7 days';
```

## Desarrollo local

```bash
cp .env.example .env.local   # llenar las claves
npm run dev
```

Sin `OPENAI_API_KEY` el research falla, pero el resto del flujo funciona: el
quiz usa las preguntas de respaldo y el diagnóstico usa `fallbackDiagnosis()`.
Es una forma útil de trabajar en la UI sin gastar tokens.

Antes de cualquier commit:
```bash
npx tsc --noEmit
npm run build
```

## Métricas que vigilamos (PRD §11)

| Métrica | Meta | Dónde |
|---|---|---|
| Visitante → submit | ≥35% | `plg_events` · `landing_submit` |
| Submit → quiz completo | ≥60% | `quiz_completed` / `landing_submit` |
| Landing → diagnóstico visible | <6 min p75 | `created_at` de sesión vs diagnóstico |
| Quiz → canal o leads | ≥30% | `channel_connected` + `leads_uploaded` |
| Costo de IA por diagnóstico | <USD 1,20 | `/admin/runs` |
| Diagnósticos con research parcial | <15% | `diagnostics.research_quality` |
| ATTACK contactados en <30 min | 100% | `prospect_scores.alerted_at` |

Consulta de embudo:
```sql
select event, count(*) as veces, count(distinct organization_id) as orgs
from holaamigo.plg_events
where created_at > now() - interval '7 days'
group by event order by veces desc;
```

---

## v2 · Runbook del motor de correo

### "No está saliendo ningún correo"

En este orden, que es de más frecuente a menos:

1. **¿Hay bandeja con cupo?** `/consola/[orgId]/agentes` muestra usado/tope de
   hoy. Si el tope de calentamiento está bajo, es correcto: el buzón es nuevo.
2. **¿Hay saldo de créditos?** A cero, el despachador pausa la campaña y publica
   una alerta en el feed.
3. **¿Estamos en franja horaria?** La configuración de SALES define desde y
   hasta qué hora, y qué días. Fuera de franja los correos esperan.
4. **¿La bandeja está verificada?** Una bandeja en `pending` no envía. El correo
   de verificación de SendGrid llegó a la dirección del cliente, no a nosotros.
5. **¿La campaña sigue activa?** Una regla de iteración pudo pausarla sola; la
   razón está en `campaigns.paused_reason` y en el feed.

```sql
select error, count(*) from holaamigo.messages
where status = 'skipped' and organization_id = :org
group by error order by count(*) desc;
```

### "Subieron los rebotes"

El buzón se pausa solo por encima de 5%. Qué hacer:

1. Verificar SPF, DKIM y DMARC del dominio en SendGrid.
2. Validar la base: rebote alto casi siempre es base sucia, no infraestructura.
3. Bajar `daily_cap` y dejar que la rampa de calentamiento suba de nuevo.
4. No reactivar el buzón hasta haber hecho 1 y 2. Reactivar y seguir enviando es
   cómo se pierde un dominio para siempre.

### "Llegó una respuesta y no aparece en la bandeja"

- ¿El `to` del correo era el `inbound_address` de una bandeja nuestra? La
  Inbound Parse recibe todo el subdominio; lo que no reconocemos se descarta.
- ¿La URL del webhook en SendGrid tiene el `?k=` correcto? Sin el secreto,
  devolvemos 401 y SendGrid reintenta 72 horas.
- Revisar los logs de la función: el inbound siempre devuelve 200, así que un
  fallo de procesamiento no se ve en el panel de SendGrid.

### "El President no está proponiendo nada"

Es lo más probable que sea correcto. Revisar en orden:

1. ¿Hay 4 o más items abiertos en el feed? Se calla a propósito.
2. ¿El agente President está en `active`?
3. ¿Hay campañas en `proposed` con audiencia disponible?
4. ¿Hay bandejas con cupo? Sin capacidad no propone un envío que no cabe.

### "Un cliente pidió que no le escribamos más"

`suppressions` es global y por organización. Insertar ahí es suficiente: el
despachador lo verifica en cada correo, aunque la campaña esté aprobada.

```sql
insert into holaamigo.suppressions (organization_id, email, reason, source)
values (:org, lower(:email), 'manual', 'soporte');

update holaamigo.messages set status = 'skipped', error = 'supresión manual'
where status = 'scheduled' and to_address = lower(:email);
```

### Variables nuevas de v2

Todas listadas en `.env.example`. La única **obligatoria en producción** es
`SENDGRID_WEBHOOK_PUBLIC_KEY`: sin ella el webhook de eventos rechaza todo y
las métricas de entrega se quedan vacías.

---

## El primer arranque en un proyecto de Supabase nuevo

Tres pasos, y **los tres son obligatorios**. Saltarse el segundo produce el modo
de falla más caro que hemos tenido: todo parece bien y nada funciona.

### 1 · Correr las migraciones

SQL Editor del proyecto, en orden:

```
0001_init.sql            → las 20 tablas de v1, RLS, grants
0002_seed_quiz.sql       → las preguntas fijas
0003_motor_de_correo.sql → las 13 tablas de v2
0004_exponer_api.sql     → expone el schema a la API (ver paso 2)
```

Todas son idempotentes.

### 2 · Exponer el schema `holaamigo` a la API

**Project Settings → API → Data API → Exposed schemas → agregar `holaamigo`.**

Por qué existe este paso: ADR 0001 puso todo en un schema dedicado, y PostgREST
solo atiende los schemas de su lista de expuestos, que por defecto es
`public, graphql_public`.

El síntoma cuando falta es engañoso: las tablas existen, los permisos están
bien, el `service_role` es correcto, y **cada consulta falla**:

```
Error: Invalid schema: holaamigo      (PostgREST PGRST106)
```

que el usuario ve como *"Algo se rompió de nuestro lado"*.

`0004_exponer_api.sql` lo hace por SQL, pero el dashboard es la fuente
duradera: si Supabase reescribe la configuración del rol en un mantenimiento,
el valor del dashboard es el que manda.

### 3 · Cargar las variables de entorno

Las de `.env.example`. Ojo con el nombre: la key de OpenAI se llama
`OPENAI_API_KEY`, exactamente. Una variable con el nombre equivocado no falla
en el intake —que no llama al modelo— sino más tarde, en el research, con
`Falta la variable de entorno OPENAI_API_KEY` dentro de un trabajo de
background que el usuario nunca ve.

---

## `GET /api/health` — el chequeo de dos segundos

Antes de diagnosticar nada a mano, esta ruta contesta si el problema es de
configuración:

```bash
curl https://TU_DOMINIO/api/health
```

```jsonc
{ "ok": false, "checks": [
  { "name": "env:supabase",  "ok": true  },
  { "name": "env:openai",    "ok": false },   // ← falta la key
  { "name": "db:schema",     "ok": true  },   // ← el schema está expuesto
  { "name": "db:v1",         "ok": true  },
  { "name": "db:v2",         "ok": false },   // ← falta correr 0003
  { "name": "db:seed_quiz",  "ok": true  },
  { "name": "env:sendgrid",  "ok": false }    // ← no bloquea: degrada
]}
```

Devuelve **503** cuando algo bloqueante está roto, así que sirve como
health check de monitoreo sin configurar nada más.

Para ver los mensajes de error y qué comando corre cada arreglo, hay que estar
autenticado: entrar a `/admin-login` y volver a `/api/health`, o llamarla con
`?key=$CRON_SECRET`. Los nombres de los chequeos son públicos; los mensajes,
no — nombran infraestructura.

### Qué bloquea y qué no

| Chequeo | ¿Bloquea? |
|---|---|
| `env:supabase`, `db:schema`, `db:v1`, `db:seed_quiz` | **Sí.** Sin eso no hay producto |
| `db:v2` | No para el diagnóstico; sí para campañas |
| `env:openai` | El diagnóstico degrada, pero sin research ni copy |
| `env:sendgrid` | No. Los envíos se registran en el log y no salen |
