# ADR 0027 · La prueba a medida, y varias líneas contra el mismo número

**Fecha:** 2026-08-23
**Estado:** aceptado
**Contexto:** el smoke tester deja de necesitar un diagnóstico para funcionar

---

## El problema

Hoy, para probar una línea, hace falta que el negocio ya exista en nuestra base
con un research corrido. El formulario del admin pide un teléfono y un molde;
las preguntas concretas las escribe `compilar.ts` leyendo `research_findings`.
Sin organización el molde sale crudo: mide atención, pero no se le puede pedir
que pregunte nada en particular.

El caso que no se puede hacer, y que es el que más se pide:

> «Quiero probar cómo responde la Clínica Mirla, que es una clínica estética en
> Bogotá. Quiero que la IA haga tres preguntas sobre sus tratamientos y
> converse. O, si no, que mande estas tres preguntas exactas: si abren el lunes,
> cuánto cuesta el tratamiento X, y qué pasa si no me funciona.»

Ninguna de las dos se puede. La primera porque no hay dónde escribir el saludo,
el objetivo y las preguntas; la segunda porque no existe un modo que mande un
guion fijo. Y las dos habría que poder hacerlas **sin crear una organización,
sin correr research y sin desplegar nada.**

Hay dos problemas de legibilidad encima:

**«Tanda» describe algo que nadie necesita.** Se diseñó como «la misma batería
contra muchas líneas» (ADR 0026, para el QA de treinta clientes). Lo que hace
falta también es lo contrario: **muchas de nuestras líneas contra un solo
número.** Tres personas distintas escribiéndole a Mirla a la vez es la única
forma de ver si su agente les contesta igual a las tres, o si se cae con dos
conversaciones abiertas.

**No se sabe dónde se ven las conversaciones.** Después de crear una prueba, el
formulario dice «el primer mensaje ya salió» y deja al operador en la misma
pantalla. La transcripción existe, a dos clics, en una lista de cuarenta filas.

## Por qué importa más que una pantalla

Esta herramienta es el único punto del producto donde producimos **evidencia y
no proyección**. Sirve para tres cosas a la vez, y las tres necesitan lo mismo:
poder apuntarle a cualquier número en treinta segundos.

- **Diagnóstico de prospectos activos.** «Le escribimos a su línea a las 2:03.
  Contestaron a las 2:19.»
- **Generación de prospectos.** El hallazgo *es* el gancho de la llamada.
- **QA de nuestros propios clientes.** Y más allá: hay millones de negocios con
  un bot de IA contestando su WhatsApp y ninguna certeza de que funcione. Poder
  auditar eso a escala, sin research previo, es un producto en sí mismo.

Si probar una línea cuesta media hora de preparación, nada de eso pasa.

## Las alternativas

### A · Que el admin cree un molde (`smoke_templates`) por negocio

Es el camino de menos código: ya hay una tabla de moldes con `objetivo`,
`persona`, `sondas` y `rubrica`, y ya hay un endpoint para escribirla.

**Por qué se descartó.** El molde es, por definición, *lo que no depende del
cliente* (wiki/23). Treinta prospectos serían treinta «moldes» permanentes en un
catálogo de tres, y la distinción entre lo de fábrica y lo de ayer se pierde en
una semana. Además el molde no tiene teléfono: seguiría haciendo falta el
segundo paso, así que no resuelve el problema que tiene el operador.

### B · El admin escribe el `PlanDePrueba` directo — **elegida**

`PlanDePrueba` ya es «el test compilado, como datos»: apertura, objetivo,
persona, sondas, ficha, rúbrica, criterios de cierre, tope de turnos. El
compilador es **un** productor de ese objeto. El formulario del admin pasa a ser
otro.

Nada río abajo se enteró: el motor, el auditor, el evaluador y el informe leen
el plan y les da igual quién lo escribió.

Costo: el plan gana cuatro campos (`modo`, `guion`, `contexto`,
`instrucciones`), el motor gana una rama, y hacen falta dos filas semilla en
`smoke_templates` (`a-medida` y `guion`) porque `smoke_probes.template_id` es
clave foránea — y así el resumen de treinta días sigue agrupando por tipo de
prueba en vez de mezclar todo en un balde.

### C · Un «playground» aparte del smoke tester

Un subsistema nuevo para pruebas exploratorias, sin tocar el existente.

