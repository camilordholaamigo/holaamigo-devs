# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico. Fechas en ISO.

Cada entrada dice **qué cambió** y **qué hay que hacer para desplegarla**. Una
entrada sin sus pasos de despliegue es una entrada incompleta.

---

## [3.16.0] — 2026-08-30 · «No autorizado» deja de ser un callejón

Dos fallos que se ven igual —una pantalla que dice algo corto y no dice qué
hacer— y no tienen nada que ver entre sí. Los dos aparecieron probando el smoke
tester contra un número nuevo por wzap, el día antes de salir a producción.

### Arreglado

- **La sesión vencida ya no se lee como un permiso que falta.** La cookie de
  admin dura 12 horas. Cuando vence, el layout de `/admin` redirige al login *en
  la siguiente carga de página* — pero una pantalla ya abierta no se recarga
  sola: el operador le daba a «Crear», el `fetch` recibía `401 {"error":"No
  autorizado"}` y el formulario mostraba **«No autorizado»** y nada más. Dos
  palabras que describen bien lo que pasó y no le sirven a nadie: se leen como
  el gobierno de capacidades frenando la prueba (ADR 0018), o como el proveedor
  rechazando la llave. Ahora dice qué pasó, cuánto dura la sesión, y **que se
  entre en otra pestaña** — navegar al login desde ahí se llevaba puestos los
  tres pasos de guion recién escritos.
- **El botón de probar una línea miraba `json.ok` antes que `res.ok`.** Un 401
  no trae ninguno de los dos, así que contestaba `Falló: No autorizado`, que se
  lee como si wzap hubiera rechazado la llave.
- **`?next=` en el login**, saneado con `destinoSeguro()`: solo rutas locales, y
  `//` queda afuera — sin ese filtro el login del admin es un redirect abierto.

### Agregado

- **`saludDeLineaWzap()`, `devicesWzap()` y `webhooksWzap()`** en `wzap.ts`, y el
  campo `wzap` en `GET /api/admin/pruebas/diagnose`. Responden la pregunta que
  ninguna pantalla contestaba: **¿va a volver la respuesta?**

  En wzap el webhook se registra **por `device`**. Una cuenta puede tener la
  llave correcta, el device correcto y el mensaje saliendo perfecto, y no
  recibir una sola respuesta, porque el webhook que reenvía los entrantes está
  atado a otra línea de la misma cuenta. La cuenta con la que corre esto tiene
  cuatro devices y tres webhooks hacia aplicaciones ajenas.

  Y no se ve por ningún lado: el mensaje sale, el negocio contesta, el evento
  se dispara hacia una URL que no es la nuestra, la conversación se cuelga, el
  watchdog la cierra y el informe del cliente dice «no contestó». No es un
  error — es una cifra falsa, y una acusación falsa contra el negocio de
  alguien. Por eso no se deduce de la configuración local: se le pregunta al
  proveedor.

- **El aviso en `/admin/pruebas`**, arriba de todo y en rojo, con lo que hay que
  arreglar por línea. Y el resultado también cuando está todo bien: sin la
  confirmación, «no hay alertas» es indistinguible de «no se pudo preguntar».

### Verificado contra producción, no contra la documentación

| Qué | Resultado |
|---|---|
| `GET /v1/devices` con `WZAP_API_KEY` | 200 · 4 devices, los 4 `operative` y `online` |
| `GET /v1/webhooks` | 200 · 4, y solo uno apunta acá |
| El webhook `holaamigo smoke tester` | activo, `message:in:new`, device `69e62a9b…`, secreto en `?k=` correcto |
| El device de la línea preferida (migración 0018) | `69e62a9b…` — **el mismo**, así que las respuestas sí vuelven |
| `GET /api/webhooks/wzap` en producción, sin secreto | 401 `no autorizado` |
| …con la cabecera, y con `?k=` | 200 las dos |

Es decir: el transporte de wzap estaba y está sano de punta a punta. El «no
autorizado» del reporte era la cookie de admin, no el proveedor — que es
exactamente la confusión que arregla el primer punto.

### Para desplegar

Nada. No hay migración, no hay variable de entorno nueva, no hay que tocar el
panel de wzap. `vercel --prod` y ya.

---

## [3.15.0] — 2026-08-29 · Reintentar con el mismo plan

Volver a correr una prueba obligaba a reescribir el negocio, la apertura, el
objetivo y las preguntas a mano, una por una. Ahora hay un botón en
`/admin/pruebas/[pruebaId]`.

### Agregado

- **`aMedidaDelPlan()`** en `guion.ts` — el inverso de `planALaMedida()`. Un
  plan es el contrato de una prueba y está guardado entero en
  `smoke_probes.plan`, así que reintentar no recompila: **vuelve a mandar el
  mismo contrato**. Recompilar contra el research daría otras preguntas y las dos
  corridas dejarían de ser comparables, que es lo único que se quiere de un
  reintento. Por eso el cuerpo va como `aMedida` aunque la prueba haya nacido de
  un molde.
- **El botón «Reintentar con el mismo plan»**, que no crea nada por su cuenta:
  arma el cuerpo y lo manda a `POST /api/admin/pruebas`, que sigue siendo la
  única forma de crear una prueba a mano (ADR 0027). Sin endpoint nuevo.
- **`scripts/alias-hooks.mjs`** — resuelve el alias `@/` para que una prueba
  suelta pueda importar el archivo real. Antes había que transpilar a mano, y
  una copia prueba la copia.

### Decisiones que se ven en la pantalla

- **El botón solo aparece con la prueba terminada.** Dos conversaciones vivas de
  la misma línea contra el mismo número son un hilo pisando al otro: la unidad de
  ocupación es el par `(línea, número)`.
- **No aparece si la línea se apagó o si el plan es viejo.** Un botón que existe
  y falla es peor que uno que no existe.
- **El reintento repite el mismo `organizationId`**, para que `compilarUnidad()`
  vuelva a resolver la misma ficha y la misma rúbrica. Sin eso mediría atención
  pero dejaría de medir exactitud.
- **En modo guion el objetivo no se devuelve tal cual.** Lo redacta
  `planALaMedida()` a partir de la cantidad de mensajes; devolverlo haría que al
  segundo reintento dijera «las 4 preguntas» de una prueba de 3. Hay una prueba
  de que reintentar un reintento no deriva.

### Cómo desplegarlo

Solo código, sin migración.

---

## [3.14.0] — 2026-08-29 · El comprador aprende a elegir del menú

La prueba `2699ffec` contra el bot de Americanino terminó **fallida** con diez
turnos quemados y cero información sobre el negocio. La transcripción:

```
[negocio]   Para ofrecerte la mejor experiencia… ¿aceptas el tratamiento de datos?
            [1] Si   [2] No
[comprador] Sí acepto. Me recomiendas una camiseta que vaya con ese jean?
[negocio]   Por favor elige solo una de las opciones.  [1] Si  [2] No
[comprador] Sí, me recomiendas una camiseta que combine…
[negocio]   Por favor elige solo una de las opciones.  [1] Si  [2] No
            … ocho veces …
```

Tres causas encadenadas, y hacían falta las tres para producir esto.

### Arreglado

1. **El comprador no sabía que existía el menú.** Las opciones se le mostraban
   dentro del hilo desde 3.13.0, pero nada le decía que ahí había que contestar
   distinto. Ahora, cuando el último bloque del negocio trae opciones, las
   instrucciones terminan con el menú y una orden explícita: *contestá solo con
   el texto exacto de una opción*. Va **al final** —lo último que lee el modelo,
   que es donde más pesa— y no aparece cuando no hay menú.

2. **`elegirOpcion()` no podía rescatar opciones cortas.** El modelo contestaba
   «Sí acepto. Me recomendás…» y el piso de 4 caracteres de la contención dejaba
   afuera a «Si» y a «No» — que son justo las que traban un menú de
   consentimiento. Se agregaron dos pasos antes: **la primera cláusula** y **la
   primera palabra**. El piso de 4 se queda para la contención, y se queda por lo
   mismo de siempre: sin él, «No» matchearía media conversación.

3. **Nada cortaba el bucle.** Un bot de menú que no entiende texto libre reenvía
   su menú idéntico para siempre. Ahora, tres mensajes iguales seguidos del
   negocio cierran la prueba como `incompleto` con el motivo escrito: *«es un
   menú automático que no acepta respuesta escrita»*. Eso no es una derrota —
   es un hallazgo sobre la atención de ese negocio, y perderlo entre diez
   mensajes repetidos es perder lo único que la prueba averiguó. La comparación
   es normalizada porque algunos bots cambian un emoji entre repeticiones.

### Cómo desplegarlo

Solo código, sin migración.

---

## [3.13.1] — 2026-08-29 · La primera lista real

Llegó el primer `list` entrante de verdad —el bot de Americanino, contra la
línea de pruebas— y enseñó tres cosas que ningún ejemplo inventado tenía. Está
guardado en `scripts/fixtures/wzap-list-inbound.json` (sin el contacto ni el
chat, que son datos de una persona) y la suite corre contra él.

### Arreglado

- **`body` no viene `null`: viene AUSENTE.** El caso ya estaba cubierto, pero
  ahora está fijado con el payload real y no con uno supuesto.
- **El encabezado y la pregunta son campos distintos.** La lista trae
  `title: "Menú inicial"` y `description: "¿Cómo puedo ayudarte ?"`, y WhatsApp
  muestra las dos. `enunciadoDe()` se quedaba con la primera y tiraba la
  pregunta, que es justo lo que el modelo necesita para elegir bien y lo que
  después se lee en la transcripción de un informe. Ahora junta las dos.
- **`button` ya no entra en el enunciado.** Es la etiqueta que abre la lista
  («Elige una opción:»); suelta arriba de las opciones se lee como si fuera una
  instrucción nuestra.
- **Los `id` de fila se acotan a 64 caracteres.** En el payload real cada uno es
  un JSON de 130 con el intent del rule builder adentro. No se usan para nada
  —no se puede contestar por id— y enteros meten medio kilobyte de basura en
  cada turno.

### Cómo desplegarlo

Solo código, sin migración. Pero **el webhook de wzap sigue sin existir**: en la
cuenta hay tres y los tres apuntan a Bubble o al proyecto viejo. El mensaje de
Americanino llegó a wzap a las 20:54:15Z, se repartió a esos tres, y este
proyecto nunca lo vio — por eso la prueba quedó en «todavía no contestan».

---

## [3.13.0] — 2026-08-29 · Los mensajes con opciones

ADR 0028 dejó una pregunta abierta y dijo que solo se podía responder con
payloads reales: si el puente de wzap nos entrega la ESTRUCTURA de un menú o si
la aplana a texto. Ya hay payload real, y la respuesta era peor que «la aplana».

```json
{ "type": "poll", "body": null, "poll": { "name": "…", "options": [ … ] } }
```

**El contenido no está en `body`. `body` viene `null`.** Y `parsearEntranteWzap`
exigía texto para devolver algo, así que un mensaje de opciones se descartaba
entero: la conversación quedaba esperando, el watchdog la cerraba por tiempo y el
negocio salía reportado como **«no contestó»**. Una cifra falsa en el informe de
un cliente, que es exactamente lo que ADR 0025 existe para impedir.

### Cómo se verificó

Igual que en 0028: contra la API real, no contra la documentación —que sigue
detrás de login y además no carga sin sesión. El validador OpenAPI de wzap
responde con `additionalProperties: false`, así que cada campo se puede probar de
a uno y la respuesta es sí o no. Todo lo de abajo salió de eso, el 2026-08-29, y
se puede repetir:

- **`POST /v1/messages` acepta** `buttons: [{id, text}]`,
  `list: {title, description, button, footer, sections: [{title, rows: [{id, title, description}]}]}`
  y `poll: {name, options, multiple}`. Rechaza `type`, `interactive`, `replyTo`,
  `quoted`, `payload` y `selectedId`.
- **Tipos de mensaje que pueden llegar** (enum de `GET /v1/chat/{device}/messages?type=…`):
  `interactive`, `template`, `list`, `list_response`, `buttons_response`, `poll`,
  `order`, `product`, `payment`, además de los de siempre.
- **Eventos de webhook que existen**: `message:in:new`, `message:out:new`,
  `message:out:ack`, `message:update`, `message:reaction`, `chat:update`,
  `contact:update`. **No hay ningún evento para botones**: un menú entra por
  `message:in:new` como todo lo demás.

### Agregado

- **`lib/pruebas/interactivos.ts`** — módulo PURO (no importa nada de servidor,
  no lee `process.env`). Saca enunciado y opciones de un entrante, las renderiza
  al texto numeradas, y traduce de vuelta la que el modelo eligió.
- **`scripts/test-interactivos.mjs`**, en `npm test`. Corre contra los dos
  payloads reales —la encuesta y un texto con link preview— porque un ejemplo
  inventado solo prueba el ejemplo.

### Cambiado

- **Las opciones se escriben DENTRO del texto**, numeradas desde 1:

  ```
  ¿Qué te interesa?
  [1] Comprar
  [2] Arrendar
  ```

  No se guardan aparte, y eso no es pereza: `Mensaje` es `{role, text, timestamp}`
  y ADR 0026 dice que meterle metadata a ese array «habría sido la muerte». Así
  se gana todo de una vez y sin migración — la transcripción las muestra, el
  auditor determinístico las ve, el evaluador las cita, y el modelo puede elegir
  una.

