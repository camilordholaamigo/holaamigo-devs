# Índice del código

Todo el código está **tal cual salió de producción**, sin editar. Los únicos
archivos escritos para este paquete son `adaptadores/*` y
`sql/schema-consolidado.sql`.

---

## `lib/smoke-tester/` — el corazón (13 archivos, ~4.000 líneas)

| Archivo | Líneas | Rol | ¿Portable? |
|---|---|---|---|
| `types.ts` | 206 | Todos los contratos. **Empezá acá.** | ✅ tal cual |
| `buyer-ai.ts` | 250 | El comprador sintético: identidad fija, objetivo, cierre propio, fallback heurístico | ✅ cambiando el prompt |
| `conversation-engine.ts` | 567 | El motor por eventos: turno, settle, `turn_token`, cierres, reaper | ✅ tal cual |
| `webhook-handler.ts` | 419 | Correlación de entrantes. Parser tolerante + 3 caminos de match | ✅ cambiando el parser |
| `wzap.ts` | 72 | Transporte (WhatsApp vía wzap.chat) | 🔁 reemplazar por el tuyo |
| `evaluator.ts` | 224 | Evaluador con Claude: 5 dimensiones + alucinaciones + sugerencias | ✅ cambiando el prompt |
| `runner.ts` | 823 | Runner clásico de guion fijo + flujo disparado por formulario | ⚠️ solo si necesitás guion fijo |
| `prodesa-auditor.ts` | 583 | Auditor determinístico de 10 pasos, 100 % regex | ⚠️ la estructura sí, el contenido no |
| `campaign-advancer.ts` | 374 | Colas seriales de escenarios con recuperación | ⚠️ si tenés un solo canal |
| `templates.ts` | 105 | Guiones prefabricados con variables `{proyecto}` | ⚠️ el mecanismo |
| `bubble-trigger.ts` | 179 | Disparo desde un sistema externo | 📖 ejemplo |
| `prodesa-catalog.ts` | 89 | 29 proyectos inmobiliarios | 📖 ejemplo |
| `prodesa-sequence-generator.ts` | 154 | Genera guiones desde los datos del escenario | 📖 ejemplo |

✅ portable · 🔁 reemplazar · ⚠️ adaptar · 📖 leer como referencia

**Orden de lectura sugerido:**
`types.ts` → `buyer-ai.ts` → `conversation-engine.ts` → `webhook-handler.ts` →
`evaluator.ts`. Con esos cinco entendés el sistema completo.

---

## `adaptadores/` — las 6 costuras

Escritos para este paquete. Ver `adaptadores/README.md`.

| Archivo | Reemplaza |
|---|---|
| `db.ts` | `lib/supabase/admin` |
| `logger.ts` | `lib/logger` |
| `phone-utils.ts` | `lib/phone-utils` |
| `openai-responses.ts` | `lib/agent-openai/responses-client` |
| `transporte.ts` | `lib/smoke-tester/wzap.ts` — **e incluye el modo síncrono completo en 40 líneas** |

---

## `app/api/` — 16 rutas

```
smoke-test/
  route.ts                      GET listar suites · POST crear
  [suiteId]/
    route.ts                    GET detalle · DELETE
    run/route.ts                POST · MODO 1 · guion fijo
    run-auto/route.ts           POST · MODO 2 · flujo completo con comprador IA  ★
    run-form/route.ts           POST · MODO 3 · disparo externo
    sequences/route.ts          GET · POST
    sequences/[seqId]/route.ts  PATCH · DELETE
    campaign/route.ts           POST cola serial
    campaign/[queueId]/route.ts GET estado · DELETE cancelar
  runs/[runId]/
    route.ts                    GET estado en vivo (+ red de seguridad) · DELETE  ★
    evaluate/route.ts           POST calificar con LLM
  diagnose/route.ts             GET entorno + último run + 30 logs               ★
  admin/seed-prodesa/route.ts   POST cargar catálogo (específico)
  admin/diagnose-bubble/route.ts GET probar el disparador externo (específico)

webhook/smoker-tester/route.ts  POST · LA ENTRADA DE TODO. Siempre 200.          ★
cron/smoke-campaign-watchdog/route.ts  GET · los 4 casos de recuperación         ★
```

★ = imprescindibles para el modo asíncrono.

---

## `components/` — 11 componentes React + 1 hook

| Archivo | Qué es |
|---|---|
| `smoke-tester-view.tsx` | Lista de suites con estadísticas |
| `smoke-suite-view.tsx` | Detalle de suite: secuencias, historial, botones de arranque |
| `smoke-test-live.tsx` | **Vista en vivo.** Polling cada 2,5 s, "Turno 3 de 14", botón cancelar |
| `smoke-test-report.tsx` | Reporte final: transcripción + notas + alucinaciones |
| `smoke-autonomous-run-modal.tsx` | Configuración del flujo completo (objetivo, identidad, turnos) |
| `smoke-suite-create-modal.tsx` | Crear suite |
| `smoke-sequence-create-modal.tsx` | Crear secuencia (con plantillas) |
| `smoke-prodesa-*.tsx` (4) | UI del flujo disparado por formulario y su auditoría |
| `use-terminal-page.ts` | Hook local de layout |

**Dependencias externas de la UI:** `react`, `next/navigation`, `lucide-react`,
`@/lib/hooks/use-mounted`, `@/lib/hooks/use-route-prefix` (los dos últimos van
incluidos en `lib/hooks/`). Sin librería de componentes: todo es CSS del
proyecto. Si tu app usa otro sistema de diseño, los componentes sirven de
referencia de estructura más que de código copiable.

---

## `lib/hooks/`

| Archivo | Por qué está |
|---|---|
| `use-mounted.ts` | **Evita el bug 7.** Cualquier valor que dependa del reloj se renderiza después del mount |
| `use-route-prefix.ts` | **Evita el bug 8.** Deriva `/central` vs `/terminal` de la URL en vez de hardcodearlo |

---

## `sql/`

| Archivo | Qué es |
|---|---|
| `schema-consolidado.sql` | ★ **Empezá por acá.** Las 3 migraciones aplanadas, anotadas, con recomendaciones y consultas de operación |
| `014_smoke_tester.sql` | Original: 4 tablas + RLS |
| `015_smoke_tester_channel.sql` | Original: `target_phone`, `awaiting_reply`, `last_buyer_at`, índice parcial |
| `022_smoke_tester_form_trigger.sql` | Original: modo formulario, auditoría, colas seriales, catálogo |

---

## `app/paginas/`

Las 4 páginas de Next.js (renombradas para que se vea la ruta original). Son
envoltorios delgados: casi toda la lógica vive en los componentes.

```
/terminal/smoke-tester              → terminal-smoke-tester-page.tsx
/terminal/smoke-tester/[suiteId]    → terminal-smoke-tester-[suiteId]-page.tsx
/central/smoke-tester               → central-smoke-tester-page.tsx
/central/smoke-tester/[suiteId]     → central-smoke-tester-[suiteId]-page.tsx
```
