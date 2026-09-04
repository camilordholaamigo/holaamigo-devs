# PRD — Hola Amigo · Motor de Ventas v1

**Producto:** diagnóstico comercial autoservicio que instancia tres agentes de
IA (President, CMO, Sales) y entrega los primeros leads trabajados en 24 horas.
**Objetivo de negocio:** cerrar 5 clientes fundadores y USD 45.000 en 45 días.
**Stack:** Next.js 16 (App Router) · TypeScript · Supabase (Postgres, schema
`holaamigo`) · Vercel · OpenAI Responses API con ruteo por paso.
**Versión:** 1.0 · Agosto 2026 · **estado: construido**

> Este es un documento **vivo**. Cuando el alcance cambie, se actualiza aquí.
> Un PRD desactualizado miente, y mentir sobre el alcance es peor que no tener
> PRD. El detalle de implementación vive en `docs/wiki/`; las decisiones
> estructurales en `docs/adr/`.

---

## 1 · La tesis en una frase

> El visitante entra con una URL y sale, seis minutos después, con un
> diagnóstico de su negocio, la cuenta de cuánta plata está dejando sobre la
> mesa, y tres agentes ya entrenados esperando permiso para trabajar.

Todo lo que no sirva a esa frase queda fuera de la v1.

**El principio operativo:** product-led growth por defecto, humano por
excepción. El cliente se guía solo; nosotros entramos al loop cuando el sistema
nos dice que vale la pena (§9).

---

## 2 · Alcance

### Dentro de v1 — todo construido

| # | Módulo | Estado | Dónde |
|---|---|---|---|
| 1 | Landing de conversión única | ✅ | `app/page.tsx` |
| 2 | Motor de investigación asíncrono | ✅ | `wiki/04` |
| 3 | Quiz adaptativo de 10–12 preguntas | ✅ | `wiki/05` |
| 4 | Diagnóstico: marca, competencia, posición, fugas | ✅ | `wiki/06` |
| 5 | Las 3 rutas con roadmap y costos | ✅ | `config/routes.ts` |
| 6 | Conexión de canal con skip | ⚠️ registra intención, sin OAuth | `adr` §13.3 |
| 7 | Carga de leads → primer trabajo en 24 h | ✅ | `wiki/07` |
| 8 | Tres agentes instanciados con contrato | ✅ | `wiki/03` |
| 9 | Admin: cola, evaluación, override | ✅ | `wiki/08` |

### Fuera de v1, explícitamente

Motor completo de iteración de campañas · atribución multi-touch al cierre ·
facturación y self-serve checkout · roles y permisos granulares por usuario ·
agente de voz · el módulo de agencia entregado en producto (en v1 es una
recomendación que dispara una conversación humana).

> Parte de esta lista entró en **v2** (§14): el motor de campañas con
> iteración, la atribución de la unidad económica y el checkout —este último
> con el cobro todavía en placeholder. Los roles por usuario y el agente de voz
> siguen fuera.

### Dentro de v2 — el motor de correo

| # | Módulo | Estado | Dónde |
|---|---|---|---|
| 10 | Bandejas múltiples con calentamiento y topes | ✅ | `wiki/10` |
| 11 | Envío y recepción por SendGrid | ✅ | `adr/0008` |
| 12 | Instantly como fuente de listas | ✅ | `adr/0009` |
| 13 | Tres campañas con proyección, medición e iteración | ✅ | `wiki/11` |
| 14 | Agendador brandeado (mini-Calendly) | ✅ | `wiki/12` |
| 15 | Checkout e inventario | ⚠️ cobro en placeholder | `adr/0013` |
| 16 | Créditos con ledger inmutable | ✅ | `adr/0011` |
| 17 | Feed del President y agentes configurables | ✅ | `wiki/13` |
| 18 | Consola del cliente y observabilidad | ✅ | `wiki/14` |
| 19 | GTM Radar → Smoke Tester, opcional y sin replicar PII | ✅ | `wiki/25` |

