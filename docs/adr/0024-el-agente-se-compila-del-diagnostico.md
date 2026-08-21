# ADR 0024 · El agente de agendamiento se compila del diagnóstico

**Fecha:** 2026-08-20
**Estado:** aceptado
**Contexto:** appointment setting por WhatsApp — el primer mercado

---

## El problema

El diagnóstico terminaba en un botón que registraba una **intención** de
conectar WhatsApp y le avisaba a un humano por Slack. A partir de ahí, todo lo
que convierte esa intención en un agente que agenda citas —qué vendemos, quién
califica, qué objeciones llegan, cómo se reserva, qué se contesta a las
preguntas de siempre— se resolvía por fuera del producto: correos, llamadas, un
documento compartido, dos semanas.

Y el diagnóstico **ya tenía ese 90%**. El motor de research leyó el sitio y sacó
la oferta, los precios, el ICP, el posicionamiento y los competidores. El quiz
sacó la meta a 90 días, el tono y los límites de marca. El Brief los tenía
consolidados y versionados. Nadie lo estaba leyendo hacia adentro de un agente.

El tiempo de onboarding es un costo de adquisición que no aparece en ninguna
hoja de cálculo y que decide cuántos clientes fundadores aguantan hasta ver el
producto funcionando.

## Las alternativas

### A · Un formulario de configuración del agente

Después de conectar el canal, el cliente llena una ficha larga: productos,
precios, objeciones, preguntas frecuentes, horarios.

Barato de construir. Y es la misma ida y vuelta de dos semanas, mudada al
cliente en vez de eliminada — con el agravante de que pregunta cosas que ya
sabemos. Un formulario que pide el nombre de los productos después de haberle
mostrado al cliente un diagnóstico que los enumera se lee como "no leímos nada".

### B · Un prompt generado por el modelo

Una llamada grande que recibe el research y devuelve el system prompt del
agente, listo para usar.

Es la alternativa más rápida de construir y es la peor:

- Contradice [ADR 0007](0007-numeros-deterministas.md): el precio, la duración
  de la cita y los horarios saldrían de un modelo.
- No se versiona de forma útil. Se puede guardar el string, pero no se puede
  diffear "cambió la respuesta a la objeción de precio" contra "cambió todo".
- No se le puede mostrar al cliente campo por campo, así que no se puede
  corregir con un tap: solo se puede reemplazar entero.
- No se puede probar. Un prompt no tiene invariantes.

Un prompt que escribió un modelo es un prompt que nadie puede defender a las 2
de la mañana cuando un contacto recibe algo raro.

### C · Un playbook compilado ✅

El código ensambla un **objeto de datos versionado** —el playbook— leyendo el
diagnóstico, el Brief, el research y las respuestas del quiz. El modelo aporta
solo lenguaje. Una base de conocimiento en un vector store aterriza las
preguntas puntuales. El runtime corre sobre la Responses API con herramientas
que tocan la agenda de verdad.

Es la más cara de las tres. Es la única en la que el agente es un artefacto y no
una caja negra.

## La decisión

**Se elige C.** El playbook es **datos, no prompt**: se le muestra al cliente, se
edita campo por campo, se versiona, se diffea y se prueba.

B se descartó porque un prompt opaco no es un producto: es una promesa.
A se descartó porque mueve las dos semanas al cliente en vez de eliminarlas.

### El reparto de trabajo

Es el mismo del diagnóstico y por la misma razón:

| | Qué aporta |
|---|---|
| **El código** | Los hechos y los números: qué productos, qué precio, qué duración de cita, qué franja horaria, qué link de agenda, qué prohibiciones, cuántas preguntas hacen falta antes de proponer horario, el orden de los ejes de calificación. |
| **El modelo** | El lenguaje: cómo se pregunta, cómo se responde una objeción, cómo se abre la conversación, cómo se cierra con quien no califica. |

Y una tercera cosa que no existe en el diagnóstico y que acá es obligatoria:

**La red que atrapa las cifras.** `blanquearCifras()` recorre todo el texto que
devuelve el modelo y reemplaza cualquier cifra de dinero que no esté autorizada
por el Brief o por los precios que el research leyó textualmente en el sitio. No
alcanza con pedirlo en el prompt: el guion se envía por WhatsApp a un contacto
real y **no hay ninguna pantalla intermedia donde un humano lo lea**. Es la única
información del producto que puede llegar a un tercero sin revisión, así que es
la única que se filtra por código además de por instrucción.

El esquema Zod que va a OpenAI (`PlaybookLanguageSchema`) **no tiene un solo
`z.number()`**. Es una invariante que se verifica leyendo el archivo.

### Qué se automatiza y qué no

El Principio §13.3 dice que nada se automatiza antes de haberse hecho tres veces
a mano, y esta decisión no lo contradice: lo aplica al lugar correcto.

- **Se automatiza la construcción del agente.** Eso es lo que costaba semanas y
  lo que hacíamos con la información ya guardada en nuestra propia base.
- **NO se automatiza la provisión del número con Meta.** Esas 24 a 48 horas son
  de Meta, no nuestras. Fingir lo contrario sería exactamente el "progreso que
  no está pasando" que prohíbe [ADR 0023](0023-mostrar-el-trabajo.md).

La consecuencia de producto es que se invirtió el orden del discurso: **el
agente ya está listo; lo que falta es el número**. El cliente espera por algo
que ya vio funcionar, no por algo que le prometimos.

### La cobertura como sustituto del formulario

