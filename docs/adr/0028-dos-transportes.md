# ADR 0028 · Dos transportes, y una preferencia

**Fecha:** 2026-08-25
**Estado:** aceptado
**Contexto:** el smoke tester deja de depender de un solo proveedor de WhatsApp

---

## El problema

Este trabajo empezó por una pregunta que resultó estar mal formulada: *¿podemos
responderle con un botón a un bot que usa botones?*

La respuesta es no, y no es un límite de nuestro proveedor. **WhatsApp dejó de
aceptar mensajes de botones nativos por conexiones no oficiales el 10 de mayo de
2023.** Los proveedores que conectan por QR aceptan la llamada a su API igual y
entregan el mensaje convertido a texto plano. Afecta a todos por igual y no hay
solución esperada. O sea: cambiar de proveedor para poder mandar botones no
compra nada, y quedarse tampoco cuesta nada.

Con eso descartado quedaron tres motivos que sí se sostienen, y ninguno tiene que
ver con botones:

1. **Un solo proveedor es un solo punto de falla.** Una línea conectada por QR se
   cae: la sesión expira, el teléfono se desvincula, la cuenta se restringe.
   Cuando eso pasa hoy, el smoke tester entero se detiene, y lo hace en silencio
   —las pruebas quedan en `pending`— hasta que alguien mira.

2. **Dos proveedores son dos líneas más.** ADR 0027 estableció que la unidad de
   ocupación es el par `(nuestra línea, su número)`: dos de nuestras líneas contra
   el mismo negocio son dos hilos de WhatsApp y los dos miden. Un proveedor nuevo
   no es un reemplazo, es capacidad.

3. **Son dos puentes distintos sobre el mismo protocolo.** Callbell y wzap leen
   el mismo WhatsApp con implementaciones distintas. Correr la misma conversación
   por las dos y comparar los payloads es la única forma honesta de saber cuál
   pierde información — y ésa sigue siendo la pregunta abierta sobre los mensajes
   interactivos.

Y un cuarto motivo, operativo: la línea de wzap ya existe, ya está conectada, y
su cuenta **ya tiene dos webhooks activos apuntando a otras aplicaciones**. O sea
que el proveedor soporta varios consumidores del mismo número sin que haya que
tocar lo que ya funciona. Eso convierte «agregar un transporte» en una tarde en
vez de una migración.

## Las decisiones

### 1 · Dos transportes, no una migración

Callbell no se retira. Pasa a `prioridad = 200` y sigue siendo una línea
elegible. wzap queda en `10` y es la que usa el camino automático.

La alternativa —migrar y apagar Callbell— era más simple de código y peor de
operación: habría cambiado un punto único de falla por otro punto único de falla,
y habría tirado la mitad de la capacidad de líneas del punto 2.

### 2 · Una ruta de webhook por proveedor

`/api/webhooks/wzap` es un archivo nuevo, no un `if` adentro de
`/api/webhooks/callbell`.

La razón es de riesgo, no de estética: la ruta de Callbell está configurada,
corriendo, y recibiendo reenvíos de otra aplicación del equipo. Meterle un
segundo proveedor para ahorrar sesenta líneas habría puesto en juego un camino
que hoy funciona. Las dos rutas comparten todo lo que importa —`correlacionar()`,
`avanzarTurno()`, el cierre— y no comparten el sobre, que es justamente lo único
que difiere entre proveedores.

El secreto de la ruta nueva va en la cabecera `x-webhook-secret` y no en la URL,
porque wzap lo permite y porque las URLs quedan escritas en los logs de todo lo
que hay en el camino. Se acepta `?k=` también, para no bloquear la puesta en
marcha.

### 3 · La línea preferida es una columna, no el orden de creación

Hasta hoy «la línea» era `order by created_at limit 1`, y con un solo proveedor
eso era exactamente correcto. Con dos, la antigüedad de la fila es un accidente
del día en que se cargó.

`smoke_channels.prioridad` —menor gana, `created_at` desempata— y editable desde
`/admin/pruebas` sin desplegar, por lo mismo que todo el resto de esa tabla:
cuál línea escribe es una decisión de operación (ADR 0014).

