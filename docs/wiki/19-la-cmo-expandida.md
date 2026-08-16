# 19 · La CMO expandida

> El valor de agentificar una CMO no está en conectar canales. Está en lo que
> hoy nadie hace porque no da el tiempo.

Parte 5 del plan. Seis funciones, y ninguna es difícil: son trabajo constante de
bajo volumen y alto valor, que es lo primero que se cae cuando alguien tiene que
elegir en qué gastar su martes.

---

## 1 · Posicionamiento vivo

```sql
positioning (version, statement, differentiators, forbidden_claims, is_current)
```

Se **versiona, no se edita**. "¿Qué decíamos ser en marzo?" es la pregunta que
permite entender por qué el copy de marzo decía lo que decía.

**Las dos listas.** Lo que la marca dice y lo que la marca *nunca* dice. La
segunda es la mitad útil: un posicionamiento que solo enumera virtudes no sirve
para detectar deriva, porque todo copy las cumple de alguna forma.

### La deriva se mide

`holaamigo.deriva_de_copy(org, texto)` compara lo que está saliendo contra el
documento vigente, y compara **distinto según el lado**:

| | Cómo | Por qué |
|---|---|---|
| Claims prohibidos | literal | una prohibición difusa no es una prohibición |
| Diferenciadores | por raíz de palabra | el copy conjuga |

```sql
select holaamigo.menciona('te respondemos en 60 segundos', 'responde en 60 segundos');
-- true: «respo» aparece, «segundos» aparece, «60» aparece
```

Con comparación literal, una pieza perfectamente alineada marcaba deriva. **A la
tercera falsa alarma nadie vuelve a mirar la alerta.** El stemmer son los
primeros 5 caracteres de cada palabra de 4 o más: crudo, con falsos positivos
entre palabras de raíz común, y suficiente para lo que mide.

`auditarCopyActivo()` revisa las secuencias de las campañas **activas**, no los
borradores: lo que importa no es lo que se escribió, es lo que está saliendo. Y
devuelve solo lo que tiene problema — reportar las diez campañas alineadas es
cómo una alerta se vuelve ruido.

---

## 2 · Inteligencia competitiva

Job semanal (lunes): leer el sitio de cada competidor que el diagnóstico ya
identificó, guardar un snapshot por sección y **alertar solo lo que cambió**.

```
home · pricing · offer · jobs · media
```

| Decisión | Por qué |
|---|---|
| Hash por sección | si no cambió, no hay diff ni llamada al modelo. El 90% de las semanas no cambia nada |
| Texto normalizado antes de hashear | un rediseño que mueve saltos de línea no es "cambió el precio" |
| **La primera captura no alerta** | alertar la línea base llena el feed de "cambió todo" el día que se agrega un competidor |
| Dedupe por semana | si el rival itera su sitio a diario, no queremos una alerta diaria |

Las **ofertas de empleo** son la señal más subestimada: una empresa que abre tres
vacantes de vendedores enterprise dice hacia dónde va seis meses antes de que se
vea en su sitio.

El modelo escribe el *por qué importa* citando el antes y el después —los dos van
en el input, así que no inventa cifras— y su segunda frase es la que vale: **qué
NO hay que hacer**. La reacción por defecto a que un competidor baje el precio es
bajar el precio, y casi siempre es la respuesta equivocada.

---

## 3 · La fábrica de ángulos

### El hueco que había

`angles.sent` y `angles.replied` existían desde `0001` y **nunca se
escribieron**: ningún mensaje guardaba de qué ángulo salía. Una fábrica de
ángulos que no puede medir un ángulo no es una fábrica.

`messages.angle_id` lo cierra, y se estampa **solo si la campaña prueba
exactamente un ángulo**:

> Con dos ángulos, la atribución sería una repartija inventada y la fábrica
> retiraría el que funciona por culpa del que no. Mejor una campaña sin
> atribución —que se ve como un hueco— que una con atribución falsa, que se ve
> como un dato.

### La saturación

```sql
select * from holaamigo.saturacion_de_angulos('<org>', 14, 30, 0.4);
```

Compara la tasa de respuesta de la ventana reciente contra la anterior. Muestra
mínima de 30 por ventana: con 12 envíos, una respuesta de más o de menos mueve
la tasa 8 puntos, y ese ruido propondría un ángulo nuevo todas las semanas.

Todo el juicio numérico es determinista. El modelo solo escribe el ángulo nuevo
—y tiene que explicar **en qué se diferencia** del que se quemó; si no puede,
sobra—. Cuando el modelo falla, **no se propone nada**: un ángulo genérico se
aprueba, se envía y quema el segmento de verdad.

La propuesta pasa por `authorize('angle.propose')` aunque sea de las capacidades
más inocuas del catálogo. **La primera acción que se salta el motor es la que
enseña que el motor es opcional.**

---

## 4 · Prueba social industrializada

La más subestimada del plan. Es puro trabajo humano que nunca se hace, y
agentificado **compone**: cada cliente que cierra deja un activo que ayuda a
cerrar al siguiente.

```
deal cerrado → borrador con números reales → permiso del cliente final
             → biblioteca de activos → ruteo a los ángulos
```

