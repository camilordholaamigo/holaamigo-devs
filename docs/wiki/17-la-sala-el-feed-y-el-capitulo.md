# 17 · La Sala, el Feed y el Capítulo

> El cliente no ve un dashboard. Ve a su organización pensando, discutiendo y
> decidiendo — y puede meter la mano cuando quiera.

Parte 3 del plan. Es la primera con pantallas: P1 y P2 eran invisibles y son lo
que hace que esto tenga algo que mostrar.

---

## Tres superficies, tres verbos

| Superficie | Para qué | Ritmo | Dónde |
|---|---|---|---|
| **El Feed** | **Decidir.** Cola de tarjetas que esperan al humano. | Cuando hay algo | `/consola/[orgId]` |
| **La Sala** | **Leer.** La conversación entre agentes, cronológica. | Continuo | `/consola/[orgId]/sala` |
| **El Capítulo** | **Entender.** 150–250 palabras cada mañana. | Diario, 7 a.m. | dentro de La Sala |

No es una separación estética. Son tres cosas que se hacen en momentos
distintos, y mezclarlas es cómo se muere el principio §13.6: si el resumen de
ayer y la propuesta de hoy están en la misma lista, hay que leer todo para
encontrar las tres cosas que le tocan al humano.

---

## La deliberación

```sql
deliberations       question · status · recommendation · confidence
                    what_would_change_my_mind · dissent · reopened_count
deliberation_turns  speaker · speaker_type · body · stance · human_input_id
```

`stance` es un enum cerrado: `propose`, `support`, `object`, `question`,
`concede`, `decide`. No es texto libre porque es lo que permite renderizar el
hilo como diálogo atribuido — y contar cuántas veces un agente objetó y tuvo
razón, que es una métrica que vamos a querer.

### Las dos reglas que no se negocian

**1 · No se resuelve sin decir qué te haría cambiar de opinión.**

```sql
constraint deliberations_resuelta_exige_cambio_de_opinion check (
  status <> 'resolved' or length(btrim(what_would_change_my_mind)) >= 20)
```

Es lo que convierte al agente en asesor y no en oráculo, y es donde el cliente
sabe exactamente qué evidencia aportar. Los 20 caracteres son el umbral debajo
del cual sale "más datos", y eso no le sirve a nadie.

| Mal | Bien |
|---|---|
| "si aparece más información" | "si en dos semanas el WhatsApp no pasa de 3% de respuesta con la base dormida, el problema es el mensaje y no el canal" |
| "si cambian las condiciones" | "si el 70% de sus clientes llegan por referido, el outbound sobra" |

**2 · Si el humano habló, la recomendación tiene que citarlo.**

Vive en `holaamigo.resolver_deliberacion()` porque depende de otra tabla y no
cabe en un `check`:

```
la recomendación no cita lo que escribió el humano (<id>). Si su aporte no
cambió nada, decilo en la evidencia con esa nota.
```

**No se exige que el cliente tenga razón.** Se exige que la respuesta diga qué se
hizo con lo que dijo. Una recomendación que ignora al cliente y llega a la misma
conclusión es peor que no haber preguntado, porque parece que escuchó.

### El desacuerdo se muestra

`dissent` guarda las posiciones enfrentadas aparte de los turnos, aunque la
información esté en los dos lados. Los turnos son la conversación —larga, con
matices—; `dissent` es el resumen de quién quería qué. La pantalla necesita las
dos cosas: el hilo para leer, el resumen para no tener que leerlo entero antes de
entender qué se discute.

---

## El titiritero entra a la sala

```
holaamigo.interponer(deliberation_id, autor, tipo, texto)
```

Tres cosas en una transacción:

1. `human_input` con **peso 2.0** — pesa más que la evidencia del sistema en la
   próxima corrida (P1).
2. Turno visible en el hilo, marcado como humano.
3. La deliberación vuelve a `open`, **aunque estuviera resuelta**, y cuenta la
   reapertura.

La recomendación anterior no se borra: queda como lo que el agente pensaba antes
de escuchar. Borrarla haría que la próxima pareciera la primera, y el cliente no
podría ver que lo movió.

> `reopened_count` es una métrica de producto, no decoración: una deliberación
> reabierta tres veces es un agente que no está escuchando.

---

## El feed: siete y por qué esas siete

`holaamigo.priorizar_feed(org, 7)` devuelve todas las tarjetas abiertas
ordenadas, cada una con su motivo y su marca de mostrado.

```
severidad    alta 300 · normal 200 · baja 100
vencimiento  <6 h +150 · <24 h +75      (lo que se va a decidir solo)
decidir      requires='approval' +50
antigüedad   +2/hora, tope 50           (lo viejo sube despacio, no se olvida)
```

El límite es **cognitivo, no técnico**. Una cola de veinte no se prioriza, se
abandona. Y cada tarjeta trae su motivo porque "el feed muestra 7" sin decir por
qué esas siete es una caja negra que el cliente no puede discutir.

### El teclado

`J`/`K` moverse · `A` aprobar · `R` rechazar · `X` marcar · `E` ver más

Las herramientas serias tienen teclado. `A` con tarjetas marcadas aprueba el
lote; sin marcas, aprueba la que está enfocada. Los atajos se ignoran cuando el
foco está en un campo de texto, porque ahí `a` es la letra a.

