# PRD 52 · Smoke Tester: el flujo completo, no el primer mensaje

**Fecha:** 18 de agosto de 2026
**Estado:** implementado
**Rama:** `backend-openai-supabase` → `master`

---

## 1. El síntoma

Suite *Prueba OpenAI Mirasol Web*
(`/terminal/smoke-tester/2845fd29-5357-466a-8141-65924fcd8d0b`).

La prueba de las 17:11 duró 46 segundos:

```
17:11:19  comprador → "Hola, quiero información sobre el proyecto Mirasol"
17:11:48  agente    → "…confírmame tu CORREO, nombre, y apellido para continuar."
17:12:04  run       → completed ✅
```

El agente contestó bien. La prueba se paró igual. Y a las 17:33 el segundo
intento se quedó colgado en `running` para siempre, con el comprador esperando
una respuesta que nadie iba a recoger.

## 2. Las dos causas (son distintas)

### A. La secuencia se quedó sin libreto

La suite tenía **una secuencia con un solo mensaje**. El runner manda los
mensajes escritos, uno por uno, y cuando se acaban marca el resultado como
`completed`. No hay error: el guion terminó.

El problema es más de fondo que "faltaban mensajes". El agente pidió *correo,
nombre y apellido*; un guion fijo no puede anticipar en qué orden va a pedir
las cosas un agente que decide su propio flujo. En el intento de las 17:33 el
usuario agregó una segunda secuencia con el correo escrito a mano — y se
desincronizó igual en el turno siguiente. **Contra un agente conversacional,
un comprador guionado no llega al cierre.**

### B. La arquitectura no aguanta un flujo completo

El runner clásico mantiene **una función viva** haciendo polling: manda el
mensaje, espera hasta 4 minutos la respuesta, manda el siguiente. Vercel mata
la función a los 300 s (tope del plan Hobby). Un flujo real —política de datos
→ identificación → proyecto → presupuesto → agendamiento— son 8-14 turnos y
15-25 minutos.

Cuentas: `MAX_REPLY_WAIT_MS` de 240 s + 12 s de ráfaga significa que **dos
mensajes del comprador ya pueden agotar los 300 s**. El run de las 17:33 murió
exactamente así: la función se apagó a mitad del `waitForReply` y el run quedó
en `running`, sin `completed_at`, envenenando el emparejamiento del webhook
para los runs siguientes.

Esto ya estaba anotado en el código como deuda:

> *"runs largos se van a cortar — el smoke-tester debe tolerar ejecuciones
> truncadas hasta que migremos a Pro o partamos el runner en chunks."*

## 3. Qué se construyó

### 3.1 Comprador IA (`lib/smoke-tester/buyer-ai.ts`)

El otro lado de la conversación. Recibe el hilo completo y devuelve el
siguiente mensaje del comprador, con:

- **Identidad fija** (nombre, correo, celular, ciudad, presupuesto): si el
  agente pide el correo tres veces, recibe el mismo correo tres veces. Es lo
  que permite verificar después que el lead llegó bien al CRM.
- **Un objetivo** ("terminar agendando una visita con fecha y hora"), que es
  hacia donde empuja después de contestar lo que le preguntaron.
- **Criterio de cierre propio**: `terminar = true` cuando el agente confirmó
  la cita, mandó la cotización, cerró con `#agendado`/`#cotizacion`, o la
  conversación empezó a dar vueltas.

Salida estructurada (`json_schema`) sobre la Responses API que ya usa todo el
backend. Sin `OPENAI_API_KEY` cae a un comprador heurístico que reconoce las
preguntas típicas (correo, nombre, presupuesto, autorización de datos) y sigue
una escalera de preguntas. Peor conversación, mismo flujo completo — la
función nunca queda muerta por falta de llave.

### 3.2 Motor por eventos (`lib/smoke-tester/conversation-engine.ts`)

Se elimina la función viva. Nadie espera a nadie:

```
POST /run-auto   → manda el mensaje 1 → responde 202 → se muere (~2 s)
webhook wzap     → guarda la respuesta del agente
                 → espera 10 s de silencio (la ráfaga de Ema son 3-5 mensajes)
                 → el comprador IA redacta el turno siguiente
                 → lo manda por wzap
                 → se muere (~30-60 s)
webhook wzap     → … y así hasta el cierre
```

Cada invocación dura menos de un minuto. **La conversación completa puede
durar 25 minutos sin chocar contra ningún límite de plataforma**, porque en
ningún momento hay una función esperando.

