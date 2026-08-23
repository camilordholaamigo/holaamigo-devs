# 05 · Qué funcionó y qué no

El documento más valioso del paquete. Son **12 bugs reales de producción**, con
su causa y su arreglo, sacados de los 16 commits que construyeron esta feature
entre abril y agosto de 2026. Cada uno costó entre una hora y dos días.

---

## Parte I · Los 12 bugs

---

### Bug 1 — El trabajo en segundo plano no existía

**Síntoma.** El log decía `kicking off run` y nunca decía
`sending wzap message`. El run se creaba, quedaba en `running` y no pasaba
absolutamente nada. Sin errores.

**Causa.** Fire-and-forget clásico:

```ts
Promise.resolve().then(() => executeRun(spec))   // ❌
return NextResponse.json({ run_id }, { status: 202 })
```

Vercel mata el handler **en cuanto devolvés la respuesta**. La promesa quedaba
huérfana a mitad de ejecución.

**Arreglo.**

```ts
import { waitUntil } from '@vercel/functions'

waitUntil(executeRun(spec).catch((err) => logger.error(/* … */)))   // ✅
return NextResponse.json({ run_id }, { status: 202 })
```

**La lección.** En serverless, *fire-and-forget* no existe: o le decís a la
plataforma que mantenga la función viva (`waitUntil`, `ctx.waitUntil`,
`context.callbackWaitsForEmptyEventLoop`), o encolás el trabajo. No hay
tercera opción, y el modo de fallo es silencioso — que es lo peor.

**Corolario:** siempre `.catch()` dentro del `waitUntil`. Un rechazo sin
manejar ahí adentro no aparece en ningún lado.

---

### Bug 2 — Los runs colgados bloqueaban todos los siguientes

**Síntoma.** El botón "Ejecutar prueba" quedaba deshabilitado para siempre.
Nadie podía correr nada.

**Causa.** La UI detectaba runs en `running`/`pending` y los tomaba como
"corrida activa". Como el bug 1 dejaba runs colgados eternamente, siempre
había uno activo.

**Arreglo, en dos frentes.**

```ts
// 1. Al arrancar: matar lo colgado de esta suite. Con un solo número de
//    pruebas, dos conversaciones vivas se pisan en el webhook.
const { data: stuck } = await db.from('smoke_test_runs')
  .select('id').eq('suite_id', suite.id).in('status', ['running','pending'])
if (stuck?.length) {
  await db.from('smoke_test_runs')
    .update({ status: 'cancelled', completed_at: now() }).in('id', ids)
  await db.from('smoke_test_results')
    .update({ status: 'failed', awaiting_reply: false,
              error_message: 'Auto-cancelado — un nuevo run reemplazó éste' })
    .in('run_id', ids).in('status', ['pending','running'])
}

// 2. En la UI: el botón no se deshabilita, cambia de texto.
{activeRunId ? 'Reiniciar prueba' : 'Ejecutar prueba'}
```

**La lección.** Un sistema con estados de larga duración **tiene que poder
salir de un estado malo sin intervención humana**. "Deshabilitar el botón
porque hay algo corriendo" suena prudente y es una trampa: el día que algo se
cuelga, el producto queda inutilizable. Preferí siempre reemplazar sobre
bloquear.

---

### Bug 3 — El modal se tragaba los errores

**Síntoma.** El usuario apretaba "Iniciar", el modal se cerraba, y no pasaba
nada. Ningún mensaje.

**Causa.** Tres líneas en el orden equivocado:

```ts
setError(err.message)   // ❌ pinta el error…
reset()                 //    …lo borra…
onClose()               //    …y cierra el modal
```

**Arreglo.** Si falla, **el modal se queda abierto con el error a la vista**.
Solo cierra en el camino feliz.

**La lección.** En una herramienta de diagnóstico, el error **es** el producto.
Cerrar el modal en el camino de error convierte un fallo de 2 segundos
("token vencido") en una investigación de 20 minutos.

---

### Bug 4 — No había forma de cancelar

**Síntoma.** Un run colgado solo se arreglaba con SQL a mano.

**Arreglo.** Botón "Cancelar" en la vista en vivo →
`DELETE /api/smoke-test/runs/[runId]`, que marca el run `cancelled` y sus
resultados `failed`.

**La lección.** Si construís algo que corre 20 minutos, el botón de parar es
parte de la versión 1, no del backlog.

---

### Bug 5 — Las ráfagas se perdían

