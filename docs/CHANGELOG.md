# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico. Fechas en ISO.

Cada entrada dice **qué cambió** y **qué hay que hacer para desplegarla**. Una
entrada sin sus pasos de despliegue es una entrada incompleta.

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
