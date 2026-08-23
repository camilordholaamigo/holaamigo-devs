# 04 · Cómo se construye (port a otra aplicación)

---

## 1. La primera decisión: ¿tu transporte es síncrono o asíncrono?

**Contestá esto antes de escribir una línea.** Define si necesitás el 100 % de
este código o el 15 %.

```
¿Cómo le hablás al agente bajo prueba?

├── Le mando un HTTP y en la MISMA respuesta viene lo que contestó
│   (API propia, WebSocket, SDK en proceso, endpoint de chat)
│   → SÍNCRONO · andá a §6. Son ~40 líneas.
│
└── Le mando algo y la respuesta llega DESPUÉS por otro canal
    (WhatsApp, SMS, email, un CRM que te hace callback)
    → ASÍNCRONO · seguí acá. Necesitás todo.
```

Casi todo el aparato de esta carpeta —el motor por eventos, el `turn_token`,
el settle de ráfagas, los tres watchdogs— existe **solo** para sobrevivir al
asincronismo. Si podés evitarlo, evitalo.

Un matiz importante: el agente de Rentmies se puede probar por HTTP
(`/api/v1/responses`), y aun así el smoke tester se hizo por WhatsApp. La
razón es deliberada: **por HTTP probás el agente; por WhatsApp probás el
producto** — el canal, la plantilla, el proveedor, la latencia real, las
ráfagas, el webhook, el registro en el CRM. Si tu objetivo es "¿el prompt
sigue sirviendo?", el modo síncrono alcanza. Si es "¿el sistema completo sigue
funcionando en producción?", vas a querer el asíncrono.

---

## 2. Qué es núcleo y qué es de Rentmies

### Núcleo — copiar tal cual

```
lib/smoke-tester/types.ts                 contratos
lib/smoke-tester/buyer-ai.ts              el comprador sintético
lib/smoke-tester/conversation-engine.ts   el motor por eventos
lib/smoke-tester/webhook-handler.ts       correlación de entrantes
lib/smoke-tester/wzap.ts                  transporte (cambiá el proveedor)
lib/smoke-tester/evaluator.ts             evaluador LLM
app/api/smoke-test/[suiteId]/run-auto/    arranque del flujo completo
app/api/smoke-test/runs/[runId]/          estado + red de seguridad
app/api/webhook/smoker-tester/            entrada del webhook
app/api/cron/smoke-campaign-watchdog/     recuperación
sql/schema-consolidado.sql                bloques 1, 2, 3 y 5
```

Lo único que hay que tocar de estos archivos son **los imports** (ver
`codigo/adaptadores/README.md`) y **las etiquetas de cierre** de tu dominio.

### Semi — la estructura sirve, el contenido no

```
lib/smoke-tester/prodesa-auditor.ts   ← la forma del auditor. Cambian pasos y regex
lib/smoke-tester/campaign-advancer.ts ← colas seriales, si tenés un solo canal
lib/smoke-tester/runner.ts            ← solo si necesitás guion fijo
lib/smoke-tester/templates.ts         ← el mecanismo de variables
components/*                          ← la UI. Reusable si usás React
```

### Específico — leer como ejemplo, no portar

```
lib/smoke-tester/bubble-trigger.ts             disparo externo (patrón útil)
lib/smoke-tester/prodesa-catalog.ts            29 proyectos inmobiliarios
lib/smoke-tester/prodesa-sequence-generator.ts guiones desde datos del escenario
app/api/smoke-test/admin/*                     seed y diagnóstico específicos
sql/ bloque 4 (prodesa_projects)
```

---

## 3. Las 6 costuras que hay que reemplazar

Detalle completo en `codigo/adaptadores/README.md`. Resumen:

| # | Original | Reemplazo | Dificultad |
|---|---|---|---|
| 1 | `lib/supabase/admin` | `adaptadores/db.ts` | Trivial si usás Supabase; mecánica si no |
| 2 | `lib/logger` | `adaptadores/logger.ts` | Trivial |
| 3 | `lib/phone-utils` | `adaptadores/phone-utils.ts` | Trivial |
| 4 | `lib/agent-openai/responses-client` | `adaptadores/openai-responses.ts` | Trivial |
| 5 | `lib/smoke-tester/wzap.ts` | `adaptadores/transporte.ts` | **La importante** |
| 6 | auth + `profiles.empresa_id` | ver §5 | Depende de tu app |

