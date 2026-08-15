# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico. Fechas en ISO.

Cada entrada dice **qué cambió** y **qué hay que hacer para desplegarla**. Una
entrada sin sus pasos de despliegue es una entrada incompleta.

---

## [1.0.0] — 2026-08-15

MVP completo del Motor de Ventas v1. Todo el PRD §2 "Dentro de v1", construido
de cero en una sesión.

### Añadido

**Base de datos** (`supabase/migrations/`)
- `0001_init.sql` — 20 tablas en el schema `holaamigo`, RLS deny-by-default en
  todas, índices, triggers de `updated_at`. Idempotente.
- `0002_seed_quiz.sql` — las 6 preguntas fijas + la de cierre (PRD §6).

**Motor de investigación** (§4.1, §8.3)
- `POST /api/intake` responde en <300 ms y encola el research con `after()`.
- Crawler propio sin dependencias (`lib/research/crawl.ts`): lee home + hasta
  3 subpáginas, detecta WhatsApp, chat, formularios, idiomas y promesas de
  tiempo de respuesta. Genera el progreso REAL que alimenta el quiz.
- Una llamada al modelo con `web_search` sobre el sitio ya leído.
- Caché por dominio de 30 días vía `research_runs.reused_from_run_id`.
- Rate limit por IP (5/h) y por dominio (3/día).

**Progreso en vivo** (§4.2)
- SSE en `GET /api/research/stream/[runId]` con fallback automático a polling.
- Desvío del PRD, documentado en `adr/0002`.

**Quiz adaptativo** (§4.2, §6)
- 6 fijas → hasta 5 generadas por el CMO con hallazgos reales → 1 de cierre.
- Guardado incremental: cada respuesta persiste al instante.
- `goal_90d` garantizada aunque el modelo falle: alimenta la cuenta al revés.
- Respaldo completo si el research quedó vacío.

**Diagnóstico** (§7)
- Las 6 secciones. Toda afirmación con fuente o marca de `inferido`.
- Fugas con fórmula visible y supuestos editables con recálculo **en el
  navegador**, usando las mismas funciones puras del servidor.
- Cuenta al revés completa con detección de metas aritméticamente imposibles.
- Matriz de posicionamiento en SVG inline, ejes elegidos por el President.
- Enlace permanente por `share_token` de 64 caracteres.
- Correo automático con el enlace (degrada a log si falta `RESEND_API_KEY`).

**Las 3 rutas** (§4.4)
- Costos separados en infraestructura y fee, calculados desde los supuestos
  reales del cliente. Roadmaps con fechas absolutas desde hoy.
- Prerequisitos visibles, incluida la aprobación de plantillas de Meta.
- La Ruta C dispara conversación humana, no autoservicio.

**Canales y leads** (§4.5, §4.6)
- Conexión de canal con skip visible y sin penalización.
- Carga de CSV/XLSX/pegado con mapeo asistido por IA — con diccionario primero
  para no gastar la llamada cuando no hace falta.
- Normalización de teléfonos a E.164 con detección de país.
- Dedup contra el archivo y contra la base existente. Supresión global aplicada
  en la carga.
- Segmentación automática por temperatura.
- Checkbox de base legal obligatorio, con IP y timestamp.

**Los tres agentes** (§3)
- Contratos completos con objetivo, presupuesto, permisos, prohibiciones y
  escalamiento. SALES arranca en `draft`: no ejecuta hasta que haya aprobación.
- Ángulos entran como `proposed` y crean trabajo en la cola de decisiones.
- Brief vivo versionado como único objeto de contexto (§13.2).

**Admin** (§9)
- Scoring FIT/INTENT con bandas AUTO/ASSIST/ATTACK y alerta a Slack en ATTACK.
- Override manual de banda con nota obligatoria.
- Ficha 360: timeline, respuestas, brief, corridas con costo, leads, cola.
- Cola de decisiones global: aprobar es un clic, rechazar exige nota.
- Salud de agentes con los 5 detectores heredados del QA de Inacar.
- Log de corridas con costo por diagnóstico contra la meta de USD 1,20.

**Infraestructura**
- Cliente de OpenAI con validación Zod, cadena de fallback de modelos,
  degradación a esquema mínimo y registro de costo en `agent_runs`.
- Cron de barrido cada 2 minutos para corridas atascadas y salud de agentes.
- Webhooks de WhatsApp (con verificación de firma HMAC) y de correo.
- Supresión automática ante opt-out, rebote duro y queja de spam.

### Desvíos del PRD, todos deliberados

| PRD dice | Hicimos | Por qué |
|---|---|---|
| Next.js 14 | Next.js 16.3 | Greenfield sobre Node 24. App Router es el mismo; 16 es lo que Vercel soporta mejor hoy. |
| Supabase Realtime para el progreso | SSE + polling | Realtime exigiría abrir una política de SELECT a `anon` sobre `research_runs`. Ver `adr/0002`. |
| Schema `public` implícito | Schema `holaamigo` | El proyecto es compartido con Rentmies en producción. Ver `adr/0001`. |
| Admin con Supabase Auth + allowlist | Contraseña + cookie HMAC | 3 usuarios internos. Ver `adr/0005`, incluye el camino de migración. |
| Sprints de 45 días | Todo en una sesión | Instrucción explícita: "cambia días por minutos". |

### Pasos para desplegar

1. **Exponer el schema en Supabase.** Dashboard → Project Settings → Data API →
   *Exposed schemas*: agregar `holaamigo`. Sin esto, PostgREST devuelve 404 en
   todas las tablas.
2. **Correr las migraciones** en el SQL Editor, en orden: `0001_init.sql`,
   luego `0002_seed_quiz.sql`. Son idempotentes.
3. **Cargar variables de entorno** (ver `.env.example`). Obligatorias:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
   `ADMIN_PASSWORD`, `CRON_SECRET`.
4. **Verificar el plan de Vercel.** El cron corre cada 2 minutos, lo que exige
   plan Pro. En Hobby hay que bajarlo a `0 0 * * *` en `vercel.json`.
5. **Confirmar los nombres de modelo** en `/admin/runs` después del primer
   diagnóstico. Si aparecen corridas `failed` con `model_not_found`, la cadena
   de fallback ya degradó — ajustar con las env vars `MODEL_*`.

### Pendiente conocido

- OAuth real de Meta y de Google/Microsoft (v1 registra intención, §13.3).
- Envío saliente de WhatsApp y de correo: la infraestructura está, falta
  conectar el proveedor y las plantillas aprobadas.
- Tasa FX USD→COP constante en `config/assumptions.ts` (ver `adr/0006`).
- Sin suite de tests automatizados.
