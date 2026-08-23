# API · contrato de endpoints

Todas las rutas corren en Node.js. Las respuestas de error tienen la forma
`{ error: string, field?: string }`.

Ninguna ruta pública requiere autenticación: la autorización viene de que los
identificadores en la URL no son enumerables (uuid v4, tokens de 64 hex). Ver
ADR 0003.

---

## Flujo público

### `POST /api/intake`

Única conversión de la landing. Crea organización + sesión, encola el research
y **responde en menos de 300 ms**. No espera a la investigación.

```jsonc
// petición
{
  "name": "Camilo Ramírez",
  "email": "camilo@acme.com",
  "url": "acme.com",                    // se normaliza a https://acme.com
  "utm": { "utm_source": "linkedin" },  // opcional
  "referrer": "https://..."             // opcional
}

// 200
{
  "sessionId": "uuid",
  "organizationId": "uuid",
  "runId": "uuid",
  "domain": "acme.com",
  "next": "/quiz/<sessionId>"
}
```

| Código | Cuándo |
|---|---|
| 400 | Correo o URL inválidos. `field` indica cuál. |
| 429 | Rate limit: 5/h por IP, 3/día por dominio. Header `retry-after`. |
| 500 | Fallo de base. |

`maxDuration: 300` — el worker del research vive en `after()`.

---

### `GET /api/research/stream/[runId]`

Progreso por Server-Sent Events. Ver ADR 0002.

```
event: open        data: {"runId":"..."}
event: progress    data: {"t":"...","step":"home","detail":"Leímos la home · ..."}
event: finished    data: {"status":"done","error":null}
```

Cierra al terminar el run o a los 240 s.

### `GET /api/research/status/[runId]`

Fallback de polling.

```jsonc
{ "status": "running", "progress": [...], "finished": false, "error": null }
```

---

### `POST /api/quiz/next`

Siguiente pregunta. Es POST porque la primera llamada tras las fijas **dispara
la generación de las adaptativas**: tiene efecto de escritura y no debe
cachearse ni pre-fetchearse.

```jsonc
// petición
{ "sessionId": "uuid" }

// 200
{
  "question": { "id": "...", "slot": "...", "prompt": "...", "input_type": "single", "options": [...], "kind": "fixed" } | null,
  "answeredCount": 3,
  "total": 12,
  "done": false,
  "answers": { "main_offer": "..." },
  "organizationId": "uuid",
  "runId": "uuid",
  "researchStatus": "running"
}
```

### `POST /api/quiz/answer`

Persiste una respuesta y devuelve la siguiente en la misma llamada.

```jsonc
{ "sessionId": "uuid", "key": "ticket_band", "answer": "2k_10k" }
```

`key` es el `id` de la pregunta fija o el `slot` de la adaptativa.

---

### `POST /api/diagnostic/generate`

El President ensambla. **Idempotente por sesión**: llamarla dos veces devuelve
el mismo diagnóstico. Espera al research hasta 45 s si sigue vivo.

```jsonc
// 200
{
  "shareToken": "64 hex",
  "next": "/diagnostico/<shareToken>",
  "researchQuality": "full" | "partial" | "none",
  "degraded": false
}
```

`maxDuration: 300`.

### `POST /api/diagnostic/assumptions`

El cliente editó un supuesto. El recálculo **visible** ya ocurrió en el
navegador; esto persiste y registra el evento (5 puntos de intent).

```jsonc
{ "shareToken": "...", "assumptions": { ... }, "changed": "close_rate" }
// 200 → { "leaks": [...], "inverse_math": {...} }
```

---

### `POST /api/channels/connect`

Registra intención de conectar, o el skip. **No corre OAuth** — v1 alerta a un
humano (§13.3).

```jsonc
{
  "organizationId": "uuid",
  "sessionId": "uuid",
  "channel": "whatsapp" | "email_inbox" | "email_outbound",
  "action": "request" | "skip"
}
```

---

### `POST /api/agent/build`

