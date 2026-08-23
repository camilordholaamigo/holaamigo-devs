# ADR 0025 · Le escribimos a su línea antes de venderle nada

**Fecha:** 2026-08-23
**Estado:** aceptado
**Contexto:** el diagnóstico y la evidencia que lo sostiene

---

## El problema

El diagnóstico es bueno y es, de punta a punta, una **proyección**. Las cuatro
fugas salen de `computeLeaks` sobre supuestos que el cliente puede mover con un
control deslizante; el embudo invertido sale de la meta a 90 días; las tres
rutas salen de tablas de costo. Todo es aritmética honesta, todo tiene su
fórmula a la vista, y todo se puede discutir.

Y hay una afirmación que hacemos en la landing y en el diagnóstico —«te estás
perdiendo los mensajes que llegan de noche», «tardan en contestar»— que **no
estábamos demostrando**. La deducíamos de que el sitio no promete un tiempo de
respuesta, o de que el quiz dijo que atienden en horario de oficina. Es una
inferencia razonable presentada al lado de cifras exactas, y es justo la que un
dueño de negocio recibe como «este man no sabe de mi negocio».

Al mismo tiempo teníamos todo para demostrarla: el crawler ya extraía los
`wa.me/` y los `tel:` de su sitio y los guardaba en `crawl_signals`. El número
estaba ahí, en nuestra base, sin que nadie lo mirara.

## Las alternativas

### A · Preguntarle en el quiz

Una pregunta más: «¿en cuánto contestan ustedes por WhatsApp?».

Cuesta una pregunta y devuelve lo que el dueño **cree**, que en este dato
específico está sistemáticamente sesgado hacia abajo: todo el mundo cree que
contesta en cinco minutos. Y agrega fricción a un quiz que ya declara seis
minutos en la landing.

**Por qué se descartó:** cambia una inferencia nuestra por una estimación suya.
No es evidencia; es otra opinión.

### B · Un análisis del sitio más profundo

Buscar más señales: si hay widget de chat, si dice horario, si tiene bot.

Es gratis y es lo que ya hacemos. El techo es duro: **el sitio no dice qué pasa
cuando alguien escribe.** Un negocio con un botón de WhatsApp gigante y nadie
del otro lado se ve, desde el crawler, exactamente igual que uno impecable.

### C · Escribirle a su línea y contarle qué pasó ✅

Un comprador sintético le escribe por WhatsApp al número que su propio sitio
publica, como si fuera un cliente. La conversación corre hasta donde llegue, y
después se califica en tres capas.

Es la más cara de las tres —una migración, un motor por eventos, un proveedor de
WhatsApp, tres redes de seguridad— y es la única que produce un hecho.

## La decisión

**Se elige C.** El diagnóstico gana una sección que no es una proyección:

> «Le escribimos a tu línea de ventas a las 2:03 p. m. Contestaron a las 2:19.
> Dieciséis minutos.»

Ese renglón no se discute. No depende de ningún supuesto, no tiene fórmula
debajo, y el cliente puede abrir su propio WhatsApp y verlo.

A se descartó porque cambia una inferencia por una creencia. B porque el sitio
no puede responder la pregunta que importa.

### El reparto de trabajo, otra vez

Es el mismo de [ADR 0007](0007-numeros-deterministas.md) y de
[ADR 0024](0024-el-agente-se-compila-del-diagnostico.md), aplicado a un objeto
nuevo:

| | Qué aporta |
|---|---|
| **El código** | Los números y los hechos: qué número se escribe y de dónde salió, a qué hora salió el mensaje, a qué hora contestaron, cuántos segundos pasaron, qué dice su sitio, qué criterios se cumplieron y cuáles no. |
| **El modelo** | El lenguaje: cómo se pregunta para que suene a una persona, y cómo se resume lo que pasó. |

Y una consecuencia que vale la pena escribir aparte porque es la parte menos
obvia de esta decisión:

**El evaluador no devuelve una nota. Devuelve juicios.**

`EvaluacionPruebaSchema` pide cinco enumeraciones —`excelente`, `bien`,
`regular`, `mal`, `pesimo`— y la nota 0-100 la calcula el código con una tabla
fija en `lib/pruebas/evaluador.ts`. Pedirle un 78 a un modelo es comprar falsa
precisión: la misma transcripción le saca 74 y 79 en dos corridas, y ese ruido
llegaría al cliente disfrazado de medición. Con juicios, la varianza se ve
—«bien» contra «regular»— y la nota es una función pura de ellos, así que dos
evaluaciones con los mismos juicios dan exactamente el mismo número.

