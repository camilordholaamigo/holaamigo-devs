# Smoke Tester — paquete portable

**Qué es:** un arnés de QA que prueba agentes conversacionales **de punta a
punta y en producción**. No hace mocks: pone a un comprador sintético a
hablarle al agente real por el canal real (WhatsApp), deja que la conversación
llegue hasta el cierre, y después califica la transcripción.

**De dónde sale:** de Rentmies (agente inmobiliario de WhatsApp en Colombia).
Se construyó entre abril y agosto de 2026, en 16 commits, con 12 bugs de
producción documentados. Este paquete trae el código, el esquema, la historia
de esos bugs y las instrucciones para montarlo en otra aplicación.

**Para qué sirve realmente:** para responder *"¿mi agente todavía sirve?"*
después de cada cambio de prompt, de modelo o de datos. Un test unitario te
dice que la función devuelve lo que espera; esto te dice que el agente, con su
prompt real, contra su base real, por su canal real, todavía llega a agendar
una cita sin inventarse un precio.

---

## Los cinco documentos

| Documento | Responde |
|---|---|
| [`01-COMO-FUNCIONA.md`](01-COMO-FUNCIONA.md) | La arquitectura. Por qué es un motor por eventos y no un loop. Las 4 tablas, el ciclo de un turno, la guarda de concurrencia. |
| [`02-COMO-HACE-LAS-PRUEBAS.md`](02-COMO-HACE-LAS-PRUEBAS.md) | Los 3 modos de prueba, el comprador IA, cómo se decide qué decir en cada turno y cuándo parar. |
| [`03-COMO-DEFINE-LOS-RESULTADOS.md`](03-COMO-DEFINE-LOS-RESULTADOS.md) | Las tres capas de veredicto: estado terminal, auditor determinístico, evaluador LLM. Cómo se calculan las notas. |
| [`04-COMO-SE-CONSTRUYE.md`](04-COMO-SE-CONSTRUYE.md) | El port paso a paso a otra app. Qué es núcleo y qué es específico de Rentmies. Los dos caminos (asíncrono / síncrono). |
| [`05-QUE-FUNCIONO-Y-QUE-NO.md`](05-QUE-FUNCIONO-Y-QUE-NO.md) | **El documento más valioso.** Los 12 bugs reales, qué los causó, cómo se arreglaron, y qué haría distinto desde cero. |

Si tenés 10 minutos: leé este README y después el 05.
Si vas a construirlo: 01 → 04 → 05.

---

## En una imagen

```
┌────────────┐   1. mensaje del comprador     ┌──────────────────┐
│  Motor     │ ─────────────────────────────► │ Proveedor de     │
│  (tu app)  │                                │ WhatsApp (wzap)  │
└────────────┘                                └────────┬─────────┘
      ▲                                                │
      │                                                ▼
      │                                       ┌──────────────────┐
      │  3. webhook con la respuesta          │ AGENTE BAJO      │
      └───────────────────────────────────────│ PRUEBA (real,    │
                                              │ en producción)   │
   4. el comprador IA lee el hilo,            └──────────────────┘
      redacta el turno siguiente
      y vuelve al paso 1
      … hasta el cierre (#agendado / #cotizacion / tope de turnos / timeout)
```

Ninguna función se queda esperando. Cada invocación vive menos de un minuto;
la conversación completa puede durar 25 sin chocar con ningún límite de
plataforma. **Esa es la idea central de todo el diseño.**

---

## Inventario del paquete