Compila el playbook del agente de agendamiento y construye su base de
conocimiento. **Devuelve un stream NDJSON**, no un JSON: una línea por fase que
terminó de verdad en el servidor. Ver [ADR 0024](../adr/0024-el-agente-se-compila-del-diagnostico.md).

Si ya hay un playbook vigente y no viene `force`, responde JSON normal con el
que hay. El botón se puede apretar dos veces.

```jsonc
// petición
{
  "organizationId": "uuid",
  "sessionId": "uuid",     // opcional; si falta se usa la última sesión
  "force": false           // true = recompilar y crear versión nueva
}

// 200 · application/x-ndjson — una línea por fase
{"fase":"contexto","estado":"corriendo","detalle":"Leyendo tu diagnóstico…"}
{"fase":"lenguaje","estado":"corriendo","detalle":"Escribiendo el guion…"}
{"fase":"playbook","estado":"listo","detalle":"Guion listo · 78% sale de tu sitio","datos":{...}}
{"fase":"conocimiento","estado":"listo","detalle":"11 documentos indexados","datos":{...}}
{"fase":"fin","estado":"listo","detalle":"Tu agente está listo.","datos":{"next":"/agente/<orgId>"}}

// 200 · application/json — ya existía
{ "ok": true, "reused": true, "playbookId": "uuid", "version": 2, "cobertura": {...} }
```

El cliente distingue los dos casos por el `content-type`. Un fallo llega como
`{"fase":"fin","estado":"falló","detalle":"…"}` dentro del stream, no como un
código HTTP: para cuando algo se rompe, la respuesta ya empezó.

| Código | Cuándo |
|---|---|
| 400 | `organizationId` no es un uuid |
| 404 | la organización no existe |

### `POST /api/agent/chat`

Un turno del simulador. Corre por el mismo runtime que las conversaciones
reales; solo se apagan las escrituras hacia afuera.

```jsonc
// petición
{
  "organizationId": "uuid",
  "conversationId": "uuid",   // null en el primer turno
  "mensaje": "¿cuánto cuesta?",
  "abrir": false              // true = que el agente abra él, como en frío
}

// 200
{
  "ok": true,
  "conversationId": "uuid",
  "mensaje": "Depende del alcance…",
  "stage": "objecion",
  "status": "open",
  "intencion": "ask_price",
  "qualification": { "dolor": "no dan abasto contestando" },
  "herramientas": [{ "name": "consultar_horarios", "ok": true }],
  "costUsd": 0.0021
}
```

| Código | Cuándo |
|---|---|
| 400 | datos inválidos, o mensaje vacío sin `abrir` |
| 404 | la conversación no existe, o es de otra organización |
| 409 | la organización todavía no tiene playbook |
| 429 | más de 40 turnos por hora desde la misma IP |

`GET /api/agent/chat?conversationId=…&organizationId=…` devuelve la
transcripción, para recargar sin perder el hilo.

### `GET|PATCH /api/agent/playbook`

`GET ?organizationId=…` devuelve el playbook vigente, **la instrucción textual
que el modelo lee en cada turno** y las últimas cinco versiones.

`PATCH` confirma o corrige un campo inferido. No versiona: confirmar un dato no
es un guion distinto. Lo que cambia es `source`, que pasa a `editado`.

```jsonc
// petición
{ "organizationId": "uuid", "ruta": "agendamiento.quien_atiende", "valor": "Camila" }

// 200 — la cobertura recalculada, para que la barra suba en el acto
{ "ok": true, "cobertura": { "porcentaje": 84, "a_confirmar": [...] } }
```

Solo se pueden editar rutas dentro de `oferta`, `agendamiento`, `calificacion`,
`objeciones`, `faq`, `tono` y `guion`. Cualquier otra devuelve 400.

### `POST /api/leads/upload`

`multipart/form-data`. Dos modos sobre la misma ruta.