---

## 3 · Los tres agentes

Cada agente es un **contrato**, no un prompt: objetivo, presupuesto, permisos,
escalamiento.

| | PRESIDENT | CMO | SALES |
|---|---|---|---|
| **Rol** | Dueño del Brief Vivo | Marca y mensaje | Ejecución |
| **Objetivo** | Plan vigente + cuenta al revés válida | ≥5 ángulos con hipótesis y segmento | Primer lead trabajado en <24 h |
| **Presupuesto** | 120k tokens/corrida | 80k tokens/corrida | Tope de mensajes/día por plan |
| **Prohibido** | Ejecutar, gastar, contactar | Publicar, enviar | Ángulo no aprobado, precio fuera de rango, contacto sin `consent_basis` |
| **Escala si** | La meta es aritméticamente imposible | <3 competidores identificables | Negativa de marca, legal, precio fuera de rango, spam, deliverability |
| **Arranca en** | `active` | `active` | **`draft`** |

> **Regla transversal:** ningún agente ejecuta una acción con dinero o con un
> tercero humano al otro lado sin una aprobación registrada en `approvals`. En
> v1 el President y el CMO **nunca** ejecutan.

Detalle completo: `wiki/03-agentes.md` · código: `lib/agents/contracts.ts`.

---

## 4 · El flujo

```
LANDING → [submit] → ┌─ research_job (background, 60–180s) ─┐
                     │                                       │
                     └─ QUIZ (3–5 min, adaptativo) ──────────┘
                                    ↓
                            DIAGNÓSTICO
                                    ↓
                            LAS 3 RUTAS + costos
                                    ↓
                     CONECTAR CANAL ──[skip]──→ CARGAR LEADS
                                    ↓                ↓
                            AGENTES ACTIVOS ←────────┘
                                    ↓
                            PRIMER RESULTADO <24h
```

### 4.1 Landing

Una sola conversión: `nombre`, `correo`, `url_empresa`. **No pedir teléfono,
empresa, cargo ni tamaño.** Cada campo extra cuesta conversión y todo eso lo
preguntamos en el quiz, cuando ya invirtió tiempo.

Debajo del fold y solo eso: qué va a pasar en los próximos 6 minutos, y prueba
social. Al hacer submit se redirige al quiz **sin esperar la investigación**.

**Métrica:** ≥35% de visitantes únicos hacen submit.

### 4.2 Quiz

Una pregunta a la vez, barra de progreso, y arriba el indicador vivo del
research. **No es decorativo: es lo que sostiene la atención durante el quiz.**
Es una línea de tiempo con los últimos cuatro pasos y el tiempo real de cada
uno, no una sola línea que se reemplaza.

6 fijas → 4–6 adaptadas a los hallazgos → 1 de cierre. **Guardado incremental:**
cada respuesta persiste al instante.

Al responder `dormant_db` (pregunta 5) aparece **la primera cifra de fuga, ya
calculada y con su fórmula**, y se queda en pantalla el resto del quiz. Sale de
`computeLeaks`, así que no puede contradecir al diagnóstico; si respondió "No
sé", no hay adelanto. Ver [ADR 0023](adr/0023-mostrar-el-trabajo.md).

### 4.3 Diagnóstico

Se revela por secciones. Cada afirmación con **fuente** (URL) o marca de
`inferido`. La sección de fugas va con **número en pesos**, no con adjetivos.
Correo automático con el enlace permanente.

### 4.4 Las 3 rutas

| Ruta | Qué es | CTA |
|---|---|---|
| **A · WhatsApp** | Leads y citas, inbound y outbound con plantillas Meta | Autoservicio |
| **B · Correo** | Agente de correo con construcción de listas | Autoservicio |
| **C · Marca y contenido** | Vía la agencia | **Conversación humana** |

Cada tarjeta con roadmap de 4 hitos con **fechas reales** y costo separado en
`infraestructura` vs `fee`. Copiamos deliberadamente la transparencia de
LetGrowth: es lo que genera confianza en este mercado.

