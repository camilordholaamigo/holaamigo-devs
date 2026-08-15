# 03 · Los agentes

## Un agente es un contrato, no un prompt

Es la idea central. Un prompt es una sugerencia; un contrato es una frontera.
Cada agente declara cuatro cosas, y las cuatro viven en la tabla `agents`:

| Campo | Qué es | Dónde vive |
|---|---|---|
| `objective` | Qué métrica, qué meta, para cuándo | `agents.objective` |
| `budget` | Tokens por corrida, mensajes por día, USD por mes | `agents.budget` |
| `permissions` | Lista de `can` y lista de `cannot` | `agents.permissions` |
| `escalation_rules` | Cuándo para y llama a un humano | `agents.escalation_rules` |

Los contratos se definen en `lib/agents/contracts.ts` y se instancian al
generar el diagnóstico.

**La lista `cannot` es tan vinculante como la `can`**, y se muestra al cliente
en su panel. Un agente que dice explícitamente lo que no va a hacer genera más
confianza que uno que solo promete.

## Los tres

### PRESIDENT — el estratega

Dueño del Brief Vivo. Traduce metas de negocio en operación con números.

- **Puede:** leer todo, escribir el Brief, proponer objetivos y presupuestos,
  priorizar las rutas.
- **No puede:** ejecutar en ningún canal, gastar dinero, contactar a nadie.
- **Escala si:** la meta declarada es aritméticamente imposible con el
  presupuesto declarado.
- **Presupuesto:** 120k tokens por corrida de diagnóstico.
- **Arranca en:** `active` — solo razona, no hay riesgo.

### CMO — la marca y el mensaje

- **Puede:** buscar en la web, generar ángulos, copy, guiones, plan de
  contenido, y las preguntas adaptativas del quiz.
- **No puede:** publicar nada, enviar nada.
- **Escala si:** no encuentra 3 o más competidores identificables, o el sitio
  no permite inferir la oferta.
- **Presupuesto:** 80k tokens por corrida.
- **Arranca en:** `active`.

### SALES — la ejecución

- **Puede:** enviar dentro de ángulos y plantillas **aprobadas**, responder
  inbound, agendar, suprimir contactos que piden salir.
- **No puede:** usar un ángulo que no esté `approved`, prometer precio fuera del
  rango del Brief, contactar sin `consent_basis`, contactar a alguien
  suprimido, lanzar campaña sin aprobación registrada.
- **Escala si:** respuesta negativa de marca, petición legal, precio fuera de
  rango, queja de spam, caída de deliverability.
- **Presupuesto:** tope de mensajes por día según plan (500 por defecto).
- **Arranca en:** `draft`. **No ejecuta nada** hasta que haya canal conectado y
  aprobación.

> **Regla transversal:** ningún agente ejecuta una acción con dinero o con un
> tercero humano al otro lado sin una aprobación registrada en `approvals`.

## El Brief Vivo — un solo objeto de contexto

Principio §13.2. Los agentes **no tienen prompts con datos del cliente
incrustados**. Su prompt de sistema define rol y prohibiciones; los datos del
cliente entran siempre por el `input`, armado desde el Brief.

Consecuencia práctica: cambiar el rango de precio de un cliente se hace en un
lugar —el Brief— y los tres agentes lo ven al instante. No hay que cazar el
número en cuatro prompts distintos.

El Brief se versiona (`briefs.version`) y solo hay uno vigente
(`is_current`, con índice único parcial). Se puede ver completo en la ficha 360
del admin.

## Ruteo de modelos

`config/models.ts`. Cada paso declara una **cadena** de modelos, no uno solo.