- **Cómo se «aprieta» un botón: se escribe su texto.** No hay alternativa —
  el schema de envío no tiene ningún campo para responder una opción. El motor
  traduce lo que el modelo eligió («2», «opción 2», «quiero arrendar») al texto
  exacto de la opción, y **la transcripción guarda lo que salió de verdad**, no
  lo que el modelo escribió (ADR 0023). En modo `guion` no se toca nada: el
  guion del operador es el contrato.

- **`enviarMensaje()` acepta `opciones`** y wzap las manda como `buttons` (hasta
  3) o `list` (más). Si el proveedor las rechaza con un 4xx, **reintenta una vez
  como texto numerado**: WhatsApp no acepta botones nativos por conexiones no
  oficiales desde 2023-05-10, así que el rechazo es lo esperado, y un mensaje que
  no sale por un adorno anula la medición entera. Sin `opciones` el envío es
  byte por byte el que era.

- El log del webhook agrega `opciones` junto a `botones`: cuántas se leyeron de
  verdad, no solo qué claves olieron a menú. Si huele a menú y salen cero, el
  lector no entendió esa forma — y sin las dos cifras ese caso es invisible.

- **La forma corta `botones: "x,y,z"`.** No es de wzap: es para simular un
  entrante con curl sin escribir el JSON anidado de una lista. Se acepta en el
  extractor y no en el webhook, porque un segundo lector del mismo payload es un
  segundo lugar donde se pierde un mensaje. Partir por comas vale **solo** dentro
  de una clave que ya se sabe que trae opciones (`botones`, `opciones`,
  `buttons`, `options`…), nunca en `body`: si no, «Hola, sí, claro» aparecería
  como un menú de tres opciones que nadie mandó.

### Cómo desplegarlo

**No hay migración.** Es solo código.

1. Desplegar.
2. **Crear el webhook en wzap**, que es el paso que faltaba desde 3.12.0 y por el
   que no llegaba nada: en la cuenta hay dos webhooks (`rentmies-reloaded…` y el
   de Bubble) y **ninguno apunta a este proyecto**. Webhooks → nuevo:
   - Evento `message:in:new`
   - Device `69e62a9b0b653ef3ef32e965` (Rentmies Propio D2C y Not)
   - URL `https://holaamigo-devs.vercel.app/api/webhooks/wzap`
   - Cabecera `x-webhook-secret` con el valor de `WZAP_WEBHOOK_SECRET`

   No hay que tocar los dos que ya existen.
3. Verificar con `GET /api/webhooks/wzap` + la cabecera: tiene que dar
   `{"ok":true,"listo":true}`.

---

## [3.12.0] — 2026-08-25 · Dos transportes, y wzap primero

El smoke tester deja de depender de un solo proveedor de WhatsApp. wzap entra
como transporte preferido; Callbell queda de suplente y no se toca nada de su
configuración.

Empezó por otra pregunta —«¿podemos contestarle con un botón a un bot de
botones?»— y la respuesta cerró ese camino: **WhatsApp dejó de aceptar botones
nativos por conexiones no oficiales el 2023-05-10** y los proveedores los
entregan convertidos a texto plano. Afecta a todos por igual. Los motivos que
quedaron son otros tres y están en [ADR 0028](adr/0028-dos-transportes.md).

### Agregado

- **`lib/pruebas/wzap.ts`** — el segundo transporte.
  `POST https://api.wzap.chat/v1/messages`, cabecera `Token` sin prefijo.
  `llaveWzap()` le saca el prefijo `Token ` a la variable por el mismo incidente
  que costó una tarde con `Bearer`. El contrato **no** salió de la documentación
  del proveedor —pide sesión— sino de tres llamadas contra la API real, y las
  tres están listadas en el ADR para poder repetirlas.

- **`lib/pruebas/transporte.ts`** — el despachador. Mira `canal.provider` y
  elige. Nadie más en el subsistema mira ese campo: `motor.ts` pide «mandá este
  texto por este canal» y no sabe por qué API salió.

- **`/api/webhooks/wzap`** — ruta nueva, con el secreto en la cabecera
  `x-webhook-secret` (se aceptan `?k=` y `?secret=` también, y el 401 dice cómo
  mandarlo: un rechazo opaco ahí es indistinguible de «el deploy no subió»). Es un archivo aparte y no un `if`
  adentro de la ruta de Callbell a propósito: esa ruta está corriendo y
  recibiendo reenvíos de otra aplicación, y no se pone en juego para ahorrar
  sesenta líneas.

- **`smoke_channels.prioridad`** — cuál es la línea preferida. Menor gana,
  `created_at` desempata, editable desde `/admin/pruebas` sin desplegar. El
  formulario de líneas ahora tiene selector de proveedor, rotula el
  identificador según cuál sea (`device` en wzap, `channel_uuid` en Callbell), y
  la pantalla marca cuál es la preferida.

- **`pistasDeBotones()`** — deja en el log qué claves del payload entrante huelen
  a mensaje interactivo. No clasifica, no puntúa y no escribe en la base. Es
  instrumentación para responder con datos la pregunta que originó todo esto.

- **Dos chequeos en `/api/health`:** `db:v12` (la columna de preferencia existe,
  el `check` acepta `wzap`, y hay una línea de wzap cargada — dice cuál es la
  preferida y con qué prioridad) y `env:wzap`, que no bloquea porque sin la llave
  el subsistema degrada a Callbell.

### Cambiado

- **«Qué falta» se pregunta por línea y no por sistema.** `faltaParaEnviar()` sin
  argumentos ya no existe: una `WZAP_API_KEY` ausente no importa si no hay
  ninguna línea de wzap activa. En `lanzar.ts` y `lote.ts` el canal se resuelve
  **antes** de preguntar qué falta — al revés se abortaba por la llave de un
  proveedor una prueba que iba a salir por el otro.
- `enviarMensaje()` y `faltaParaEnviar()` de `callbell.ts` pasaron a llamarse
  `enviarPorCallbell()` y `faltaParaEnviarCallbell()`. El `enviarMensaje()` que
  usa el resto del código ahora vive en `transporte.ts`.
- `GET /api/admin/pruebas/diagnose` devuelve `webhooks` (las dos URLs) en vez de
  `webhook`, y agrega `lineas` en orden de preferencia. El POST dice por qué
  proveedor salió el mensaje.

### Cómo desplegarlo

1. **Correr `supabase/migrations/0018_wzap_como_transporte.sql`** en el editor de
   Supabase. Amplía el `check` del proveedor, agrega `prioridad`, siembra la
   línea de wzap con prioridad 10 y baja las de Callbell a 200. Es idempotente y
   la siembra usa `on conflict do nothing`, así que no pisa lo que se ajuste a
   mano después.
2. **Cargar dos variables en Vercel** (Production y Preview) y volver a
   desplegar, porque el build congela las variables del momento:
   - `WZAP_API_KEY` — la llave de la cuenta de wzap.
   - `WZAP_WEBHOOK_SECRET` — cualquier cadena larga que vos elijas; es la que va
     en la cabecera del webhook.
3. **Crear el webhook en wzap**: Webhooks → nuevo, evento `message:in:new`,
   device de la línea de pruebas, URL
   `https://holaamigo-devs.vercel.app/api/webhooks/wzap`, y la cabecera
   `x-webhook-secret` con el valor del paso 2. **No hay que tocar ni borrar los
   webhooks que ya existen**: wzap admite varios por device y los que están
   apuntan a otras aplicaciones.
4. **En Callbell no hay que cambiar nada.** Su webhook sigue igual y su línea
   sigue activa, solo deja de ser la preferida.
5. Verificar: `GET /api/health` tiene que listar `db:v12` y `env:wzap`; y
   `GET /api/admin/pruebas/diagnose` tiene que mostrar `WZAP_API_KEY: true` y la
   línea de wzap primera en `lineas`.
6. Probar el envío con el botón de prueba de la línea en `/admin/pruebas`, contra
   un celular propio, antes de apuntarle a un prospecto.

---

## [3.11.0] — 2026-08-23 · `Bearer Bearer`, y el botón que faltaba

Dos cosas que impedían probar el smoke tester de punta a punta.

### Arreglado

- **`Bearer Bearer …`.** El panel de Callbell muestra el token ya escrito como
  cabecera —`Bearer EmbeccJyn…`— y así es como se copia. El código ya ponía
  `Bearer ${CALLBELL_API_KEY}`, así que con el prefijo adentro de la variable el
  header salía duplicado y Callbell contestaba
  `401 {"error":"not authorized"}`. Verificado contra la API: con un prefijo
  responde 200, con dos responde 401.

  Ahora `llaveCallbell()` le saca el prefijo y **las dos formas funcionan**. El
  header no lee `process.env`: lo lee de esa función, y hay una prueba que
  verifica que no vuelva a leerlo directo, porque ése es el único punto donde el
  bug puede regresar. `faltaParaEnviar()` también mira la cadena normalizada —
  una variable que solo contiene `Bearer ` es una variable que falta, y eso hay
  que decirlo antes de crear la prueba, no después del 401. `GET
  /api/admin/pruebas/diagnose` agrega `CALLBELL_API_KEY_traia_bearer` para que el
  caso se vea de una.

### Agregado

- **`/admin/pruebas/nueva` ahora arranca eligiendo un cliente.** Dos caminos
  arriba de la pantalla: *un cliente nuestro* o *un número cualquiera*. El
  segundo es el de ADR 0027 y no cambió.

- **El botón «Probar como en el diagnóstico».** Se elige el cliente y sale la
  batería completa —`servicio → faq → ventas`, la de
  `settings['pruebas.bateria']`— compilada contra su research. No es un atajo
  para escribir el guion más rápido: manda `plantillas` en vez de `aMedida`, que
  es el mismo cuerpo que arma el disparo automático. Reproduce el escenario del
  cliente en vez de parecerse a él.

- **La lista de clientes dejó de salir de `smoke_targets`.** Ahí estaba el bug de
  verdad: esa tabla solo tiene los números que el research encontró
  **publicados** en el sitio (ADR 0025), así que un cliente que no publica
  WhatsApp —Conceptum, por ejemplo— desaparecía de la pantalla junto con todo su
  análisis, y el bloque entero se ocultaba por estar vacío. Ahora sale de
  `organizations` y el número es un campo que puede faltar: cuando falta, se
  escribe a mano y queda registrado como `origen: 'manual'`, `source_url: null`.
  La ficha del cliente dice cuál de los dos casos es y enlaza la fuente cuando la
  hay.

- **La columna derecha no finge en este camino.** No pinta globos de WhatsApp con
  preguntas inventadas: las escribe el compilador en el momento del lanzamiento,
  así que la pantalla lista qué pruebas corren, en qué orden y qué mide cada una,
  y dice que el texto exacto queda en la pantalla de la prueba. Pintar un globo
  con una pregunta que a lo mejor no sale con esas palabras es la clase de
  precisión falsa que prohíbe [ADR 0023](adr/0023-mostrar-el-trabajo.md).

Y el tercer caso de frenos —manual pero con organización— quedó escrito en
[`docs/api/pruebas.md`](api/pruebas.md): `authorize('smoketest.probe')` **sí**
corre, el enfriamiento de 72 h no, y el bloqueo sigue siendo terminal.

### Despliegue

1. `git push` — la integración de Git despliega a producción.
2. **La variable no hay que tocarla.** Si `CALLBELL_API_KEY` tiene el `Bearer `
   adelante, el código se lo saca. Lo que sí hace falta es que el despliegue sea
   posterior a este commit.
3. Confirmar con `GET /api/admin/pruebas/diagnose` (con sesión de admin):
   `entorno.CALLBELL_API_KEY` en `true`.
4. **Sin migración.** 0016 y 0017 ya corrieron: `db:v11` en `/api/health` está en
   `true`.

---

## [3.10.1] — 2026-08-23 · La env var que el dashboard mostraba y el build no tenía

Arreglo de diagnóstico, no de producto. El síntoma fue el peor posible: la
landing pedía nombre, correo y sitio, y contestaba **«Algo se rompió de nuestro
lado. Intenta de nuevo en un minuto.»** Reintentar no servía, porque no era
transitorio.

El log lo decía en una línea:

```
[intake] fallo: Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY.
```

Y la variable **estaba** en Vercel. La causa: **Vercel congela las env vars en el
build**. El despliegue que estaba sirviendo se construyó minutos antes de que
`SUPABASE_SERVICE_ROLE_KEY` se agregara al proyecto, así que corría sin ella.
Agregar una variable no la inyecta en lo que ya está corriendo — hay que
redesplegar. Desde afuera eso es indistinguible de una llave mal pegada, y
`explainDbError()` —que existe justo para traducir esta clase de error— no tenía
esa rama.

### Arreglado

- **`explainDbError()` traduce «Falta la variable de entorno».** Ahora el log
  dice qué hacer: *si ya está en Vercel, el despliegue se construyó ANTES de
  agregarla; redesplegar y confirmar con `GET /api/health`*. Es la misma decisión
  que la rama de `Invalid schema`: el error crudo apunta al lugar equivocado, y
  quien lo lee se va a buscar una llave mala en vez de un build viejo.