### 4.5 Conectar canal

Dos botones, ambos con **skip visible**. El skip no penaliza: lleva directo a
4.6, que es el camino de menor fricción y mayor valor inmediato.

**Desde v3 (P7), elegir WhatsApp ya no registra una intención: arma el agente.**
El playbook del agente de agendamiento se compila en menos de un minuto con el
research, el Brief, el diagnóstico y las respuestas del quiz, y el cliente le
habla ahí mismo en el simulador. Lo único que sigue tardando es la verificación
del número con Meta —de 24 a 48 horas—, y esa demora es de Meta.

Ver §15 y [ADR 0024](./adr/0024-el-agente-se-compila-del-diagnostico.md).

### 4.6 Carga de leads

Drag & drop de CSV/XLSX o pegado. Mapeo asistido por IA, normalización de
teléfonos, deduplicación, segmentación por temperatura.

**Checkbox obligatorio de base legal.** Sin eso, no se procesa. Se guarda con
timestamp e IP.

> **Honestidad técnica que hay que respetar:** la promesa de 24 horas solo es
> real para **reactivación de la base propia** desde su propio dominio o su
> propio WhatsApp. El outbound frío necesita 2–3 semanas de calentamiento. Si
> prometemos 24 h en frío, quemamos dominios y reputación.

---

## 5 · Modelo de datos

20 tablas en el schema `holaamigo` (ADR 0001). RLS habilitado y forzado, cero
políticas: deny-by-default (ADR 0003).

SQL: `supabase/migrations/0001_init.sql` · explicación: `wiki/02`.

---

## 6 · El banco de preguntas

6 fijas + 4–6 adaptadas + 1 de cierre. Nunca más de 12 en pantalla.

**Fijas:** `main_offer`, `ticket_band`, `rev_band`, `sales_team`, `dormant_db`,
`main_channel`.

> `dormant_db` es la pregunta más importante del quiz. Su respuesta multiplicada
> por `ticket_band` genera la cifra de fuga y dispara la oferta de reactivación.

**Adaptadas:** el CMO instancia plantillas de intención con datos reales del
research. `goal_90d` es **obligatoria**: alimenta la cuenta al revés.

**Cierre:** `goal_deadline`.

Detalle: `wiki/05`.

---

## 7 · El diagnóstico

Seis secciones: **quién eres** · **tu posición** · **dónde se te está cayendo la
plata** · **la cuenta al revés** · **las 3 rutas** · **el siguiente paso**.

Las fórmulas de fugas y de la cuenta al revés están en `wiki/06`. Cada supuesto
es editable en pantalla con recálculo en vivo. **Eso convierte el diagnóstico en
algo suyo y no en algo nuestro.**

Dos figuras acompañan la aritmética y se mueven con los controles: la **cascada
de fugas** (§7.3) y el **embudo de la cuenta al revés** (§7.4). Ninguna
reemplaza la derivación escrita — el dibujo contesta "cuánto", la lista contesta
"de dónde sale", y quitar la segunda rompería §13.4.

---

## 8 · Arquitectura técnica

Rutas, ruteo de modelos, trabajos en background y salida estructurada: `wiki/01`
y `wiki/03`.

Dos puntos que no se negocian:

- **El diagnóstico se genera aunque el research quede `partial`** — con menos
  secciones y confianza marcada. Nunca dejamos al usuario sin salida.
- **Todo output de agente pasa por validación Zod** contra un esquema
  versionado. Si falla dos veces se degrada a un esquema mínimo. Nunca se
  renderiza JSON sin validar.

---

## 9 · Admin

Scoring FIT (0–60) + INTENT (0–40) → bandas AUTO / ASSIST / **ATTACK**.

| Banda | Rango | Acción |
|---|---|---|
| AUTO | <45 | Nurture automático. Nadie lo toca. |
| ASSIST | 45–69 | Secuencia con nudge. |
| **ATTACK** | ≥70 | **Alerta a Slack. Contacto humano en <30 min.** |