| Paso | Modelos | Tope salida | Web search |
|---|---|---|---|
| `research` | gpt-5 → gpt-4.1 | 8.000 | sí |
| `extract` | gpt-5-mini → gpt-4.1-mini | 6.000 | no |
| `adaptive_question` | gpt-5-mini → gpt-4.1-mini | 1.200 | no |
| `diagnosis` | gpt-5 → gpt-4.1 | 9.000 | no |
| `angles` | gpt-5-mini → gpt-4.1-mini | 4.000 | no |
| `classify` | gpt-5-nano → gpt-4.1-nano → gpt-4.1-mini | 500 | no |

**Por qué una cadena:** si OpenAI retira un nombre de modelo o la cuenta no
tiene acceso, la llamada devuelve `model_not_found`. Con un solo modelo eso
tumba el producto. Con cadena, baja al siguiente y sigue. Un nombre equivocado
degrada **calidad**, nunca **disponibilidad**.

**Todo es override-able por env var** (`MODEL_RESEARCH`, `MODEL_DIAGNOSIS`, …),
que acepta lista separada por comas. Cambiar de modelo no requiere desplegar.

## El cliente de IA

`lib/ai/client.ts`, función `runStructured()`. Todo lo que un agente le pide al
modelo pasa por aquí, y aquí pasan cuatro cosas:

**1 · Salida estructurada validada.** El esquema Zod se convierte a JSON Schema
con `zodTextFormat` y va al API con `strict: true`. La respuesta se valida
contra el mismo esquema antes de devolverse. Nunca se renderiza JSON sin
validar (PRD §8.4).

**2 · Cadena de fallback.** Ante `model_not_found` o 404, rota al siguiente
modelo. Ante `web_search` no soportado, reintenta con `web_search_preview`.

**3 · Reintento y degradación.** Dos intentos con el esquema pedido. Si el
llamador ofrece un `degradeTo`, un tercero con el esquema mínimo, y la función
`inflate` lo devuelve a la forma completa para que nadie tenga que bifurcar. El
run queda marcado `degraded` en `agent_runs`.

**4 · Registro de costo.** Cada llamada escribe modelo, tokens de entrada y
salida, `cost_usd` estimado y duración. Sin esto no podríamos responder
"¿cuánto nos costó este diagnóstico?", que es la métrica de §11.

### Dos reglas de los esquemas Zod

Vienen de cómo funciona `strict: true` en la Responses API:

1. **Nada de `.optional()`.** En modo estricto todos los campos son requeridos.
   Lo que puede faltar se modela con `.nullable()`.
2. **Nada de `.min()`, `.max()`, `.url()`, `.email()`.** Esos keywords no están
   en el subconjunto de JSON Schema que acepta el modo estricto y hacen que el
   API rechace la petición. Los rangos se validan después con `clamp`.

Están escritas al principio de `lib/ai/schemas.ts` para que nadie las descubra
a la mala.

## Salud de agentes

`lib/agents/health.ts`, recalculada por el cron cada 2 minutos.

La idea: **un agente no se cae, se degrada**. Deja de responder bien antes de
dejar de responder, y para cuando alguien lo nota ya mandó 400 mensajes malos.
Los detectores buscan la degradación, no la caída.

| Detector | Umbral | Descuento |
|---|---|---|
| Sin corridas exitosas en 24 h | hubo intentos y ninguno OK | 0,40 |
| Caída de salida estructurada | >30% inválidas o degradadas, con ≥5 corridas | 0,30 |
| Pico de escalamientos | >25% de las corridas | 0,20 |
| Caída de deliverability | >5% de rebotes sobre ≥20 envíos (solo SALES) | 0,40 |
| Deriva de longitud | >60% contra la línea base de 200 corridas | 0,10 |

Cualquier detector en rojo → `agents.status = 'degraded'` + alerta a Slack. La
alerta se manda **al cruzar** a degradado, no en cada barrido: un canal que
grita cada 2 minutos se silencia, y ahí perdimos la señal.

**Un agente ocioso no está enfermo.** El primer detector solo aplica si hubo
intentos. Un agente sin trabajo está esperando, no fallando.