- **Los cuatro puntos del camino del visitante pasan por `explainDbError()`.**
  `/api/intake`, `/api/quiz/next`, `/api/quiz/answer` y `/api/diagnostic/generate`
  logueaban el error crudo —los tres últimos ni siquiera lo traducían— y ninguno
  nombraba `/api/health`. Ahora los cuatro cierran con `· diagnóstico completo en
  GET /api/health`, que es el endpoint que ya contestaba la pregunta y al que
  nadie sabía que había que ir.

El mensaje que ve el visitante **no cambió**, a propósito: los `detail` de
`/api/health` nombran infraestructura y viven detrás del admin (ADR 0003).

### Despliegue

1. `git push` — la integración de Git despliega a producción.
2. Confirmar con `GET /api/health`: `env:supabase`, `db:schema` y `db:seed_quiz`
   en `true`.
3. **Sin migración.** El cambio es de código.

Pendiente de operación, no de este cambio: `db:v11` sigue en `false` porque
**`0016_la_prueba_no_la_gobierna_el_plan.sql` y `0017_prueba_a_medida.sql` no se
han corrido** en el proyecto Supabase (faltan los moldes `a-medida` y `guion`, y
`smoketest.probe` sigue con clase `external_comms`). El flujo de la landing al
diagnóstico no los usa; el smoke tester sí.

---

## [3.10.0] — 2026-08-23 · La prueba a medida, y varias líneas

El smoke tester dejó de ser una parte del diagnóstico y pasó a ser **una
herramienta**. Antes solo sabía apuntarle a un negocio que ya estuviera en nuestra
base con research corrido: las preguntas las escribía el compilador leyendo
`research_findings`. El caso que faltaba es el que más se pide:

> «Probá la Clínica Mirla, +57…, es una clínica estética en Bogotá. Que la IA haga
> tres preguntas sobre sus tratamientos y converse. O que mande estas tres
> exactas: si abren el lunes, cuánto cuesta el tratamiento X, y qué pasa si no me
> funciona.»

Sin crear organización, sin correr research, sin desplegar. Y **desde varias de
nuestras líneas a la vez**, que es la única forma de ver si el agente de un negocio
les contesta igual a tres clientes simultáneos.

Ver [ADR 0027](adr/0027-la-prueba-a-medida-y-las-lineas.md),
[wiki/23](wiki/23-smoke-tester.md), [wiki/24](wiki/24-lotes-e-informes.md) y el
contrato en [`docs/api/pruebas.md`](api/pruebas.md).

### Agregado

- **`/admin/pruebas/nueva`** — la única pantalla que crea pruebas a mano. Tres
  pasos (a quién · qué le decimos · desde qué líneas) y **una vista previa al
  lado con los mismos globos de WhatsApp que va a ver el que contesta.** El
  problema que arregla no era de campos que faltaban: era que nadie sabía qué
  hacía el botón, y un preview exacto contesta eso mejor que cualquier
  explicación. Por eso `lib/pruebas/guion.ts` es **puro** — las sugerencias que se
  ven en pantalla salen de la MISMA función que arma el plan en el servidor.

- **Dos modos, y el modo vive en el plan.** `conversar` es el comprador sintético
  de siempre. `guion` manda los mensajes exactos que escribió el operador, uno
  tras otro, **sin importar qué contesten** y sin gastar un peso en modelo. Sirve
  para hacerle la misma pregunta a veinte negocios y comparar las veinte
  respuestas palabra por palabra.

- **`lib/pruebas/guion.ts`** — de un formulario a un `PlanDePrueba`. El plan sigue
  siendo el contrato; quién lo escribió es un detalle, y río abajo el motor, el
  auditor, el evaluador y el informe no se enteraron.

- **Varias líneas de Callbell.** `canalesActivos()`, y la pantalla «Nuestras
  líneas» pasó de editar una a administrar todas. Cada línea abre su propio hilo
  de WhatsApp: tres líneas contra un número son tres conversaciones que el negocio
  ve como tres clientes distintos. Contesta la puerta que ADR 0026 dejó abierta en
  su alternativa B.

- **`POST /api/admin/pruebas/redactar`** — el **borrador** de un guion a partir de
  dos líneas escritas a las apuradas. Rellena el formulario; lo que se manda es lo
  que quedó escrito en los campos. Nunca falla hacia afuera: sin llave devuelve
  las sugerencias determinísticas con `degradado: true`.

- **`GET /api/admin/pruebas?telefono=…`** — si el número está bloqueado, cuándo fue
  la última prueba, si ya lo conocemos. Es lo que reemplaza al enfriamiento en el
  camino manual, y la razón está abajo.

- **La transcripción crece sola** en `/admin/pruebas/[pruebaId]`. La conversación
  tarda entre dos y veinticinco minutos y antes había que recargar a mano, así que
  nadie volvía. Y no es solo comodidad: ese GET **es la red de seguridad real del
  motor** — cierra estancadas y despierta colas, con la frecuencia del problema.

- **La pantalla de una prueba tiene dos vistas.** *Comparar* pone hasta seis
  transcripciones lado a lado —«¿les contestó igual a los tres?»— y *Lista* da una
  fila por conversación con el último mensaje del negocio a la vista. Arranca en la
  que corresponde al tamaño. Si hay que abrir tres pestañas para comparar, nadie
  compara.

- **Dos moldes semilla**, `a-medida` y `guion`. `smoke_probes.template_id` es clave
  foránea, y así `resumen_de_pruebas()` sigue agrupando por tipo de prueba en vez
  de mezclar todo en un balde.

### Cambiado

- **La unidad de ocupación es el par `(nuestra línea, su número)`, no el número.**
  Es el cambio con más consecuencias:
  - `avanzarCola(runId, targetId, canalId)` — sin el canal, la conversación de la
    línea B veía «ya hay una corriendo» (la de la línea A) y **nunca arrancaba**;
  - `cancelarVivasContra(telefono, canalId, exceptoRunId?)` — sin el canal,
    arrancar la línea B **cancelaba** la de la línea A contra el mismo negocio;
  - `siguientePendiente` del lote y el espaciado de 90 s, también por par.

- **La correlación del webhook desambigua entre líneas**, en tres escalones: el
  `channel_uuid` del payload, nuestro propio número (que para un entrante Callbell
  manda en `from`), y **a ciegas** con el log `desambiguación a ciegas entre
  líneas`. El tercero es el comportamiento que había antes, y con una sola línea es
  exactamente correcto — por eso esto no rompió nada.

- **Una prueba es `números × líneas × guiones`.** `crearLote` acepta `canales[]` y
  `aMedida`, y devuelve `conversaciones[]`. Con una sola, la pantalla siguiente es
  la transcripción y no el grupo: una herramienta que no deja ver lo que acaba de
  hacer no se vuelve a usar.

- **El orden de inserción agrupa por objetivo y no por línea.** `avanzarLote`
  arranca en orden de creación, así que un tope de 3 abre las tres líneas contra el
  primer negocio antes de pasar al segundo — y en un barrido de treinta, el primer
  negocio queda completo y legible en minutos en vez de al final.

- **El vocabulario, fijo.** En pantalla: **la prueba** (un guion contra N números
  desde M líneas) y **la conversación** (una transcripción con su veredicto). La
  palabra «tanda» no se usa más en ningún lado: describía el diseño de ADR 0026 y
  no el uso, y era la mitad de por qué nadie entendía la pantalla.

- `PlanDePrueba` gana `modo`, `guion`, `contexto` e `instrucciones`, **opcionales
  porque las filas anteriores no los tienen** y por ninguna otra razón. Se leen con
  `modoDelPlan(plan)`, nunca directo.

### Eliminado

- **`POST /api/admin/pruebas/lotes`** y **`lanzarDesdeAdmin()`**. Hacían casi lo
  mismo que `crearLote()` con otras palabras, y tener dos formas de crear una
  prueba a mano era la mitad de la confusión que ADR 0027 vino a arreglar. Hay una
  prueba que verifica que el endpoint no vuelva.

- El formulario «Probar una línea» de `/admin/pruebas`. Se fue a su propia pantalla
  con la vista previa; al lado de la configuración las dos cosas parecían del mismo
  peso, y no lo son.

### Sobre los frenos, dicho en voz alta

**Los tres primeros frenos de ADR 0025 rigen el camino automático y no el manual,
y eso es diseño y no descuido.** No hay organización contra la que autorizar
cuando un operador escribe un número suelto, y el enfriamiento de 72 h existe para
que cinco recargas de la landing no manden cinco mensajes — no para impedir
retestear al cliente al que se le acaba de cambiar el prompt. Lo que se paga a
cambio:

- el **bloqueo es terminal en los dos caminos** y no lo levanta nada automático;
- la cuenta va **escrita en el botón**: «Escribir ahora · 3 conversaciones»;
- la pantalla muestra **cuándo fue la última prueba** contra ese número;
- cada conversación queda como fila con su hora, su línea y su operador.

La tabla completa está en [ADR 0027](adr/0027-la-prueba-a-medida-y-las-lineas.md)
y en [`docs/api/pruebas.md`](api/pruebas.md).

### Lo que queda pendiente, a propósito

- **Una sola persona sintética por prueba.** Tres líneas hoy son la misma identidad
  tres veces. Que cada línea lleve la suya convertiría esto de una prueba de
  coherencia en una de carga.
- **El guion no reacciona.** Si el negocio pregunta algo, sigue de largo. Es el
  precio de que sea determinístico.
- **La correlación a ciegas.** Si el proveedor deja de mandar `channel_uuid` *y*
  nuestro número, dos conversaciones simultáneas contra el mismo negocio pueden
  cruzar un mensaje. Queda en el log con esas palabras.

### Para desplegarlo

1. **Correr la migración** `supabase/migrations/0017_prueba_a_medida.sql` en el
   editor SQL de Supabase. Es idempotente y **no toca ninguna fila existente**:
   crea dos índices parciales, siembra dos moldes con `on conflict do nothing`, y
   actualiza comentarios de tabla. Va **después** de
   `0016_la_prueba_no_la_gobierna_el_plan.sql`; si se corre antes, falla temprano
   diciendo cuál falta.

2. **Desplegar.** No hay variables de entorno nuevas.

   Después del despliegue, `GET /api/health` trae un chequeo nuevo, `db:v11`,
   que dice si las cuatro migraciones del smoke tester corrieron, si los cinco
   moldes están sembrados, si `smoketest.probe` sigue siendo `self_outreach` y
   **cuántas líneas activas hay**. Existe porque estas migraciones se corren a
   mano —las credenciales están marcadas Sensitive en Vercel— y sin el chequeo
   «la 0017 no se corrió» y «Callbell rechazó la llave» se ven exactamente igual
   desde afuera: una prueba que se crea y no hace nada.

3. **Verificar, en este orden:**
   - `/admin/pruebas` → «Nuestras líneas»: la línea de siempre sigue ahí y activa.
   - **Probar el envío** desde esa línea a tu propio celular. No seguir hasta
     verlo llegar.
   - `/admin/pruebas/nueva` contra tu celular, modo **conversar**, y contestá vos.
     La transcripción tiene que crecer sola.
   - Otra vez con un **guion de tres preguntas**. Tienen que salir las tres, una
     por respuesta tuya, y cerrar sola al terminar la tercera.

4. **Si vas a usar varias líneas** —y es lo que más valor agrega—: agregá la
   segunda en «Nuestras líneas» con su `channel_uuid`, apuntá su webhook al mismo
   `/api/webhooks/callbell?k=…`, y creá una prueba contra tu celular eligiendo las
   dos. **Tienen que llegar dos conversaciones separadas y las dos tienen que
   avanzar.** Si solo avanza una, la correlación no está desambiguando: buscá
   `desambiguación a ciegas entre líneas` en el log de Vercel.

5. Nada que revertir en el código si algo sale mal: con una sola línea configurada
   el comportamiento es idéntico al de 3.9.0.

---

## [3.9.0] — 2026-08-23 · El lote y el informe

La 3.8.0 dejó el motor: le escribimos a **una** línea. Eso resuelve un
prospecto y no resuelve las dos cosas que el producto tiene que hacer:

**QA** — «¿a cuál de mis treinta clientes se le rompió la IA esta semana?».
**Growth** — «mandale a este prospecto lo que pasó cuando le escribimos».

Son el mismo motor con distinto destinatario. Ahora hay una **tanda** que corre
muchas líneas con freno, y un **informe** público que convierte lo que pasó en
algo que se manda por WhatsApp y cuyas aperturas se cuentan.

Ver [ADR 0026](adr/0026-el-lote-y-el-informe.md), [wiki/24](wiki/24-lotes-e-informes.md)
y el contrato del subsistema en [`docs/api/pruebas.md`](api/pruebas.md).

### Agregado

- **El lote** (`lib/pruebas/lote.ts`, `holaamigo.smoke_batches`). La misma
  batería contra N líneas, con `max_concurrentes` (4, techo 12) y
  `ritmo_segundos` (45). **Eso no es afinación:** treinta clientes por tres
  pruebas son noventa conversaciones desde una sola línea de WhatsApp, y para
  el clasificador de Meta eso es un emisor de spam. Lo que se pierde no es la
  tanda, es el número. Son columnas y no constantes para poder bajarlas en
  caliente.

