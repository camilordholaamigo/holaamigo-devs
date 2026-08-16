# 15 · El sustrato: decisiones, trazas y aprendizaje

> Todo lo que un agente hace queda registrado como **decisión**, no como log. Y
> de esas decisiones la empresa aprende.

Esta es la Parte 1 del plan de la meta-organización, y es la parte que no se ve.
No hay una sola pantalla nueva. Es, aún así, el 60% del valor: la trazabilidad,
la calibración, los sobres de P2, la deliberación visible de P3 y el P&G de P4
descansan todos sobre lo que hay acá.

---

## Las tres capas

| Capa | Qué guarda | Volumen | Vida |
|---|---|---|---|
| **Traza** (`traces`) | Cada paso de ejecución: input, salida, tokens, costo, latencia | Enorme | 90 días |
| **Decisión** (`decisions`) | Qué se decidió, por qué, con qué evidencia, **qué se predijo** y **qué pasó** | Media | Permanente |
| **Lección** (`lessons`) | Regla destilada de N decisiones, con alcance, confianza y evidencia | Pequeña | Permanente, versionada |

La separación no es estética. Son tres retenciones distintas: las trazas se
purgan a los 90 días con `holaamigo.purgar_trazas()`, las decisiones no se
borran nunca, y las lecciones se versionan en vez de reescribirse.

`agent_runs` sigue existiendo y no se toca. Responde "¿cuánto costó este
diagnóstico?". `traces` responde "¿qué pasó adentro de esta corrida y cuánto le
toca a cada decisión que salió de ella?". Son dos preguntas distintas.

---

## La microdecisión

Es la unidad atómica. Tres invariantes viven en `check` constraints de la base y
no en el código, a propósito: el código se puede saltar, la tabla no.

1. **Dos opciones mínimo.** Una decisión con una sola opción es una
   justificación. Misma regla que `PROCESO.md` §1, aplicada a los agentes.
2. **Predicción obligatoria**, salvo `escalate` y `handoff`, que no predicen un
   resultado: transfieren el control a un humano.
3. **La predicción tiene forma:** `{metric, expected_value, horizon_days}`. Sin
   horizonte no se puede medir, y una predicción que no se puede medir es una
   opinión con formato de dato.

```ts
await recordDecision({
  organizationId,
  role: 'president',
  runId,                                   // ← sin esto no hay costo imputado
  kind: 'route_recommendation',
  question: '¿Con cuál de las tres rutas arrancamos?',
  context: { segment: 'diagnostico', channel: 'whatsapp' },
  optionsConsidered: [ /* las 3 rutas con su costo real */ ],
  chosen: { label: 'whatsapp', payload: { /* ... */ } },
  rationale: diagnosis.recommended_rationale,
  prediction: {
    metric: 'clientes_nuevos_90d',
    expected_value: 12,
    horizon_days: 90,
    confidence: 0.6,
    direction: 'up',
  },
});
```

La primera decisión real del producto es exactamente esa: la elección de ruta
del President en `lib/diagnostic/generate.ts`. No es un ejemplo — corre en cada
diagnóstico.

### Cerrar el ciclo

```ts
await settleDecision(decisionId, 9);   // llegaron 9 clientes, no 12
```

Va por RPC a `holaamigo.cerrar_decision()`, que escribe el `outcome` **y** la
calibración en la misma sentencia. Es imposible guardar un resultado sin su
calibración, y eso es deliberado: un resultado sin calibración desaparece del
aprendizaje sin hacer ruido.

La fórmula está en SQL y en un solo lugar:

```
calibración = 1 − |real − esperado| / max(|esperado|, |real|)
```

| Esperado | Real | Calibración | |
|---|---|---|---|
| 100 | 100 | 1,00 | clavado |
| 100 | 80 | 0,80 | |
| 100 | 200 | 0,50 | pasarse al doble no es gratis |
| 100 | 0 | 0,00 | |
| 0 | 0 | 1,00 | predecir "nada" y que no pase nada acierta |

Es simétrica a propósito: con un denominador fijo, predecir siempre cero daría
una calibración excelente.

**Quién mide.** En P1 nadie mide solo: `settleDecision()` está disponible y
`decisionesPorMedir()` lista las que ya vencieron su horizonte. Las fuentes de
métrica —ingresos, respuestas, citas— se conectan en P4 con el motor de
experimentos, que hace el readout automático.

---

## El destilador

Corre cada noche (`/api/cron/destilar`, 07:00 UTC = 2 a.m. Bogotá) y es **SQL
puro**. No llama al modelo, y eso es la aplicación literal del ADR 0007 a la
capa de aprendizaje: el lift, la n y la confianza se pueden verificar con una
consulta.

```
1. Agrupa decisiones medidas por  kind × contexto × métrica
2. Compara el promedio de la mejor opción contra el promedio del resto
3. Donde hay señal, escribe una lección `candidate`
4. Alcance `organization` + confianza > 0,7 → se activa sola
5. Evidencia invertida → se retira, o vuelve a candidata con versión nueva
```

La confianza es determinista y multiplica dos factores:

```
volumen  = 1 − 1/√n            n=8 → 0,65 · n=16 → 0,75 · n=50 → 0,86
fuerza   = min(1, (lift−1)/0,5)  lift 1,25 → 0,5 · lift ≥1,5 → 1
confianza = min(0,95, volumen × fuerza)
```

Consecuencia buscada: hacen falta ~16 decisiones medidas con 50% de ventaja para
que una lección se active sola. Menos que eso queda esperando evidencia.

### Cuando la evidencia se da vuelta

Si la opción ganadora del grupo cambia, la lección **deja de ser ley en el acto**:
sube de versión, vuelve a `candidate`, y queda marcada con `contradicted_at`.
No se reactiva en la misma pasada que la contradijo — necesita una noche más de
evidencia sostenida.