| Campo | Modo | Notas |
|---|---|---|
| `mode` | ambos | `preview` \| `commit` |
| `organizationId` | ambos | |
| `file` o `pasted` | ambos | Archivo (CSV/TSV/XLSX, ≤25 MB) o texto |
| `mapping` | opcional | JSON del mapeo confirmado; si falta, se detecta |
| `country` | opcional | ISO 2 letras para normalizar teléfonos |
| `consentBasis` | **commit** | **Obligatorio.** Sin esto no se procesa. |

```jsonc
// preview → 200
{ "preview": { "raw_count": 2000, "valid_count": 1847, "dup_count": 213,
               "invalid_count": 94, "phone_count": 1612, "mapping": {...},
               "segments": {...}, "sample": [...], "notes": [...] },
  "headers": ["Nombre", "Correo", ...] }

// commit → 200
{ "batchId": "uuid", "inserted": 1810, "suppressed": 37, "next": "/panel/<orgId>" }
```

| Código | Cuándo |
|---|---|
| 413 | Archivo > 25 MB |
| 422 | Ni correo ni teléfono en el archivo, o ningún contacto utilizable |
| 429 | 20 cargas por hora por organización |

---

## Admin — requieren cookie firmada

### `POST /api/admin/login` · `DELETE /api/admin/login`

```jsonc
{ "password": "..." }
```
Rate limit: 10 intentos por IP por hora. `DELETE` cierra sesión.

### `POST /api/approvals/[id]/decide`

```jsonc
{ "decision": "approved" | "rejected", "note": "..." }
```

**`note` es obligatoria si se rechaza.** Aprobar un `angle_new` mueve el ángulo
a `approved`, que es lo único que habilita a SALES a usarlo.

| Código | Cuándo |
|---|---|
| 400 | Rechazo sin nota |
| 401 | Sin cookie válida |
| 409 | Ya estaba decidido |

### `POST /api/admin/band`

Override manual de banda. `note` de mínimo 3 caracteres, obligatoria.

```jsonc
{ "organizationId": "uuid", "band": "attack", "note": "..." }
```

### `POST /api/admin/models` · `DELETE /api/admin/models`

Ruteo de modelos de IA por paso, sin desplegar. `POST` guarda; `DELETE` vuelve
a los valores del código. Precedencia: esta tabla → variable de entorno →
default. El cambio se propaga en menos de 30 s (caché de `lib/settings.ts`).

```jsonc
{
  "overrides": {
    "diagnosis": {
      "models": ["gpt-5", "gpt-4.1"],   // se intentan en orden
      "maxOutputTokens": 16000,          // incluye razonamiento invisible
      "reasoningEffort": "low",          // minimal | low | medium | high
      "webSearch": false
    }
  }
}
```

Pasos válidos: `research`, `extract`, `adaptive_question`, `diagnosis`,
`angles`, `classify`. Todo lo que llega se sanea con `sanitizeOverrides()`:
campos desconocidos se descartan y los rangos se acotan. Ver
[ADR 0014](../adr/0014-configuracion-en-caliente.md).

| Código | Cuándo |
|---|---|
| 200 | Guardado. Devuelve los overrides ya saneados |
| 400 | Forma inválida |
| 401 | Sin cookie de admin |

---

## Sistema

### `GET /api/cron/sweep`

Reintenta corridas atascadas, recalcula salud de agentes, marca sesiones
abandonadas. Protegida con `Authorization: Bearer $CRON_SECRET`.

```jsonc
{ "ok": true, "retried": 2, "abandoned_runs": 0, "sessions_abandoned": 5,
  "agents_checked": 12 }
```

### `GET|POST /api/webhooks/whatsapp`

`GET` responde el `hub.challenge` de la verificación de Meta.

`POST` recibe eventos. Verifica la firma `x-hub-signature-256` y **toma uno de
dos caminos según si la organización tiene playbook**:

- **Con playbook** (P7): el agente de agendamiento contesta y el mensaje sale
  por la Cloud API. Sin `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` la fila
  queda en `messages` con estado `queued` y el motivo escrito.
- **Sin playbook**: el camino de v1 — clasificar, suprimir si pidió salir,
  escalar si toca, y no contestar.