- **`avanzarLote()`**, idempotente, empujado por tres cosas: la creación, el
  cierre de cada prueba, y la pantalla del admin mientras alguien la mira. Es el
  único lugar del subsistema donde se duerme, acotado a 200 s — y ahí es
  correcto: no esperamos un evento externo, espaciamos nuestros propios envíos.

- **Omitir en vez de fallar.** Si una compilación falla, ese par sale de la
  tanda con su motivo y el resto sigue. Un lote de treinta que muere en el
  cuarto no sirve. Los motivos se muestran uno por uno.

- **El informe** (`lib/pruebas/informe.ts`, `holaamigo.smoke_reports`) con
  `share_token` público. Las cifras salen de `salud_de_linea()`, los hallazgos
  de `hallazgos_por_frecuencia()`, las citas de `citas_del_periodo()`, y **qué
  recomendar lo decide un catálogo que vive en el repositorio**. El modelo pone
  las palabras y su esquema no tiene un `z.number()`.

- **La frecuencia se cuenta sobre los `id` de la rúbrica, no sobre el texto del
  modelo.** «Falló en 4 de 5» es un problema del guion; «1 de 5» es una
  conversación mala, y esa distinción es todo el valor del análisis. Solo
  funciona con claves estables: las alucinaciones son texto libre y van aparte,
  **textuales y sin contar**, porque una cita resumida deja de ser prueba.
  Un criterio con `paso = null` **no cuenta como fallo**: es «no se pudo
  verificar», y reprobar a alguien porque nosotros no pudimos leer su sitio es
  la forma más rápida de que el informe pierda credibilidad.

- **`/informe/[shareToken]`** — público, imprimible, con barras de tiempo
  lineales (la astilla de la conversación rápida al lado de la de 40 minutos
  **es** la información) y los puntitos de frecuencia, que se entienden sin
  leer. El titular lo escribe el código, no el modelo: parece prosa y contiene
  cifras.

- **Compartir: un link, no un PDF adjunto.** Se previsualiza, no pesa, y —lo que
  decide— **se puede medir**. `vistas` y `visto_at` no son telemetría: saber que
  el prospecto lo abrió tres veces es la señal de compra más barata que tenemos.
  El PDF sigue existiendo vía `window.print()`.

- **El correo del informe**, redactado por el modelo y **enviado por una
  persona** desde `/admin/pruebas` (misma disciplina que ADR 0021). Sale por
  **Resend y no por SendGrid**: SendGrid es el motor de las campañas de los
  clientes y su reputación está atada a lo que ellos envían (ADR 0008).

- **Cuatro funciones SQL** — `salud_de_linea`, `hallazgos_por_frecuencia`,
  `citas_del_periodo`, `estado_del_lote` — con sus 35 chequeos en
  `scripts/test-lotes-e-informes.mjs`, que verifica la aritmética y no solo que
  las tablas existan.

- **`docs/api/pruebas.md`** — el contrato módulo por módulo del subsistema:
  qué recibe cada función, qué escribe en la base, qué lanza, cuál es la
  invariante que no se puede romper, y **las seis costuras** a reemplazar para
  portarlo a otra aplicación.

### Arreglado

- **`cancelarVivasContra()` se cancelaba a sí misma.** `crearLote` inserta N
  pruebas en `pending` y acto seguido cancelaba todo lo pendiente contra esos
  números — incluidas las que acababa de crear. El síntoma habría sido «el lote
  se crea y muere en el acto», sin error. Ahora acepta `exceptoRunId`.

- **`avanzarCola()` dormía 90 segundos.** Rompía tres cosas: el GET de estado
  (techo 60 s) moría a mitad de respuesta, el stream se quedaba mudo, y el cron
  con cinco colas pendientes sumaba siete minutos contra un techo de cinco.
  Ahora es una guarda: pregunta «¿cerró hace poco?» y se retira.

- **El costo de modelo del smoke tester no se imputaba a nadie.**
  `smoke_probes.organization_id` no existía, así que cada turno y cada
  evaluación quedaban sin organización en `agent_runs`.

### Para desplegarlo

**1 · Supabase — una migración.**

```
0015_lotes_e_informes.sql
```

Idempotente, y falla temprano diciendo qué falta si se corre sin `0014`.

**2 · Vercel — ninguna variable nueva.** El informe usa `RESEND_API_KEY`, que ya
estaba. Sin ella el informe se genera igual y el enlace funciona: solo no se
puede mandar el correo desde el admin, y lo dice así.

**3 · Nada más.** El cron y el webhook ya existentes empujan los lotes; no hay
rutas nuevas que registrar.

---

**Nota de plan: los crons van a diario.**

El team `holaamigo` en Vercel está en Hobby, que topa los crons a uno por día.
`sweep`, `dispatch` y `pruebas` estaban cada 2 y cada 5 minutos y pasaron a
diarios. Lo que eso cuesta, en orden de gravedad:

| Cron | Diseñado | Hoy | Qué se pierde |
|---|---|---|---|
| `/api/cron/sweep` | 2 min | 11:00 UTC | Un research que se cuelga se queda colgado hasta el otro día, y el cliente ve un diagnóstico que nunca carga. **Es la razón número uno para pasar a Pro.** |
| `/api/cron/dispatch` | 5 min | 13:30 UTC | Un cliente cuya franja de envío no incluya las 8:30 a. m. de Colombia no recibe envíos ese día. La hora **no es libre**: el briefing del President solo se publica entre las 12 y las 14 UTC, así que el cron tiene que caer adentro de esa franja o el President no habla nunca. |
| `/api/cron/pruebas` | 5 min | 11:30 UTC | Casi nada. La red real del smoke tester nunca fue este cron: es el GET de estado que la interfaz consulta cada pocos segundos. Solo queda `running` hasta el otro día la prueba de alguien que cerró la pestaña. |

Volver atrás en un plan Pro es cambiar tres líneas de `vercel.json`. Está
anotado en el encabezado de cada una de las tres rutas.

---

## [3.8.0] — 2026-08-23 · Le escribimos a su línea antes de venderle nada

El diagnóstico era bueno y era, de punta a punta, una **proyección**. Las cuatro
fugas salen de supuestos que el cliente puede mover; el embudo sale de la meta a
90 días. Todo con su fórmula a la vista, y todo discutible.

Ahora tiene una sección que no se discute:

> «Le escribimos a tu línea de ventas a las 2:03. Contestaron a las 2:19.
> Dieciséis minutos.»

Un comprador sintético le escribe por WhatsApp al número que su propio sitio
publica, la conversación corre hasta donde llegue, y se califica en tres capas.
Arranca **cuando termina el research**, así que cuando el cliente llega al
diagnóstico la primera prueba ya tiene respuesta —o ya sabemos que no la va a
tener.

Sale del paquete portable de Rentmies, que quedó en `docs/referencia/smoke-tester/`
con sus doce bugs de producción documentados. Tres de sus ocho deudas se
resolvieron acá en el diseño y no como parche: correlación por número, `turno` y
`turn_token` como columnas, y evaluación que se dispara sola.

Ver [ADR 0025](adr/0025-el-smoke-tester-como-evidencia.md) y
[wiki/23](wiki/23-smoke-tester.md).

### Agregado

- **Las pruebas de línea** (`lib/pruebas/`, `holaamigo.smoke_*`). Cinco tablas,
  un motor por eventos y tres capas de veredicto. `numeros.ts` saca los números
  del `crawl_signals` que el crawler ya guardaba y nadie leía — **ningún modelo
  elige un número**, y los fijos se descartan porque no tienen WhatsApp y
  reportarlos como «no contestó» sería mentira. `compilar.ts` instancia el molde
  con el research: si el sitio anuncia un evento, se pregunta por el evento.

- **El motor por eventos** (`lib/pruebas/motor.ts`). Nadie espera a nadie: el
  estado vive en la base y cada entrante despierta el sistema, hace un turno y
  lo apaga. Es el único diseño que sobrevive a que una persona conteste un
  WhatsApp cuarenta minutos después, con una función que Vercel corta a los
  300 s. Guarda de concurrencia con `turn_token` **como columna**, para poder
  reclamarla con un update condicional, que es atómico.

- **Correlación por número.** `smoke_probes.target_phone` denormalizado y un
  índice parcial sobre `awaiting_reply`. Es lo que permite escribirle a tres
  líneas en paralelo — el original emparejaba contra «la conversación activa más
  reciente» y por eso allá nunca se pudo paralelizar.

- **Tres capas de veredicto.** Estado terminal (gratis, determinístico),
  auditoría contra la rúbrica compilada (regex, determinística) y evaluación con
  modelo. **El evaluador no devuelve números**: devuelve cinco juicios
  cualitativos y la nota la calcula el código con una tabla fija, así que dos
  evaluaciones con los mismos juicios dan exactamente el mismo número (ADR 0007).
  Ningún esquema del smoke tester tiene un `z.number()`, y el test lo verifica.

- **`components/smoke-live.tsx`** en el diagnóstico, entre las cifras y las
  rutas. La barra avanza **solo cuando pasa un hecho con hora**; entre dos hechos
  se queda quieta. Lo que corre es el cronómetro, y es real. El reloj es un
  `useSyncExternalStore` con snapshot de servidor en 0: nada que dependa de la
  hora se renderiza antes de montar (ADR 0023, y el bug 7 del paquete).

- **`/admin/pruebas`** y **`/admin/pruebas/[id]`**. Crear una prueba contra
  cualquier número **sin diagnóstico**, editar nuestra línea de Callbell sin
  desplegar, y leer cada conversación con su plan compilado y sus dos
  calificaciones. La agregación sale de `holaamigo.resumen_de_pruebas()`, no de
  contar filas en el render.

- **`POST /api/webhooks/callbell`.** Siempre 200, loguea la forma del payload
  antes de parsear, y cuando no matchea nada deja escrito el estado del mundo que
  sí encontró. Aguanta el envoltorio nativo de Callbell y el reenvío desde otra
  aplicación.

- **`/api/cron/pruebas`** cada 5 minutos: estancadas, colas huérfanas, zombis y
  las que quedaron sin calificar.

- **`/api/admin/pruebas/diagnose`** — qué variables están presentes (booleanos,
  nunca sus valores), qué canal está activo, las últimas diez pruebas con su
  error. El `POST` manda un mensaje de prueba y devuelve el error crudo con una
  pista accionable.

- **Capacidad `smoketest.probe`** en el catálogo de 0007: `external_comms`, techo
  de plataforma **4** y no 5. Un número quemado por Meta no se recupera con un
  rollback.

- Dos pasos de modelo nuevos, `comprador` y `prueba`, visibles y ajustables en
  `/admin/modelos`.

- `scripts/test-smoke-tester.mjs` en `npm test`: esquema, claves de upsert,
  idempotencia de la semilla, la función de resumen, y **las invariantes del
  código** — sin `z.number()`, sin `await` pelado, webhook sin 5xx, primer
  mensaje en primer plano, correlación por teléfono.

### Cambiado

- `lib/research/run.ts` lanza las pruebas al terminar, también en el camino de
  caché: el análisis del sitio vale un mes, pero que hoy contesten en dos minutos
  no dice nada de hace tres semanas. El enfriamiento de 72 h decide.
- `blanquearCifras()` acepta un cuarto argumento con el texto de reemplazo. La
  red es la misma; lo que cambia es la voz — «lo hablamos en la llamada» en boca
  de un comprador delata la prueba.
- El paquete de referencia se movió a `docs/referencia/smoke-tester/` y quedó
  fuera de `tsconfig` y de ESLint: es código de otra aplicación, y corregirlo lo
  volvería una copia editada en vez de la referencia.

### Lo que NO se hizo, a propósito

- **No se automatiza a quién más se le escribe.** Por el camino automático solo
  entran números publicados en el sitio de la organización que pidió el
  diagnóstico. Todo lo demás pasa por una persona en `/admin/pruebas`.
- **El motor por eventos no tiene pruebas automáticas.** Necesita un proveedor
  respondiendo, y simularlo probaría la simulación. Se verifica a mano con el
  paso 6 de acá abajo. Es la deuda más grande de este cambio.
- **No se le avisa al cliente cuando termina.** Si cerró la pestaña, tiene que
  volver al enlace del diagnóstico. Resend ya está conectado; es lo obvio que
  sigue.

### Para desplegarlo

**1 · Supabase — proyecto nuevo, hay que correr TODO.**

El proyecto pasa a `vbtoqprrmgfhisfcmcpx`. Está vacío, así que las catorce
migraciones van **en orden**, una por una, desde el SQL Editor:

```
0001_init.sql → 0002_seed_quiz.sql → 0003_motor_de_correo.sql →
0004_exponer_api.sql → 0005_claves_y_settings.sql → 0006_sustrato.sql →
0007_gobierno.sql → 0008_la_sala.sql → 0009_cro.sql → 0010_cmo.sql →
0011_integraciones.sql → 0012_flujo_inicial.sql →
0013_agente_de_agendamiento.sql → 0014_smoke_tester.sql
```

