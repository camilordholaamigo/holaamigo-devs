# ADR 0014 · El ruteo de modelos se cambia sin desplegar

- **Fecha:** 2026-08-15
- **Estado:** aceptada

## Contexto

`config/models.ts` decide qué modelo de OpenAI corre cada paso. Hasta la v2.0.1
había dos formas de cambiarlo: editar el archivo y desplegar, o poner una
variable de entorno en Vercel y **volver a desplegar** para que la función la
tome.

Eso choca con lo que estamos haciendo esta semana. El producto está en prueba,
el flujo completo se corre veinte veces al día, y cada corrida con `gpt-5` en
research y diagnóstico cuesta cerca de un dólar. La pregunta operativa real es
"¿esto sigue sirviendo con un modelo mini?", y responderla exige alternar entre
modelos en minutos, no en despliegues.

El costo también es una decisión de producto, no de infraestructura: quien tiene
que poder tomarla es quien mira la factura, no quien tiene acceso a `git push`.

## Alternativas consideradas

**A · Variables de entorno y ya.** Es lo que había. Cambiar una exige
redesplegar, y quien la cambia no ve en la misma pantalla cuánto costó el paso
el mes pasado. Se descarta por lento y por ciego.

**B · Edge Config de Vercel.** Lectura rapidísima y hecha justo para esto. Se
descarta porque introduce un almacén más que provisionar y mantener, con su
propio panel y su propia forma de fallar, para una tabla de seis filas. Postgres
ya está ahí, ya es transaccional, y el dato es auditable con un `select`.

**C · Tabla `settings` en el schema `holaamigo`, con caché en memoria.**
Elegida.

## Decisión

Una tabla llave-valor y una pantalla en el admin.

```
holaamigo.settings (key text primary key, value jsonb, updated_at, updated_by)
```

**Precedencia, siempre en este orden: tabla → variable de entorno → default del
código.** La tabla gana porque es la única de las tres que se puede cambiar
mientras un cliente está en pantalla. El default del código gana al final porque
es lo que garantiza que el producto arranque en un proyecto vacío, sin ninguna
fila y sin ninguna variable.

`lib/settings.ts` cachea 30 segundos en memoria. El número no es arbitrario: una
llamada de IA tarda entre 5 y 90 segundos, así que leer la configuración es
irrelevante frente a la llamada, y a la vez un cambio hecho en el admin se
siente inmediato. Sin caché, cada paso de cada corrida agregaría un viaje a
Postgres para leer lo mismo.

Vercel corre varias instancias y cada una tiene su caché. Un cambio tarda hasta
30 segundos en propagarse a todas. Es aceptable: nadie cambia de modelo a mitad
de una corrida a propósito, y coordinar invalidación entre instancias es
maquinaria que este problema no paga.

La corrida resuelve su configuración **una sola vez, al empezar**
(`runStructured`). Si alguien cambia el modelo mientras un diagnóstico está a la
mitad, ese diagnóstico termina con el modelo que arrancó. Cambiarlo entre el
intento 1 y el 2 haría imposible leer `agent_runs`.

## Por qué es seguro bajar de modelo

Porque **ninguna cifra que el cliente lee sale de un modelo** (ADR 0007). Las
fugas, la cuenta al revés y los costos de cada ruta los calcula
`lib/diagnostic/math.ts` y `config/routes.ts`. Bajar de `gpt-5` a `gpt-5-mini`
degrada la prosa y la calidad del análisis competitivo; no mueve un solo número
de los que sostienen la venta.

Por eso el default de la v2.1 es toda la familia mini/nano, y por eso subirlo es
un formulario y no un incidente.

## Lo que NO se configura desde ahí

Los prompts, los contratos de los agentes y las fórmulas. Un prompt editable en
caliente es un prompt sin revisión de código y sin historia en git; los
contratos son lo que le prometemos al cliente que el agente no va a hacer (ver
`lib/agents/config.ts`), y una prohibición que se cambia en un formulario no es
una prohibición.

## Consecuencias

- `/admin/modelos` muestra el valor **vigente** de cada paso, de dónde sale
  (tabla, entorno o default) y cuánto costó ese paso en los últimos 30 días.
  Poner el costo real al lado del formulario es deliberado: sin eso, "subir el
  modelo" es una decisión sin precio.
- `config/models.ts` expone `routeFor(step)` asíncrono. Los llamadores nuevos
  tienen que resolver la ruta, no leer una constante.
- La tabla soporta más llaves cuando haga falta. Cada una necesita su
  saneamiento propio: `settings.value` es JSON libre y nunca se confía en su
  forma, ni aunque venga de nuestra propia pantalla.