Un lead con `status = 'suppressed'` no recibe respuesta automática aunque
escriba: su mensaje se guarda y lo ve un humano. Devuelve siempre 200 salvo
firma inválida (401), para no entrar en el bucle de reintentos de Meta.

### `POST /api/webhooks/email`

Eventos de Resend. Actualiza el estado del mensaje. **Rebote duro y queja de
spam entran a `suppressions` de inmediato** — es lo que protege la reputación de
los dominios.

---

## v2 · Consola del cliente

Todas exigen `organizationId` en el cuerpo (o en la query si son `GET`). La
autorización es la de `lib/auth/console.ts`: cookie de admin válida, o
conocimiento del `orgId`. Ver el comentario de ese archivo sobre qué hay que
cambiar antes del primer cliente que no sea fundador.

Además, toda ruta que muta verifica que **el recurso pertenezca a esa
organización**: un link filtrado da acceso a una organización, nunca a las demás.

### `POST /api/campaigns/propose`

El CMO arma las tres campañas desde el diagnóstico y la base. Tarda entre 20 y
60 segundos. No lanza nada: deja tres filas en `proposed`.

```jsonc
// petición
{ "organizationId": "uuid" }

// 200
{ "ok": true, "campaigns": [
  { "id": "uuid", "playbook": "reactivacion", "name": "...",
    "audience": 1840, "credits": 4120, "expected_bookings": 12 }
]}
```

### `PATCH /api/campaigns/[id]`

```jsonc
{ "organizationId": "uuid",
  "action": "approve" | "reject" | "pause" | "resume" | "schedule",
  "note": "obligatoria si action es reject",
  "scheduledFor": "ISO, solo para schedule" }
```

| Código | Cuándo |
|---|---|
| 400 | `reject` sin nota. |
| 402 | No hay créditos suficientes. Devuelve `credits_needed` y `credits_available`. |
| 409 | La campaña ya estaba corriendo, o no hay audiencia/bandejas. |

Aprobar materializa la cola completa de `messages` y crea las
`scheduled_actions` del plan.

### `POST /api/feed/[id]/respond`

```jsonc
{ "organizationId": "uuid",
  "decision": "approved" | "rejected" | "answered" | "dismissed",
  "note": "obligatoria si rejected",
  "payload": { "respuesta": "https://..." } }
```

Actualiza el `feed_item` **y** su `approval` asociado, y ejecuta el efecto
(activar o archivar la campaña). Devuelve `{ ok, effect }`.

### `POST /api/threads/[id]`

```jsonc
{ "organizationId": "uuid", "action": "reply" | "handled",
  "body": "texto de la respuesta", "status": "won" | "lost" | "closed" }
```

La respuesta sale desde la misma bandeja que envió el original, con el
`In-Reply-To` del hilo.

### `POST|PATCH|GET /api/mailboxes`

`POST` registra una dirección y le asigna su alias de recepción. **La bandeja no
queda activa**: SendGrid manda un correo de verificación a esa dirección.
`PATCH` cambia tope diario, estado, nombre o firma.

### `POST|GET|PUT /api/integrations/instantly`

`POST` guarda y prueba la API key. `GET` lista las listas de leads.
`PUT` importa una lista — **exige `consentBasis`**, igual que la carga de un CSV.

### `POST /api/agents/config`

```jsonc
{ "organizationId": "uuid", "role": "president" | "cmo" | "sales",
  "config": { ... }, "autonomy": "propose" | "approve_each" | "auto_within_limits" }
```

Solo toca `config`, `autonomy` y `status`. El contrato —objetivo, presupuesto,
permisos, escalamiento— no es editable por nadie desde acá. Devuelve lo que
quedó guardado, porque los topes se acotan en el servidor.

### `POST|GET /api/productos` · `POST|PATCH|GET /api/assets`

Inventario y activos brandeados. El primer producto crea el link de pago si no
existe. El `slug` de un activo no se puede cambiar: está dentro de correos ya
enviados.