`cobertura` es parte del playbook, no un cálculo de la vista. Cuenta cuántos
campos se sostienen con una fuente del sitio y cuáles inferimos, y produce la
lista de "confirmá esto" ordenada por lo que más mueve la aguja.

La diferencia con un formulario no es cosmética. Un formulario le pide al
cliente que **produzca** información: cuesta media hora y se pospone. Esto le
pide que **corrija** información que ya está escrita: cuesta un minuto y se hace
ahí mismo. Cada campo dice además *por qué importa* — "un nombre concreto agenda
más que 'un asesor'" — porque la gente contesta consejos y abandona formularios.

Se muestran seis como máximo. Una lista de "confirmá estas 19 cosas" es un
formulario con otro nombre.

## La base de conocimiento: qué es y qué no

El vector store en OpenAI **no es donde viven los hechos**. Los hechos viven en
el playbook, que entra completo en la instrucción de sistema de cada turno. Si
vivieran en el índice, el agente tendría que hacer una búsqueda para saber qué
vende, y una búsqueda que falla se convierte en un agente amnésico.

El índice es para las preguntas puntuales que el playbook no anticipa:
"¿trabajan en Barranquilla?", "¿tienen la certificación X?". Son las palabras
del sitio del cliente.

La consecuencia de diseño: **si la indexación falla, el agente sigue
funcionando**. Se marca `failed`, se corre sin `file_search`, y el cliente lo ve
en la consola. Un onboarding que se cae porque un índice no se construyó sería
el problema que estamos resolviendo, otra vez.

Los vector stores vencen a los 30 días de inactividad (`last_active_at`). Se
cobran por GB/día pasado el primero, y en un lead magnet la mayoría de los
prospectos prueban una vez y no vuelven. Un cliente activo renueva el suyo con
solo trabajar; uno que se fue deja de costar. Si vuelve, se reconstruye en 20
segundos.

## El techo del plan

Esto salió de una prueba que falló, y es la parte de la decisión que más lejos
llega:

`techo_de_plan()` devolvía L2 para el plan `diagnostico` y ese L2 se aplicaba a
**todas** las clases de riesgo por igual. Compilar un playbook es clase `write`
sobre un objeto propio —no sale nada del edificio— y aun así quedaba en L2, o
sea "preparar", o sea **una tarjeta de aprobación por cada compilación**. El
onboarding que estábamos colapsando a cero terminaba en una cola.

La regla correcta ya estaba escrita en el proyecto, en `techo_de_autonomia()`:

> El dial grueso gobierna lo que sale del edificio. Investigar, puntuar y
> escribir en objetos propios no lo toca.

El plan es un dial comercial y le aplica el mismo razonamiento. Un plan es una
puerta sobre lo que le llega a un tercero —correos, WhatsApp, plata,
publicaciones—, no sobre si el agente puede pensar y escribir en sus propias
tablas. Cobrar por lo segundo es cobrar por el borrador.

Desde `0013`, `techo_de_plan(plan, risk_class)` devuelve L5 para `read` y
`write`, y la tabla comercial de siempre para `external_comms`, `spend` e
`irreversible`. Lo que **no** cambió, y es lo que hace segura la línea:

- Contestar un WhatsApp real (`outreach.reply`, `external_comms`) sigue topado
  por el plan. El plan gratis arma y prueba; no le escribe a nadie.
- `min_plan` sigue mandando por encima de todo.
- `platform_ceiling` no se toca jamás. Firmar sigue en L0.

`autorizar` y `habilidades_activas` se redefinen enteras en `0013` porque en
PL/pgSQL no hay forma de inyectar el argumento nuevo sin tocar la llamada. Los
cuerpos son idénticos salvo esa línea. **La versión vigente es siempre la del
número de migración más alto.**

## Consecuencias

**Buenas**

- Un cliente que termina el diagnóstico y elige WhatsApp tiene un agente
  conversable en menos de un minuto, sin escribir nada.
- El agente es auditable: el cliente puede leer, literal, la instrucción que el
  modelo recibe en cada turno.
- Las conversaciones se miden por escalón alcanzado. `embudo_del_setter()`
  responde "de 100 que contestaron, ¿cuántas llegaron a que les propusiéramos
  horario?", que es la pregunta que decide qué frase hay que reescribir.
- El simulador corre por el mismo runtime que las conversaciones reales. Un
  banco de pruebas con su propio código prueba el banco.

**Malas, y asumidas**

- Superficie nueva grande: una migración, un compilador, un runtime con
  herramientas, tres pantallas. Es deuda que hay que mantener.
- El historial de la Responses API vive 30 días en OpenAI. Nuestra copia está en
  `conversation_turns`, que es la fuente si algún día hay que reconstruir una
  conversación para una disputa.
- Dos definiciones de `autorizar` en el repo (0007 y 0013). Se mitiga con el
  comentario y con `scripts/test-agente-agendamiento.mjs`, que verifica el
  comportamiento en las dos direcciones: que el plan gratis pueda compilar y que
  **no** pueda contestarle a una persona real.

## Lo que nos haría cambiar de opinión

Si a los 30 días menos del 20% de las conversaciones llega a que el agente
proponga un horario, el problema no es la calificación: es la apertura, y el
compilador está escribiendo el primer mensaje mal. Eso se arregla en el
compilador, no en el runtime.

Si más de la mitad de los clientes corrige más de la mitad de los campos de
`a_confirmar`, entonces no estamos infiriendo: estamos adivinando, y el research
tiene que mejorar antes que el compilador.