**Ningún esquema del smoke tester tiene un solo `z.number()`.** Es una
invariante que se verifica leyendo el archivo, y `scripts/test-smoke-tester.mjs`
la verifica.

### Qué se automatiza y qué no

El §13.3 dice que nada se automatiza antes de haberse hecho tres veces a mano.
Acá se aplica con una asimetría deliberada:

- **Se automatiza el disparo**, en cuanto termina el research, contra los
  números que **ese mismo sitio publica**. Es lo que le da al cliente cuatro o
  cinco minutos de ventaja: cuando llega al diagnóstico, la primera prueba ya
  tiene respuesta o ya sabemos que no la va a tener.
- **No se automatiza a quién más se le escribe.** Un número que no está
  publicado en el sitio de esa organización no entra por el camino automático,
  y no hay forma de que entre. Para eso está `/admin/pruebas`, donde una
  persona escribe el número y responde por él.

### Los cuatro frenos

Escribirle por WhatsApp a un negocio que no nos escribió primero es la acción
más delicada que hace este producto. Los frenos, de más duro a menos:

1. **`authorize()`.** `smoketest.probe` es `external_comms` con techo de
   plataforma **4**, no 5. L5 sería «hacelo y ni lo cuentes»; L4 es «podés
   ejecutar sin aprobación previa, queda registrado y es reversible dentro de
   la ventana». Un número quemado por Meta no se recupera con un rollback.
2. **Propiedad del número.** En el camino automático, el número tiene que estar
   publicado en el sitio de la organización que pidió el diagnóstico. Le
   escribimos al dueño de la línea, no a un tercero.
3. **Enfriamiento de 72 horas**, global por número. Cinco recargas de la landing
   no son cinco mensajes.
4. **Bloqueo.** Si del otro lado piden que paremos, la conversación se corta en
   ese mismo turno, el número queda bloqueado, y **ningún camino automático lo
   desbloquea** — ni un upsert, ni volver a correr el diagnóstico. Solo una
   persona desde el admin.

### La arquitectura: motor por eventos, no un loop

El transporte es asíncrono: mandamos un HTTP a Callbell y la respuesta llega
minutos después por un webhook. Eso obliga a que **el estado viva en la base y
nadie espere a nadie**.

No es una preferencia. Es aritmética: Vercel corta la función a los 300 s y una
persona contesta un WhatsApp en 4, 20 o 40 minutos. Un runner que espera
respuesta agota su presupuesto en dos mensajes, muere a la mitad, y deja la
prueba en `running` para siempre — envenenando la correlación de todas las que
vienen después. Ese fallo está documentado con nombre y apellido en
`docs/referencia/smoke-tester/05-QUE-FUNCIONO-Y-QUE-NO.md`, que es el paquete
del que sale este subsistema.

### Tres deudas del paquete original que acá no se heredan

El material de referencia trae ocho deudas listadas. Tres eran estructurales y
se resolvieron en el diseño, no después:

**La correlación es por número.** `smoke_probes.target_phone` está
denormalizado y el webhook empareja contra él. Allá se emparejaba contra «la
conversación activa más reciente», lo que impedía correr dos pruebas a la vez
para siempre. Acá se le puede escribir a tres líneas en paralelo, y hace falta:
el cliente está mirando la pantalla.

**`turno` y `turn_token` son columnas.** Allá vivían adentro de un `jsonb` que
se escribía con leer-modificar-escribir, y dos webhooks simultáneos se pisaban.
Como columna, reclamar un turno es un `update … where turn_token = $viejo`, que
es atómico.

**La evaluación se dispara sola.** Allá estaba detrás de un botón y por eso casi
nunca se corría. Una evaluación que hay que acordarse de pedir es una evaluación
que no existe.

### Serial por número, paralelo entre números

Dos conversaciones simultáneas contra la misma línea caen en el mismo hilo de
WhatsApp y ninguna de las dos mide nada. Contra números distintos no hay
problema, porque la correlación es por número. De ahí la cola: una prueba viva
por número, y las tres pruebas de un mismo número una detrás de otra, separadas
por al menos 90 segundos.

