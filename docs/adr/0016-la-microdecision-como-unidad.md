# ADR 0016 · La microdecisión es la unidad, y siempre lleva predicción

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Parte 1 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)

## Contexto

Hasta hoy, lo que hacía un agente quedaba en `agent_runs`: paso, modelo, tokens,
costo, salida. Es un **log**. Un log responde "¿qué pasó?" y no responde ninguna
de las cuatro preguntas que hacen que esto sea una organización y no un chatbot
con memoria:

1. ¿Qué alternativas se consideraron y por qué se descartaron?
2. ¿Qué esperaba el agente que pasara?
3. ¿Pasó?
4. ¿Cuánto costó **esa decisión**, no esa llamada?

La segunda es la que no se puede reconstruir después, y es la que lo sostiene
todo. Sin una predicción registrada **antes** del hecho, no hay forma de
distinguir un agente que acierta de uno que racionaliza el resultado. Un modelo
al que se le pregunta "¿esto salió como esperabas?" contesta que sí. Siempre.

El producto que estamos construyendo le va a mostrar al cliente qué tan bien
predice su propia IA. Esa columna —la calibración— es el diferenciador, y no se
puede calcular a posteriori sobre un log.

## Alternativas consideradas

**A · Enriquecer `agent_runs` con campos de decisión.** Descartada: una corrida
y una decisión tienen vidas distintas. Las corridas son enormes y se purgan; las
decisiones son medianas y son permanentes. Mezclarlas obliga a elegir una
retención para las dos, y cualquiera de las dos elecciones es mala: o guardamos
gigabytes de entradas de prompt para siempre, o borramos el historial que
explica por qué la empresa está donde está.

**B · Registrar decisiones solo cuando hay aprobación humana.** Descartada: eso
deja fuera todo lo que el agente hace solo, que es justamente lo que queremos
poder auditar y de lo que queremos aprender. Las decisiones que ya pasan por un
humano son las que menos falta hace vigilar.

**C · Tres capas con vidas distintas — trazas, decisiones, lecciones.** Elegida.

## Decisión

Tres tablas, tres volúmenes, tres retenciones:

| Capa | Qué guarda | Volumen | Vida |
|---|---|---|---|
| `traces` | cada paso de ejecución | enorme | 90 días |
| `decisions` | qué se decidió, por qué, qué se predijo, qué pasó | media | permanente |
| `lessons` | regla destilada de N decisiones medidas | pequeña | permanente, versionada |

Y **tres invariantes que viven en la base, no en el código**, porque el código
se puede saltar y la tabla no:

```sql
constraint decisions_dos_opciones check (
  jsonb_array_length(options_considered) >= 2),
constraint decisions_prediccion check (
  prediction is not null or kind in ('escalate','handoff')),
constraint decisions_prediccion_forma check (
  prediction is null or (prediction ? 'metric'
    and prediction ? 'expected_value' and prediction ? 'horizon_days'))
```

1. **Dos opciones mínimo.** Una decisión con una sola opción no es una decisión,
   es una justificación. Es la misma regla de `docs/PROCESO.md` §1 aplicada a los
   agentes: "hacerlo o no hacerlo" no son dos alternativas.
2. **Predicción obligatoria**, con dos excepciones nombradas: `escalate` y
   `handoff` no predicen un resultado, transfieren el control a un humano.
3. **La predicción tiene forma:** métrica, valor esperado y horizonte. Sin los
   tres no se puede medir, y una predicción que no se puede medir es una opinión
   con formato de dato.

La **calibración se define una sola vez, en SQL**
(`holaamigo.calibracion(esperado, real)`), y se escribe en la misma sentencia que
el resultado (`holaamigo.cerrar_decision`). Tenerla también en TypeScript
garantizaría que en seis meses las dos digan cosas distintas y nadie sepa cuál
manda. La copia en `lib/decisions/types.ts` existe solo para proyectar en el
navegador y lo dice en su comentario.

Es normalizada y simétrica —el denominador es el mayor de los dos valores—
porque con un denominador fijo, predecir siempre cero da una calibración
excelente.

El **costo se imputa por corrida y se reparte en partes iguales** entre las
decisiones que esa corrida produjo. Es una atribución, no una medición, y se
dice explícito: no existe forma honesta de saber qué fracción de los tokens fue
"por" cada decisión. Lo que sí garantiza la regla es que la suma cuadre, y sin
eso el P&G por canal de P4 nace mintiendo.

## Consecuencias

- Todo camino que produzca una decisión tiene que crear un `runId` y pasarlo a
  `runStructured`. Sin `runId` no hay traza, sin traza no hay costo, y la
  decisión queda sin costo imputado.
- La primera decisión real del producto es la elección de ruta del President en
  `lib/diagnostic/generate.ts`: tres opciones con costo calculado, una elegida,
  y una predicción medible a 90 días.
- `recordDecision()` valida las mismas invariantes antes de escribir, no para
  reemplazar a la base sino para que el error diga qué agente y qué le faltó, en
  vez de `violates check constraint "decisions_dos_opciones"`.
- `GET /api/health` verifica las tablas **y la función**: si el
  `grant execute` no corrió, las tablas existen, la migración aparenta haber
  pasado, y el ciclo de aprendizaje se queda mudo sin un solo error visible.

## Lo que este ADR prohíbe

Escribir un `outcome` con un `update` directo. El único camino es
`holaamigo.cerrar_decision()`, porque es lo que hace imposible guardar un
resultado sin su calibración — y un resultado sin calibración desaparece del
aprendizaje sin hacer ruido.
