# ADR 0020 · Pre-registro obligatorio y economía por canal

- **Fecha:** 2026-08-16
- **Estado:** aceptada
- **Parte 4 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)

## Contexto

El agente más valioso de SaaStr empezó como dashboard y terminó proponiendo
campañas, porque tenía finanzas, marketing y CRM en la misma cabeza. Nuestro
President tenía dos de las tres: sabía proponer (P1) y sabía hacerlo dentro de
una correa (P2), pero no sabía cuánto entró, cuánto salió y en qué se fue.

Sin eso no puede contestar la pregunta que un dueño hace todas las semanas:
**¿dónde está el próximo dólar mejor invertido?**

Y hay un problema anterior a la contabilidad. En P1 quedó montada la
calibración —qué predijo el agente contra qué pasó— pero **nadie medía**. Las
decisiones acumulaban `outcome is null` y el destilador no tenía de qué
aprender. Faltaba la pieza que cierra el ciclo.

## Alternativas consideradas

**A · Que cada agente reporte su propio resultado.** Descartada, y es la
descartada importante: un agente al que se le pregunta "¿salió como esperabas?"
contesta que sí. Siempre. No por mentir, sino porque el mismo contexto que
produjo la predicción produce la evaluación.

**B · Medir todo automáticamente contra métricas del producto.** Suena bien y no
se puede: "¿funcionó el ángulo de costo?" depende de qué se considera funcionar,
en qué ventana y contra qué. Un motor que adivine eso termina siendo una función
gigante que conoce todo el producto y que nadie puede auditar.

**C · Pre-registro: declarar antes qué esperamos, cómo lo medimos y cuándo
decidimos; y aplicar la regla literalmente al final.** Elegida.

## Decisión

### El pre-registro es inmutable, y lo hace cumplir un trigger

```sql
create trigger experiments_pre_registro before update on holaamigo.experiments
  for each row execute function holaamigo.proteger_pre_registro();
```

Una vez que el experimento sale de `draft`, no se pueden cambiar hipótesis,
métrica, efecto esperado, regla de decisión, muestra mínima ni guardrail. Se
pueden anotar cosas operativas; no se puede mover el poste.

Es la pieza que hace que un experimento signifique algo. Quien puede ajustar el
efecto esperado después de ver el número siempre acierta, y **una
racionalización con formato de dato es peor que no tener dato**: contamina el
aprendizaje de P1 con calibraciones perfectas y falsas.

### La regla de decisión es un objeto, no una frase

```json
{ "comparador": ">=", "umbral": 0.06, "gana": "won", "pierde": "lost" }
```

"Si mejora bastante, seguimos" no se puede aplicar literalmente, y una regla que
no se aplica literalmente no es un pre-registro: es una intención.

El vocabulario de comparadores es cerrado (`>=`, `>`, `<=`, `<`) a propósito. Un
DSL más rico se convierte en un intérprete, y un intérprete de reglas de
decisión escrito en una tarde es la peor pieza posible para tener en el camino
del dinero.

### El guardrail le gana a la métrica principal

Un experimento que sube la tasa de respuesta 20% mientras triplica las quejas de
spam **no ganó**. Cuando el guardrail se rompe, el readout devuelve `lost` y la
nota dice exactamente qué se rompió y contra qué tope.

### El readout cierra la decisión

```
readout_experimento() → aplica la regla → escribe outcome vía cerrar_decision()
                                        → calibración → destilador → lección
```

Ese encadenamiento es todo el sistema de aprendizaje en una función, y por eso
vive en SQL: si el readout se olvidara de escribir el `outcome`, la decisión
quedaría sin medir para siempre y nadie se enteraría.

### El join que no multiplica

`channel_economics` agrega ingresos y gastos **por separado** y después une los
agregados. La versión ingenua —unir las dos tablas por canal y agrupar— produce
un producto cartesiano: con 10 ingresos y 8 gastos del mismo canal y mes, cada
cifra se reporta 80 veces y el CAC sale dividido por un número inventado.