### 4 · El `device` nunca es implícito

wzap identifica la línea con un `device` de 24 hex que va en cada POST. Es
opcional en su API: si no se manda, el proveedor elige.

Acá es obligatorio, y `enviarPorWzap()` falla con una pista antes de tocar la red
si el canal no lo trae. El motivo es concreto: **la misma llave de API ve todas
las líneas de la cuenta, incluidas las de otros negocios.** En la cuenta con la
que se puso esto en marcha había cuatro devices, tres de ellos líneas de atención
reales con miles de contactos. Un POST sin `device` es un mensaje de prueba
saliendo desde la línea de atención de un cliente.

Por eso el `device` vive en `smoke_channels.channel_uuid` —la misma columna donde
Callbell guarda su `channel_uuid`— y no en una variable de entorno: es un dato de
operación por línea, no un secreto global.

### 5 · «Qué falta» se pregunta por línea, no por sistema

`faltaParaEnviar()` era global: había un proveedor y «falta la llave» era una
verdad del sistema entero. Ahora la pregunta correcta es qué falta **para las
líneas que se van a usar**. Una `WZAP_API_KEY` ausente no importa si no hay
ninguna línea de wzap activa, y decir que importa manda a alguien a cargar un
secreto que no hace nada.

Consecuencia de orden: en `lanzar.ts` y en `lote.ts` el canal se resuelve **antes**
de preguntar qué falta. Al revés se abortaba por la llave de un proveedor una
prueba que iba a salir por el otro.

## Lo que este ADR NO decide

**Qué hacer con los mensajes interactivos.** Sigue sin saberse si el puente de
wzap nos entrega la estructura de un mensaje con botones o la aplana a texto, y
la respuesta no se puede deducir: hay que ver payloads reales. `pistasDeBotones()`
existe para eso y hace exactamente una cosa —dejar en el log qué claves del
payload huelen a interactivo— sin clasificar, sin puntuar y sin escribir en la
base. Cuando haya datos, la decisión va en su propio ADR.

Esto es a propósito. Un menú de WhatsApp que llega como texto plano y uno que
llega con sus opciones adentro se ven idénticos en la transcripción, y diseñar la
detección antes de saber cuál de los dos casos tenemos es diseñar para un mundo
inventado.

## El precio

- **Dos llaves y dos secretos de webhook** en vez de uno. El diagnóstico
  (`/api/admin/pruebas/diagnose`) muestra los cuatro booleanos y las dos URLs,
  porque el modo de fallo más probable de esto es configurar el webhook de un
  proveedor en la URL del otro.
- **`callbell.ts` quedó con inquilinos que no son de Callbell**: la lectura de la
  tabla de canales, el parser tolerante de entrantes y `describirFalloDeRed()`.
  Mover eso habría tocado el camino que corre en producción sin arreglar nada. Se
  paga con un comentario en el encabezado que dice qué es de quién.
- **El parser de wzap tiene un fallback al de Callbell.** No es indecisión: la
  forma exacta del payload de wzap no está verificada contra un mensaje real
  —los artículos de su documentación piden sesión— y perder un entrante en
  silencio es el peor modo de fallo del subsistema. Cuando el propio no alcanza,
  el genérico atrapa, y el log dice que pasó.

## Cómo se verificó

El contrato de la API de wzap **no** salió de su documentación, que está detrás
de login. Salió de tres llamadas contra la API real el 2026-08-25:

| Llamada | Qué confirmó |
|---|---|
| `GET /v1/devices` | La cabecera de auth es `Token: <llave>`, sin prefijo. Y que la llave ve cuatro líneas, tres de ellas ajenas al smoke tester |
| `POST /v1/messages` con `{}` | Los destinos posibles son `phone`, `group`, `channel` o `chat`, y al menos uno es obligatorio |
| `POST /v1/messages` con un teléfono roto | El formato es E.164 con `+` y sin espacios, y el error viene con `errorCode` legible (`phone:invalid`) — que es lo que hace accionables las pistas |

Ninguna de las tres manda un mensaje. Cada una se puede repetir.