**Por qué se descartó.** Serían dos motores, dos webhooks, dos correlaciones y
dos evaluadores. En un mes los resultados de uno no se podrían comparar con los
del otro, que es justo lo único que este producto vende. El valor del smoke
tester es que es la línea real por el canal real; un segundo motor deriva.

### Y para la tanda

**D · Borrar `smoke_batches` y dejar una conversación por vez.**
Se pierde el barrido de prospección, que es la mitad del valor comercial.

**E · Redefinir la tanda como `números × líneas` — elegida**

Una prueba es un guion, una lista de números y una lista de **nuestras** líneas.
El producto cartesiano decide todo lo demás:

| Números | Líneas | Qué es |
|---|---|---|
| 1 | 1 | una conversación |
| 1 | 3 | tres clientes distintos escribiéndole a Mirla a la vez |
| 30 | 1 | el barrido de prospección de ADR 0026 |
| 30 | 3 | lo mismo, tres veces más rápido |

El mismo objeto, el mismo tope de concurrencia, el mismo ritmo, el mismo
informe. **La confusión se arregla generalizando, no borrando.** Y contesta la
puerta que ADR 0026 dejó abierta en su alternativa B: varias líneas ya no es
«más adelante», es la unidad de escala.

## Lo que cuesta la alternativa E

La única parte cara, y hay que decirla completa: **el motor serializa por número
y el webhook correlaciona por número.** Con dos de nuestras líneas escribiéndole
al mismo negocio hay dos hilos de WhatsApp distintos, y los dos son legítimos.
Cuatro cambios:

1. **La correlación pasa a ser por `(nuestra línea, su número)`.** El payload
   trae el `channel_uuid` y, para un entrante, también nuestro propio número:
   con cualquiera de los dos se desambigua. Cuando no viene ninguno se cae al
   comportamiento de hoy —la más reciente que espera respuesta— y queda escrito
   en el log que se desambiguó a ciegas.
2. **`cancelarVivasContra` recibe la línea.** Sin eso, arrancar la conversación
   de la línea B cancelaría la de la línea A contra el mismo negocio, que es
   exactamente lo que se quiere permitir.
3. **«La línea está ocupada» se evalúa por par.** En `avanzarCola` del motor y
   en `siguientePendiente` del lote.
4. **El espaciado de 90 s entre pruebas es por par.** Dos conversaciones
   seguidas desde la *misma* línea al *mismo* negocio se pisan; desde líneas
   distintas, no.

Y una consecuencia de producto que hay que aceptar a los ojos: **desde el
momento en que existe más de una línea, `canalActivo()` deja de ser una pregunta
con respuesta.** Se agrega `canalesActivos()`, y el camino automático del
diagnóstico sigue usando una sola —la primera por orden de creación—. Con una
línea, que es el estado de hoy, todo se comporta igual.

## Las decisiones

**1 · El plan es el contrato; quién lo escribe es un detalle.** Un plan escrito
a mano y uno compilado del research son el mismo objeto y se guardan igual. Lo
único que los distingue es `cobertura`: sin research no hay ficha, y sin ficha no
se puede acusar a nadie de haber inventado un dato. Eso ya se muestra sin
adornos y sigue igual.

**2 · Dos modos, y el modo vive en el plan.**

| | `conversar` | `guion` |
|---|---|---|
| Quién escribe cada turno | el comprador sintético | el operador, de antemano |
| Costo en modelo | ~1 llamada barata por turno | **cero** |
| Para qué sirve | ver cómo venden | comparar la misma pregunta entre negocios |
| Cuándo termina | objetivo cumplido, cierre detectado o topes | se acabaron los mensajes |

En `guion` **los detectores de cierre no paran la prueba**: si el negocio agenda
en el mensaje dos, las preguntas tres y cuatro se mandan igual — eso es lo que
pidió el que armó el guion. Al terminar sí se corren una vez sobre todo lo que
dijo el negocio, para que `cerro_con` siga significando lo mismo en las dos
modalidades y el embudo siga sumando.

**3 · En `guion`, un mensaje se manda cuando el anterior tuvo respuesta.** No
«los tres seguidos». Mandarle tres mensajes a un número que no contesta no
produce más información —ya sabemos lo que hay que saber en el primero— y sí es
la firma exacta de un emisor de spam. Si no contestan, la prueba cierra con
`sin_respuesta`, que es el hallazgo más vendedor que tenemos.

