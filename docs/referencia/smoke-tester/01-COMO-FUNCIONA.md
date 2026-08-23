# 01 · Cómo funciona

---

## 1. El problema que resuelve

Un agente conversacional en producción falla de maneras que ningún test
unitario ve:

- responde bien la primera pregunta y se pierde en la cuarta;
- inventa un precio que no está en la base;
- pide el correo tres veces;
- llega al final del flujo pero nunca emite la etiqueta de cierre que dispara
  el registro en el CRM;
- deja de responder a los 6 minutos y nadie se entera.

Todo eso solo aparece **en una conversación completa, contra el agente real,
por el canal real**. El smoke tester automatiza exactamente eso: pone a un
comprador sintético a hablarle al agente productivo por WhatsApp, deja que la
conversación corra hasta el cierre, guarda la transcripción y la califica.

Es *smoke test* en el sentido literal: no verifica cada rama, verifica que
prendés el aparato y no sale humo.

---

## 2. Las cuatro entidades

```
SUITE ──┬── SECUENCIA ──┐
        │               │
        └── RUN ────────┴── RESULTADO
```

| Entidad | Qué es | Analogía |
|---|---|---|
| **Suite** | Qué agente pruebo y contra qué número. | El archivo de tests |
| **Secuencia** | Qué le digo (guion) o de dónde arranco (autónomo) + la ficha de verdad. | Un `describe` |
| **Run** | Una ejecución de la suite. | Una corrida de CI |
| **Resultado** | Una conversación completa: transcripción + veredicto + nota. | Un `it` con su assert |

Dos campos de la suite se confunden siempre y rompen todo el setup:

- `test_phone` = el número **desde el que escribe** el comprador (tu device).
- `target_phone` = el número **del agente bajo prueba** (a dónde escribís).

Y un campo de la secuencia carga más peso del que parece: `ficha_tecnica` es
la **verdad de referencia**. Sin ella el evaluador puede juzgar tono y
completitud, pero no puede detectar una alucinación, porque no sabe cuál era
el dato correcto.

---

## 3. La decisión de arquitectura que define todo

### Lo que se intentó primero: el runner con una función viva

```
POST /run
  ├── manda mensaje 1
  ├── espera la respuesta (polling a la base, hasta 4 min)  ← acá muere
  ├── manda mensaje 2
  └── …
```

Funciona para 2-3 mensajes. Falla para un flujo real, por aritmética:

```
Vercel mata la función a los 300 s.
Esperar una respuesta: hasta 240 s.
Acumular la ráfaga del agente: 12 s.
⇒ DOS mensajes del comprador agotan el presupuesto.
```

Un flujo completo son 8-14 turnos y 15-25 minutos. La función moría a la
mitad, el run quedaba en `running` **para siempre**, y —peor— envenenaba la
correlación del webhook, que empareja los mensajes entrantes contra "el run
running más reciente". Un run zombi se traga las respuestas de los runs
siguientes.

Está en `runner.ts:19` como deuda anotada en su momento:

> *"runs largos se van a cortar — el smoke-tester debe tolerar ejecuciones
> truncadas hasta que migremos a Pro o partamos el runner en chunks."*

### Lo que se construyó: el motor por eventos

**Nadie espera a nadie.** El estado de la conversación vive en la base, no en
la memoria de un proceso. Cada mensaje entrante es un evento que despierta el
sistema, hace un turno y lo apaga.

```
POST /run-auto
  └── manda el mensaje 1 → responde 202 → muere        (~2 s)

webhook ← respuesta del agente
  ├── guarda la respuesta
  ├── espera 10 s de silencio (la ráfaga son 3-5 mensajes)
  ├── el comprador IA redacta el turno siguiente
  ├── lo manda
  └── muere                                            (~30-60 s)

webhook ← … y así hasta el cierre
```

Cada invocación dura menos de un minuto. **La conversación completa puede
durar 25 minutos sin chocar con ningún límite de plataforma**, porque en
ningún momento hay una función esperando.

> Ésta es la idea que hay que llevarse. Todo lo demás —el `turn_token`, los
> watchdogs, el settle— son consecuencias de haber elegido este modelo.

---

## 4. El ciclo de un turno, en detalle

**Archivo:** `codigo/lib/smoke-tester/conversation-engine.ts`