### `PATCH /api/orders/[id]`

```jsonc
{ "organizationId": "uuid", "action": "mark_paid", "externalId": "opcional" }
```

El paso manual del ADR 0013. Cuando se conecte la pasarela, el webhook llamará
a la misma función.

---

## v2 · Público, sin autenticación

Links que llegan por correo a gente que no tiene cuenta. Exponen el nombre del
activo y, en el checkout, el catálogo. Nunca la agenda existente ni datos de
terceros.

### `GET|POST /api/agendar/[slug]`

`GET` devuelve los horarios disponibles. Acepta `?tz=` para mostrarlos en la
zona de quien agenda.
`POST` crea la cita. Revalida el horario en el servidor: la lista que vio el
usuario pudo quedar vieja.

```jsonc
// POST
{ "name": "...", "email": "...", "phone": null,
  "start": "2026-08-20T15:00:00.000Z", "notes": null }

// 200
{ "ok": true, "booking": { "id": "uuid", "human_label": "jueves 20 de agosto, 10:00 a. m." } }
```

`409` cuando el cupo ya no está. Los parámetros `?c=&l=&m=` de la URL son la
atribución y se guardan con la cita.

### `GET|POST /api/checkout/[slug]`

`GET` devuelve el catálogo del activo con disponibilidad.
`POST` crea la orden: reserva inventario, congela el fee y guarda la
atribución. **No cobra** (ADR 0013): devuelve `payment_url: null` y las
instrucciones de qué pasa después.

### `GET|POST /api/baja/[messageId]`

Baja de la lista. `GET` es el clic en el pie del correo y devuelve una página;
`POST` es el `List-Unsubscribe-Post` de un clic. Entra a `suppressions`, que es
global, y cancela los envíos pendientes de esa persona.

---

## v2 · Sistema

### `GET /api/cron/dispatch`

Cada 5 minutos. Activa campañas programadas, envía lo vencido respetando franja
horaria y topes, y una vez al día corre el briefing del President. Protegida con
`Authorization: Bearer $CRON_SECRET`.

```jsonc
{ "ok": true, "activated": 1, "briefings": 3, "out_of_window": 0,
  "dispatch": { "considered": 60, "sent": 58, "skipped": 2, "failed": 0,
                "reasons": { "en la lista de supresión": 2 } } }
```

### `POST /api/webhooks/sendgrid/events`

Entregas, rebotes, aperturas, clics y quejas. **Firma ECDSA verificada**; en
producción, sin firma válida se rechaza con 401. Rebote duro y queja entran a
`suppressions` de inmediato.

### `POST /api/webhooks/sendgrid/inbound`

Las respuestas, por Inbound Parse (`multipart/form-data`). Autenticación por
secreto en la URL (`?k=`): SendGrid no firma este webhook. Devuelve 200 incluso
ante error, para no entrar en el bucle de reintentos de 72 horas.

### `GET /api/health`

¿Está bien configurado esto? Chequea credenciales, alcance del schema,
migraciones corridas y seed del quiz.

Devuelve **503** si algo bloqueante falla (`env:supabase`, `db:schema`,
`db:v1`, `db:seed_quiz`), así que sirve de health check de monitoreo.

```jsonc
// público: qué falla
{ "ok": false, "checks": [{ "name": "db:schema", "ok": false }, ...] }

// con cookie de admin o ?key=$CRON_SECRET: por qué falla y cómo se arregla
{ "ok": false, "blocking": ["db:schema"],
  "checks": [{ "name": "db:schema", "ok": false,
               "detail": "Invalid schema: holaamigo → ...",
               "fix": "Project Settings → API → Exposed schemas: agregar `holaamigo`" }] }
```

Los nombres de los chequeos son públicos; los mensajes de error no, porque
nombran infraestructura.

---

## Smoke tester

Ver [wiki/23](../wiki/23-smoke-tester.md) y
[ADR 0025](../adr/0025-el-smoke-tester-como-evidencia.md).