Todas son idempotentes. Correr una fuera de orden falla temprano diciendo cuál
falta: `0013` sin `0011` y `0014` sin `0007` están cubiertas por
`scripts/test-orden-migraciones.mjs` y `scripts/test-smoke-tester.mjs`.

Después, **Project Settings → API → Exposed schemas: agregar `holaamigo`**. Sin
eso PostgREST devuelve `Invalid schema: holaamigo` y todo falla con un mensaje
que no dice qué hacer.

Verificar con `GET /api/health`, que responde 503 mientras falte algo bloqueante.

**2 · Vercel — variables nuevas.**

```
CALLBELL_API_KEY          Callbell → Settings → API
CALLBELL_WEBHOOK_SECRET   una cadena larga y aleatoria, la inventás vos
```

Y las que cambian de valor con el proyecto nuevo:

```
SUPABASE_URL              https://vbtoqprrmgfhisfcmcpx.supabase.co
SUPABASE_SERVICE_ROLE_KEY la del proyecto nuevo
NEXT_PUBLIC_SITE_URL      el dominio del proyecto nuevo
```

Opcionales: `MODEL_COMPRADOR`, `MODEL_PRUEBA`.

**3 · El webhook de Callbell.**

Apuntarlo —o apuntar la aplicación que reenvía los mensajes— a:

```
https://TU_DOMINIO/api/webhooks/callbell?k=EL_SECRETO
```

El `GET` de esa misma URL devuelve `{"ok": true}` si el secreto es correcto.

**4 · El cron.** `/api/cron/pruebas` cada 5 minutos ya está en `vercel.json`; se
registra solo en el despliegue.

**5 · La línea, y el envío aislado.** En `/admin/pruebas` → «Nuestra línea»,
verificar el número y el `channel_uuid` que la migración siembra
(`+573054182637` / `124902a5f0fa43289fe1fa7a4c23fe0d`) y **mandar un mensaje de
prueba a tu propio celular con el botón que está ahí mismo**. No sigas hasta
verlo llegar: la mitad de los problemas de configuración viven en ese paso y
salen todos en dos segundos.

**6 · Una conversación entera, a mano.** Creá una prueba contra tu propio
celular, contestá vos, y verificá que la transcripción quede completa y que la
prueba cierre sola. Es lo que las pruebas automáticas no cubren.

**Apagado de emergencia**, sin desplegar:

```sql
insert into holaamigo.settings (key, value)
values ('pruebas.bateria', '{"activo": false}')
on conflict (key) do update
  set value = jsonb_set(holaamigo.settings.value, '{activo}', 'false');
```

---

## [3.7.0] — 2026-08-20 · Del diagnóstico a un agente que agenda

Appointment setting por WhatsApp es el primer mercado, y entre "el cliente leyó
su diagnóstico" y "el cliente tiene un agente que agenda citas" había dos
semanas de correos. Todo lo que se intercambiaba en esas dos semanas ya estaba
en nuestra base cuando terminó el quiz; nadie lo estaba leyendo.

Ahora elegir WhatsApp **arma el agente en menos de un minuto** y el cliente le
habla ahí mismo, antes de que exista el número.

Ver [ADR 0024](adr/0024-el-agente-se-compila-del-diagnostico.md) y
[wiki/22](wiki/22-agente-de-agendamiento.md).

### Agregado

- **El playbook compilado** (`lib/playbook/compile.ts`, `holaamigo.agent_playbooks`).
  Un objeto de datos versionado —oferta, calificación, objeciones, FAQ,
  agendamiento, guion, escalamiento, tono— que sale de leer el research, el
  Brief, el diagnóstico y las respuestas del quiz. El modelo aporta lenguaje; el
  código aporta los hechos y los números. `PlaybookLanguageSchema` **no tiene un
  solo `z.number()`**, y `blanquearCifras()` borra del texto cualquier cifra de
  dinero que no esté autorizada por el Brief o publicada en el sitio: el guion
  llega a un contacto real sin ninguna pantalla intermedia donde un humano lo
  lea.

- **La base de conocimiento** (`lib/playbook/knowledge.ts`,
  `holaamigo.knowledge_bases`). Un vector store por organización con el sitio del
  cliente, su oferta, sus precios, su competencia y su FAQ. `file_search` en cada
  turno. Vence a los 30 días de inactividad para que un prospecto que probó una
  vez no cueste plata para siempre. **Si falla, el agente sigue funcionando**: los
  hechos viven en el playbook, no en el índice.

- **El runtime del setter** (`lib/whatsapp/setter.ts`, `lib/whatsapp/tools.ts`).
  Responses API con `previous_response_id` —el turno 20 cuesta lo mismo que el
  2— y herramientas que tocan la agenda de verdad: `consultar_horarios`,
  `agendar_cita`, `registrar_calificacion`, `escalar_a_humano`, `no_contactar`.
  El tool list es la intersección de siempre, calculada en runtime.
  `runConversation()` vive en `lib/ai/client.ts` para que siga habiendo **una
  sola** envoltura sobre la Responses API.

- **`/agente/[orgId]`.** El orden es el de la confianza y no el obvio: primero
  háblale, después confirma lo que inferimos, y al final da tu número. Pedir
  datos antes de que el cliente vea para qué son es cómo se pierde a la mitad de
  la gente.

- **El simulador** (`/api/agent/chat`). Corre por el mismo runtime que las
  conversaciones reales, con `channel = 'simulador'`. Solo se apagan las
  escrituras hacia afuera. En la interfaz se ven las herramientas que usó cada
  turno: "Consultó tu agenda" al lado del mensaje es la diferencia entre creerle
  al agente y poder verificarlo.

- **"Confirmá cuatro cosas"** (`components/playbook-review.tsx`) en vez de un
  formulario. Cada campo trae su valor ya escrito, dice por qué importa, y sube
  el porcentaje de cobertura al confirmarlo.

- **El embudo del setter** (`holaamigo.embudo_del_setter`,
  `holaamigo.objeciones_que_matan`) en `/consola/[orgId]/agentes`, junto con la
  **instrucción textual completa** que el modelo lee en cada turno. Sin resumir.

- **El webhook de WhatsApp contesta.** Con playbook, el agente responde y se
  envía por la Cloud API. Sin playbook, sigue el camino de v1: clasificar,
  suprimir y escalar. Un lead suprimido no recibe respuesta automática aunque
  escriba.

### Cambiado

- **`techo_de_plan` ahora recibe la clase de riesgo.** Lo encontró una prueba: un
  cliente del plan `diagnostico` no podía compilar su propio playbook, porque el
  techo L2 se aplicaba por igual a todas las clases y compilar terminaba en una
  tarjeta de aprobación por cada build. La regla correcta ya estaba escrita en
  `techo_de_autonomia`: **el plan gobierna lo que sale del edificio, no lo que el
  agente hace con sus propios objetos.** `read` y `write` van libres;
  `external_comms`, `spend` e `irreversible` siguen topados. `min_plan` y
  `platform_ceiling` no se tocaron. `autorizar` y `habilidades_activas` se
  redefinen enteras en `0013` con esa única línea distinta.

- **`stage_alcanzado` en `conversations`**, mantenido por trigger. Otro bug que
  encontró la prueba: `cerrar_conversacion()` pone `stage = 'cerrado'`, así que
  una conversación que llegó a proponer horario y después escaló quedaba contada
  como si nunca hubiera pasado de la apertura. El embudo contaba de menos
  exactamente en las conversaciones que más interesan.

- **`embudo_inicial` tiene ocho etapas**, no seis: se sumaron "Armó su agente" y
  "Habló con su agente". Se redefine en `0013` en vez de editar `0012`, porque una
  migración que cambia después de haberse aplicado es una migración que nadie
  puede auditar.

- **`/conectar` cambió de significado.** Elegir WhatsApp ya no registra una
  intención: arma el agente. El skip sigue visible (§13.5).

- **El research persiste el texto de las páginas** (sección `pages` de
  `research_findings`). Pasaba por el crawler y moría ahí; ahora es la materia
  prima de la base de conocimiento.

- **Pasos de modelo nuevos:** `playbook` y `setter`, configurables en caliente
  desde `/admin/modelos` como todos los demás.

### Para desplegar

1. **Correr las migraciones EN ORDEN** en el SQL Editor de Supabase:

   ```
   0011_integraciones.sql  →  0012_flujo_inicial.sql  →  0013_agente_de_agendamiento.sql
   ```

   `0013` crea `agent_playbooks`, `knowledge_bases`, `conversations` y
   `conversation_turns`; siembra cuatro capacidades y cuatro habilidades; y
   **redefine `techo_de_plan`, `autorizar`, `habilidades_activas` y
   `embudo_inicial`**. Las tres son idempotentes: correr una dos veces no hace
   daño.

   El orden importa de verdad: `0013` siembra las habilidades del setter en
   `holaamigo.skills`, que la crea `0011`. Si falta, `0013` **se detiene antes de
   tocar nada** y dice qué archivo correr — no revienta 500 líneas adentro con un
   `42P01` que no explica nada. Ese guardia está cubierto por
   `scripts/test-orden-migraciones.mjs`.

2. **Verificar desde `/api/health`.** Se agregó el chequeo `db:v10`, que no solo
   mira que las tablas existan: comprueba que `techo_de_plan` sea la versión de
   dos argumentos y que `embudo_inicial` devuelva ocho etapas. Desde afuera,
   "las migraciones corrieron" y "el cliente puede compilar su guion sin generar
   una tarjeta" se ven idénticas hasta que un cliente lo intenta.

   > **Ojo:** al momento de escribir esto, producción también tenía pendiente
   > `0011_integraciones.sql` (P6) — `db:v9` en rojo. El orden es 0011 → 0012 →
   > 0013.

3. **O a mano, en el SQL Editor:**

   ```sql
   select holaamigo.techo_de_plan('diagnostico', 'write');  -- 5
   select holaamigo.techo_de_plan('diagnostico', 'external_comms');  -- 2
   select id from holaamigo.capabilities where id like 'playbook%' or id like 'setter%';
   select count(*) from holaamigo.embudo_inicial();  -- 8
   ```

4. **Variables de entorno.** Ninguna nueva es obligatoria. Para que el agente
   **envíe** por WhatsApp (además de razonar) hacen falta, cuando el número esté
   aprobado por Meta:

   ```
   WHATSAPP_TOKEN=...
   WHATSAPP_PHONE_NUMBER_ID=...
   ```

   Sin ellas el turno se calcula igual y el mensaje queda en `messages` con
   estado `queued` y el motivo escrito. No es un fallo silencioso.

5. **Opcional, por modelo:** `MODEL_PLAYBOOK` y `MODEL_SETTER`. Por defecto
   `gpt-5-mini`. El playbook se compila una vez por cliente y gobierna meses de
   conversaciones: es el paso donde subir el modelo se paga solo.

6. **Nada que hacer con los clientes existentes.** Un cliente sin playbook sigue
   funcionando por el camino de v1. El agente se compila la primera vez que
   entra a `/agente/[orgId]` o elige WhatsApp en `/conectar`.

---

## [3.6.0] — 2026-08-17 · El flujo inicial muestra su trabajo

Los primeros seis minutos son donde el cliente decide si esto piensa o si es un
formulario con IA de adorno. Estábamos guardando toda la evidencia de que sí
piensa y no mostrando casi nada de ella.

Ni una llamada de modelo nueva: todo lo que aparece acá ya estaba en la base.
Ver [ADR 0023](adr/0023-mostrar-el-trabajo.md) y
[wiki/21](wiki/21-flujo-inicial-y-embudo.md).

### Agregado

- **La cascada de fugas** (`components/charts/leak-waterfall.tsx`). Las cuatro
  fugas eran cuatro renglones sin proporción entre sí: decían cuánto, no *cuánto
  de qué*. Ahora se ve el techo alcanzable arriba, cada fuga como el pedazo que
  se cae, y lo que entra hoy abajo. Cada barra arranca donde termina la anterior.
  Se mueve con los controles, en el mismo frame.

- **El embudo de la cuenta al revés** (`components/charts/inverse-funnel.tsx`).
  `computeInverseMath` ya producía la cadena entera y se renderizaba como una
  lista numerada. El embudo va **al derecho** aunque la cuenta vaya al revés, con
  la conversión de cada caída al lado y los contactos por semana destacados
  debajo. La derivación con sus fórmulas sigue ahí, intacta: el dibujo no
  reemplaza la auditoría.

- **La primera cifra, en la pregunta 5** (`lib/quiz/preview.ts`). Al responder
  `dormant_db` el servidor devuelve la fuga de base dormida ya calculada, con su
  fórmula, y **se queda en pantalla el resto del quiz**. Sale de `computeLeaks`,
  no de una fórmula copiada, así que no puede contradecir al diagnóstico. Si
  respondió "No sé", no hay adelanto. Evento nuevo: `quiz_preview_shown`.

- **`/admin/embudo`.** `plg_events` llevaba desde `0001` guardando todo lo
  necesario y nadie lo agregaba. Tres bloques, cada uno con su decisión escrita
  encima: dónde se cae la gente · en qué pregunta exacta · qué supuestos
  discuten. Más la duración real del quiz contra los 6 minutos que promete la
  landing. Sin series temporales: se respeta el criterio de wiki/14.

