# 02 · Cómo hace las pruebas

---

## 1. Los tres modos

| | **Modo 1 · Guion fijo** | **Modo 2 · Flujo completo** | **Modo 3 · Disparo externo** |
|---|---|---|---|
| Ruta | `POST /[suiteId]/run` | `POST /[suiteId]/run-auto` | `POST /[suiteId]/run-form` |
| Quién escribe los mensajes | Vos, de antemano | Un LLM, turno a turno | Vos (el sistema externo abre) |
| Arquitectura | Función viva con polling | Motor por eventos | Híbrido |
| Duración máxima | ~2 mensajes antes de morir | **Sin límite práctico** | Limitado |
| Para qué sirve | Verificar una respuesta puntual | **Probar el flujo hasta el cierre** | Probar el embudo real de marketing |
| Costo IA | 0 | ~1 llamada barata por turno | 0 |

**Cuál usar:** el 2 para casi todo. El 1 cuando querés verificar una respuesta
concreta y determinística ("¿si le pregunto el precio del proyecto X, dice el
número correcto?"). El 3 solo si tu conversación real arranca desde afuera
(un formulario de Meta Ads, un CRM, una plantilla).

---

## 2. Modo 1 — Guion fijo

La secuencia trae la lista de mensajes:

```json
[
  { "text": "Hola, buenas tardes" },
  { "text": "Vi un apartamento suyo, ¿sigue disponible?", "delay": 8000 },
  { "text": "¿Cuánto cuesta?", "delay": 10000 }
]
```

El runner manda uno, espera la respuesta por webhook (polling sobre
`awaiting_reply`, hasta 4 min), acumula la ráfaga (12 s de silencio), espera
el `delay`, y manda el siguiente.

### Por qué NO alcanza — y ésta es la lección central

Caso real, 18 de agosto de 2026. Suite "Prueba OpenAI Mirasol Web":

```
17:11:19  comprador → "Hola, quiero información sobre el proyecto Mirasol"
17:11:48  agente    → "…confírmame tu CORREO, nombre, y apellido para continuar."
17:12:04  run       → completed ✅
```

46 segundos. El agente contestó **bien**. La prueba se paró igual, porque la
secuencia tenía **un solo mensaje**: el guion se acabó y el runner marcó
`completed`. No hubo error. Simplemente no había nada más que decir.

El intento siguiente, con un segundo mensaje agregado a mano con el correo
escrito, se desincronizó en el turno siguiente: el agente pidió las cosas en
otro orden.

> **Contra un agente que decide su propio flujo, un comprador guionado no
> llega nunca al cierre.** Un guion fijo asume que sabés qué te van a
> preguntar y en qué orden. Un agente conversacional no te da esa garantía —
> y si te la diera, no haría falta probarlo.

El guion fijo sirve para lo que sirve un test determinístico: verificar una
respuesta puntual. No para probar un flujo.

---

## 3. Modo 2 — Flujo completo con comprador IA

**Archivo:** `codigo/lib/smoke-tester/buyer-ai.ts`

El otro lado de la conversación. Recibe el hilo completo y devuelve el
siguiente mensaje del comprador.

### 3.1 Las tres cosas que lo hacen funcionar

**(a) Identidad fija.** Nombre, correo, celular, ciudad, presupuesto —
constantes durante toda la conversación:

```
TU IDENTIDAD (úsala siempre igual, nunca la cambies ni la inventes de nuevo):
- Nombre completo: Camila Restrepo
- Correo: camila.restrepo.pruebas@gmail.com
- Celular: 3001234567
```

Si el agente pide el correo tres veces, recibe el mismo correo tres veces.
**No es un detalle de realismo: es lo que hace verificable la prueba.**
Terminada la conversación podés ir al CRM y confirmar que el lead llegó con
ese correo exacto. Con una identidad que muta no podés afirmar nada.

**(b) Un objetivo.** Una frase que dice a dónde tiene que llegar:

> *"Conocer el proyecto, sus precios y condiciones, y terminar agendando una
> visita a la sala de ventas con fecha y hora."*

Después de contestar lo que le preguntaron, el comprador **empuja** hacia ahí.
Sin objetivo, la conversación deriva y nunca llega a un cierre evaluable.

**(c) Criterio de cierre propio.** El comprador decide cuándo terminar:

- el asesor confirmó la cita con fecha y hora, o mandó la cotización;
- el asesor cerró con una etiqueta (`#agendado`, `#cotizacion`);
- el asesor dijo que un humano va a contactar y no hay nada más que hacer;
- la conversación empezó a dar vueltas.

Esto es lo que evita que la prueba se quede pegada dando vueltas hasta agotar
el tope de turnos.

### 3.2 El prompt, comentado

Cinco secciones, en este orden:

```
1. QUIÉN SOS
   "Eres una PERSONA REAL buscando vivienda en Colombia y estás escribiendo
    por WhatsApp a un asesor inmobiliario. NO eres un asistente, no eres una
    IA y jamás mencionas que esto es una prueba."
   ↑ sin esto, el modelo se delata: "Como asistente, te comento que…"

2. TU IDENTIDAD          → los datos fijos

3. TU OBJETIVO           → a dónde empujar

4. CÓMO ESCRIBÍS
   - Mensajes cortos, 1-2 frases, español colombiano. Nada de markdown.
   - SIEMPRE respondés primero lo último que te preguntaron.
   - Si te preguntan varias cosas, las contestás todas en el mismo mensaje.
   - Después de contestar, empujás hacia tu objetivo.
   - No repitas tu mensaje anterior; si no te entendió, reformulá.
   - Nunca inventes que ya diste un dato: revisá el historial.

5. CUÁNDO TERMINAR       → los 4 criterios de arriba
```

La regla *"SIEMPRE respondés primero lo último que te preguntaron"* es la que
más impacto tiene. Sin ella el comprador ignora las preguntas del agente y
sigue su propia agenda, y la conversación no avanza nunca.

La regla *"nada de markdown"* también importa: los LLM escriben listas con
viñetas por defecto, y nadie manda viñetas por WhatsApp. Un agente bien hecho
puede reaccionar raro a un mensaje que parece generado.

### 3.3 Salida estructurada

```ts
{
  mensaje:  string,   // lo que escribe, tal cual iría por WhatsApp
  terminar: boolean,  // ¿ya se cumplió el objetivo?
  motivo:   string    // por qué sigue o por qué termina
}
```

Se pide con `json_schema` + `strict: true` sobre la Responses API. Sin salida
estructurada hay que parsear prosa, y el día que el modelo conteste
`"¡Claro! Aquí va: {...}"` perdés el turno.

El campo `motivo` no se usa para decidir nada: se guarda en
`form_data.ultimo_motivo` y **es el que te explica después por qué la
conversación tomó el rumbo que tomó**. Vale su peso en oro cuando estás
depurando.

### 3.4 El fallback heurístico

Sin `OPENAI_API_KEY` —o si la llamada falla— el módulo **no explota**. Cae a un
comprador de reglas que:

1. detecta etiquetas de cierre → termina;
2. reconoce qué le pidieron (correo / nombre / celular / presupuesto / ciudad)
   por regex y lo entrega desde la misma identidad;
3. detecta la autorización de tratamiento de datos y acepta;
4. si no reconoce nada, avanza por una escalera fija de 6 preguntas
   (precios → metros → zona → subsidio → visita → día y hora).

Peor conversación, **mismo flujo completo**. La función nunca queda muerta por
falta de llave, y en CI podés correr el arnés sin gastar un peso en tokens.

> Este patrón —degradar en vez de fallar— es de los que más se pagan solos.
> Un arnés de QA que se cae cuando falta una variable de entorno deja de
> usarse a la semana.

### 3.5 Parámetros

| Parámetro | Default | Nota |
|---|---|---|
| `objetivo` | agendar visita con fecha y hora | La palanca principal. Cambialo y cambia toda la prueba |
| `persona` | Camila Restrepo, Bogotá, 250 M | Usá un correo real y verificable |
| `mensaje_inicial` | `messages[0]` de la 1ª secuencia | Lo único que se usa del guion |
| `max_turnos` | 14 | Acotado a [2, 40]. 14 cubre un flujo inmobiliario completo |
| `contexto` | `ficha_tecnica` de la secuencia | Lo que el comprador "sabe" del producto |
| `SMOKE_BUYER_MODEL` | `gpt-4o-mini` | Un modelo chico alcanza y sobra |

---

## 4. Modo 3 — Disparo desde un sistema externo

En Rentmies el embudo real es: formulario de Meta Ads → workflow en Bubble →
plantilla de WhatsApp Business → conversación. El comprador **no abre**; lo
abren.

```
POST /run-form
  ├── 1. marca el run como waiting_for_template = true   ← ANTES
  ├── 2. dispara el webhook del sistema externo (Bubble)
  └── 3. devuelve

webhook ← llega la PLANTILLA (no es una respuesta: es la apertura)
  ├── camino 1.5: la reconoce por waiting_for_template
  ├── la guarda como conversation[0] con role 'agent'
  └── arranca el loop del comprador
```

**El orden del paso 1 es un bug arreglado, no un capricho.** Al principio era:
disparar Bubble → si responde OK → marcar `waiting_for_template = true`. Meta
a veces entregaba la plantilla **más rápido** que el roundtrip HTTP con
Bubble; el webhook llegaba con el flag todavía en `false`, no matcheaba nada,
y el mensaje se perdía en silencio.

> **Regla general: armá el receptor antes de disparar el emisor.** Vale para
> cualquier integración donde la respuesta puede llegar por un canal distinto
> al de la petición.

---

## 5. Colas seriales — probar N escenarios

**Archivo:** `codigo/lib/smoke-tester/campaign-advancer.ts`

Con **un solo número de pruebas**, dos conversaciones simultáneas se mezclan
en el webhook (que empareja contra "el run activo"). Entonces: de a una.

```
cola: [escenario1, escenario2, …, escenario29]
  │
  ├── arranca escenario1
  ├── espera a que llegue a estado terminal
  ├── espera inter_run_delay_seconds (default 60)
  ├── revalida que la cola siga en 'running' (el usuario pudo cancelar)
  ├── arranca escenario2
  └── …
```

29 escenarios × ~12 min = **~6 horas**. Es un test nocturno, no un test de PR.

El avanzador se llama desde dos lados: desde el runner en cada salida
terminal, y desde el watchdog como red por si el primero murió. Es
idempotente-por-diseño: si la cola ya no está en `running`, se retira.

Detalle que se ve barato y no lo es: cuando un escenario no existe, **no mata
la cola** — incrementa `failed_projects`, salta al siguiente y sigue. Una cola
de 6 horas que muere en el escenario 4 por un dato faltante no sirve para
nada.

---

## 6. Los guiones prefabricados

`templates.ts` trae 5 guiones con variables `{proyecto}`:

| id | Mensajes | Para qué |
|---|---|---|
| `quick` | 3 | Smoke mínimo: ¿responde y da precio? |
| `standard` | 6 | Comprador interesado, de saludo a visita |
| `price` | 5 | Negociación: tipologías, financiación, descuentos |
| `comparison` | 4 | Busca opciones en una zona y pide recomendación |
| `prodesa-full` | 6 | Las 11 preguntas obligatorias de un agente específico |

Siguen sirviendo en modo autónomo: `messages[0]` es el mensaje de arranque.

El patrón de `prodesa-full` es el más interesante de robar: **el comprador no
responde pregunta por pregunta, vuelca la información en bloques naturales.**

```
"Es para vivir, estoy buscando en Bogotá. Mi presupuesto máximo son 350 millones"
```

Tres datos en un mensaje. Así habla la gente, y así se descubre si el agente
sabe extraer varios campos de una frase o si solo entiende respuestas de a
una. Un guion que entrega un dato por mensaje **le hace el examen fácil**.

---

## 7. Cómo se prueba el arnés (el flujo del usuario)

1. `/terminal/smoke-tester` → **Nueva suite**: nombre + número del agente +
   mensaje inicial.
2. Abrir la suite → **Flujo completo**.
3. Ajustar objetivo e identidad (los defaults sirven) y el tope de turnos.
4. **Iniciar flujo completo.** El primer mensaje sale en el acto; si el
   transporte lo rechaza, el error aparece de inmediato en el modal en vez de
   esconderse en los logs.
5. Ver la conversación crecer sola en la vista en vivo (`Turno 3 de 14` +
   objetivo). **Se puede cerrar el navegador**: el motor es 100 % de servidor.
6. Al cerrarse: transcripción completa + `closed_with` + botón para evaluar
   con LLM.

Detalle de UX que se ganó a los golpes: **el primer mensaje se manda en primer
plano**, no en el `waitUntil`. Es la única parte del flujo donde el usuario
está mirando, y es donde fallan el 90 % de los problemas de configuración
(token vencido, número mal escrito, device desconectado). Mandarlo en segundo
plano convierte un error de 2 segundos en una investigación de 20 minutos.
