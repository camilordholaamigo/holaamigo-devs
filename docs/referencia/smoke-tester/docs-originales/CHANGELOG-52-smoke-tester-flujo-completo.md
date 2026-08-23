# Changelog · PRD 52 — Smoke Tester: flujo completo con comprador IA

**18 de agosto de 2026** · rama `backend-openai-supabase`

## Qué se arregló

La prueba de la suite *Prueba OpenAI Mirasol Web* se paraba después de la
primera respuesta del agente. No era un crash: **la secuencia tenía un solo
mensaje**, el runner lo mandó, el agente contestó pidiendo correo y nombre, y
el guion se acabó → `completed` en 46 segundos.

Debajo había una segunda falla, peor: el runner mantenía una función viva
esperando respuestas y Vercel la mata a los 300 s. El intento de las 17:33
(con dos secuencias) quedó colgado en `running` para siempre.

## Qué se construyó

### Comprador IA — `lib/smoke-tester/buyer-ai.ts`
Lee el hilo y redacta el siguiente mensaje del comprador. Identidad fija
(nombre, correo, celular, presupuesto) para que el lead sea verificable en el
CRM, un objetivo hacia el que empuja, y criterio propio de cierre. Sin
`OPENAI_API_KEY` cae a un comprador heurístico y el flujo sigue corriendo.

### Motor por eventos — `lib/smoke-tester/conversation-engine.ts`
Se elimina el polling. Cada respuesta del agente entra por el webhook de wzap
y **ahí mismo** se espera a que termine la ráfaga (10 s de silencio), se
redacta el turno siguiente y se envía. Cada invocación dura menos de un
minuto; la conversación completa puede durar 25 sin tocar ningún límite.

Guarda de concurrencia `turn_token`: los agentes que mandan 3-5 mensajes por
respuesta disparan 3-5 webhooks, y solo el último contesta.

### Arranque — `POST /api/smoke-test/[suiteId]/run-auto`
Manda el primer mensaje en primer plano (si wzap falla, el error se ve al
instante) y devuelve 202. Cancela runs colgados de la misma suite: con un solo
número de pruebas dos conversaciones vivas se pisarían en el webhook.

### UI
Botón **"Flujo completo"** en la vista de la suite + modal de configuración
(objetivo, identidad del comprador, tope de turnos). La vista en vivo muestra
"Turno 3 de 14" y el objetivo cuando el run es autónomo.

### Redes de seguridad
- `GET /api/smoke-test/runs/[runId]` cierra el run si el agente lleva 8 min
  sin contestar. Es la red real: la UI ya consulta ese endpoint cada 2,5 s.
- Watchdog: el caso B dejó de filtrar por `trigger_type` (antes solo rescataba
  runs de Prodesa) y se agregó el **caso D — runs zombis**, que cancela los
  `running` sin actividad hace más de 60 min.
- Limpieza puntual de 5 runs colgados en producción (4 de abril/mayo + el de
  hoy 17:33) que competían por los mensajes entrantes.

## Sin migraciones

El estado del run autónomo vive en `smoke_test_runs.form_data` (`jsonb` que ya
existe y está vacío en los runs manuales). Deliberado: el proyecto arrastra
migraciones sin correr y una nueva habría dejado la función inservible hasta
abrir el SQL editor.

## Archivos

**Nuevos**
- `lib/smoke-tester/buyer-ai.ts`
- `lib/smoke-tester/conversation-engine.ts`
- `app/api/smoke-test/[suiteId]/run-auto/route.ts`
- `components/terminal/smoke-autonomous-run-modal.tsx`
- `docs/prd/52-smoke-tester-flujo-completo.md`

**Modificados**
- `lib/smoke-tester/webhook-handler.ts` — dispara el turno siguiente (rutas 1 y 2)
- `app/api/smoke-test/runs/[runId]/route.ts` — cierre por estancamiento
- `app/api/cron/smoke-campaign-watchdog/route.ts` — caso B ampliado + caso D
- `components/terminal/smoke-suite-view.tsx` — botón "Flujo completo"
- `components/terminal/smoke-test-live.tsx` — progreso por turnos

## Entorno

`OPENAI_API_KEY` recomendada (sin ella, comprador heurístico).
`SMOKE_BUYER_MODEL` opcional, default `gpt-4o-mini`.

## Pendiente

- El auditor de 10 pasos sigue siendo solo de Prodesa.
- El evaluador con Claude no se dispara solo al cerrar (botón aparte, necesita
  `ANTHROPIC_API_KEY`).