### `POST /api/webhooks/callbell`

**La entrada de todo.** Acá llegan las respuestas de los negocios a los que les
escribimos.

Autenticación por secreto en la URL (`?k=$CALLBELL_WEBHOOK_SECRET`): Callbell no
firma sus webhooks. Sin el secreto configurado, acepta en desarrollo y rechaza
en producción.

**Siempre devuelve 200** salvo por falta de autorización. Un 5xx hace que el
proveedor reintente o desactive el webhook, y se pierde la conversación entera
por un error transitorio. Los errores van al log.

El parser aguanta el envoltorio nativo de Callbell y el reenvío desde otra
aplicación. Junta *todos* los teléfonos del payload y prueba cada uno contra las
conversaciones que esperan respuesta, porque distintos emisores ponen el número
del contacto en campos distintos.

```jsonc
// Callbell nativo
{ "event": "message_created",
  "payload": { "to": "...", "from": "...", "text": "Hola", "status": "received",
               "contact": { "phoneNumber": "..." } } }

// respuesta, siempre 200
{ "ok": true, "prueba": "<uuid>", "camino": "turno" | "rafaga" }
{ "ok": true, "ignorado": "sin match" | "es eco de un mensaje nuestro" | ... }
```

`GET` de la misma ruta con el secreto correcto devuelve `{ok: true}`. Sirve para
verificar la configuración desde el navegador.

### `GET /api/pruebas/estado/[runId]`

El resumen de una corrida, y **la red de seguridad que de verdad funciona**:
antes de responder, cierra las pruebas estancadas y despierta las colas
huérfanas. Público por `runId`, igual que el stream del research.

### `GET /api/pruebas/stream/[runId]`

Lo mismo, por SSE. Emite `estado` con el resumen completo cada vez que algo
cambia de verdad —se compara una huella—, y `finished` cuando no queda nada
vivo. Una conversación quieta no manda nada.

### `POST /api/admin/pruebas` · `PATCH`

Crear una prueba a mano, sin diagnóstico. Solo admin.

```jsonc
// POST
{ "telefono": "+57 300 123 4567", "nombre": "Ferretería El Tornillo",
  "plantillas": ["servicio", "ventas"],
  "organizationId": null,   // con él, compila con el research de esa org
  "canalId": null, "contexto": null }
→ { "ok": true, "runId": "<uuid>", "pruebas": 2 }

// falta configuración: 400 con el nombre exacto
→ { "error": "Falta configurar CALLBELL_API_KEY en Vercel.",
    "falta": { "CALLBELL_API_KEY": true } }

// PATCH — cancelar, recalificar, desbloquear un número
{ "accion": "cancelar" | "reevaluar", "pruebaId": "<uuid>" }
{ "accion": "desbloquear", "targetId": "<uuid>" }
```

### `POST /api/admin/pruebas/canales` · `DELETE`

Nuestra línea: número y `channel_uuid` de Callbell, editables sin desplegar. El
`DELETE` apaga, no borra: las pruebas viejas la referencian.

### `POST /api/admin/pruebas/plantillas` · `DELETE`

Los moldes de prueba. Las tres de fábrica se editan como cualquier otra.

### `GET /api/admin/pruebas/diagnose` · `POST`

«¿Por qué no salió el mensaje?». Variables presentes (booleanos, nunca sus
valores), canal activo, últimas diez pruebas con su error, números bloqueados.

El `POST` manda un mensaje de prueba a un número y devuelve el error crudo con
una pista accionable. Es el paso que no hay que saltarse al configurar.

### `GET /api/cron/pruebas`

El watchdog. Cierra estancadas y zombis, despierta colas huérfanas y califica
lo que quedó sin nota. Protegido con `CRON_SECRET`.

Se diseñó para correr cada 5 minutos; en el plan Hobby de Vercel corre una vez
al día. No rompe el arnés —la red real es el GET de estado que la interfaz ya
consulta— pero sí deja colgada hasta el otro día la prueba de alguien que cerró
la pestaña.