- **Tres funciones de agregación** en `0012_flujo_inicial.sql`:
  `embudo_inicial()` (por organización, cohorte anclada al primer
  `landing_submit`), `caida_por_pregunta()` (abandonos = última respuesta de una
  sesión sin completar) y `supuestos_discutidos()` (dirección de cada edición).

- **En la ficha 360:** los dos gráficos que el cliente está viendo, fit e intent
  sobre una barra de 100 con los umbrales dibujados, qué números no se creyó con
  la dirección del cambio, y `utm`/`referrer` — que se venían seleccionando y no
  se renderizaban nunca.

- **`node scripts/test-flujo-inicial.mjs`** — 18 chequeos de las tres funciones
  contra Postgres real (PGlite). Ya entró a `npm test`.

### Cambiado

- **El ticker del research pasó de una línea a una línea de tiempo.**
  `progress_log` guarda hasta 40 pasos con timestamp y se mostraba **uno**. Ahora
  se ven los últimos cuatro con el tiempo real de cada uno. Una línea que cambia
  cada tanto se lee como un spinner con texto; la lista con tiempos prueba que
  hubo trabajo.

- **La pantalla de ensamblaje dejó de mentir.** Rotaba cinco frases con un
  `setInterval(4200)` que no tenía relación con nada, y es la pantalla más larga
  del flujo. Ahora hay dos cosas vivas y las dos son reales: el estado del
  research y un cronómetro. Los cinco pasos siguen listados en presente, sin
  marcador por paso — se dice qué está corriendo, no se finge saber en cuál va.
  Pasados los 90 s el mensaje lo reconoce.

- **`assumption_edited` ahora lleva `from` y `to`.** Guardaba el objeto completo
  de supuestos y nadie comparaba dos versiones: sabíamos que alguien tocó
  `close_rate` pero no si nos considera optimistas o pesimistas, que es lo que
  cambia el default. El origen se captura en el primer disparo del arrastre y no
  en el último, para que mover 18% → 40% no quede registrado como "subió un
  punto". Los campos son opcionales: un cliente con la página vieja en caché
  sigue guardando su supuesto, solo que sin dirección.

- `QuizFlow` recibe `currency` — el adelanto se muestra en la moneda local que
  el research escribió en `organizations` (ADR 0006), y en USD si todavía no
  terminó.

### Sabido y no hecho

- **No hay evento de visita a la landing**, así que la conversión visitante →
  submit que §4.1 declara (≥35%) **no se puede calcular**. El embudo arranca en
  `landing_submit` y la pantalla lo dice en vez de dibujar una primera barra al
  100% que parezca que sí. Un `POST /api/track` público es una superficie de
  escritura nueva sobre `plg_events`; se hace cuando haga falta de verdad
  (§13.3).
- `supuestos_discutidos()` ignora las ediciones anteriores a esta versión: no
  guardaban el valor previo y su dirección es irrecuperable.

### Para desplegar

1. **Correr `supabase/migrations/0012_flujo_inicial.sql`.** Idempotente, no crea
   ni una tabla — son tres funciones y sus permisos.
2. Verificar que el schema recargó: `select * from holaamigo.embudo_inicial();`
   desde el SQL Editor debe devolver seis filas.
3. **Sin variables de entorno nuevas y sin cambios de costo.** No hay ninguna
   llamada de modelo adicional en todo esto.
4. `/admin/embudo` queda en la barra del admin, entre Cola y Señales.
5. El bloque "Qué números no se creen" arranca vacío y se llena con las
   ediciones nuevas. Es esperado, no un error de despliegue.

---

## [3.5.0] — 2026-08-16 · P6 · Integraciones, CRM propio y habilidades

Sexta y última parte del plan de la meta-organización. P2 definió qué puede
**hacer** un agente; esto define qué puede **usar**, y guarda quién hizo qué.

### Agregado

- **El registro de habilidades.** `skills`, `skill_grants` y `skill_requests`,
  con catálogo de 9 herramientas sembrado. El tool list de runtime es la
  intersección de cuatro conjuntos, y el cuarto usa **las mismas funciones del
  motor de permisos de P2**: subir la autonomía de un agente hace aparecer una
  habilidad sin desplegar, y bajar el plan la hace desaparecer aunque el grant
  siga ahí. Ver [ADR 0022](adr/0022-habilidades-y-crm-con-actor.md).

- **La regla dura, con trigger.** Ninguna habilidad de clase `spend` o
  `irreversible` se enciende sin operador y sin sobre: *sin tope no es un
  permiso, es una firma en blanco*.

- **El "intraer".** `conHabilidad()` ejecuta si el agente tiene la herramienta y,
  si no, deja un pedido con su justificación y **la decisión que quedó
  bloqueada**. Aparece en `/admin/habilidades`. Los agentes empujan capacidades
  hacia sí mismos; nosotros decidimos cuáles existen.

- **HubSpot y la ingesta.** Sync incremental con cursor hacia
  `staging_contacts`. **Los contactos no entran a operación hasta que se
  analicen** — obliga a pasar por el paso que paga y evita que 8.000 contactos
  crudos aparezcan como leads trabajables. La credencial se referencia por
  nombre de variable de entorno, no se guarda en la tabla.

- **Lotes de análisis y reactivación.** El sistema propone el tamaño (los que
  interactuaron en 18 meses, acotado al saldo), cotiza, espera aprobación y
  **después** cobra. El cobro es atómico en SQL: el estado del lote es el candado
  contra el doble cobro. La clasificación de temperatura es por reglas de
  recencia, no por modelo.

- **El CRM propio, con trazabilidad de actor.** `opportunities` y `touchpoints`:
  cada toque sabe quién lo hizo (agente o humano), qué decisión lo originó y
  cuánto costó. La vista `lead_timeline` resuelve el costo por paso. Ningún CRM
  del mercado puede pintar esa línea.

- **Pantallas:** `/consola/[orgId]/crm` (pipeline + línea de tiempo) y
  `/admin/habilidades` (pedidos y catálogo).

- **`/api/cron/datos`** — sincroniza, propone lotes y corre los aprobados.

- **`node scripts/test-integraciones.mjs`** — 30 chequeos con los cinco
  criterios de aceptación de P6.

### Cambiado

- `integrations` (de `0003`) se **extiende** en vez de recrearse: gana
  `credentials_ref`, `config`, `cursor` y `connected_by`, y su `check` de
  proveedor acepta los nuevos. Un `create table if not exists` sobre una tabla
  con otra forma no falla — no hace nada, y el error aparece después con un
  mensaje que no dice por qué. Lo encontró la prueba.

### Para desplegar

1. **Correr `supabase/migrations/0011_integraciones.sql`.** Idempotente; siembra
   el catálogo de habilidades y lo actualiza en cada corrida.
2. Verificar `db:v9` en `GET /api/health?key=$CRON_SECRET`.
3. **Para conectar HubSpot de un cliente:** poner el token en una variable de
   entorno (por ejemplo `HUBSPOT_TOKEN_ACME`) y llamar a `conectar()` con ese
   nombre como `credentialsRef`. El OAuth es de una tarde y se escribe cuando
   haya tres clientes con HubSpot, no antes (§13.3).
4. Las habilidades de clase `spend` e `irreversible` se otorgan **desde SQL**,
   con el sobre escrito y revisado. La UI de admin las rechaza a propósito.

---

## [3.4.0] — 2026-08-16 · P5 · La CMO expandida

Quinta de las seis partes. Seis funciones que hoy nadie hace porque no da el
tiempo, y una disciplina que es la parte importante.

### Agregado

- **Posicionamiento vivo y medible.** Versionado, con dos listas —lo que la
  marca dice y lo que **nunca** dice— y `holaamigo.deriva_de_copy()` que compara
  el copy que está saliendo contra el documento vigente.
  Ver [ADR 0021](adr/0021-la-cmo-expandida.md).

- **Inteligencia competitiva semanal.** Snapshot con hash por competidor y
  sección (precios, oferta, **vacantes**, home). Solo alerta lo que cambió; la
  primera captura nunca alerta. El modelo explica por qué importa citando el
  antes y el después, y su segunda frase dice qué **no** hay que hacer.

- **La fábrica de ángulos, y la columna que le faltaba.** `angles.sent` y
  `angles.replied` existían desde `0001` y nunca se escribieron: ningún mensaje
  guardaba de qué ángulo salía. Ahora `messages.angle_id` lo estampa —solo si la
  campaña prueba **un** ángulo— y `holaamigo.saturacion_de_angulos()` compara dos
  ventanas de 14 días con muestra mínima.

- **Prueba social industrializada.** Detecta deals grandes (umbral relativo al
  ticket promedio), redacta el caso con los números del CRM y pide lo único que
  no podemos hacer nosotros: permiso del cliente final. Dos candados en la base:
  un caso por deal, y nada publicado sin aprobación.

- **Media play.** Detecta el activo de data propietaria y deja el brief listo —
  no la publicación. Disparo manual a propósito (§13.3).

- **La máquina de upsell, con escalera.** `detected → proposed_internal →
  proposed_client`, y el salto al cliente exige firma humana nuestra por `check`
  constraint. Cinco reglas de detección, cada una sostenida con dos números.

- **Pantallas:** `/consola/[orgId]/marca` para el cliente y `/admin/senales`
  para nosotros. Que estén separadas es la decisión del ADR hecha interfaz.

- **`/api/cron/cmo`** — diario (casos y ángulos), con rama semanal los lunes
  (competencia y señales). `?semanal=1` fuerza la parte semanal.

- **`node scripts/test-cmo.mjs`** — 24 chequeos con los cuatro criterios de P5.

### Cambiado

- La comparación de diferenciadores pasó de literal a **por raíz de palabra**.
  Con comparación literal, "te respondemos en 60 segundos" marcaba deriva contra
  "responde en 60 segundos" — y a la tercera falsa alarma nadie vuelve a mirar
  la alerta. Lo encontró la prueba en la primera corrida.
- `campaigns.angle_ids` ahora se llena al proponer, con un solo ángulo o
  ninguno. Nunca dos: una tasa de respuesta repartida a ojo es peor que ninguna.

### Para desplegar

1. **Correr `supabase/migrations/0010_cmo.sql`.** Idempotente.
2. Verificar `db:v8` en `GET /api/health?key=$CRON_SECRET`.
3. **Escribir el posicionamiento de cada cliente activo.** Sin él, la deriva no
   se puede medir (la función devuelve `sin_posicionamiento: true` y la pantalla
   de Marca lo dice). Se escribe con `writePositioning()` desde un script o
   desde el SQL Editor; la UI de edición no está y se anota en la wiki.
4. Las alertas de competencia arrancan **la segunda semana**: la primera
   corrida guarda la línea base sin alertar.

---

## [3.3.0] — 2026-08-16 · P4 · El President como CRO

Cuarta de las seis partes. El President ya sabía proponer (P1) dentro de una
correa (P2) y discutirlo a la vista (P3); ahora sabe cuánto entró, cuánto salió
y en qué se fue — y **por fin alguien mide** las predicciones que P1 venía
registrando.

### Agregado

- **P&G por canal.** `revenue_events`, `cost_events` y la vista
  `channel_economics` con ingreso, costo, margen, clientes, **CAC y ROAS** por
  mes. Reembolsos y churn restan; el CAC es `null` y no cero cuando no hubo
  clientes. Ver [ADR 0020](adr/0020-pre-registro-y-economia-por-canal.md).

- **El costo de pensar entra al P&G.** `importar_costos_de_agentes()` trae el
  costo de agente de P1 como gasto `agent_compute`, todas las noches e
  idempotente. Sin eso el P&G miente por omisión.

- **Motor de experimentos con pre-registro obligatorio.** Hipótesis, métrica,
  efecto esperado, regla de decisión, muestra mínima y guardrail se declaran
  **antes**, y un trigger impide cambiarlos una vez que el experimento arrancó.
  La regla es un objeto (`{comparador, umbral}`), no una frase: una regla que no
  se aplica literalmente no es un pre-registro, es una intención.

- **El readout cierra el ciclo de P1.** Aplica la regla, respeta el guardrail
  —que le gana a la métrica principal—, exige la muestra declarada, y escribe el
  `outcome` de la decisión asociada vía `cerrar_decision()`. De ahí sale la
  calibración y de ahí el destilador saca lecciones.

- **Pronóstico de tres escenarios** con banda de variación semanal acotada y
  probabilidades que son la lectura estándar de una banda P85/P50/P15 — no una
  simulación disfrazada.

- **Propuesta de reasignación de presupuesto** que toca P1, P2 y P3 a la vez:
  registra decisión con predicción, pasa por `budget.shift` (techo **L2**:
  prepara, no ejecuta) y abre deliberación con las dos posiciones. Mueve como
  máximo el 20%, del peor canal al mejor, y solo con evidencia en los dos.

- **El libro de resultados** (`/consola/[orgId]/libro`) con seis secciones y la
  columna que ningún competidor muestra: **qué predijo cada agente, qué pasó y
  qué tan lejos estuvo**. CSV por `/api/libro/[orgId]`; PDF por el diálogo de
  impresión. Los dos leen el mismo objeto, así que traen los mismos números por
  construcción.