**Guarda de concurrencia (`turn_token`).** Los agentes tipo Ema mandan varios
mensajes por respuesta, y cada uno dispara su propio webhook: sin guarda,
todos querrían contestar y el comprador mandaría 4 mensajes seguidos. Al
programar un turno se escribe un token nuevo en el run; al despertar, el que
ya no tiene el token vigente se retira en silencio. Gana el último chunk — que
es justo el que vio la respuesta completa.

**Condiciones de cierre**, todas terminales y todas escriben `closed_with`:

| Condición | `status` | `closed_with` |
|---|---|---|
| `#agendado` / `#cotizacion` en la respuesta | `completed` | `agendado` / `cotizacion` |
| El comprador da el objetivo por cumplido | `completed` | `null` (motivo en `form_data.motivo_cierre`) |
| Se agotaron los turnos (default 14) | `completed` | `incomplete` |
| El agente no responde en 8 min | `timeout` | `timeout` |
| Falla el envío por wzap | `failed` | `null` |

### 3.3 Cero migraciones

El estado del run autónomo (`modo`, `objetivo`, `persona`, `max_turnos`,
`turno`, `turn_token`) vive en **`smoke_test_runs.form_data`**, un `jsonb` que
ya existe y que en los runs manuales está vacío.

Decisión deliberada: el proyecto arrastra varias migraciones sin correr en
producción, y una nueva habría dejado la función muerta hasta que alguien
abriera el SQL editor. `trigger_type` además tiene un `CHECK` que solo acepta
`manual|form_trigger|webhook`, así que agregar `autonomo` ahí habría exigido
tocar el constraint. Se queda como `manual` y el modo se lee del `form_data`.

### 3.4 Redes de seguridad

Si el agente **nunca contesta**, no hay webhook — y sin webhook no hay quien
cierre el run. Dos redes:

1. **`GET /api/smoke-test/runs/[runId]`** cierra el run cuando lleva más de 8
   minutos esperando. Es la red real: la UI ya consulta ese endpoint cada
   2,5 s mientras el run está vivo.
2. **Cron watchdog** (`/api/cron/smoke-campaign-watchdog`), ampliado:
   - el caso B ya no filtra por `trigger_type` (antes solo rescataba runs de
     Prodesa; los manuales se colgaban para siempre);
   - nuevo **caso D — runs zombis**: `running` sin ninguna fila esperando y
     sin actividad hace más de 60 min. Son los que envenenaban el webhook,
     que empareja los mensajes entrantes contra "el run running más reciente".
     En el plan Hobby este cron corre una vez al día, por eso no puede ser la
     red principal.

Limpieza puntual: se cancelaron 5 runs colgados (4 de abril/mayo + el de las
17:33 de hoy) que ya estaban compitiendo por los mensajes entrantes.

### 3.5 UI

Botón **"Flujo completo"** junto a "Ejecutar prueba", en la vista de la suite.
Abre un modal con objetivo, mensaje de arranque, identidad del comprador
(nombre, correo, celular, ciudad, presupuesto) y tope de turnos.

La vista en vivo, cuando el run es autónomo, muestra **"Turno 3 de 14"** y el
objetivo en vez del contador de secuencias.

## 4. Lo que NO cambió

- `/run` (guion fijo) sigue igual. Sirve para probar una respuesta puntual.
- El flujo Prodesa `form_trigger` sigue con su runner de polling: no es
  autónomo (`form_data.modo` no existe ahí) y el motor lo ignora.
- El evaluador con Claude y el auditor de 10 pasos de Prodesa: sin tocar.

## 5. Cómo se prueba

1. `/terminal/smoke-tester/<suite>` → **Flujo completo**.
2. Ajustar objetivo e identidad del comprador (los defaults sirven).
3. **Iniciar flujo completo**. El primer mensaje sale en el acto; si wzap lo
   rechaza, el error aparece de inmediato en vez de esconderse en los logs.
4. Ver la conversación crecer sola en la vista en vivo. Se puede cerrar el
   navegador: el motor es 100 % de servidor.

## 6. Variables de entorno

| Variable | Requerida | Nota |
|---|---|---|
| `WZAP_TOKEN`, `WZAP_DEVICE` | sí | ya estaban |
| `OPENAI_API_KEY` | recomendada | sin ella, comprador heurístico |
| `SMOKE_BUYER_MODEL` | no | default `gpt-4o-mini` |

## 7. Pendientes

- El auditor de 10 pasos solo corre en runs de Prodesa; los autónomos guardan
  la transcripción pero no el `audit_result`.
- Falta encadenar el evaluador con Claude automáticamente al cerrar (hoy es un
  botón aparte y necesita `ANTHROPIC_API_KEY`).
- Con un solo número de pruebas los runs son estrictamente seriales. Un
  segundo dispositivo wzap permitiría paralelizar.