```
llega un mensaje entrante
  │
  ├─ 1. webhook-handler correlaciona
  │     ¿qué fila está esperando respuesta?
  │     → awaiting_reply = true, run.status = 'running', el más reciente
  │
  ├─ 2. anexa el texto a results.conversation y baja awaiting_reply
  │
  ├─ 3. RESERVA el turno: escribe un turn_token nuevo en el run
  │     (síncrono, ANTES de programar el trabajo de fondo)
  │
  ├─ 4. waitUntil(advanceAutonomousTurn(resultId, token))
  │     ── devuelve 200 al proveedor ──
  │
  └─ 5. en segundo plano:
        a. settleBurst: espera 10 s de silencio (techo duro 60 s)
        b. relee el run: ¿sigue 'running'? ¿sigue siendo autónomo?
        c. ¿el token sigue siendo el mío? si no → me retiro en silencio
        d. ¿el agente cerró con #agendado / #cotizacion? → cerrar
        e. ¿se acabaron los turnos? → cerrar como 'incomplete'
        f. el comprador IA redacta el turno siguiente
        g. RECLAMA el token justo antes de mandar (redactar tardó segundos)
        h. escribe el mensaje en la transcripción, sube awaiting_reply,
           y recién ahí lo manda por el transporte
```

Tres detalles que parecen menores y no lo son:

**(b) Releer el estado.** Entre el settle y el turno pueden haber pasado 60
segundos. El run pudo cancelarse, cerrarse o cambiar de modo. Confiar en lo
que leíste al entrar es cómo se resucitan runs muertos.

**(g) Reclamar el token tan tarde como se pueda.** Redactar con el LLM tarda
2-5 s. En esa ventana puede llegar otro chunk del agente que reprograma el
turno. Si reclamaras al principio, contestarías con información vieja.

**(h) Marcar `awaiting_reply = true` ANTES de mandar.** Si el agente contesta
rapidísimo, el webhook tiene que encontrar la fila ya armada. Al revés se
pierde la respuesta, y no hay reintento.

---

## 5. La guarda de concurrencia (`turn_token`)

**El problema:** los agentes conversacionales rara vez contestan con un
mensaje. Mandan 3-5 chunks cortos seguidos ("Hola 👋" / "Claro que sí" /
"Te cuento del proyecto…"). Cada chunk dispara **su propio webhook**, y cada
webhook querría contestar. Sin guarda, el comprador manda 4 mensajes seguidos
y la conversación se vuelve ilegible.

**La solución, en tres líneas:**

```ts
// al programar un turno (síncrono, en el webhook):
const token = newTurnToken()            // "lz3k1p-a8f2c9d1"
await writeState(db, runId, { turn_token: token })

// al despertar (segundo plano), antes de gastar un peso en el LLM:
if (state.turn_token !== token) return  // otro chunk más nuevo se lo llevó

// y otra vez justo antes de mandar:
const claimed = await claimTurn(db, runId, token)   // pone turn_token = null
if (!claimed) return
```

**Gana el último chunk** — que es justo el que vio la respuesta completa. Los
anteriores se retiran en silencio, sin escribir nada.

> Cualquier sistema donde una respuesta llega en pedazos necesita esta guarda.
> Si tu transporte garantiza un mensaje por respuesta, podés saltártela; en
> cuanto no lo garantice, la vas a necesitar.

---

## 6. Dónde vive el estado

Todo el estado del run autónomo vive en **una columna JSONB**,
`smoke_test_runs.form_data`:

```json
{
  "modo": "autonomo",
  "objetivo": "terminar agendando una visita con fecha y hora",
  "persona": { "nombre": "...", "correo": "...", "telefono": "...",
               "ciudad": "...", "presupuesto": "..." },
  "contexto": "ficha técnica del proyecto…",
  "max_turnos": 14,
  "turno": 7,
  "turn_token": "lz3k1p-a8f2c9d1",
  "motivo_cierre": null,
  "ultimo_motivo": "El asesor pidió el presupuesto",
  "fuente_comprador": "ia"
}
```

**Por qué en un JSONB y no en columnas:** el proyecto arrastraba varias
migraciones sin correr en producción, y una nueva habría dejado la función
muerta hasta que alguien abriera el editor SQL. Además `trigger_type` tiene un
`CHECK` que solo acepta `manual|form_trigger|webhook`, así que agregar
`autonomo` ahí exigía tocar el constraint.

**Si arrancás de cero, hacelo distinto:** poné `autonomo` en el CHECK desde el
principio y dejá el JSONB solo para lo que de verdad es variable (`persona`,
`objetivo`). Y sobre todo: **`turno` y `turn_token` deberían ser columnas
propias.** Hoy `writeState()` hace leer-modificar-escribir sobre el JSONB, y
dos webhooks simultáneos pueden pisarse. Ver `05 §Deuda`.

---

## 7. Las tres redes de seguridad

Si el agente **nunca contesta**, no hay webhook — y sin webhook no hay quien
cierre el run. Queda colgado en `running`, y envenena la correlación de todos
los runs siguientes. Tres capas contra eso:

| Red | Dónde | Cuándo dispara | Qué tan confiable |
|---|---|---|---|
| **Cierre por estancamiento** | `GET /api/smoke-test/runs/[runId]` | 8 min sin respuesta | **La real.** La UI consulta este GET cada 2,5 s mientras el run vive |
| **Auto-cancelación al arrancar** | `POST /run-auto` y `/run` | cada vez que empezás una prueba nueva | Muy confiable, pero solo limpia la misma suite |
| **Cron watchdog** | `/api/cron/smoke-campaign-watchdog` | 1×/día en plan Hobby | La última. Recoge lo que las otras dos no vieron |