- **`/api/cron/mes`** (día 1, 8 a.m. Bogotá): importa costos, guarda el
  pronóstico y propone la reasignación.

- **`node scripts/test-cro.mjs`** — 26 chequeos con los cuatro criterios de P4,
  incluido el caso que rompe un join ingenuo (10 ingresos × 8 gastos).

### Para desplegar

1. **Correr `supabase/migrations/0009_cro.sql`.** Idempotente.
2. Verificar `db:v7` en `GET /api/health?key=$CRON_SECRET`. Ese chequeo pide el
   readout de un experimento inexistente y exige error de dominio.
3. El cron `/api/cron/mes` se registra con el deploy. Ya son cinco crons; sigue
   dentro de lo que permite el plan Pro.
4. **Los ingresos hay que cargarlos.** `revenue_events` acepta `source` de
   Stripe, Wompi o HubSpot con `external_ref` idempotente, pero el conector es
   de P6: hoy entran a mano o por el checkout propio. Sin ingresos, el P&G
   muestra solo costos y el pronóstico sale en cero — que es correcto, no un
   error.

---

## [3.2.0] — 2026-08-16 · P3 · La Sala

Tercera de las seis partes, y la primera con pantallas. P1 y P2 eran invisibles;
son lo que hace que esto tenga algo que mostrar.

### Agregado

- **La deliberación como objeto.** `deliberations` + `deliberation_turns`: la
  conversación entre agentes con turnos atribuidos, postura (`propose`,
  `object`, `decide`…) y desacuerdo explícito. Ver
  [ADR 0019](adr/0019-la-deliberacion-como-objeto.md).

- **Dos reglas que viven en la base, no en el render:**
  1. No se resuelve sin `what_would_change_my_mind` (mínimo 20 caracteres). Ni
     un `update` a mano puede saltárselo.
  2. **Si el humano habló, la recomendación tiene que citarlo.** No se exige que
     el cliente tenga razón: se exige decir qué se hizo con lo que dijo.

- **La Sala** (`/consola/[orgId]/sala`): vista de lectura, columna angosta,
  tipografía de libro. El cliente se mete en cualquier hilo; lo que escribe pesa
  **2.0** —más que la evidencia del sistema— y **reabre la deliberación** aunque
  estuviera resuelta. La recomendación anterior queda a la vista: es lo que el
  agente pensaba antes de escuchar.

- **El feed, rehecho.** Máximo **7 tarjetas** en pantalla, priorizadas por
  `holaamigo.priorizar_feed()` y **cada una con el motivo de por qué está ahí**.
  Teclado (`J`/`K`/`A`/`R`/`X`/`E`), aprobación en lote solo para severidad baja
  y normal, y la tarjeta desaparece al instante —vuelve si el servidor falla.

- **"Ajustar" nunca abre una caja de texto.** Sliders sobre números reales y
  checkboxes sobre ítems reales, declarados por la propuesta
  (`ajustes_disponibles`) y aplicados antes de ejecutar. El tipo de la ruta
  (`number | string[]`, nunca `string`) impide que se convierta en otra caja de
  texto con otro nombre.

- **El Capítulo.** Job diario a las 12:00 UTC (7 a.m. Bogotá): 150–250 palabras
  narradas, archivadas como serie. **Si el modelo escribe una cifra que no le
  dimos, se descarta el texto** y se publica la versión determinista.

- **Cada diagnóstico abre una deliberación real.** Las notas de ruta se atribuyen
  al agente de su dominio (WhatsApp/correo → SALES, marca → CMO) y el rationale
  del President es el turno que decide. No se inventan turnos.

- **`node scripts/test-la-sala.mjs`** — 22 chequeos con los cuatro criterios de
  aceptación de P3.

### Cambiado

- `DiagnosisSchema` gana **`what_would_change_my_mind`**, con ejemplos en el
  prompt de lo que cuenta y de lo que no. En modo degradado hay una frase de
  respaldo que admite que el diagnóstico salió corto en vez de fingir precisión.
- Nuevo paso de modelo `chapter`, configurable desde `/admin/modelos` como los
  demás.
- La consola gana la pestaña **La Sala**, en segundo lugar: es lo que explica lo
  que aparece en el feed, y un cliente que no entiende de dónde salió una
  propuesta no la aprueba.

### Para desplegar

1. **Correr `supabase/migrations/0008_la_sala.sql`.** Idempotente.
2. Verificar `db:v6` en `GET /api/health?key=$CRON_SECRET`. Ese chequeo intenta
   resolver una deliberación con una frase de cinco letras y exige que la
   función responda con error de dominio.
3. El cron `/api/cron/capitulo` se registra solo con el deploy. Usa el
   `CRON_SECRET` que ya existe.
4. Opcional: `MODEL_CHAPTER` si se quiere fijar el modelo del capítulo por
   variable de entorno en vez de por `/admin/modelos`.

---

## [3.1.0] — 2026-08-15 · P2 · Gobierno

Segunda de las seis partes. Los permisos de los agentes dejan de ser frases en
español dentro de `agents.permissions` —que ningún código consultaba— y pasan a
ser una máquina que se evalúa antes de cada acción.

### Agregado

- **La escalera de capacidades (L0–L5).** Toda capacidad de todo agente vive en
  uno de seis niveles, de "ni la menciona" a "ejecuta y se audita por muestreo".
  Catálogo de 25 capacidades sembrado en la migración, con el ejemplo trabajado
  del plan completo: la CMO investiga partners en L5, redacta en L2, contacta en
  L3–L4 con sobre, prepara un term sheet en L2 y **firma en L0, sin excepción**.
  Ver [ADR 0018](adr/0018-la-escalera-de-capacidades.md).

- **Los tres diales.** `nivel_efectivo = MIN(plataforma, cliente, plan)`. El
  techo de plataforma no está en ninguna pantalla y no lo mueve ningún cliente;
  el del cliente se recorta al escribir además de al evaluar.

- **El sobre.** Límites declarados que hacen posible L4: monto, volumen por día
  y por semana, contrapartes permitidas y prohibidas, compromisos prohibidos,
  vencimiento y aviso obligatorio de que escribe un agente. Un sobre violado
  bloquea **y** genera tarjeta; no degrada en silencio.

- **`holaamigo.autorizar()` — la única puerta.** Decide y escribe la auditoría
  (`guard_events`) en la misma transacción. Falla cerrado: capacidad desconocida
  o motor caído dan `blocked`.

- **SLA por tipo de tarjeta.** Cada `approval_kind` declara qué pasa si el humano
  no contesta: `campaign_launch` se rechaza a las 48 h; `pause_losing_campaign`
  se **aprueba** a las 4 h. Corre en el barrido de cada 2 minutos.

- **Cableado real.** `activateCampaign()` (`campaign.launch`) y `dispatchDue()`
  (`outreach.send_email`, sexta verificación por lote) pasan por el motor. Una
  aprobación autoriza la campaña una vez; el sobre limita el ritmo todos los días.

- **`node scripts/test-gobierno.mjs`** — 42 chequeos contra Postgres real, ya en
  `npm test`.

### Cambiado

- **La CMO deja de estar forzada a `propose`.** El principio §13.1 no cambia; se
  aplica con precisión: el President —el que razona sobre dinero— tiene
  `budget.shift` con techo de plataforma **L2** (prepara la reasignación, no la
  ejecuta) y su autonomía sigue fija.
- **`agents.autonomy` gana una cuarta posición, `sampled` (L5)**, que no está en
  el formulario del cliente: la abre un operador a mano (§13.3).
- **`agents.autonomy` ahora gobierna solo lo que sale del edificio.** Las
  capacidades `read` y `write` internas no lo tocan: sin eso, la CMO en
  `propose` no podría ni mirar el sitio de un competidor.
- **La regla de reversibilidad del plan se corrigió.** Decía "baja un nivel";
  aplicada literal dejaba L4 inalcanzable para todo lo que sale hacia afuera y
  el sobre no se evaluaba nunca. Quedó como **tope en L4**: una acción
  irreversible nunca corre sin sobre. Lo encontró la prueba, está explicado en
  el ADR.

### Para desplegar

1. **Correr `supabase/migrations/0007_gobierno.sql`** en el SQL Editor. Es
   idempetente y siembra el catálogo; correrla de nuevo lo actualiza.
2. Verificar `db:v5` en `GET /api/health?key=$CRON_SECRET`. Ese chequeo no mira
   tablas: le pregunta al motor por `partnership.commit` y exige `blocked`.
3. **El plan de cada organización lo deriva la migración** del ciclo de vida:
   quien esté en `activated`, `trial` o `customer` pasa a `starter` (techo L3).
   El resto queda en `diagnostico` (L2). Sin eso, la correa frenaría en seco los
   envíos de los clientes que ya estaban corriendo. Verificar después de correr:
   ```sql
   select plan, lifecycle, count(*) from holaamigo.organizations group by 1,2;
   ```
   Para abrir L4 —ejecutar dentro de sobres— hay que subir a `growth` a mano.
4. Sin variables de entorno nuevas.

---

## [3.0.0] — 2026-08-15 · P1 · El sustrato

Primera de las seis partes del plan de la meta-organización
([`docs/plan/meta-organizacion.md`](plan/meta-organizacion.md)). **No hay una
sola pantalla nueva**: es la capa sobre la que descansan P2 a P6. Si se salta o
se hace a medias, todo lo demás se construye sobre arena.

### Agregado

- **La microdecisión como unidad del sistema.** Tabla `decisions`: qué se
  decidió, con qué alternativas, con qué evidencia, **qué se predijo** y **qué
  pasó**. Tres invariantes viven en `check` constraints de la base y no en el
  código: mínimo dos opciones, predicción obligatoria (salvo `escalate` y
  `handoff`), y la predicción con métrica, valor esperado y horizonte.
  Ver [ADR 0016](adr/0016-la-microdecision-como-unidad.md).

- **Trazas y costo por decisión.** `traces` registra cada paso de ejecución con
  su `run_id`; `holaamigo.imputar_costos()` reparte el costo de cada corrida
  entre las decisiones que produjo; la vista `cost_rollup` agrega por
  organización, agente, día y tipo de decisión y **cuadra exacto** contra la
  suma cruda de trazas. Las trazas se purgan a los 90 días, las decisiones no.

- **Calibración.** `holaamigo.calibracion(esperado, real)` y
  `holaamigo.cerrar_decision()`, que escribe el resultado y la calibración en la
  misma sentencia — es imposible guardar un `outcome` sin ella.

- **El destilador, en SQL.** `holaamigo.destilar()` agrupa decisiones medidas
  por tipo × contexto × métrica y escribe lecciones con `n`, `lift` y confianza
  calculados, sin llamar al modelo (ADR 0007 aplicado al aprendizaje). Las de
  alcance `organization` con confianza > 0,7 se activan solas; las de `industry`
  y `global` **no pueden quedar activas sin firma humana**, y eso es un `check`
  en la base, no una convención. Ver [ADR 0017](adr/0017-lecciones-sin-pgvector.md).

- **Inyección de contexto aprendido.** `buildLearningContext()` recupera las 5–8
  lecciones más relevantes (similitud + confianza + alcance) más lo que escribió
  el humano (`human_inputs`, con peso), y deja traza de qué leyó el agente. Las
  lecciones no se hornean en el prompt.

- **La primera decisión real.** La elección de ruta del President en
  `lib/diagnostic/generate.ts` ahora se registra como decisión: tres opciones
  con su costo calculado, una elegida, y predicción medible a 90 días.

- **`GET /api/cron/destilar`** — pasada nocturna (07:00 UTC): destila, calcula
  vectores, imputa costos y purga trazas viejas.

- **`node scripts/test-sustrato.mjs`** — los cuatro criterios de aceptación de
  P1 como pruebas contra Postgres real (PGlite). Ya está en `npm test`.

### Para desplegar

1. **Correr `supabase/migrations/0006_sustrato.sql`** en el SQL Editor de
   Supabase. Es idempotente.
2. Verificar con `GET /api/health?key=$CRON_SECRET` que `db:v4` esté en `ok`.
   Ese chequeo mira las cinco relaciones **y** la función `calibracion` por RPC:
   sin el `grant execute` las tablas existen igual y el aprendizaje se queda
   mudo sin error visible.
3. El cron nuevo se registra solo con el deploy (`vercel.json`). Requiere
   `CRON_SECRET`, que ya existe.
4. Sin variables de entorno nuevas. Los embeddings usan la `OPENAI_API_KEY` que
   ya está; si falta, la recuperación degrada a solape de palabras.

### Notas

- No hay UI. Se valida por SQL, por `/api/health` y por `npm test`.
- La medición automática de resultados (quién escribe el `outcome`) llega en P4
  con el motor de experimentos. En P1 `settleDecision()` está disponible y
  `decisionesPorMedir()` lista las que ya vencieron su horizonte.

---

## [2.1.0] — 2026-08-15

Barrido de bugs antes de traer clientes. El quiz volvió a funcionar, los fallos
de escritura dejaron de ser invisibles, y el modelo de IA se cambia desde el
admin sin desplegar.