Si no usás Supabase, el port de la base es mecánico salvo dos cosas:

- `select('a, b, hija!inner(x, y)')` es un INNER JOIN con la fila hija
  anidada como objeto. Aparece en `webhook-handler.ts`, `runner.ts` y
  `conversation-engine.ts`.
- `form_data`, `conversation`, `metadata`, `evaluation` y `audit_*` son JSONB.
  Necesitás un tipo JSON nativo.

---

## 4. El orden de construcción (probado)

No lo hagas todo de una. Cada paso deja algo que **se puede probar solo**.

### Paso 1 · Esquema (30 min)

Corré `sql/schema-consolidado.sql` bloques 1, 2, 5. Ajustá las FK a tus
tablas. Saltate los bloques 3 y 4 por ahora.

### Paso 2 · Transporte, aislado (1-2 h)

Antes de nada, una ruta que mande **un** mensaje y devuelva la respuesta del
proveedor:

```
POST /api/smoke-test/diag/send  { phone, message }
```

**No sigas hasta que este endpoint funcione y veas el mensaje en el teléfono.**
La mitad de los problemas de un port viven acá: token vencido, device
desconectado, formato de teléfono equivocado, la cuenta requiere plantilla
aprobada para abrir conversación.

### Paso 3 · Webhook, aislado (1-2 h)

Ruta que reciba el webhook del proveedor y **solo loguee el payload crudo**.
Mandale un mensaje al número de pruebas desde tu celular y mirá qué llega.

> Esto no es opcional. La documentación de los proveedores de WhatsApp miente
> o está incompleta, y el parser de `webhook-handler.ts` tiene 6 formas
> distintas de payload porque las 6 aparecieron en producción.

Recién con el payload real a la vista escribí tu `parsearEntrante()`.

### Paso 4 · Un turno redondo (medio día)

Une los dos: mandás un mensaje, el webhook lo correlaciona con la fila que
espera, lo anexa a `conversation` y baja `awaiting_reply`. Sin comprador IA
todavía — mandá el mensaje a mano.

Ahora ya tenés un smoke test de un turno, que es más de lo que tenía Rentmies
durante sus primeras dos semanas.

### Paso 5 · El comprador IA (2-3 h)

Copiá `buyer-ai.ts` y reescribí `buildInstructions()` para tu dominio:
identidad, objetivo, cómo escribe, cuándo terminar. Probalo **aislado** con
transcripciones falsas antes de conectarlo:

```ts
const turn = await nextBuyerMessage({
  conversation: [
    { role: 'buyer', text: 'Hola', timestamp: '...' },
    { role: 'agent', text: 'Hola, ¿me confirmás tu correo?', timestamp: '...' },
  ],
  objetivo: 'agendar una visita',
  persona: { nombre: 'Camila Restrepo', correo: 'x@y.com', telefono: '300…' },
  turno: 2, maxTurnos: 14,
})
// → { mensaje: 'Claro, es x@y.com. ¿Qué precios manejan?', terminar: false, … }
```

Escribí el fallback heurístico **al mismo tiempo**, no después. Es lo que
mantiene el arnés vivo cuando falta la llave o el proveedor tiene un mal día.

### Paso 6 · El motor por eventos (1 día)

Copiá `conversation-engine.ts`. Cambiá:

- `detectTerminalTag()` → tus etiquetas de cierre;
- `SETTLE_SILENCE_MS` → medí la ráfaga real de **tu** agente (§7);
- `AUTONOMOUS_STALL_MS` → 3-4× la latencia peor de tu agente.

Conectá `scheduleAutonomousTurnIfNeeded()` en el webhook y `run-auto` para
arrancar.

### Paso 7 · Redes de seguridad (2-3 h)