**Síntoma.** Los agentes tipo "Ema" contestan con 3-5 mensajes cortos
seguidos. El arnés capturaba el primero y descartaba el resto con
`No awaiting result matched inbound message`. La transcripción quedaba
mutilada, y el evaluador calificaba respuestas incompletas.

**Causa.** El primer chunk consumía el match (bajaba `awaiting_reply`) y los
siguientes no encontraban a quién pegarse.

**Arreglo — dos piezas.**

```ts
// (a) Camino 2 en el webhook: si el ÚLTIMO mensaje del hilo es del agente y
//     llegó hace menos de 30 s, esto es continuación de la misma respuesta.
const isFreshAgent = last?.role === 'agent'
  && Date.now() - Date.parse(last.timestamp) < BURST_APPEND_WINDOW_MS

// (b) Settle: no contestar hasta que pasen 10 s sin mensajes nuevos.
while (Date.now() < quietUntil && Date.now() < hardDeadline) {
  await sleep(2000)
  if (conversation.length > lastLength) {
    lastLength = conversation.length
    quietUntil = Date.now() + SETTLE_SILENCE_MS   // reinicia la ventana
  }
}
```

**La lección.** **Un mensaje del proveedor ≠ un turno de la conversación.** Si
tratás cada webhook como un turno, el comprador contesta 4 veces seguidas y el
hilo se vuelve ilegible. Necesitás una ventana de silencio *con reinicio* —
fija no sirve— y un techo duro por si el agente no para nunca.

---

### Bug 6 — `maxDuration: 800` rompía el build

**Síntoma.** El deploy fallaba entero.

**Causa.** El plan Hobby de Vercel topa `maxDuration` en 300 s, y el builder
**falla con error** en vez de recortar en silencio.

**Arreglo.** Bajar a 300… y aceptar que un flujo real no cabe en 300 s. Eso es
lo que forzó el rediseño completo del bug 12.

**La lección.** Un límite de plataforma no se negocia con una constante. Si tu
flujo no entra, el problema es la arquitectura, no el número. Y agradecé que
el builder falle: un recorte silencioso te habría dado timeouts inexplicables
en producción.

---

### Bug 7 — Hydration mismatch que dejaba el modal muerto

**Síntoma.** El modal se veía pero no respondía a los clics. En consola,
errores React #418 y #423.

**Causa.** Ésta es sutil y vale por sí sola el documento:

```tsx
<span>{timeAgo(run.created_at)}</span>   // usa Date.now() DURANTE el render
```

