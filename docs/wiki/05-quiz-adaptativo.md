# 05 · Quiz adaptativo

## Estructura

**6 fijas → hasta 5 adaptadas → 1 de cierre.** Tope duro de 12 en pantalla,
como pide el PRD §6.

Una pregunta a la vez, con barra de progreso y el ticker del research arriba.

## Las 6 fijas

Viven en dos lugares a propósito: `lib/quiz/bank.ts` (el que corre) y
`supabase/migrations/0002_seed_quiz.sql` (para poder corregir copy sin
desplegar). **El servicio prefiere la tabla.** Si divergen, gana la tabla.

| id | Qué mide | Para qué se usa |
|---|---|---|
| `main_offer` | La oferta en una frase | Brief · contexto del diagnóstico |
| `ticket_band` | Ticket promedio | **Todas las fórmulas de fuga** · FIT |
| `rev_band` | Facturación mensual | Deriva leads/mes · FIT |
| `sales_team` | Tamaño del equipo comercial | FIT |
| `dormant_db` | Contactos dormidos | **Fuga de base dormida** · FIT (el que más pesa) |
| `main_channel` | De dónde salen los clientes hoy | Elección de ruta |

> `dormant_db` es la pregunta más importante del quiz. Su respuesta multiplicada
> por `ticket_band` genera la cifra de fuga y es lo que dispara la oferta de
> reactivación — que es lo único que hace real la promesa de 24 horas.

Cada opción de banda trae un `mid` (punto medio) que es lo que entra a las
fórmulas. Los puntos medios están duplicados en `lib/diagnostic/math.ts` bajo
`BAND_MIDPOINTS`: ese es el que corre, el del seed es solo para editar copy.

## Las adaptadas

El CMO las genera **una sola vez por sesión**, cuando el usuario termina las
fijas. Se guardan en `quiz_generated` para que recargar la página no las
regenere ni las cambie.

### Los slots permitidos

Solo estos nueve. El modelo devuelve un `slot` y el servicio filtra cualquier
cosa que no esté en la lista:

`offer_margin` · `real_competitor` · `price_choice` · `differentiator` ·
`friction` · `speed` · **`goal_90d`** · `tone` · `limits`

### Por qué el filtro

Sin él, el modelo inventa slots y las respuestas quedan bajo claves que nada
lee. Los slots son el contrato entre lo que el modelo genera y lo que el resto
del sistema sabe consumir.

### La regla que hace que valga la pena

Una pregunta adaptativa que no menciona nada específico del negocio es una
pregunta desperdiciada. El cliente se da cuenta y pierde la confianza.

```
Mal:  "¿Cuál es tu principal diferenciador?"
Bien: "Vimos que ofrecen mudanzas locales y bodegaje. ¿Cuál deja más margen?"
```

Está escrito así, con ese ejemplo, en `ADAPTIVE_QUESTION_SYSTEM`.

### `goal_90d` es obligatoria

Alimenta la cuenta al revés (§7.4). Si el modelo no la devuelve —o si no hubo
modelo— el servicio la inyecta desde `FALLBACK_ADAPTIVE`. Nunca falta.

## La espera al research

Cuando el usuario termina las fijas, el research puede seguir corriendo.
`ensureAdaptive()` espera hasta **12 segundos** consultando cada 1,5 s.

Por qué esperar: llegar con hallazgos vale mucho más que llegar rápido, y el
usuario acaba de invertir dos minutos respondiendo. Por qué solo 12: pasados
esos, la espera se nota y el costo de una pregunta genérica es menor que el de
una pantalla congelada.

Pasado el techo, se generan con lo que haya. Si no hay nada, entran las de
respaldo — que no dependen de hallazgos: `differentiator`, `friction`, `speed`,
`goal_90d`, `limits`.

## Guardado incremental

**Cada respuesta viaja al servidor apenas se da.** Nunca acumulamos estado en el
cliente para mandarlo al final.

Si el usuario cierra la pestaña en la pregunta 4, tenemos las tres primeras y
un lead recuperable. Eso vale más que la elegancia de un submit único. Es §4.2
del PRD y no es negociable.

El `upsert` usa índices únicos parciales distintos según el tipo de pregunta
(`session_id, question_id` para fijas; `session_id, slot` para generadas), así
que volver atrás y cambiar una respuesta actualiza en vez de duplicar.

## Al terminar

1. `markQuizCompleted()` → sesión pasa a `diagnosed`, evento `quiz_completed`
   (15 puntos de intent).
2. El cliente llama a `POST /api/diagnostic/generate`.
3. Esa ruta espera al research hasta **45 segundos** más si sigue vivo, y
   después genera con lo que haya.
4. Mientras tanto la pantalla de ensamblaje muestra los cinco pasos reales que
   el President está ejecutando.

## Qué pasa si algo falla

| Falla | Resultado |
|---|---|
| Research vacío o fallido | Se usan las preguntas de respaldo. El quiz no se acorta. |
| El modelo devuelve slots inválidos | Se filtran; si quedan menos de 4, se completa con respaldo. |
| El modelo no devuelve `goal_90d` | Se inyecta. |
| El modelo falla del todo | `FALLBACK_ADAPTIVE` completo. |
| La tabla `quiz_questions` no existe | `FIXED_QUESTIONS` del código. |

El quiz **nunca** se queda sin preguntas ni deja al usuario en una pantalla
muerta.