Es la misma trampa que en `cost_rollup` (P1), y por eso el criterio de
aceptación es que la vista cuadre contra la suma cruda: no es una formalidad, es
la prueba de que este join está bien.

Dos detalles que la prueba fija:

- **Reembolsos y churn restan.** Meterlos como positivos hace que el mes en que
  se va un cliente se vea como el mejor mes del año.
- **El CAC es `null`, no cero, cuando no hubo clientes.** Un CAC de cero es una
  afirmación falsa y encima halagadora.

### El costo de pensar entra al P&G

`importar_costos_de_agentes()` trae de `cost_rollup` (P1) el costo de agente por
día como `cost_events` de categoría `agent_compute`. Sin esto, el P&G miente por
omisión: muestra lo que se gastó en anuncios y herramientas, y no lo que costó
pensar. Es idempotente por `external_ref`, así que corre todas las noches.

### El pronóstico es simple y se puede explicar

Ritmo diario de los últimos 90 días, banda de variación semanal acotada entre
15% y 60%, tres escenarios. Las probabilidades (85/50/15) son la **lectura
estándar de una banda**, no una simulación: decirlo de otra forma sería inventar
precisión estadística que no existe con doce semanas de datos.

Lo que el modelo no hace se dice en el código: no distingue estacionalidad, no
modela el pipeline abierto y no sabe de renovaciones. Con tres meses de
historia, cualquier modelo que pretenda eso está sobreajustando ruido.

### La reasignación se prepara, no se ejecuta

`proponerReasignacion()` toca las tres partes anteriores a la vez: registra la
decisión con predicción (P1), pasa por `authorize('budget.shift')` que tiene
techo de plataforma **L2** (P2), y abre una deliberación con las dos posiciones
y su `what_would_change_my_mind` (P3).

Mueve como máximo el 20% del presupuesto, del peor canal al mejor, y solo con
evidencia en los dos. Sin ese tope, un mes flojo de un canal bueno lo deja en
cero, y el mes siguiente hay que reconstruirlo desde el calentamiento — que
cuesta más de lo que se ahorró.

### El PDF es el diálogo de impresión del navegador

No hay librería de PDF, y es una decisión, no una omisión. Son entre 2 y 6 MB de
dependencia y un cold start de función serverless para producir un documento que
el navegador ya renderiza mejor: con las fuentes del sistema, con su paginación
y con vista previa incluida.

El criterio de aceptación —"el PDF y el CSV traen los mismos números"— se cumple
**por construcción**: las dos salidas leen el mismo objeto (`buildResultsBook`).
No hay dos caminos de cálculo que puedan divergir; si mañana el PDF muestra otra
cifra, es un bug de render.

El día que haga falta un PDF generado en servidor —para adjuntarlo a un correo—
se agrega ahí, y la pantalla no cambia.

## Consecuencias

- El resumen del libro se narra **en código**, con `format`, no con el modelo.
  Este documento es el que el cliente le muestra a su socio o a su junta: un
  número inventado acá no es un texto flojo, es un problema contractual. Cuando
  el modelo entre a mejorar la prosa, será con la verificación de cifras del
  Capítulo (P3).
- `/api/cron/mes` (día 1, 8 a.m. Bogotá): importa costos, guarda el pronóstico y
  propone la reasignación. El costo de agentes además se importa cada noche: un
  margen que solo cuadra el día 1 no sirve para decidir el día 15.
- `/api/health` (`db:v7`) le pide el readout de un experimento inexistente y
  exige error de dominio. Si contestara "ok", el pre-registro sería decorativo.

## Lo que este ADR prohíbe

Editar el pre-registro de un experimento que ya arrancó — el trigger lo impide,
y la salida es abortarlo y abrir uno nuevo, que deja el intento fallido visible
en el libro. Y escribir el `outcome` de una decisión desde el readout con un
`update`: el único camino sigue siendo `cerrar_decision()` (ADR 0016).
