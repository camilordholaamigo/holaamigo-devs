# 18 · El President como CRO

> El agente más valioso de SaaStr empezó como dashboard y terminó proponiendo
> campañas porque tenía finanzas, marketing y CRM en la misma cabeza. Acá se
> construye esa cabeza.

Parte 4 del plan. Es la que le da al President las cinco respuestas que un dueño
pide todas las semanas:

1. ¿Cuánto entró, cuánto salió y en qué se fue este mes?
2. ¿Cuánto cuesta un cliente por canal y en cuánto se paga solo?
3. ¿Dónde está el próximo dólar mejor invertido?
4. ¿Vamos a llegar a la meta del trimestre? ¿Con qué probabilidad?
5. ¿Qué decisión de hace 60 días funcionó, y cómo lo sé?

La quinta es la que cierra el círculo de P1.

---

## El P&G por canal

```sql
revenue_events   (amount_usd, kind, channel_id, occurred_at, source, external_ref)
cost_events      (amount_usd, category, channel_id, decision_id, occurred_at)
channel_economics → ingreso · costo · margen · clientes · CAC · ROAS, por mes
```

### El join que no multiplica

La vista agrega **cada lado por separado** y después une los agregados. La
versión ingenua —unir las dos tablas por canal y agrupar— produce un producto
cartesiano: con 10 ingresos y 8 gastos del mismo canal y mes, reporta 80 veces
cada cifra y el CAC sale dividido por un número inventado.

Es la misma trampa que en `cost_rollup` (P1). Por eso el criterio de aceptación
es que la vista cuadre contra la suma cruda de eventos: no es una formalidad, es
la prueba de que el join está bien.

| Detalle | Por qué |
|---|---|
| Reembolsos y churn **restan** | meterlos positivos hace que el mes en que se va un cliente se vea como el mejor del año |
| CAC es `null`, no cero, sin clientes | un CAC de cero es falso y encima halagador |
| Un canal solo con gasto **aparece** | el que quema plata sin traer nada es exactamente el que hay que ver |

### El costo de pensar entra al P&G

`importar_costos_de_agentes()` trae de `cost_rollup` el costo de agente por día
como gasto de categoría `agent_compute`. Sin eso el P&G miente por omisión:
muestra lo que se gastó en anuncios y no lo que costó pensar.

Es idempotente por `external_ref = 'agentes:2026-08-16'`, así que corre todas
las noches. Un margen que solo cuadra el día 1 no sirve para decidir el día 15.

### Payback

`payback_dias = CAC / (ARPU mensual / 30)`. Es una aproximación y se dice: con
contratos de duración distinta, lo correcto es la cohorte, y la cohorte necesita
meses de historia que un cliente nuevo no tiene.

---

## El motor de experimentos

> **Ninguna acción consecuente se ejecuta sin declarar antes qué esperamos, cómo
> lo mediremos y cuándo decidiremos.**

```ts
await preRegistrar({
  organizationId,
  hypothesis: 'El ángulo de costo supera al de urgencia en logística',
  primaryMetric: 'reply_rate',
  expectedEffect: 0.08,
  decisionRule: { comparador: '>=', umbral: 0.06 },
  minSample: 200,
  guardrailMetric: 'complaint_rate',
  guardrailThreshold: 0.003,
  decisionId,          // la decisión de P1 que este experimento va a medir
});
```

### Inmutable una vez que arranca

Un trigger impide cambiar hipótesis, métrica, efecto esperado, regla, muestra
mínima o guardrail después de salir de `draft`:

```
el experimento <id> ya arrancó: la hipótesis, la métrica, el efecto esperado
y la regla de decisión no se pueden cambiar. Abortalo y abrí uno nuevo.
```

Quien puede ajustar el efecto esperado después de ver el número siempre acierta.
Una racionalización con formato de dato es peor que no tener dato: contamina el
aprendizaje de P1 con calibraciones perfectas y falsas.

Abortar y abrir uno nuevo deja el intento fallido **visible en el libro**, que es
exactamente lo que queremos.

### El readout aplica la regla, literalmente

```ts
await readout({ experimentId, actual: 0.09, sample: 400, guardrail: 0.001 });
// → { status: 'won', nota: '0.09 >= 0.06 con n=400', calibracion: 0.888 }
```

Tres caminos, en este orden de precedencia:

1. **`sample < min_sample` → `inconclusive`**, aunque el número sea buenísimo.
   Es lo que evita concluir con tres datos.
2. **Guardrail roto → `lost`**, aunque la métrica principal haya pasado. Un
   experimento que sube la respuesta 20% y triplica las quejas no ganó.
3. La regla, aplicada tal como se declaró.

Y después escribe el `outcome` de la decisión asociada vía `cerrar_decision()`:

```
experimento → decisión → calibración → destilador → lección
```

Todo el sistema de aprendizaje en una función. Por eso vive en SQL: si el
readout se olvidara del `outcome`, la decisión quedaría sin medir para siempre y
nadie se enteraría.

---

## El pronóstico

```
ritmo diario = ingreso neto de 90 días / días con datos
banda        = coeficiente de variación semanal, acotado a [15%, 60%]
escenarios   = ritmo × días restantes, ± banda
```

Las probabilidades **85 / 50 / 15** son la lectura estándar de una banda
P85/P50/P15, no una simulación. Decirlo de otra forma sería inventar precisión
estadística que no tenemos con doce semanas de datos.