**4 · El modelo puede redactar el borrador, y nunca es lo que se manda.** Hay un
botón que convierte «clínica estética en Bogotá, quiero saber si abren el lunes y
cuánto cuesta el tratamiento X» en un saludo y tres sondas. Rellena el
formulario; el operador lo edita; **lo que se manda es lo que quedó escrito en
los campos.** Es la misma frontera de ADR 0024: el modelo aporta lenguaje, el
plan es datos que se pueden ver, versionar y diffear. Si el botón falla, el
formulario sigue funcionando a mano.

**5 · El camino manual tiene frenos distintos del automático, y hay que decirlo
en voz alta.** ADR 0025 escribió cuatro frenos pensando en el disparo
automático, donde no hay nadie mirando. Lo que rige en cada camino, sin
eufemismos:

| Freno | Automático | Manual (esta pantalla) |
|---|---|---|
| `authorize('smoketest.probe')` | siempre | **solo si hay organización vinculada** |
| El número publicado en el sitio de esa organización | siempre | nunca — lo eligió una persona |
| Enfriamiento de 72 h | siempre | no |
| Bloqueo («no me escriban») | siempre | **siempre, y no lo levanta nada** |
| Espaciado de 90 s por par (línea, número) | siempre | siempre |
| Apagado de emergencia en `settings` | siempre | no |

Los dos primeros y el tercero no aplican al camino manual porque no pueden: no
hay organización contra la que autorizar cuando el operador escribe un número
suelto, y el enfriamiento existe para que cinco recargas de la landing no
manden cinco mensajes — acá hay una persona que apretó un botón una vez, y que
muchas veces necesita justamente volver a probar el mismo número después de
haberle cambiado algo al agente.

**Eso no es un descuido: es el diseño.** Y para que sea un diseño y no un
agujero, lo que se paga a cambio:

- El **bloqueo es terminal en los dos caminos.** Si pidieron que paremos, esta
  pantalla tampoco puede escribir, y solo una persona lo revierte desde el
  admin.
- La cuenta va **escrita en el botón** antes de apretarlo: `números × líneas`
  mensajes de WhatsApp reales, con el total en el propio texto del botón.
- La pantalla muestra **cuándo fue la última prueba contra ese número.** Si fue
  hace doce minutos, se ve antes de mandar. La decisión es de la persona, pero
  informada.
- El registro queda igual: cada conversación es una fila con su hora, su línea y
  su operador.

**6 · Después de crear, se cae en la conversación.** Si el producto cartesiano da
uno, en la transcripción; si da más, en la pantalla de la prueba con todas las
transcripciones. Las dos se actualizan solas. La cola de conversaciones es el
producto (PRD §13.6): una herramienta que no deja ver lo que hizo no se vuelve a
usar.

## Cómo se llaman las cosas ahora

El vocabulario era la mitad del problema, así que queda fijo:

| En pantalla | En el código | En la base |
|---|---|---|
| **la prueba** — un guion contra N números desde M líneas | `lote` | `smoke_batches` |
| **la conversación** — una transcripción, un veredicto | `prueba` | `smoke_probes` |
| **nuestras líneas** — los números desde los que escribimos | `canal` | `smoke_channels` |
| **el molde** — lo que no depende del cliente | `plantilla` | `smoke_templates` |

«Tanda» no se usa más en ningún lado. La palabra describía el diseño viejo y por
eso no se entendía qué hacía el botón.

## Lo que esto habilita, y no es teórico

- Auditar el bot de IA de un tercero en treinta segundos, sin research.
- Ver si su agente aguanta tres conversaciones simultáneas.
- Correr la **misma** pregunta contra veinte negocios de un sector y comparar las
  veinte respuestas. Con el guion, sin gastar un peso en modelo.

## Lo que queda pendiente a propósito

- **La correlación a ciegas.** Si el proveedor deja de mandar `channel_uuid` y
  nuestro propio número, dos conversaciones simultáneas contra el mismo negocio
  desde dos líneas pueden cruzar un mensaje. Queda escrito en el log con esas
  palabras. Se arregla el día que haga falta, mirando el log.
- **El guion no reacciona.** Si el negocio pregunta algo, el guion sigue de
  largo. Es el precio de que sea determinístico, es lo que se pidió, y para lo
  otro está `conversar`.
- **Una sola persona sintética por prueba.** Tres líneas hoy son la misma
  identidad tres veces. Que cada línea lleve su propia persona es lo obvio que
  sigue, y es lo que haría de esto una prueba de carga y no solo de coherencia.