Ficha 360, cola de decisiones global y salud de agentes: `wiki/08`.

**`/admin/embudo`** mide nuestro producto, no el negocio del cliente: dónde se
cae la gente en el flujo inicial, en qué pregunta exacta del quiz, y qué
supuestos nuestros discuten. Tres bloques, cada uno con su decisión escrita
encima; sin series temporales, por el criterio de `wiki/14`. La conversión
visitante → submit de §4.1 **todavía no se puede calcular**: no hay evento de
visita a la landing y la pantalla lo dice. Ver `wiki/21`.

---

## 10 · Restricciones y riesgos

| Riesgo | Mitigación | Estado |
|---|---|---|
| Plantillas de WhatsApp requieren aprobación de Meta | Prerequisito explícito en el roadmap de la Ruta A | ✅ |
| Cold email exige calentamiento de dominios | La promesa de 24 h aplica solo a reactivación, dicho en el producto | ✅ |
| Habeas Data, GDPR, TCPA | `consent_basis` obligatorio, supresión global, sin envío a `suppressed` | ✅ |
| Costo del research por visitante anónimo | Rate limit por IP y dominio, caché de 30 días por dominio | ✅ |
| Sitios que bloquean crawl o son SPA sin SSR | Fallback a `web_search` + estado `partial`. Nunca error en blanco | ✅ |
| Diagnóstico que alucina competidores o cifras | Fuente o marca de inferido en toda afirmación; los números los calcula el código (ADR 0007) | ✅ |

---

## 11 · Métricas de éxito

| Métrica | Meta |
|---|---|
| Visitante → submit | ≥35% |
| Submit → quiz completo | ≥60% |
| Landing → diagnóstico visible | <6 min (p75) |
| Quiz completo → canal o leads | ≥30% |
| Leads cargados → primer mensaje | <24 h (p90) |
| Costo de IA por diagnóstico | <USD 1,20 |
| Diagnósticos con research `partial` | <15% |
| ATTACK contactados en <30 min | 100% |

Consultas para medirlas: `wiki/09`.

---

## 12 · Plan de construcción — **minutos, no días**

Instrucción explícita del fundador: *"cambia días por minutos, ya debemos tener
esto listo."*

| Sprint | Entregable | Estado |
|---|---|---|
| **0** | Esquema, RLS, ruteo de modelos, prompts, seed | ✅ |
| **1** | Landing + intake + research asíncrono + progreso en vivo | ✅ |
| **2** | Quiz completo con adaptación y persistencia incremental | ✅ |
| **3** | Diagnóstico + fugas editables + cuenta al revés + 3 rutas | ✅ |
| **4** | Conexión de canal + carga de leads + normalización + dedup | ✅ |
| **5** | Provisión de los 3 agentes + cola de aprobaciones | ✅ |
| **6** | Admin: scoring, ficha 360, salud de agentes, alertas | ✅ |

> El sprint 3 es el que cierra ventas. Si hay que recortar, se recorta del 5 y
> 6 — la operación de los primeros clientes se puede sostener a mano, y de
> hecho **debe** sostenerse a mano hasta haber ejecutado cada paso tres veces.

**Lo que queda para después del primer cliente real:** OAuth de Meta y de
Google/Microsoft, envío saliente conectado al proveedor, suite de tests.

---

## 13 · Principios que no se negocian

1. **El agente que razona sobre dinero no toca dinero.** President y CMO nunca
   ejecutan.
2. **Un solo objeto de contexto.** Los agentes leen el Brief, no tienen prompts
   propios. Cambiar un precio se hace en un lugar.
3. **Nada se automatiza antes de haberse hecho tres veces a mano.**
4. **Toda afirmación sobre el negocio del cliente lleva fuente o se marca como
   inferida.**
5. **El skip siempre es visible.** La fricción escondida convierte peor y enseña
   desconfianza.