**La tarjeta desaparece al instante**, sin esperar al servidor, y vuelve si la
petición falla. Aprobar con el teclado y quedarse mirando la misma tarjeta 800 ms
es lo que hace que una cola se sienta lenta aunque el trabajo real tarde igual.

### El lote es solo para lo barato

Solo severidad baja y normal, y el filtro está en la ruta de API, no en la
pantalla. Lo caro cuesta un clic propio: si se pudieran aprobar diez campañas de
una, el primer día que alguien lo hace sin leer, todo el modelo de "el humano
decide" se volvió teatro.

**Rechazar en lote no existe**: rechazar exige nota, y una nota compartida por
diez rechazos distintos no enseña nada.

### "Ajustar" nunca abre una caja de texto

Cuando el cliente quiere aprobar *pero no así*, no se le pide un párrafo: se le
muestran los números reales de la propuesta y los mueve.

```json
"ajustes_disponibles": [
  { "key": "send_today", "tipo": "slider", "min": 10, "max": 340, "valor": 340,
    "efecto": "Baja el tope diario. El resto espera al día siguiente." },
  { "key": "pasos", "tipo": "checkboxes", "opciones": [...],
    "efecto": "Los que desmarques no se envían nunca." }
]
```

Es declarativo: la propuesta declara, la pantalla pinta,
`lib/feed/adjust.ts` aplica. Cuando P4 y P5 propongan reasignaciones de
presupuesto o listas de partners, no hay que tocar ni el componente ni el
aplicador — solo declarar el ajuste.

Un tipo de ajuste que el componente no sabe pintar **no se pinta**. No hay caso
`default` que caiga a texto libre, y el tipo de la ruta
(`number | string[]`, nunca `string`) lo garantiza a nivel de contrato.

---

## El Capítulo

Job diario a las 12:00 UTC (7 a.m. Bogotá). El President escribe 150–250
palabras: qué hizo la organización ayer, sobre qué discutió, qué decidió, qué
cambió de opinión y qué necesita del humano hoy.

Es una **serie, no una notificación**. Se archiva y se lee de corrido tres meses
después: *"¿qué estaba pasando en septiembre?"* es una pregunta que un dueño se
hace, y hoy la única respuesta es abrir doce pantallas.

### El modelo narra, el código cuenta

Las cifras se calculan antes (`chapterStats`) y se le pasan como **lista
cerrada**. Después, `cifrasInventadas()` revisa el texto: si trae un número que
no está en la lista, se descarta el texto y se publica la versión determinista.

No se reintenta. La versión determinista ya dice lo mismo sin riesgo, y un
reintento cuesta.

```ts
// permitidas: los valores de stats + los días del mes
const intrusas = cifrasInventadas(result.data.body, cifrasPermitidas(stats));
if (intrusas.length > 0) { /* se publica lo determinista, y queda en el log */ }
```

Que quede en el log importa: un modelo que inventa cifras seguido es una señal,
no ruido.

---

## Qué produce deliberaciones hoy

Cada diagnóstico abre una. Las notas de ruta que el modelo ya producía se
atribuyen al agente de su dominio —WhatsApp y correo son ejecución (SALES),
marca y contenido es la CMO— y el `recommended_rationale` del President es el
turno que decide.

**No se inventan turnos**: se atribuyen los argumentos que ya existían al dueño
que les corresponde. Si el modelo no produjo notas para al menos dos rutas, no se
abre nada: una deliberación con un solo turno es peor que ninguna, porque parece
que nadie discutió.

Si el modelo devuelve un `what_would_change_my_mind` de cinco palabras, la
deliberación **se queda abierta**. Es el resultado correcto y se ve así en La
Sala: una recomendación sin condición de refutación no está cerrada.

---

## Cómo verificar

```bash
curl -s "$SITE/api/health?key=$CRON_SECRET" | jq '.checks[] | select(.name=="db:v6")'
```

Ese chequeo intenta resolver una deliberación con una frase de cinco letras y
exige que la función responda con error de dominio.

```sql
-- ¿Qué se está discutiendo?
select question, status, reopened_count, confidence from holaamigo.deliberations
where organization_id = '<org>' order by opened_at desc;

-- ¿El cliente entró alguna vez?
select t.speaker, t.body, h.weight from holaamigo.deliberation_turns t
join holaamigo.human_inputs h on h.id = t.human_input_id
where t.speaker_type = 'human';

-- ¿Qué muestra el feed y por qué?
select * from holaamigo.priorizar_feed('<org>');
```

Y `node scripts/test-la-sala.mjs`: 22 chequeos con los cuatro criterios del plan.

---

## Lo que NO hay todavía

- **Envío del capítulo por correo y WhatsApp.** Se escribe y se archiva; el
  `sent_at` está en la tabla esperando. Sale en P4, junto con el reporte mensual
  que usa el mismo camino.
- **Deliberaciones que nacen de la operación diaria.** Hoy la produce el
  diagnóstico. Las de asignación de presupuesto llegan en P4 y las de
  posicionamiento y partnerships en P5 — con las mismas dos reglas.
- **El panel de sliders de capacidades (P2).** `matrizDeCapacidades()` devuelve
  todo lo que esa pantalla necesita; la pantalla no está.