`reapStalledAutonomousRun()` en el GET del run, auto-cancelación en el
arranque, y el cron con los casos B y D. **No las dejes para después:** sin
ellas, el primer run que se cuelgue arruina todos los siguientes y vas a
depurar el sistema equivocado.

### Paso 8 · UI mínima (medio día)

Lista de suites → detalle → botón → vista en vivo con polling cada 2,5 s. Los
componentes de `codigo/components/` sirven de base si usás React.

### Paso 9 · Veredictos (1-2 días, opcional)

Auditor determinístico (capa 2) y/o evaluador LLM (capa 3). Ver documento 03.

---

## 5. Auth y multi-tenant

El original asume: sesión → `profiles.empresa_id` → todo filtrado por empresa.

```ts
// patrón repetido en cada ruta
const supabase = createClient()                      // con cookies → RLS aplica
const { data: { user } } = await supabase.auth.getUser()
if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

const { data: profile } = await supabase
  .from('profiles').select('empresa_id').eq('id', user.id).single()
if (!profile?.empresa_id) return NextResponse.json({ error: 'Sin empresa' }, { status: 400 })

const db = createAdminClient()                       // service-role → sin RLS
const { data: suite } = await db
  .from('smoke_test_suites')
  .select('*')
  .eq('id', suiteId)
  .eq('empresa_id', profile.empresa_id)              // ← el filtro es explícito
  .single()
```

**Las dos reglas que salieron caras:**

1. **La lectura con cookies aplica RLS.** Un panel que leía con el cliente de
   sesión mostraba "0 integraciones" habiendo 9. En el back-office y en
   cualquier cosa que corra sin usuario (webhook, cron, motor): **service-role
   siempre**.
2. **Con service-role, el filtro por tenant es tuyo.** Salteaste la RLS, así
   que el `.eq('empresa_id', …)` no es opcional. Es la única barrera que queda.

Si tu app es de un solo tenant, borrá `empresa_id` del esquema y de las
consultas. Nada más depende de él.

Sobre roles: en Rentmies el smoke tester quedó **abierto a cualquier rol
autenticado de la empresa**, a propósito, durante la fase de validación. Si en
tu app las corridas cuestan plata o mandan mensajes reales a clientes,
restringilo desde el día uno.

---

## 6. El camino corto: transporte síncrono

Si tu agente responde en el mismo request, **todo esto se reduce a un loop**.
La implementación completa está en `codigo/adaptadores/transporte.ts` →
`correrConversacionSincrona()`. Lo esencial:

```ts
for (let turno = 1; turno <= maxTurnos; turno++) {
  conversation.push({ role: 'buyer', text: texto, timestamp: now() })

  const r = await transporte.preguntar({ sessionId, texto })
  if (!r.ok) return cerrar('failed', `transporte: ${r.error}`)

  conversation.push({ role: 'agent', text: r.respuesta, timestamp: now() })

  if (detectTerminalTag(r.respuesta)) return cerrar('completed', 'etiqueta')

  const siguiente = await nextBuyerMessage({ conversation, objetivo, persona, turno: turno + 1, maxTurnos })
  if (siguiente.terminar) return cerrar('completed', siguiente.motivo)

  texto = siguiente.mensaje
}
return cerrar('completed', 'incomplete')
```

**Lo que seguís necesitando** aun en modo síncrono:

- `buyer-ai.ts` completo (con su fallback);
- la tabla de resultados y el formato canónico de `conversation`;
- las capas de veredicto (documento 03);
- **un tope de turnos**: sin él, dos LLM conversan hasta que se acabe el saldo.

**Lo que ya no necesitás:** `conversation-engine.ts`, `webhook-handler.ts`, el
`turn_token`, `settleBurst`, `awaiting_reply`, `last_buyer_at`, el watchdog
completo y los tres caminos de correlación. Es literalmente el 85 % del código.

**La trampa del modo síncrono:** 14 turnos × 20 s = ~5 min, y Vercel corta a
los 300 s. Si tu agente es lento, o partís los turnos en invocaciones (cron
corto, cola, `Vercel Queues`/`Workflow`), o corrés el arnés fuera de
serverless. Un script de Node en tu CI es perfectamente válido: nada del
núcleo depende de Next.js.

