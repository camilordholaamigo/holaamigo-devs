# 01 · Arquitectura

## El stack, y por qué

| Pieza | Elección | Por qué esta |
|---|---|---|
| Framework | Next.js 16.3, App Router | Server Components nos dejan consultar la base directo desde la página, sin capa de API para lectura. Menos código, menos superficie. |
| Runtime | Node.js en Fluid Compute | Necesitamos `node:crypto`, streams y 300 s de duración. Edge no daba ninguna de las tres. |
| Base | Supabase Postgres, schema `holaamigo` | Ver ADR 0001. |
| IA | OpenAI Responses API, nativa | Sin framework de orquestación. El `web_search` es tool nativa y la salida estructurada es de primera clase. |
| Validación | Zod 4 | Un solo esquema sirve para el JSON Schema que va al modelo y para validar la respuesta. |
| Estilos | Tailwind v4 con tokens en `@theme` | Sin librería de componentes. Ver `components/ui.tsx`. |
| Despliegue | Vercel | Es donde vive el proyecto. |

**Lo que NO usamos, a propósito:** ORM (el cliente de Supabase alcanza), gestor
de estado (el estado vive en la base), librería de componentes (son cinco
pantallas), librería de gráficos (son seis puntos en un SVG), librería de
animación (CSS con `animation-timeline: view()`).

Cada dependencia que no está es una que no hay que actualizar, auditar ni
entender dentro de seis meses.

## Cómo corre el trabajo largo

El research tarda entre 60 y 180 segundos. Nadie va a esperar eso mirando un
formulario. El patrón es:

```
POST /api/intake
  ├─ inserta organizations + intake_sessions + research_runs(queued)
  ├─ responde en <300 ms  →  el navegador se va a /quiz/[sessionId]
  └─ after(() => executeResearch(runId))   ← sigue vivo tras la respuesta
                ↓ va escribiendo research_runs.progress_log
GET /api/research/stream/[runId]  (SSE)
  └─ el quiz muestra cada paso a medida que ocurre
```

`after()` de `next/server` mantiene la función viva después de enviar la
respuesta. Por eso la ruta declara `maxDuration = 300`.

**Qué pasa si la función se muere igual** (despliegue en curso, error de
infraestructura): el run queda colgado en `running` y el usuario ve una barra
que no avanza. Para eso está `/api/cron/sweep`, que cada 2 minutos busca runs
atascados más de 5 minutos y los reintenta hasta 2 veces, o los marca `partial`.

**Regla que sostiene todo esto:** el diagnóstico se genera aunque el research
haya quedado `partial` o `failed` (PRD §8.3.5). Nunca dejamos al usuario sin
salida. Los números salen de sus respuestas, no del crawl.

## Frontera cliente / servidor

Solo cinco componentes son `'use client'`, y cada uno por una razón concreta:

| Componente | Por qué es cliente |
|---|---|
| `intake-form` | Validación y envío del formulario |
| `quiz-flow` | Máquina de estados de pregunta en pregunta |
| `research-ticker` | `EventSource` para SSE |
| `money-panel` | Recálculo en vivo al mover un supuesto |
| `leads-upload` | Drag & drop y lectura de archivo |

Más `approval-card`, `band-override`, `admin-login-form` y `admin-logout`, que
son islas de interacción del admin.

**Todo lo demás es Server Component** y consulta la base directamente. No hay
cliente de Supabase en el navegador (ADR 0003).

## Mapa de archivos

```
app/
  page.tsx                          Landing
  quiz/[sessionId]/                 Quiz
  diagnostico/[shareToken]/         Diagnóstico público
  conectar/[sessionId]/             Canales
  leads/[orgId]/                    Carga de base
  panel/[orgId]/                    Panel del cliente
  admin-login/                      Login (fuera del árbol protegido)
  admin/                            Interno, protegido por layout
  api/                              Rutas de servidor

lib/
  supabase/admin.ts                 El único cliente de base
  ai/{client,schemas}.ts            Envoltura de OpenAI y esquemas Zod
  research/{run,crawl}.ts           Motor de investigación
  quiz/{bank,service}.ts            Banco y flujo del quiz
  diagnostic/{math,generate}.ts     Aritmética y ensamblaje
  agents/{contracts,health}.ts      Los tres contratos y sus detectores
  leads/ingest.ts                   Pipeline de carga
  {scoring,events,notify,ratelimit,utils,env}.ts

config/
  models.ts        Ruteo de modelos, editable sin desplegar
  prompts.ts       Los prompts de sistema
  assumptions.ts   Supuestos por defecto y tasas por industria
  routes.ts        Las 3 rutas con costos y roadmaps

supabase/migrations/                SQL, idempotente
docs/                               Esto
```

## Convenciones

- **Nada de `any` sin comentario** que explique por qué es inevitable.
- **Los errores nunca tumban el flujo del usuario**: `track()`, `alertSlack()` y
  `sendDiagnosticEmail()` capturan y registran, jamás lanzan.
- **Las variables de entorno se leen perezosamente** (`lib/env.ts`): validar al
  importar rompe builds en Vercel, donde las env de runtime no siempre están
  presentes durante el build.
- **Todo dato que se muestra pasa por Zod** si vino de un modelo.
