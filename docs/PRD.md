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

6 fijas → 4–6 adaptadas a los hallazgos → 1 de cierre. **Guardado incremental:**
cada respuesta persiste al instante.

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

## Apéndice · Desvíos respecto al PRD original

Todos deliberados, todos documentados.

| Original | Construido | ADR |
|---|---|---|
| Next.js 14 | Next.js 16.3 | — |
| Supabase Realtime para el progreso | SSE + polling como fallback | 0002 |
| Schema `public` implícito | Schema dedicado `holaamigo` | 0001 |
| Admin con Supabase Auth + allowlist | Contraseña + cookie HMAC firmada | 0005 |
| Sprints de 45 días | Todo en una sesión | Instrucción del fundador |