6. **La cola de decisiones es el producto.** Los gráficos son consulta; la cola
   es el trabajo.

---

## 14 · v2 — El motor de correo

v1 terminaba en una promesa: tres agentes instanciados esperando permiso. v2 es
lo que pasa cuando les das el permiso.

### 14.1 El ciclo completo

```
DIAGNÓSTICO → 3 CAMPAÑAS PROPUESTAS → [el cliente aprueba]
     ↓
ENVÍO desde sus bandejas, con topes y calentamiento
     ↓
RESPUESTA → el agente clasifica → agenda, contesta o te pasa a ti
     ↓
CITA en el agendador · VENTA en el checkout — ambas atribuidas
     ↓
EL PRESIDENT PROPONE LO DE MAÑANA con los números de hoy
```

### 14.2 Qué le pedimos al humano, y qué no

**Le pedimos:** aprobar o rechazar un envío, entrar a las conversaciones que el
agente no debe manejar solo, y grabar lo que solo él puede grabar.

**No le pedimos:** elegir a quién escribir, escribir el copy, decidir desde qué
bandeja sale cada correo, acordarse de revisar una campaña, ni calcular nada.

El tope de cuatro decisiones abiertas es la regla que sostiene esto. Un feed con
doce propuestas no es más información: es el día en que alguien empieza a
aprobar sin leer, y ahí la supervisión humana se volvió teatro.

### 14.3 Los tres pilares, dentro del motor

| Pilar | Cómo entra |
|---|---|
| **Correo** | El motor completo: outbound, inbound, secuencias, medición |
| **WhatsApp** | Los créditos y la supresión ya son transversales; el envío conecta cuando haya el primer número provisionado |
| **Marca y contenido** | El playbook de lanzamiento, que es el único que le pide un activo al humano y lo edita la agencia |

### 14.4 Los activos como producto

El agendador y el checkout no son features: son **la superficie por la que pasa
la conversión**, y por eso el modelo de cobro por resultado es posible.
Detalle en [ADR 0010](./adr/0010-activos-y-atribucion.md).

La regla para agregar el siguiente: ¿resuelve una unidad económica concreta de
un tipo de cliente, y la conversión pasa por nosotros?

### 14.5 Métricas de v2

| Métrica | Meta |
|---|---|
| Campañas propuestas → aprobadas | ≥60% |
| Entregabilidad en reactivación | ≥95% |
| Tasa de respuesta en reactivación | ≥4% |
| Respuestas que el agente resuelve sin humano | ≥50% |
| Citas agendadas desde el link ÷ respuestas positivas | ≥40% |
| Decisiones abiertas en el feed, promedio | ≤3 |
| Quejas de spam | <0,1% |

---

## 15 · v3 — El agente de agendamiento

Appointment setting por WhatsApp es el primer mercado en el que nos enfocamos.
Esta sección define el alcance de lo que se construyó para que el onboarding sea
cero.

### 15.1 La tesis

Todo lo que hace falta para que un agente agende citas para un negocio —qué
vende, a quién, a qué precio, qué objeciones recibe, qué preguntan siempre, cómo
se reserva— ya está en nuestra base cuando termina el quiz. El producto no es
pedirlo otra vez: es leerlo.

### 15.2 El playbook

Un objeto de datos versionado, no un prompt. Se compila; se le muestra al
cliente campo por campo; se corrige con un tap; se diffea entre versiones.

**El código pone los hechos y los números. El modelo pone el lenguaje.** El
esquema que va a OpenAI no tiene un solo campo numérico, y una red en el
compilador borra del texto cualquier cifra de dinero que no esté autorizada por
el Brief o publicada en el sitio del cliente. Es ADR 0007 llevado al único lugar
del producto donde un texto llega a un tercero sin que un humano lo lea.

### 15.3 La base de conocimiento

Un vector store por cliente con las palabras de su propio sitio. Aterriza las
preguntas puntuales que el playbook no anticipa. **No sostiene los hechos**: si
falla, el agente sigue funcionando.