Sin esa regla, el mismo job que detecta la contradicción activaría la regla
contraria un milisegundo después, y el cliente vería su organización cambiando
de ley sin que nadie mirara.

### Alcances, en escalera

| Alcance | `scope_ref` | Qué es |
|---|---|---|
| `agent` | `<org_id>:<role>` | lo que aprendió ese agente en esa empresa |
| `organization` | `<org_id>` | lo que aprendió esa empresa |
| `industry` | slug | lo que aprendimos del sector |
| `global` | `null` | lo que aprendimos del producto |

**Las de `industry` y `global` no se pueden activar sin firma humana nuestra.**
No es una convención: es un `check` en la base
(`lessons_alcance_amplio_requiere_humano`). Un cliente con un negocio raro no
puede envenenar a los demás por acumulación de datos. El único camino que
satisface la restricción es `promoteLesson()`.

El destilador de v1 **solo produce lecciones de alcance `organization`**.

### Límite conocido de v1

Solo destila métricas donde más es mejor (`direction: 'up'`) y con promedios
positivos. Las de costo —donde bajar es ganar— se registran igual y entran al
aprendizaje en P4.

---

## La inyección en runtime

Las lecciones **no se hornean en el prompt**. Si estuvieran en el prompt,
cambiar lo que el sistema cree exigiría desplegar, y no habría forma de saber
qué creía el agente el día que decidió lo que decidió.

```ts
const learning = await buildLearningContext({
  organizationId, role: 'president', industry: org.industry,
  task: 'Recomendar ruta de crecimiento para Acme en logística',
  runId,
});

// learning.block →  "## Lo que hemos aprendido\n1. En logistica·email…"
// learning.lessonIds →  se guardan en la decisión y en una traza
```

El ranking mezcla tres cosas, y ninguna sola sirve:

```
puntaje = 0,5 · similitud + 0,3 · confianza + 0,2 · peso_del_alcance
```

La similitud sola trae lecciones parecidas pero flojas; la confianza sola trae
lecciones sólidas de otro tema; el alcance solo trae lo específico aunque no
aplique.

El bloque lleva `n` y confianza visibles a propósito: un agente que lee
"n=9, confianza 0,72" trata la lección distinto que uno que lee "n=140,
confianza 0,94". Una regla sin su respaldo es dogma.

Cada inyección deja una traza `lecciones_inyectadas` con los **enunciados**, no
solo los ids: una lección puede subir de versión mañana, y entonces el id ya no
dice qué leyó el agente hoy.

---

## Lo que dice el humano

`human_inputs` guarda lo que el sistema no puede observar: que un competidor
quebró, que el cliente no quiere que lo vean como el barato, que la cuenta X es
intocable.

`weight > 1` significa que **pesa más que la evidencia del sistema**, y el
bloque de contexto lo dice con esas palabras. La alternativa —confiar en que el
modelo infiera la jerarquía de un número— es el tipo de cosa que funciona en la
demo y falla en producción.

En P3 esto se conecta a La Sala: el cliente responde en el hilo, entra como
`human_input` con peso alto, y la deliberación se reabre.

---

## Costos

`holaamigo.cost_rollup` agrega por organización, agente, día y tipo de decisión,
y **cuadra exacto** contra la suma cruda de trazas.

El detalle que lo hace posible: la vista no une trazas con decisiones directo.
Una corrida puede producir varias decisiones y el join multiplicaría las trazas,
inflando el costo. Se colapsa primero a una fila por corrida.

`holaamigo.imputar_costos()` reparte el costo de cada corrida **en partes
iguales** entre las decisiones que produjo. Es una atribución, no una medición:
no existe forma honesta de saber qué fracción de los tokens fue "por" cada
decisión. Lo que sí garantiza es que la suma cuadre — y sin eso, el P&G por
canal de P4 nace mintiendo.

`reconciliarCostos()` compara vista contra crudo y devuelve el desvío. Existe
porque una vista de agregación que se desincroniza no avisa: sigue devolviendo
números, solo que equivocados.

---

## La noche

`GET /api/cron/destilar` — 07:00 UTC, protegido con `CRON_SECRET`:

1. Destila lecciones por organización con decisiones medidas.
2. Calcula los vectores de las lecciones nuevas (`backfillEmbeddings`).
3. Imputa costo de corridas a decisiones.
4. Purga trazas de más de 90 días.

El orden importa: si se purgara antes de imputar, se borrarían las trazas que
sostienen el costo que todavía no se imputó.

---

## Cómo verificar que esto está vivo

```bash
curl -s "$SITE/api/health?key=$CRON_SECRET" | jq '.checks[] | select(.name=="db:v4")'
```

```sql
-- ¿hay decisiones con predicción?
select kind, count(*), count(outcome) as medidas, round(avg(calibration),3) as calibracion
from holaamigo.decisions group by kind;

-- ¿qué leyó el agente en su última corrida?
select output from holaamigo.traces
where name = 'lecciones_inyectadas' order by created_at desc limit 1;

-- ¿cuadra la contabilidad?
select (select round(sum(cost_usd),6) from holaamigo.traces) as crudo,
       (select round(sum(costo_usd),6) from holaamigo.cost_rollup) as vista;
```

Y las pruebas: `node scripts/test-sustrato.mjs` corre los cuatro criterios de
aceptación del plan contra Postgres real.

---

## Lo que NO hay todavía

- **Pantallas.** Nada de esto se ve. P3 lo muestra.
- **Medición automática de resultados.** Llega en P4 con el motor de
  experimentos y el pre-registro.
- **Lecciones de industria y globales.** La estructura está y la salvaguarda
  también; la promoción es manual y en P6 tendrá su tarjeta en el admin.