| Candado | Dónde vive |
|---|---|
| Los números salen del CRM, no del modelo | el prompt los recibe como lista cerrada |
| Nada se publica sin aprobación del cliente final | `check` en la base |
| Un caso por deal | índice único sobre `revenue_event_id` |

El umbral de "deal grande" es **relativo**: el doble del ticket promedio, con
piso. USD 24.000 es enorme para un negocio de tickets de 800 y rutina para uno
de 20.000.

El item del feed no pregunta "¿te gusta?". Pregunta lo único que no podemos
hacer nosotros: **si podemos escribirle a esa persona**.

---

## 5 · Partnerships

El gobierno ya está hecho en P2 y es el ejemplo trabajado del plan: investigar
L5, redactar L2, contactar L3–L4 con sobre, term sheet L2, **firmar L0**. Ver
[wiki/16](./16-gobierno-capacidades-y-sobres.md).

---

## 6 · Media play (enterprise)

Casi todo cliente con volumen tiene un activo de data propietaria que no sabe
que tiene. `detectarActivoDeData()` cuenta contactos, respuestas y segmentos; por
debajo de 500 contactos y 100 respuestas **no propone nada**: cualquier hallazgo
sería una anécdota, y publicar una anécdota como estudio es la forma más rápida
de perder la autoridad que se buscaba.

**Disparo manual, a propósito (§13.3).** La detección y el brief son
automáticos; quién decide que este cliente vale un media play es un humano
nuestro. Hoy solo sabríamos automatizar nuestra corazonada.

Y es el brief, no la publicación: `content.publish` tiene techo de plataforma
L2 y no hay plan que lo suba.

---

## La máquina de upsell

**La CMO no vende: detecta restricciones y genera propuestas con evidencia.**

| Señal observada | Restricción | Servicio |
|---|---|---|
| Respuesta alta + pocas citas | prueba | media play |
| Todos los ángulos quemados a la vez | posicionamiento | reposicionamiento |
| El copy se alejó de la marca | marca | agencia · marca |
| Base mucho mayor que la capacidad | capacidad | créditos |
| Un mes de gasto sin un cliente | operación | operador dedicado |

Cada una se sostiene con **dos números y su referencia**. Si no se puede
sostener con datos, no es una señal.

### La escalera, que es la disciplina

```
detected → proposed_internal → proposed_client → won | lost
```

```sql
constraint upsell_al_cliente_exige_visto_bueno check (
  status not in ('proposed_client','won','lost') or internal_approved_by is not null)
```

**Toda señal aparece primero en `/admin/senales`.** Un humano nuestro mira la
cuenta y decide. No es prudencia excesiva: el día que el cliente sospecha que el
agente que le recomienda cosas también nos está vendiendo, deja de creerle a
todo lo demás — incluida la ruta, el ángulo y el P&G.

En la consola del cliente aparecen **al final, sin énfasis**, diciendo
explícitamente que alguien de nuestro equipo las revisó antes.

En el admin, promover es un clic y descartar exige nota — la misma asimetría del
feed del cliente, y por la misma razón: la nota es la única señal de aprendizaje
sobre qué detecciones no sirven.

---

## Las pantallas

| Quién | Dónde | Qué ve |
|---|---|---|
| Cliente | `/consola/[orgId]/marca` | posicionamiento, deriva, ángulos y sus números, competencia, casos |
| Nosotros | `/admin/senales` | las señales de upsell con su evidencia y la escalera |

---

## El cron

`/api/cron/cmo`, 14:00 UTC (9 a.m. Bogotá):

| Cuándo | Qué |
|---|---|
| todos los días | casos de estudio (el criterio es <24 h del cierre) y saturación de ángulos |
| lunes | competencia y señales de upsell |

Un solo cron con una rama y no dos: comparten el recorrido de organizaciones y
los mismos errores de red. Dos rutas serían dos lugares donde arreglar lo mismo.

Se puede forzar la parte semanal con `?semanal=1`.

---

## Cómo verificar

```bash
curl -s "$SITE/api/health?key=$CRON_SECRET" | jq '.checks[] | select(.name=="db:v8")'
```

```sql
-- ¿El copy se está alejando?
select holaamigo.deriva_de_copy('<org>', 'somos el más barato del mercado');

-- ¿Qué ángulo se quemó?
select nombre, tasa_previa, tasa_reciente, caida, saturado
from holaamigo.saturacion_de_angulos('<org>');

-- ¿Qué le vamos a ofrecer, y quién lo aprobó?
select signal, status, internal_approved_by from holaamigo.upsell_signals
where organization_id = '<org>';
```

Y `node scripts/test-cmo.mjs`: 24 chequeos con los cuatro criterios de P5.

---

## Lo que NO hay todavía

- **Ruteo automático de casos a ángulos.** `case_studies.angle_ids` existe; qué
  caso alimenta qué ángulo se decide a mano hasta que haya suficientes casos
  para que la decisión signifique algo.
- **Crawl de prensa.** La sección `media` está en el esquema y hoy queda vacía:
  requiere búsqueda web por marca, que es otra clase de trabajo (y de costo) que
  el crawl de un sitio.
- **El flujo de partnerships end-to-end.** El gobierno está (P2) y las
  capacidades también; el pipeline de candidatos llega con el CRM de P6.