### 15.4 El banco de pruebas

El cliente le habla a su agente antes de que exista el número. Corre por el mismo
runtime que las conversaciones reales y muestra qué herramientas usó cada turno.

Es la señal de activación más fuerte que tenemos: quien le escribe a su agente
entiende qué compró.

### 15.5 Qué sigue siendo manual

La provisión del número con Meta. Se piden los tres datos que un operador
necesitaría —qué número, si es suyo o hace falta uno, quién atiende las citas—
mientras el cliente está mirando su agente funcionar, para que no haya un primer
correo de ida y vuelta. Principio §13.3 intacto: se sigue provisionando a mano,
pero ya no preguntando a mano.

### 15.6 Métricas de v3

| Métrica | Meta |
|---|---|
| Diagnósticos que terminan con un agente compilado | ≥50% |
| Clientes que le hablan al agente en el simulador | ≥70% de los que lo compilan |
| Campos de `a_confirmar` corregidos por el cliente | ≤40% (más significa que estamos adivinando) |
| Cobertura del playbook con fuente | ≥65% |
| Conversaciones reales que llegan a oferta de horario | ≥40% |
| Conversaciones que agendan ÷ las que reciben horario | ≥30% |
| Tiempo de compilación de punta a punta | <60 s |

---

## 16 · v4 — El smoke tester

**Estado:** construido. Fase 1 en [ADR 0025](adr/0025-el-smoke-tester-como-evidencia.md),
fase 2 en [ADR 0026](adr/0026-el-lote-y-el-informe.md),
fase 3 en [ADR 0027](adr/0027-la-prueba-a-medida-y-las-lineas.md).
Cómo funciona: [wiki/23](wiki/23-smoke-tester.md) y [wiki/24](wiki/24-lotes-e-informes.md).
Contrato del código: [`docs/api/pruebas.md`](api/pruebas.md).

**Cambio de alcance en la fase 3, y es el que más mueve el negocio:** el smoke
tester dejó de ser *una parte del diagnóstico* y pasó a ser *una herramienta*.
Apunta a **cualquier número** sin que el negocio exista en nuestra base y sin
research previo, y eso lo saca de §7 y lo pone al lado de §14: no es solo lo que
cierra un diagnóstico, es con qué se abre una conversación de venta.

Lo que eso habilita, y no es teórico:

- **Diagnosticar prospectos activos.** «Le escribimos a su línea a las 2:03.»
- **Generar prospectos.** El hallazgo *es* el gancho de la llamada.
- **Auditar bots ajenos a escala.** Hay millones de negocios con una IA
  contestando su WhatsApp y ninguna certeza de que funcione. Treinta segundos por
  número, cero preparación.

### 16.1 La tesis

El diagnóstico (§7) es bueno y es, de punta a punta, una **proyección**. Las
fugas salen de supuestos que el cliente puede mover; el embudo sale de la meta a
90 días. Todo con su fórmula a la vista, y todo discutible.

Faltaba una sola cosa en todo el producto que **no se pudiera discutir**:

> «Le escribimos a tu línea de ventas a las 2:03. Contestaron a las 2:19.
> Dieciséis minutos.»

Un comprador sintético le escribe por WhatsApp al número que el propio sitio del
cliente publica, la conversación corre hasta donde llegue, y se califica. No hay
mocks: es la línea real, por el canal real, y nadie del otro lado sabe que es
una prueba.

### 16.2 De dónde salió

Del paquete portable de Rentmies, que vive en `docs/referencia/smoke-tester/`
con **doce bugs de producción documentados**. Tres de sus ocho deudas se
resolvieron acá en el diseño y no como parche:

| Deuda del original | Cómo quedó |
|---|---|
| Correlación contra «la conversación activa más reciente» | **Por el par (nuestra línea, su número)** — permite probar N negocios en paralelo, y N de nuestras líneas contra el mismo negocio |
| `turno` y `turn_token` dentro de un `jsonb` | **Columnas** — reclamar un turno es un update condicional, atómico |
| La evaluación detrás de un botón | **Se dispara sola** al cerrar |

