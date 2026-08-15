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

Son idempotentes: se pueden correr varias veces sin romper nada.

Verificación:
```sql
select count(*) from holaamigo.quiz_questions;  -- debe dar 7
select tablename from pg_tables where schemaname = 'holaamigo';  -- 20 tablas
```

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

## La primera prueba de humo

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

### Corridas `failed` con `model_not_found`

El nombre de modelo no existe en tu cuenta. La cadena de fallback ya degradó a
la alternativa, así que el producto sigue vivo — pero con menos calidad.

Arreglo sin desplegar:
```bash
vercel env add MODEL_RESEARCH production   # p.ej. "gpt-4.1"
vercel env add MODEL_DIAGNOSIS production
```

### Costo por diagnóstico por encima de USD 1,20

`/admin/runs` desglosa el costo por paso. Casi siempre es `research`.

- Bajar `maxOutputTokens` de `research` en `config/models.ts`.
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