### Corregido

- **El quiz no guardaba ninguna respuesta y no avanzaba.** `quiz_responses`
  tenía dos índices únicos **parciales** y el código hacía `upsert` con
  `onConflict` sobre esas columnas. Postgres no puede usar un índice parcial
  como árbitro de un `ON CONFLICT` que no repite su predicado: cada respuesta
  fallaba con `42P10`. Ahora hay una columna generada `answer_key =
  coalesce(question_id, slot)` y **un** índice único plano.
  Ver [ADR 0015](adr/0015-claves-de-upsert-planas.md).

- **Ese fallo era invisible, y esa era la mitad del bug.** `supabase-js` no
  lanza: devuelve `{ error }`. Sesenta escrituras del código hacían
  `await db().from(x).insert(...)` sin mirarlo, así que un error de Postgres no
  aparecía ni en la pantalla ni en los logs — la ruta devolvía 200 con la misma
  pregunta. Se agregaron `mustWrite()` (lanza, para lo que no se puede perder) y
  `tryWrite()` (registra, para telemetría y contadores) en
  `lib/supabase/admin.ts`, y se aplicaron a todo el camino del producto.
  `/api/quiz/answer` además verifica que la pregunta haya cambiado y devuelve
  500 si no.

- **Crear un producto o una bandeja de correo fallaba siempre**, por la variante
  de índices de **expresión** del mismo problema (`lower(sku)`,
  `lower(address)`). Índices planos y normalización a minúsculas en el código.

- **`temperature` mataba cuatro de los seis pasos de IA.** Los modelos de la
  familia gpt-5 rechazan el parámetro con un 400 que no es `model_not_found`, así
  que la cadena de fallback no lo cubría: el paso moría entero. Las preguntas
  adaptativas del quiz caían siempre al respaldo, en silencio. Ahora
  `paramsFor()` decide los parámetros por familia de modelo, y un 400 de
  parámetro no soportado reintenta sin él.

- **Respuestas vacías por presupuesto de tokens.** En modelos de razonamiento
  `max_output_tokens` incluye el razonamiento invisible; con los topes viejos
  (500 en `classify`, 1200 en `adaptive_question`) el modelo gastaba el
  presupuesto pensando y devolvía texto vacío, que se veía igual que un fallo de
  esquema. Topes subidos, `reasoning.effort` explícito por paso, y un mensaje de
  error que dice qué subir y dónde.

- **La generación del diagnóstico podía duplicarse.** La idempotencia por sesión
  vivía solo en un `select` previo: dos llamadas concurrentes creaban dos
  diagnósticos, cobraban dos corridas del modelo, y a partir de ahí el
  `maybeSingle()` de la comprobación fallaba para siempre con *multiple rows*.
  Ahora hay índice único en `diagnostics(session_id)`, la inserción perdedora
  relee la ganadora, y el cliente tiene una guarda con `useRef` contra el doble
  disparo del efecto.

- **La barra de progreso del quiz retrocedía** al pasar de las fijas a las
  adaptativas. El total se estima con el piso (4 adaptativas) y el cliente nunca
  deja bajar el porcentaje.

- **El error de ensamblaje quedaba oculto** detrás de la pantalla "estamos
  armando tu diagnóstico", para siempre. Ahora se muestra con un botón de
  reintentar.

### Añadido

- **`/admin/modelos`** — qué modelo corre cada paso, editable sin desplegar.
  Precedencia: tabla `settings` → variable de entorno → default del código.
  Toma efecto en menos de 30 segundos. La pantalla muestra al lado el costo real
  de cada paso en los últimos 30 días.
  Ver [ADR 0014](adr/0014-configuracion-en-caliente.md).
- **Tabla `holaamigo.settings`** y `lib/settings.ts`, con caché de 30 s.
- **`npm test`** — pruebas contra Postgres de verdad, sin Docker ni servidor
  (PGlite, WASM). `scripts/test-claves.mjs` **reproduce** el bug con el esquema
  viejo y prueba que el nuevo funciona; `scripts/test-migraciones.mjs` corre las
  cinco migraciones en orden **dos veces** y verifica que el upsert real del
  quiz funcione contra el esquema real. Ninguna prueba con la base simulada
  habría visto este bug: hacía falta un planificador de Postgres diciendo que
  no.
- **`npm run smoke`** — prueba de humo del flujo completo contra una URL real:
  intake → quiz → diagnóstico → panel. Falla si una pregunta del quiz se repite,
  que es exactamente el bug de esta versión.
- **`db:v3` en `GET /api/health`** — verifica que la columna `answer_key` y la
  tabla `settings` existan. La pregunta "¿corrió la migración?" se responde con
  un curl.

### Cambiado

- **Todos los pasos de IA arrancan en la familia mini/nano.** Decisión temporal
  y deliberada mientras se prueba el flujo: un diagnóstico completo cuesta
  centavos en vez de un dólar largo. Es seguro porque ninguna cifra que el
  cliente lee sale del modelo (ADR 0007). Para volver a calidad de producción no
  hay que desplegar: `/admin/modelos`, subir `diagnosis` y `research`.

### Para desplegar

1. **Correr `supabase/migrations/0005_claves_y_settings.sql`** en el SQL Editor
   de Supabase. Sin esto el quiz sigue sin guardar. Es idempotente.
2. Verificar: `curl https://TU_DOMINIO/api/health` debe devolver `ok: true` con
   `db:v3` en verde.
3. Correr la prueba de humo: `node scripts/smoke.mjs https://TU_DOMINIO`.
4. Opcional: en `/admin/modelos`, subir `diagnosis` a `gpt-5` si se quiere
   calidad de producción. No requiere despliegue.

No hay variables de entorno nuevas.

---

## [2.0.1] — 2026-08-15

Arreglo del arranque en producción y del diagnóstico a ciegas que lo hizo caro.

### Corregido

- **`Invalid schema: holaamigo` en cada consulta.** No era un bug del código: el
  schema dedicado de ADR 0001 no estaba en la lista de *Exposed schemas* de la
  API de Supabase, y PostgREST rechazaba todo con `PGRST106`. En la app se veía
  como *"Algo se rompió de nuestro lado"* en el primer clic de la landing.
  El paso nunca estuvo documentado — ese era el bug real.

### Añadido

- `supabase/migrations/0004_exponer_api.sql` — expone el schema por SQL, con
  manejo de excepciones: si no hay permisos avisa en vez de abortar. El
  dashboard sigue siendo la fuente duradera.
- `GET /api/health` — responde en un solo request si hay credenciales, si la
  base contesta, si el schema está expuesto, qué migraciones corrieron y si el
  seed del quiz está. Devuelve 503 cuando algo bloqueante falla, así que sirve
  de health check de monitoreo. Público ve los nombres de los chequeos;
  los mensajes de error exigen cookie de admin o `?key=$CRON_SECRET`.
- `explainDbError()` en `lib/supabase/admin.ts` — traduce los errores de
  configuración de Supabase (schema no expuesto, migraciones sin correr,
  permisos, key inválida) a instrucciones. `/api/intake` ya lo usa: el usuario
  sigue viendo el mensaje amable y el log dice qué arreglar.
- Runbook: sección "El primer arranque en un proyecto de Supabase nuevo" con
  los tres pasos obligatorios y el síntoma de cada uno.

### Para desplegar

1. Correr `0004_exponer_api.sql`, **o** agregar `holaamigo` en Project Settings
   → API → Exposed schemas.
2. Verificar con `curl https://TU_DOMINIO/api/health`.

---

## [2.0.0] — 2026-08-15

Motor de correo, activos brandeados y el feed del President. El diagnóstico
dejó de terminar en una promesa: ahora arranca una operación.

### Añadido

**Base de datos** (`supabase/migrations/0003_motor_de_correo.sql`)
- 13 tablas nuevas: `integrations`, `mailboxes`, `email_threads`,
  `campaign_metrics`, `assets`, `asset_events`, `bookings`, `products`,
  `orders`, `credit_ledger`, `feed_items`, `scheduled_actions`.
- Columnas nuevas en `campaigns` (objetivo, secuencia, esperado, medición,
  iteración), `messages` (hilo, bandeja, asunto, headers, clasificación),
  `agents` (`config`, `autonomy`) y `leads` (`source`, `external_ref`).
- Función `holaamigo.credit_balance(uuid)`.
- RLS deny-by-default sobre todo lo nuevo, con el mismo bloque de `0001`.

**Correo** (ADR 0008 · wiki 10)
- SendGrid para campañas; Resend se queda para el correo del producto.
- Bandejas múltiples por cliente con tope duro, rampa de calentamiento
  (20/día, +30% diario) y rotación por antigüedad de uso.
- Recepción por Inbound Parse con emparejamiento de hilos por `In-Reply-To`.
- Webhook de eventos con verificación de firma ECDSA.
- Link de baja propio en `/api/baja/[messageId]` → supresión global,
  cancelación inmediata de los envíos pendientes de esa persona.
- Pausa automática de bandeja por encima de 5% de rebotes o 0,3% de quejas.

**Campañas** (wiki 11)
- Cuatro playbooks: reactivación, rescate, conquista, lanzamiento. Selección
  determinista de tres según diagnóstico y base.
- Cada campaña trae segmento, proyección con rango, plan de medición con
  fechas reales y reglas de iteración que pueden pausarla sola.
- El CMO escribe el copy; los números los calcula `lib/campaigns/math.ts`
  (ADR 0007). Copy de respaldo si el modelo falla.
- Despachador con cinco verificaciones por correo, aunque esté aprobada.

**Instantly** (ADR 0009)
- Importación de listas de leads. El envío y la medición se quedan acá.
- Exige base legal, igual que la carga de un CSV.

**Activos brandeados** (ADR 0010 · wiki 12)
- Agendador propio en `/agendar/[slug]`: cálculo de horarios puro y
  browser-safe, zonas horarias con `Intl`, sin cuenta para quien agenda.
- Checkout en `/pagar/[slug]` sobre el inventario del cliente, con reserva de
  cupos y fee congelado en la orden.
- `asset_events` registra visita y conversión: es toda la atribución.

**Créditos** (ADR 0011)
- Ledger inmutable, saldo por suma. Débito en el envío real, no en la
  aprobación. Créditos de bienvenida al provisionar los agentes.

**Feed del President** (ADR 0012 · wiki 13)
- `feed_items` con cinco tipos. Las propuestas siguen escribiendo en
  `approvals`: la auditoría no se parte.
- Briefing diario: resumen, reglas de iteración, saldo, propuesta de envío y
  petición de insumos al humano.
- Tope de items abiertos: si hay 4 esperando, el President no propone más.

**Agentes configurables** (wiki 13)
- Tres niveles de autonomía para SALES. President y CMO fijos en `propose`.
- El contrato sigue siendo inmutable y se muestra al lado del formulario.

**Consola del cliente** (`/consola/[orgId]`)
- Siete pantallas: feed, campañas, bandeja, agenda, activos, agentes y números.

**Observabilidad** (wiki 14)
- `scheduled_actions` con qué va a pasar, por qué y cómo se mide.
- Esperado contra real por campaña, salud de bandejas y agentes, consumo de
  créditos y ventas atribuidas.

### Pendiente y explícito

- **Pagos en placeholder** (ADR 0013): la orden se registra, se reserva el
  cupo y se calcula el fee, pero el cobro es manual.
- **Acceso a la consola por link** (`lib/auth/console.ts`): quien tiene la URL
  de `/consola/[orgId]` puede decidir por esa organización, igual que el panel
  de v1. **Hay que cambiarlo por auth real antes del primer cliente que no sea
  fundador.**
- Las credenciales de integraciones se guardan en claro en `integrations`. El
  schema es deny-by-default y solo las lee código de servidor; pasan a Vault
  cuando haya más de un operador con acceso a la base.

### Para desplegar

1. **Migración:** correr `supabase/migrations/0003_motor_de_correo.sql` en el
   SQL Editor del proyecto. Es idempotente.
2. **Variables nuevas** (ver `.env.example`):
   - `SENDGRID_API_KEY` — sin ella el motor corre y registra en el log.
   - `SENDGRID_WEBHOOK_PUBLIC_KEY` — **obligatoria en producción**: sin ella el
     webhook de eventos rechaza todo.
   - `SENDGRID_INBOUND_SECRET` — va en la URL de la Inbound Parse.
   - `EMAIL_INBOUND_DOMAIN` — subdominio apuntado a `mx.sendgrid.net`.
   - `INSTANTLY_API_KEY` — opcional; cada cliente puede conectar la suya.
3. **SendGrid:**
   - Autenticar el dominio de envío (SPF, DKIM, DMARC).
   - Inbound Parse del subdominio →
     `https://TU_DOMINIO/api/webhooks/sendgrid/inbound?k=SENDGRID_INBOUND_SECRET`
   - Signed Event Webhook →
     `https://TU_DOMINIO/api/webhooks/sendgrid/events`, activar la firma y
     copiar la clave pública.
4. **Cron:** `vercel.json` agrega `/api/cron/dispatch` cada 5 minutos. Usa el
   mismo `CRON_SECRET`.
5. Verificar con `npx tsc --noEmit` y `npm run build`.

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
