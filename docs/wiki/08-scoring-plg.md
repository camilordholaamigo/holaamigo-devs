# 08 · Scoring PLG · cuándo entra un humano

## La tesis

> PLG por defecto, humano por excepción. El humano entra **por señal, no por
> corazonada**.

`lib/scoring.ts` es esa señal.

## FIT (0–60) · ¿este negocio nos sirve?

| Pregunta | Máximo | Cómo puntúa |
|---|---|---|
| `rev_band` | 20 | Pico en USD 50k–200k/mes. Más abajo no paga; más arriba compra distinto. |
| `ticket_band` | 15 | Pico en USD 2k–10k. Ticket bajo no aguanta el fee; muy alto tiene ciclo largo. |
| **`dormant_db`** | **15** | 2k+ contactos = puntaje máximo. |
| `sales_team` | 10 | Pico en 1–5 personas. Con 0 nadie ejecuta; con 15+ ya tienen proceso. |

**Por qué `dormant_db` pesa tanto:** es lo que hace real la promesa de 24 horas.
Sin base propia no hay reactivación, y sin reactivación estamos vendiendo cold
email con tres semanas de calentamiento — otro producto, otra conversación,
otra tasa de cierre.

Fíjate que las curvas **no son monótonas**. Una empresa de USD 1M+ al mes
puntúa 14, no 20. No es que sea peor cliente: es que compra distinto —comité,
procurement, ciclo de 6 meses— y el motor de autoservicio no es lo que necesita.

## INTENT (0–40) · ¿se está involucrando?

| Señal | Puntos |
|---|---|
| Completó el quiz | 15 |
| Cargó leads | 15 |
| Conectó un canal | 10 |
| Vio el diagnóstico | 5 |
| **Editó un supuesto** | **5** |
| Volvió en 48 h | 5 |
| Deadline esta semana o este mes | 5 |

**Editar un supuesto** vale lo mismo que ver el diagnóstico completo, y es la
señal más honesta de todas. Alguien que discute tu número ya se apropió del
número. Pasó de "esto me lo mostraron" a "esto es mío y creo que está mal en
este punto". Esa transición es la venta.

## Bandas

| Banda | Rango | Qué pasa |
|---|---|---|
| **AUTO** | < 45 | Nurture automático. Nadie lo toca. |
| **ASSIST** | 45–69 | Secuencia con nudge. Mensaje personal si se estanca 48 h. |
| **ATTACK** | ≥ 70 | **Alerta a Slack en tiempo real. Contacto humano en <30 min.** |

## La alerta ATTACK

Se manda **una vez**, al cruzar a ATTACK. `prospect_scores.alerted_at` es el
candado.

Por qué importa: un canal que grita dos veces por el mismo prospecto se
silencia, y ahí perdimos la señal. La disciplina de la alerta es lo que hace que
el SLA de 30 minutos sea creíble.

La alerta lleva dominio, contacto, desglose fit/intent, las cinco razones
principales y enlace directo a la ficha 360.

## Cuándo se recalcula

`refreshScore()` corre en cada momento que puede mover la aguja:

- Al generar el diagnóstico
- Al verlo
- Al editar un supuesto
- Al conectar un canal
- Al cargar leads

No hay cron de recálculo. El score se mueve cuando pasa algo, que es cuando
importa.

## Override manual

Cualquier admin puede cambiar la banda **con nota obligatoria**. El botón está
deshabilitado sin ella.

No es burocracia: el score se recalcula solo, y un override sin explicación es
un número que nadie va a saber por qué está ahí en dos semanas. La nota queda en
`prospect_scores.manual_note` y el evento en `plg_events`.

## La ficha 360

`/admin/prospects/[orgId]`. Todo en una pantalla:

- Fuga calculada · **costo de IA** · contactos cargados · fit/intent
- Desglose del score con los puntos de cada razón
- Override de banda
- Respuestas del quiz, en orden
- **Brief vivo completo** en JSON
- Corridas de agentes con modelo, tokens, costo, duración y error
- Timeline de eventos PLG
- Aprobaciones y salud de agentes

**El costo de IA va arriba y visible.** Si un prospecto AUTO nos costó USD 3 en
research, eso es una decisión de producto que hay que ver, no un número
enterrado en una tabla de logs.

## La cola de decisiones

`/admin/approvals`. Global, ordenada por severidad y luego por antigüedad — los
más viejos primero dentro de cada severidad, para que nada se pudra al fondo.

Cada ítem dice **cuatro cosas**: qué propone el agente, por qué, qué pasa si se
aprueba, y qué pasa si no. Sin esas cuatro no se puede decidir en cinco
segundos, y una cola que no se puede vaciar a cinco segundos por ítem no se
vacía nunca.

**Aprobar es un clic. Rechazar exige nota.** La asimetría es intencional:
aprobar sin pensar es barato de revertir; rechazar sin explicar destruye la
única señal de aprendizaje que tenemos sobre por qué un ángulo no sirve.

> "La cola de decisiones es el producto. Los gráficos son consulta; la cola es
> el trabajo." (§13.6)

Por eso esa pantalla no tiene gráficos.