El servidor calcula "hace 18m" en el instante T. El cliente hidrata en T+200ms
y calcula lo mismo… **casi siempre**. En el borde del minuto los buckets
divergen, React detecta mismatch del DOM (#418), y **cae a render solo-cliente
(#423)**. Durante ese fallback los event handlers del modal no quedan
adjuntos. De ahí "veo el modal pero no puedo hacer nada".

**Arreglo.**

```tsx
const mounted = useMounted()   // useState(false) + useEffect(() => setTrue)
<span suppressHydrationWarning>{mounted ? timeAgo(run.created_at) : '—'}</span>
```

**La lección.** En SSR, **cualquier cosa que dependa del reloj es no
determinística**: `Date.now()`, `Math.random()`, `new Date()`. Van después del
mount, con `suppressHydrationWarning`. Y ojo con el modo de fallo: no se
manifiesta como "la fecha está mal", se manifiesta como "los botones no
funcionan" en un componente que ni toca fechas.

---

### Bug 8 — Navegación hardcodeada entre dos montajes

**Síntoma.** Abrir una suite desde `/central` te llevaba a `/terminal`, donde
faltaba la mitad de la UI nueva.

**Causa.** `router.push('/terminal/smoke-tester/' + id)` en un componente
montado en dos rutas distintas.

**Arreglo.** Un hook `useRoutePrefix()` que lee `usePathname()` y arma la ruta.

**La lección.** Un componente que vive en dos rutas no puede saber dónde está
por convención. Prefijo derivado, nunca literal.

---

### Bug 9 — El webhook fallaba en silencio

**Síntoma.** Mensajes que no aparecían en ninguna conversación. Cero pistas.

**Causa.** El parser devolvía `null` para payloads que no reconocía y el
handler retornaba `false` **sin loguear nada**. Y no reconocía las plantillas
de WhatsApp Business, que traen el texto anidado
(`message.text.body`, `template.body`).

**Arreglo — tres capas.**

```ts
// (a) Loguear SIEMPRE el shape del payload entrante, antes de parsear.
logger.info('smoke-webhook', 'inbound wzap event', { context: summarizeRawPayload(raw) })

// (b) Extractor recursivo (profundidad 4) sobre los nombres de campo
//     conocidos: body, text, caption, message, template.body, content, value.
function extractText(node: unknown, depth = 0): string { /* … */ }

// (c) Cuando NINGÚN camino matchea, loguear los 5 runs activos con su estado.
logger.warn('smoke-webhook', 'No awaiting result matched inbound message', {
  context: { from, preview, active_runs: [{ id, status, trigger, waiting_template }] },
})
```

**La lección.** El caso "no matcheó nada" es el que **más** información
necesita, y es justo el que se suele escribir como un `return false`. La regla:
**cuando no encontrás nada, logueá el estado del mundo que sí encontraste.**
El (c) es el log que más veces resolvió un incidente en este proyecto.

---

### Bug 10 — La carrera del disparo externo

**Síntoma.** A veces la plantilla llegaba y el sistema no la reconocía. La
conversación entera se perdía.

**Causa.**

```
1. llamar a Bubble           ──┐
2. si responde OK →            │ Meta entregaba la plantilla ACÁ,
   waiting_for_template = true ┘ con el flag todavía en false
```

**Arreglo.** Invertir el orden: armar el receptor primero, disparar después, y
revertir si el disparo falla.

**La lección.** **Armá el receptor antes de disparar el emisor.** Vale para
cualquier integración donde la respuesta puede llegar por un canal distinto al
de la petición. El costo de armar de más (un flag colgado que un watchdog
limpia) es infinitamente menor que el de perder el evento.

---

### Bug 11 — "fetch failed" no dice nada

**Síntoma.** `Bubble webhook failed: fetch failed`. Fin.

**Causa.** El `fetch` nativo de Node envuelve los errores de red en un
`TypeError` genérico. La causa real vive en `err.cause`.

**Arreglo.**

```ts
function describeFetchError(err: unknown) {
  const out = { message: (err as Error).message }
  const cause = (err as Error & { cause?: any }).cause
  if (cause?.code)    out.code = cause.code            // ENOTFOUND, ECONNREFUSED…
  if (cause?.message) out.cause_message = cause.message
  return out
}
// → "getaddrinfo ENOTFOUND app.rentmies.com (ENOTFOUND)"
```

Y un endpoint de diagnóstico que reporta qué variables están presentes (sin
sus valores), hace un POST de prueba y devuelve **pistas accionables**:
*"DNS no resuelve"*, *"devolvió 401 → revisá el token"*.

**La lección.** Desempacá `err.cause` en **todo** `fetch` a un servicio
externo. Y agregá `User-Agent`: algunos hosts (Bubble entre ellos) bloquean
peticiones sin él, y el error que devuelven no lo dice.

---

### Bug 12 — El bug que rediseñó el sistema

**Síntoma.** Dos fallas distintas, el mismo día.

```
17:11:19  comprador → "Hola, quiero información sobre Mirasol"
17:11:48  agente    → "…confírmame tu CORREO, nombre, y apellido."
17:12:04  run       → completed ✅        ← 46 segundos
```

Y a las 17:33, el segundo intento quedó colgado en `running` **para siempre**.

**Causa A — el guion se acabó.** La secuencia tenía **un** mensaje. El runner
lo mandó, el agente pidió tres datos, y no había nada más que decir. No hubo
error: el guion terminó. Agregar un segundo mensaje a mano tampoco sirvió — el
agente pidió las cosas en otro orden y se desincronizó igual.

> **Contra un agente que decide su propio flujo, un comprador guionado no
> llega nunca al cierre.**

**Causa B — la arquitectura no aguantaba.** El runner mantenía una función
viva haciendo polling. Las cuentas:

```
tope de la función:           300 s
espera por respuesta:      hasta 240 s
acumular la ráfaga:            12 s
⇒ DOS mensajes agotan el presupuesto
```

Y el run que moría a mitad quedaba en `running` envenenando la correlación de
todos los siguientes, porque el webhook empareja contra "el run running más
reciente".

**Arreglo.** El rediseño completo: comprador IA + motor por eventos +
`turn_token` + tres redes de seguridad. Está descrito en el documento 01.

**Las lecciones.**

1. **Un guion fijo no prueba un agente conversacional.** Si supieras el orden
   exacto de las preguntas, no necesitarías probarlo.
2. **Si el flujo dura más que tu función, el estado va en la base, no en la
   memoria.** El motor por eventos no es una optimización: es el único diseño
   que sobrevive.
3. **Todo camino tiene que cerrar el run.** Un run que puede quedar abierto
   *va* a quedar abierto, y contamina a los que vienen después.

---

## Parte II · Lo que funcionó bien desde el principio

**Los estados terminales explícitos.** `closed_with` con cinco valores
posibles convierte "¿cómo fue?" en una consulta SQL. Es el campo que más se
usa y el que menos costó.

**El formato canónico de la transcripción.**
`[{ role, text, timestamp }]` en un JSONB, y nada más. Sobrevivió tres
rediseños sin cambiar. Meterle metadata al array habría sido la muerte.

**Los índices parciales.**

```sql
create index … on smoke_test_results (awaiting_reply) where awaiting_reply = true;
```

El webhook busca "la fila que espera" en cada mensaje entrante. El 99,9 % de
las filas tienen `false`; indexar solo las `true` mantiene esa búsqueda en
O(conversaciones activas).

**El fallback heurístico del comprador.** Sin `OPENAI_API_KEY` el arnés sigue
corriendo, peor pero entero. Permite correrlo en CI sin gastar tokens, y evita
que una llave vencida un viernes deje la herramienta muerta.

**Loguear el payload crudo de cada webhook.** Cuesta nada y es lo único que
tenés cuando el proveedor cambia el formato sin avisar. Lo hizo el bug 9 y no
volvió a haber un incidente ciego de webhook.

**El endpoint `/diagnose`.** Variables de entorno presentes (booleanos, no
valores), último run, resultados con `error_message`, últimos 30 logs. Le
permite a alguien sin acceso a Vercel ni a la base decir *"falta
WZAP_DEVICE"*. Se paga solo la primera vez que lo usás.

**Validar el entorno en el arranque del run.** Un 400 con
`{ missing: { WZAP_TOKEN: true } }` en vez de un fallo silencioso adentro del
`waitUntil`.

**Mandar el primer mensaje en primer plano.** Es el único momento en que el
usuario está mirando, y donde falla el 90 % de los problemas de configuración.

**Auto-crear un agente placeholder.** Si la empresa no tenía ningún agente
registrado, el sistema creaba uno oculto (`activo=false`) en vez de exigir un
paso previo. Eliminó la fricción de entrada casi por completo.

---

## Parte III · La deuda que queda

Honesta y ordenada por gravedad. Si portás esto, **empezá por la 1**.

### 1. La correlación asume un solo run activo — y no filtra por teléfono

El webhook busca así:

```ts
.from('smoke_test_results')
.select('…, smoke_test_runs!inner(status, …)')
.eq('awaiting_reply', true)
.eq('smoke_test_runs.status', 'running')
.order('last_buyer_at', { ascending: false })
.limit(1)                                  // ← "el más reciente". Nada más.
```

`event.fromPhone` se parsea… **y no se usa para matchear**. Todo el sistema
descansa en el invariante "una sola conversación viva a la vez", sostenido por
la auto-cancelación al arrancar y por las colas seriales.

Consecuencias: no se puede paralelizar, y cualquier run zombi se traga los
mensajes de los siguientes.

**El arreglo:** guardar `target_phone` en `smoke_test_results` y filtrar por
él. Con eso podés correr N conversaciones en paralelo con N números.

```sql
alter table smoke_test_results add column target_phone text;
create index on smoke_test_results (target_phone) where awaiting_reply = true;
```

### 2. `writeState()` es leer-modificar-escribir sobre un JSONB

```ts
const run = await readRun(db, runId)                     // leer
await db.from('smoke_test_runs')
  .update({ form_data: { ...run.form_data, ...patch } }) // escribir
  .eq('id', runId)
```

Dos webhooks simultáneos pueden pisarse la escritura. En la práctica casi no
pasa porque el `turn_token` serializa el trabajo real, pero es una carrera de
verdad.

**El arreglo:** `turno` y `turn_token` como **columnas propias**, y actualizar
el token con un UPDATE condicional (`where turn_token = $viejo`), que es
atómico. O `jsonb_set` en un RPC.

### 3. `smoke_test_runs` no tiene `updated_at`

Por eso el watchdog tiene que inferir "última actividad" desde
`smoke_test_results.last_buyer_at`, que es frágil y le costó un caso entero
(el "caso D — runs zombis"). Agregá la columna con su trigger desde el día uno.

### 4. El evaluador no se dispara solo

Al cerrar un run no se ejecuta la capa 3: hay que apretar un botón. Debería
encadenarse en `closeAutonomousRun()` — con `waitUntil`, tolerante a fallo, y
sin bloquear el cierre.

### 5. El auditor determinístico está atado a un cliente

`prodesa-auditor.ts` sirve solo para runs de un flujo específico. Los runs
autónomos guardan la transcripción pero no `audit_result`. Debería ser
**configurable por suite**: los pasos y sus regex en una tabla, no en el
código.

### 6. Dos fuentes escriben `overall_score`

El auditor lo escribe al cerrar y el evaluador lo pisa al calificar. Deberían
ser dos columnas (`audit_score`, `eval_score`) y una vista que las combine.

### 7. El cron corre una vez al día

Limitación del plan Hobby. Por eso la red de seguridad real terminó siendo el
`GET` del run que la UI ya consultaba cada 2,5 s. **Funciona**, pero depende de
que alguien tenga la pestaña abierta. En un plan con crons frecuentes,
llevalo a cada 5 minutos y sacale esa responsabilidad al GET.

### 8. Un solo número de pruebas

29 escenarios × ~12 min = ~6 horas en serie. Con un segundo dispositivo y el
arreglo de la deuda 1, se paraleliza casi lineal.

---

## Parte IV · Qué haría distinto desde cero

**1. Motor por eventos desde el minuto uno.** El runner de polling se
construyó el 29 de abril, se parcheó cuatro veces en los tres días siguientes
—captura de ráfagas, timeouts, `maxDuration`— y el 18 de agosto se reemplazó
entero. Si el flujo dura más que tu función, no hay diseño intermedio que
sirva: lo que parece "un ajuste de constantes" es un rediseño postergado.

**2. Comprador IA antes que guiones fijos.** Los guiones parecen el camino
simple y son un callejón: no llegan al cierre y hay que mantenerlos cada vez
que cambia el prompt del agente. El comprador IA se adapta solo.

**3. La correlación por teléfono desde el diseño.** El invariante "un solo run
activo" se cuela en veinte lugares y sacarlo después es cirugía.

**4. Un contrato de etiquetas de cierre antes de escribir código.** `#agendado`
y `#cotizacion` son el punto donde se tocan el agente, el CRM y el arnés.
Definilas primero.

**5. Fallback en cada dependencia externa.** Sin LLM → heurística. Sin
evaluador → capas 1 y 2. Sin ficha → tono y completitud. Un arnés que se cae
cuando falta una llave deja de usarse en una semana.

**6. Observabilidad desde el commit 1, no desde el 4.** El endpoint
`/diagnose`, el log del payload crudo y el log de "no matcheó nada + estado
del mundo" llegaron tarde. Con ellos desde el principio, la mitad de estos 12
bugs se habrían diagnosticado en minutos.

**7. Métricas de estabilidad del propio arnés.** Nadie mide cuántos runs
terminan en `failed` por culpa del arnés y no del agente. Sin ese número no
sabés si tus resultados son confiables. Es la métrica que falta.

---

## Apéndice · Los 16 commits

| Commit | Qué trajo |
|---|---|
| `7db82ec` | Base: suites, secuencias, transporte wzap, webhook, evaluador Claude, migraciones 014+015 |
| `42a9154` | Fix de tipos en el `delay` del runner |
| `9319015` | Abrir a cualquier rol durante la validación |
| `aa55673` | Auto-crear agente placeholder |
| `548cf07` | **Observabilidad**: precheck de entorno + `/diagnose` + vista en vivo automática |
| `43e3212` | **Bug 1** · `waitUntil` |
| `68aa792` | **Bugs 2, 3, 4** · desbloquear runs, errores visibles, cancelar |
| `08503c0` | **Bug 5** · captura de ráfagas + timeout 4 min + plantilla de 11 preguntas |
| `ffa3b06` | **Bug 6** · `maxDuration` 800 → 300 |
| `87ebfa1` | Flujo disparado por formulario (bloques 1+2), migración 022 |
| `686a01c` | **Bug 7** · hydration mismatch |
| `89cdbe5` | **Bugs 8, 9, 10** · navegación, parser del webhook, carrera del disparo |
| `49b4163` | Fix de CSS + botón de seed |
| `afe87ed` | **Bug 11** · `err.cause` + `/diagnose-bubble` + reordenar la UI |
| `88dcb33` | Sincronización con producción |
| `93728e6` | **Bug 12** · comprador IA + motor por eventos + `turn_token` + redes de seguridad (PRD 52) |