Los topes de la banda son un juicio declarado, no un dato: con pocas semanas el
coeficiente real puede dar 4% (una banda falsamente estrecha, que hace parecer
certero lo que no lo es) o 300% (una que no dice nada).

**Lo que este modelo no hace**, y hay que decirlo cuando alguien pregunte: no
distingue estacionalidad, no modela el pipeline abierto y no sabe de
renovaciones. Con tres meses de historia, cualquier modelo que pretenda eso está
sobreajustando ruido.

---

## La reasignación de presupuesto

Toca las tres partes anteriores a la vez:

| Parte | Qué aporta |
|---|---|
| **P1** | la propuesta se registra como decisión con predicción medible a 30 días |
| **P2** | `authorize('budget.shift')` — techo de plataforma **L2**: prepara, no ejecuta |
| **P3** | se discute en La Sala, con las dos posiciones y qué la cambiaría |

La regla es determinista y conservadora: se mueve **como máximo el 20%** del
presupuesto total, del peor canal al mejor, y solo si hay evidencia en los dos.
Sin ese tope, un mes flojo de un canal bueno lo deja en cero y el mes siguiente
hay que reconstruirlo desde el calentamiento — que cuesta más de lo que se
ahorró.

El retorno esperado usa el **ROAS observado** del canal ganador, no uno
proyectado, y el supuesto de que escala linealmente se dice en el texto de la
propuesta. Es falso a la larga y aceptable para un movimiento del 20%.

> El agente que razona sobre dinero no toca dinero (§13.1). Acá se ve concreto:
> el President arma la propuesta, la argumenta y la deja lista. Mover el
> presupuesto es del humano.

---

## El libro de resultados

`/consola/[orgId]/libro` · `GET /api/libro/[orgId]?periodo=2026-08&formato=csv`

Seis secciones: resumen narrado, P&G por canal, **todas las decisiones con
costo, predicción, resultado y calibración**, experimentos, lecciones nuevas y
la propuesta del próximo periodo.

### La columna que nadie más muestra

| Fecha | Agente | Decisión | Costo | Predijo | Pasó | **Calibración** |
|---|---|---|---|---|---|---|
| 2026-08-02 | president | ¿Con cuál ruta arrancamos? → whatsapp | $0.42 | 12 clientes | 9 | **0.75** |

Ningún competidor le muestra al cliente qué tan bien predice su propia IA. Es el
diferenciador del documento, y sale gratis porque P1 lo venía registrando desde
la primera decisión.

### Los mismos números en los dos formatos

El CSV y la pantalla imprimible leen el **mismo objeto** (`buildResultsBook`).
No hay dos caminos de cálculo que puedan divergir: "el PDF y el CSV traen los
mismos números" es cierto por construcción, no algo que haya que verificar en
cada cambio.

### Por qué no hay librería de PDF

"Guardar como PDF" abre el diálogo de impresión del navegador, con una hoja de
estilo `@media print`. Una librería son 2–6 MB de dependencia y un cold start de
función serverless para producir un documento que el navegador ya renderiza
mejor: fuentes del sistema, paginación del sistema, vista previa incluida.

El día que haga falta un PDF generado en servidor —para adjuntarlo a un correo—
se agrega ahí y esta pantalla no cambia.

### El resumen se narra en código

Doscientas palabras con `format`, no con el modelo. Este documento es el que el
cliente le muestra a su socio o a su junta: un número inventado acá no es un
texto flojo, es un problema contractual.

---

## Los trabajos programados

| Cuándo | Qué |
|---|---|
| cada noche (`/api/cron/destilar`) | importa el costo de agentes al P&G |
| día 1, 8 a.m. (`/api/cron/mes`) | costos + pronóstico + propuesta de reasignación |

---

## Cómo verificar

```bash
curl -s "$SITE/api/health?key=$CRON_SECRET" | jq '.checks[] | select(.name=="db:v7")'
```

Ese chequeo pide el readout de un experimento inexistente y exige error de
dominio. Si contestara "ok", el pre-registro sería decorativo.

```sql
-- ¿Cuadra el P&G?
select
  (select sum(case when kind in ('refund','churn') then -amount_usd else amount_usd end)
     from holaamigo.revenue_events where organization_id = '<org>') as crudo,
  (select sum(ingreso_usd) from holaamigo.channel_economics
     where organization_id = '<org>') as vista;

-- ¿Qué tan bien predice esta organización?
select kind, count(*) filter (where outcome is not null) as medidas,
       round(avg(calibration), 3) as calibracion
from holaamigo.decisions where organization_id = '<org>' group by kind;
```

Y `node scripts/test-cro.mjs`: 26 chequeos con los cuatro criterios de P4.

---

## Lo que NO hay todavía

- **Quién mide cada métrica.** `pendientesDeReadout()` devuelve los experimentos
  listos; el que sabe leer `reply_rate` es el dominio de campañas, no el motor.
  Los conectores por dominio llegan con P5 y P6.
- **Ingresos automáticos.** `revenue_events` acepta `source: 'stripe' | 'wompi' |
  'hubspot'` con `external_ref` idempotente, pero el conector es de P6. Hoy se
  cargan a mano o desde el checkout propio.
- **Cohortes de payback.** La aproximación por ARPU mensual está documentada
  arriba y se cambia cuando haya meses de historia.