El watchdog cubre cuatro casos:

- **A** — el disparo externo nunca llegó (>5 min esperando).
- **B** — conversación estancada (>30 min sin respuesta con `awaiting_reply`).
- **C** — cola serial cuyo avanzador murió (el run actual ya terminó pero la
  cola sigue en `running`).
- **D** — **runs zombis**: `running`, sin ninguna fila esperando, sin
  actividad hace más de 60 min. Éstos son los que envenenan el webhook.

> Lección: la red de seguridad tiene que correr con la **frecuencia del
> problema**, no con la que te dé el plan. Un cron diario no rescata una
> conversación de 20 minutos. Por eso la red real terminó siendo el endpoint
> que la UI ya estaba consultando — gratis y cada 2,5 s.

---

## 8. Mapa de archivos

### Núcleo — portable tal cual

| Archivo | Líneas | Qué hace |
|---|---|---|
| `types.ts` | 206 | Todos los contratos. Empezá acá. |
| `buyer-ai.ts` | 250 | El comprador sintético: identidad fija, objetivo, criterio de cierre, fallback heurístico. |
| `conversation-engine.ts` | 567 | El motor por eventos: turno, settle, `turn_token`, cierres, reaper. |
| `webhook-handler.ts` | 419 | Correlación de entrantes. Parser tolerante a 6 formas de payload. 3 caminos de match. |
| `wzap.ts` | 72 | Transporte. La pieza más chica y la que más define el diseño. |
| `evaluator.ts` | 224 | Evaluador con Claude: 5 dimensiones 0-100 + alucinaciones + sugerencias. |

### Semi-portable — la idea sirve, el contenido es de Rentmies

| Archivo | Qué hace | Qué conservar |
|---|---|---|
| `runner.ts` | Runner clásico de guion fijo + flujo disparado por formulario. | El patrón `waitForReply` + `settleBurst`, si necesitás guion fijo. |
| `prodesa-auditor.ts` | Auditor determinístico de 10 pasos, 100 % regex, sin LLM. | **La estructura entera.** Solo cambian los pasos y las regex. |
| `campaign-advancer.ts` | Cola serial de escenarios con contadores y recuperación. | Todo, si tenés que correr N escenarios con un solo canal. |
| `templates.ts` | Guiones prefabricados con variables `{proyecto}`. | El mecanismo. Los guiones son inmobiliarios. |

### Específico — ejemplo, no producto

`bubble-trigger.ts`, `prodesa-catalog.ts`, `prodesa-sequence-generator.ts`, y
las rutas `admin/seed-prodesa` y `admin/diagnose-bubble`. Sirven como
referencia de **cómo se dispara una conversación desde un sistema externo** —
que es un patrón que probablemente necesites— pero el contenido no.

---

## 9. Las rutas HTTP

| Ruta | Método | Para qué |
|---|---|---|
| `/api/smoke-test` | GET / POST | Listar y crear suites |
| `/api/smoke-test/[suiteId]` | GET / DELETE | Detalle de suite |
| `/api/smoke-test/[suiteId]/sequences` | GET / POST | Secuencias |
| `/api/smoke-test/[suiteId]/run` | POST | **Modo 1** · guion fijo |
| `/api/smoke-test/[suiteId]/run-auto` | POST | **Modo 2** · flujo completo con comprador IA |
| `/api/smoke-test/[suiteId]/run-form` | POST | **Modo 3** · disparado desde un sistema externo |
| `/api/smoke-test/[suiteId]/campaign` | POST | Cola serial de N escenarios |
| `/api/smoke-test/runs/[runId]` | GET / DELETE | Estado en vivo (y red de seguridad) · cancelar |
| `/api/smoke-test/runs/[runId]/evaluate` | POST | Disparar la calificación con LLM |
| `/api/smoke-test/diagnose` | GET | Env vars + último run + últimos 30 logs |
| `/api/webhook/smoker-tester` | POST | **La entrada de todo.** Siempre devuelve 200 |
| `/api/cron/smoke-campaign-watchdog` | GET | Las 4 recuperaciones |

Dos convenciones que valen para cualquier port:

**El webhook SIEMPRE devuelve 200.** Aunque no haya matcheado nada, aunque el
JSON sea inválido, aunque el handler explote. Un 500 hace que el proveedor
reintente o —peor— desactive el webhook, y perdés la conversación entera por
un error transitorio. Los errores van al log, no al status code.

**El arranque valida el entorno antes de crear el run.** `/run` y `/run-auto`
revisan `WZAP_TOKEN` y `WZAP_DEVICE` y devuelven un 400 con el nombre exacto
de lo que falta. Sin eso, el fallo ocurre dentro del `waitUntil`, después del
202, y el usuario ve un run que "no hizo nada".