### 16.3 Las tres capas de veredicto

| Capa | Contesta | Cómo | Costo | Determinística |
|---|---|---|---|---|
| 1 · Estado terminal | ¿Contestaron? ¿En cuánto? | Restar timestamps | 0 | Sí |
| 2 · Auditoría | ¿Cumplió los criterios? | Regex contra la rúbrica compilada | 0 | Sí |
| 3 · Evaluación | ¿Estuvo bien hecho? | Modelo contra la ficha de verdad | ~USD 0,02 | No |

**Con la capa 1 sola ya hay producto.** Las otras dos suman.

La capa 3 **no devuelve números**: devuelve cinco juicios cualitativos y el
código los convierte con una tabla fija. Pedirle un 78 a un modelo es falsa
precisión — la misma transcripción le saca 74 y 79 — y esa cifra la lee el
cliente (§13.4, ADR 0007).

### 16.4 Los dos modos

| | **Conversar** | **Preguntas fijas** |
|---|---|---|
| Quién escribe cada turno | el comprador sintético | el operador, de antemano |
| Costo en modelo | ~1 llamada barata por turno | **cero** |
| Para qué sirve | ver cómo venden | comparar la misma pregunta entre negocios |

En preguntas fijas los detectores de cierre **no paran la conversación**: si el
negocio agenda en el mensaje dos, las preguntas tres y cuatro se mandan igual. Es
lo que hace comparables veinte conversaciones. Y el mensaje siguiente sale cuando
el anterior tuvo respuesta — mandarle tres seguidos a un número que no contesta no
agrega información y es la firma exacta de un emisor de spam.

El modelo puede redactar el **borrador** del guion, y nunca es lo que se manda: lo
que sale es lo que quedó escrito en los campos después de que una persona los leyó
(misma frontera que ADR 0024).

### 16.5 Los frenos

Escribirle por WhatsApp a un negocio que no nos escribió primero es la acción
más delicada del producto.

1. **`authorize('smoketest.probe')`** — `self_outreach`, techo de plataforma 4.
   Un número quemado por Meta no se recupera con un rollback. Fue
   `external_comms` y esa clasificación dejó la capacidad inalcanzable por
   construcción — ver la migración `0016`.
2. **Propiedad del número** — en el camino automático tiene que estar publicado
   en el sitio de la organización que pidió el diagnóstico.
3. **Enfriamiento de 72 h**, global por número.
4. **Bloqueo** — si piden que paremos, se corta en ese turno y **ningún camino
   automático lo revierte**.

**Los tres primeros rigen el camino automático y no el manual, y eso es diseño y
no descuido** (ADR 0027, decisión 5): no hay organización contra la que autorizar
cuando un operador escribe un número suelto, y el enfriamiento existe para que
cinco recargas de la landing no manden cinco mensajes — no para impedir retestear
al cliente al que se le acaba de cambiar el prompt. Lo que se paga a cambio: el
bloqueo es terminal en los dos caminos, la cuenta de mensajes va escrita en el
botón antes de apretarlo, y la pantalla muestra cuándo fue la última prueba contra
ese número.

Apagado de emergencia sin desplegar: `settings['pruebas.bateria'].activo`.

### 16.6 La prueba, y varias de nuestras líneas

Una prueba es `números × líneas × guiones = conversaciones`. El mismo objeto
sirve para las tres cosas: una conversación suelta (1×1×1), ver si el agente de un
negocio aguanta tres clientes a la vez (1×3×1), y barrer treinta líneas de un
sector (30×1×1).

**Varias de nuestras líneas es la unidad de escala.** Cada línea abre su propio
hilo de WhatsApp, así que tres líneas dan lo que ninguna otra prueba da —si su
agente les contesta igual a los tres, si se cae con dos abiertas, si al tercero le
dice otro precio— y suben el techo diario sin acercarse al umbral de spam.