---

## 7. Los números que tenés que medir en TU agente

Todas las constantes del original están calibradas para un agente específico.
Copiarlas sin medir es la forma más rápida de tener un arnés que reporta
timeouts falsos.

| Constante | Valor original | Cómo calibrar |
|---|---|---|
| `SETTLE_SILENCE_MS` | 10 s | Mirá 20 respuestas reales: ¿cuánto tarda entre el chunk 1 y el último? Poné el p95 |
| `SETTLE_HARD_CAP_MS` | 60 s | Techo por si el agente no para nunca de escribir |
| `AUTONOMOUS_STALL_MS` | 8 min | 3-4× la latencia peor observada |
| `MAX_REPLY_WAIT_MS` | 4 min | Solo modo guion fijo |
| `BURST_APPEND_WINDOW_MS` | 30 s | Ventana en la que un entrante todavía se considera parte de la misma respuesta |
| `DEFAULT_MAX_TURNOS` | 14 | Contá los turnos de 5 conversaciones humanas reales y sumá 4 |
| `inter_run_delay_seconds` | 60 s | Que el proveedor y el agente "olviden" la conversación anterior |

Consulta para medir la ráfaga con datos que ya tenés:

```sql
select
  jsonb_array_length(conversation)                       as mensajes,
  (conversation->-1->>'timestamp')::timestamptz
    - (conversation->0->>'timestamp')::timestamptz       as duracion_total
from smoke_test_results
where status = 'completed'
order by created_at desc limit 20;
```

---

## 8. Variables de entorno

| Variable | ¿Obligatoria? | Para qué |
|---|---|---|
| `WZAP_TOKEN`, `WZAP_DEVICE` | sí (asíncrono) | Transporte |
| `WZAP_URL` | no | Default `https://api.wzap.chat/v1/messages` |
| `OPENAI_API_KEY` | recomendada | Comprador IA. Sin ella → heurístico |
| `SMOKE_BUYER_MODEL` | no | Default `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | no | Evaluador LLM (capa 3) |
| `SMOKE_TESTER_MODEL` | no | Default `claude-sonnet-4-5` |
| `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_URL` | sí | Base |
| `CRON_SECRET` | sí | Autoriza el watchdog |
| `BUBBLE_PRODESA_TEMPLATE_URL`, `BUBBLE_API_TOKEN` | no | Solo modo 3 |

**Validá las obligatorias en el arranque del run, no en el fondo.** Un 400 con
`{ missing: { WZAP_TOKEN: true } }` ahorra horas comparado con un run que
"no hizo nada".

---

## 9. Checklist de puesta en marcha

**Antes de escribir código**

- [ ] ¿Transporte síncrono o asíncrono? (§1)
- [ ] ¿Cuáles son las **etiquetas de cierre** de tu dominio?
- [ ] ¿Tenés una **verdad de referencia** por escenario? (sin esto no hay capa 3)
- [ ] ¿Cuánto tarda tu agente en responder? ¿Manda ráfagas?
- [ ] ¿Cuántos números/canales de prueba tenés? (1 = todo serial)

**Infraestructura**

- [ ] Esquema corrido, FK ajustadas
- [ ] Número de pruebas **separado** del de producción
- [ ] Webhook del proveedor apuntando a tu ruta, con 200 siempre
- [ ] Cron del watchdog agendado y autorizado
- [ ] Variables de entorno cargadas y validadas en el arranque

**Comportamiento**

- [ ] Toda condición de cierre escribe estado terminal (ningún camino deja el run abierto)
- [ ] Auto-cancelación de runs colgados al arrancar uno nuevo
- [ ] Tope de turnos con corte duro
- [ ] Fallback del comprador sin llave de LLM
- [ ] Primer mensaje enviado **en primer plano**, con error visible

**Antes de confiar en los resultados**

- [ ] Constantes calibradas contra tu agente (§7)
- [ ] Una conversación completa verificada **a mano**, mensaje por mensaje
- [ ] El lead de esa conversación **aparece en tu CRM** con la identidad esperada
- [ ] Un run interrumpido a la fuerza cierra solo (probá matando el proceso)
