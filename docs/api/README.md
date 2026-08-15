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

`GET` = verificación de Meta (`hub.challenge`).
`POST` = eventos, con **firma HMAC verificada** (`x-hub-signature-256` contra
`WHATSAPP_APP_SECRET`). En producción, sin secreto configurado se rechaza.

Guarda el mensaje entrante, lo clasifica con SALES, y según el resultado
suprime al contacto (`opt_out`) o escala a la cola.

Devuelve 200 incluso ante error de procesamiento, para no entrar en bucle de
reintentos de Meta.

### `POST /api/webhooks/email`

Eventos de Resend. Actualiza el estado del mensaje. **Rebote duro y queja de
spam entran a `suppressions` de inmediato** — es lo que protege la reputación de
los dominios.