Treinta clientes × tres pruebas son **noventa conversaciones desde una sola
línea de WhatsApp**. Un lote sin tope de concurrencia no es una feature a medio
hacer: es la forma de perder el número.

`max_concurrentes` (4, techo 12) y `ritmo_segundos` (45) son columnas de la
tabla y no constantes, para poder bajarlas en caliente.

Dos propósitos, un motor:

| | `qa` | `prospeccion` |
|---|---|---|
| Quién | Nuestros clientes | Prospectos |
| Pregunta | ¿A cuál se le rompió la IA? | ¿Qué le pasa a quien le escribe? |
| Frenos | Nos contrataron | Los cuatro de §16.4 |

### 16.7 El informe

Enlace público con `share_token`, como el diagnóstico. Agrega lo que pasó y lo
convierte en algo que se manda.

**La frecuencia se cuenta sobre los criterios de la rúbrica, no sobre el texto
del modelo.** «Falló en 4 de 5» es un problema del guion; «1 de 5» es una
conversación mala. Esa distinción es todo el valor del análisis, y solo funciona
con claves estables — las alucinaciones son texto libre y van **aparte,
textuales y sin contar**, porque una cita resumida deja de ser prueba.

**Un link, no un PDF adjunto.** Se previsualiza, no pesa, y —lo que decide— **se
puede medir**. `vistas` y `visto_at` no son telemetría: saber que el prospecto
abrió el informe tres veces es la señal de compra más barata que tenemos.

El correo lo redacta el modelo y **lo manda una persona** (misma disciplina que
§14 y ADR 0021), por Resend y no por SendGrid (ADR 0008).

### 16.8 Métricas de v4

| Métrica | Objetivo |
|---|---|
| Prospectos con al menos una prueba corrida | ≥ 80% de los que publican número |
| Tiempo hasta la primera respuesta visible en el diagnóstico | < 5 min desde que el cliente entra |
| Pruebas que terminan en `failed` por culpa nuestra | < 5% — es la métrica de confiabilidad del arnés |
| Informes abiertos al menos una vez | ≥ 40% |
| Costo por conversación | < USD 0,08 |
| Cobertura del QA semanal | 100% de los clientes activos |
| Tiempo desde «quiero probar este número» hasta el primer mensaje | < 60 s, sin research |

### 16.9 Qué sigue siendo manual, a propósito

- **A quién se le escribe fuera del camino automático.** Lo elige una persona.
- **Qué correo sale.** El sistema redacta; un humano aprieta enviar.
- **Desbloquear un número.** Único camino de vuelta, y pasa por una persona.
- **La verificación del motor por eventos.** Turnos, ráfagas y correlación no
  tienen prueba automática: necesitan un proveedor respondiendo, y simularlo
  probaría la simulación. El procedimiento a mano está en wiki/23.

---

## Apéndice · Desvíos respecto al PRD original

Todos deliberados, todos documentados.

| Original | Construido | ADR |
|---|---|---|
| Next.js 14 | Next.js 16.3 | — |
| Supabase Realtime para el progreso | SSE + polling como fallback | 0002 |
| Schema `public` implícito | Schema dedicado `holaamigo` | 0001 |
| Admin con Supabase Auth + allowlist | Contraseña + cookie HMAC firmada | 0005 |
| Sprints de 45 días | Todo en una sesión | Instrucción del fundador |
| Conectar WhatsApp = registrar una intención | Conectar WhatsApp = compilar el agente | 0024 |
| El diagnóstico termina en una proyección | El diagnóstico termina en una conversación real que pasó | 0025 |
| Una prueba por prospecto | Tandas con tope de concurrencia, e informe compartible | 0026 |
| El smoke tester solo prueba a quien pidió un diagnóstico | Apunta a cualquier número, sin research, y desde varias de nuestras líneas a la vez | 0027 |