```
Review Smoke Tester Shared/
├── README.md                       ← estás acá
├── 01-COMO-FUNCIONA.md
├── 02-COMO-HACE-LAS-PRUEBAS.md
├── 03-COMO-DEFINE-LOS-RESULTADOS.md
├── 04-COMO-SE-CONSTRUYE.md
├── 05-QUE-FUNCIONO-Y-QUE-NO.md
│
├── codigo/
│   ├── lib/smoke-tester/           ← el corazón (13 archivos, ~4.000 líneas)
│   │   ├── types.ts                    contratos compartidos
│   │   ├── buyer-ai.ts             ★   el comprador sintético
│   │   ├── conversation-engine.ts  ★   el motor por eventos
│   │   ├── webhook-handler.ts      ★   correlación de mensajes entrantes
│   │   ├── wzap.ts                     transporte (WhatsApp)
│   │   ├── runner.ts                   runner clásico de guion fijo
│   │   ├── evaluator.ts            ★   evaluador con Claude (0-100)
│   │   ├── prodesa-auditor.ts          auditor determinístico de 10 pasos
│   │   ├── campaign-advancer.ts        colas seriales de escenarios
│   │   ├── templates.ts                guiones prefabricados
│   │   ├── bubble-trigger.ts           disparador externo (específico)
│   │   ├── prodesa-catalog.ts          catálogo de escenarios (específico)
│   │   └── prodesa-sequence-generator.ts
│   │
│   ├── README.md                   ← índice archivo por archivo
│   ├── app/api/                    ← 16 rutas (arranque, consulta, cron)
│   ├── app/paginas/                ← las 4 páginas Next.js
│   ├── components/                 ← 11 componentes React (UI en vivo, reportes)
│   ├── lib/hooks/                  ← use-mounted y use-route-prefix (bugs 7 y 8)
│   ├── sql/
│   │   ├── schema-consolidado.sql  ★   TODO el esquema, anotado y portable
│   │   └── 014 / 015 / 022             las migraciones originales
│   └── adaptadores/                ★   las 6 costuras a reemplazar
│       ├── README.md
│       ├── db.ts · logger.ts · phone-utils.ts · openai-responses.ts
│       └── transporte.ts               incluye el MODO SÍNCRONO (40 líneas)
│
└── docs-originales/                ← PRD 52 y su changelog, sin editar
```

★ = leélo antes de portar.

---

## Arranque rápido (asíncrono, el caso completo)

```bash
# 1. Base de datos
psql < codigo/sql/schema-consolidado.sql       # ajustá las FK a tus tablas

# 2. Código
cp -r codigo/lib/smoke-tester   <tu-app>/lib/
cp -r codigo/adaptadores        <tu-app>/lib/
cp -r codigo/app/api/smoke-test <tu-app>/app/api/
# … y arreglá los imports (ver adaptadores/README.md)

# 3. Entorno
WZAP_TOKEN=...          # transporte: cómo mandar mensajes
WZAP_DEVICE=...
OPENAI_API_KEY=...      # comprador IA (sin esto → comprador heurístico)
ANTHROPIC_API_KEY=...   # evaluador (opcional)
SUPABASE_SERVICE_ROLE_KEY=...
CRON_SECRET=...         # watchdog

# 4. Webhook del proveedor → https://tu-app/api/webhook/smoker-tester
# 5. Cron diario         → /api/cron/smoke-campaign-watchdog
```

**Antes de escribir una línea, leé [`04-COMO-SE-CONSTRUYE.md` §1](04-COMO-SE-CONSTRUYE.md).**
La primera decisión —si tu transporte es síncrono o asíncrono— determina si
necesitás el 100 % de este código o el 15 %.

---

## Costo y límites reales

| | |
|---|---|
| Duración de un flujo completo | 12-25 min (el agente real tarda 30-90 s por respuesta) |
| Turnos típicos hasta el cierre | 8-14 |
| Costo IA por conversación | ~USD 0,01-0,03 (comprador `gpt-4o-mini`) + ~USD 0,02 (evaluador Sonnet, opcional) |
| Concurrencia | **1 conversación a la vez por número de pruebas.** Es la limitación más dura; ver 05. |
| Plataforma | Next.js App Router sobre Vercel (`waitUntil`, `maxDuration`). Portable a cualquier runtime con webhooks. |