Ese espaciado se implementa como **guarda y no como espera**: `avanzarCola()`
mira cuándo cerró la anterior y, si fue hace poco, se retira. Quien vuelva a
pasar la arranca. Una espera de 90 s adentro de esa función habría reventado el
techo de 60 s del endpoint de estado y el de 300 s del cron — y habría
contradicho la única regla que sostiene todo el diseño: nadie espera a nadie.

## Lo que esto NO cambia

**Sigue sin haber cifras salidas de un modelo.** Los segundos los resta el
código, la nota de auditoría sale de contar criterios, y la nota de calidad sale
de una tabla fija aplicada a juicios cualitativos.

**Sigue sin fingirse progreso.** La barra del panel en vivo avanza solo cuando
pasa un hecho con hora: salió el mensaje, contestaron, se cerró un turno, se
cerró la prueba. Entre dos hechos se queda quieta. Lo que corre es el
cronómetro, y es real. Es [ADR 0023](0023-mostrar-el-trabajo.md) al pie.

**Sigue sin haber cliente de Supabase en el navegador.** El panel en vivo lee
por SSE desde una ruta de servidor, igual que el ticker del research
([ADR 0002](0002-sse-en-vez-de-realtime.md)).

## Consecuencias

**Buenas**

- El diagnóstico tiene una sección que no se puede discutir, y es la que más
  fácil se reenvía a un socio.
- `/admin/pruebas` responde «¿a qué prospecto llamo ahora?» con un criterio
  duro: el que tiene la línea muerta.
- Las tres capas de veredicto se escalonan por costo. Con la capa 1 sola
  —contestaron o no, en cuánto— ya hay producto. Las otras dos suman.
- El paquete de referencia queda en `docs/referencia/smoke-tester/`. Sus doce
  bugs son la razón de la mitad de las decisiones de acá.

**Malas, y asumidas**

- Superficie nueva grande: una migración con cinco tablas, once archivos de
  lógica, siete rutas, dos pantallas, un cron. Es deuda que hay que mantener.
- **Mandamos mensajes reales a terceros.** Es la acción más delicada del
  producto y por eso tiene cuatro frenos, pero el riesgo no es cero: un número
  quemado por Meta no se recupera.
- Cuesta plata por prospecto: una llamada de compilación por plantilla, una por
  turno, una de evaluación. Del orden de USD 0,03–0,08 por conversación, sobre
  una meta de USD 1,20 por diagnóstico (§11). Hay que mirarlo.
- **El motor por eventos no está cubierto por pruebas automáticas.** Turnos,
  acumulado de ráfagas y correlación necesitan un proveedor respondiendo, y
  simularlo probaría la simulación. Se verifica a mano con el procedimiento de
  [wiki/23](../wiki/23-smoke-tester.md). Es la deuda más grande que deja este
  PR y está dicha en el propio script de pruebas.

## Lo que nos haría cambiar de opinión

Si más de la mitad de las líneas contestan en menos de dos minutos, la prueba
deja de ser un gancho y se convierte en un cumplido caro: habría que quedarse
solo con la de ventas, que mide si cierran y no si contestan.

Si un número se quema o llega una queja formal, el disparo automático se apaga
desde `settings` (`pruebas.bateria.activo = false`) sin desplegar, y la decisión
se vuelve a discutir con ese caso encima de la mesa.

Si el compilador marca `del_research` en menos del 30% de las preguntas de
forma sostenida, entonces el research no está alcanzando para especializar
nada y estamos pagando una llamada de modelo para reescribir el molde con otras
palabras. En ese caso el problema es el research, no el smoke tester — es el
mismo criterio que ADR 0024 aplica a `a_confirmar`.

## Referencias

- [ADR 0007 · Números deterministas](0007-numeros-deterministas.md)
- [ADR 0018 · La escalera de capacidades](0018-la-escalera-de-capacidades.md)
- [ADR 0023 · Mostrar el trabajo](0023-mostrar-el-trabajo.md)
- [ADR 0024 · El agente se compila del diagnóstico](0024-el-agente-se-compila-del-diagnostico.md)
- [wiki/23 · El smoke tester](../wiki/23-smoke-tester.md)
- `docs/referencia/smoke-tester/` — el paquete portable y sus doce bugs
- [Callbell · POST /messages/send](https://docs.callbell.eu/es/api/reference/messages_api/post_send_messages)
