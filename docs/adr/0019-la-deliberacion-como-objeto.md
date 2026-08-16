# ADR 0019 · La deliberación es un objeto, y resolverla tiene dos condiciones

- **Fecha:** 2026-08-16
- **Estado:** aceptada
- **Parte 3 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)

## Contexto

Después de P1 y P2 los agentes deciden (con predicción, con evidencia) dentro de
una correa (con niveles, con sobres). El cliente ve el **resultado**: una tarjeta
en el feed que dice "quiero enviarle a 340 personas".

Un resultado sin proceso es un oráculo. Se cree o no se cree, y no hay nada que
hacer al respecto. Los dos modos de falla que produce son igual de malos:

- El cliente **desconfía** y aprueba nada, o
- el cliente **confía** y aprueba todo sin leer — y ahí "el humano decide" se
  volvió teatro.

Lo que faltaba no era más información en la tarjeta. Era mostrar que hubo una
discusión, con posiciones distintas, y dejar entrar al cliente en ella.

## Alternativas consideradas

**A · Un campo de texto "razonamiento" más largo en cada tarjeta.** Es lo barato.
Descartada: un párrafo escrito por el mismo agente que decidió no es una
deliberación, es una justificación mejor redactada. Y no hay dónde meter la mano.

**B · Un chat con el agente.** Descartada por dos razones. La primera es de
producto: un chat convierte una organización en un asistente, y el cliente pasa
de titiritero a usuario que pregunta. La segunda es operativa: un chat abierto no
tiene estado, así que no se puede saber si la conversación cambió algo.

**C · La deliberación como objeto con turnos, desacuerdo explícito y estado.**
Elegida.

## Decisión

```sql
deliberations       (question, status, recommendation, confidence,
                     what_would_change_my_mind, dissent, reopened_count)
deliberation_turns  (speaker, speaker_type, body, stance, human_input_id)
```

`stance` es un enum cerrado —`propose`, `support`, `object`, `question`,
`concede`, `decide`— y no texto libre, porque es lo que permite renderizar el
hilo como diálogo atribuido y contar cuántas veces un agente objetó y tuvo razón.

### Las dos condiciones para resolver

Viven en la base, no en la capa de render. Un `if` en el componente se puede
saltar; un `check` constraint y una función no.

**1. `what_would_change_my_mind` es obligatorio**, mínimo 20 caracteres:

```sql
constraint deliberations_resuelta_exige_cambio_de_opinion check (
  status <> 'resolved'
  or (recommendation is not null
      and length(btrim(what_would_change_my_mind)) >= 20))
```

Los 20 caracteres no son un número mágico: son el umbral debajo del cual sale
"más datos", y "más datos" no le sirve a nadie para saber qué aportar. El prompt
del diagnóstico trae ejemplos de lo que cuenta y de lo que no.

**2. Si el humano habló, la recomendación tiene que citarlo.** Esto no se puede
expresar como `check` porque depende de otra tabla, así que vive en
`holaamigo.resolver_deliberacion()`, que es el único camino para resolver:

```
la recomendación no cita lo que escribió el humano (<id>). Si su aporte no
cambió nada, decilo en la evidencia con esa nota.
```

El mensaje de error es la mitad de la decisión. **No exigimos que el cliente
tenga razón** — exigimos que la respuesta diga qué se hizo con lo que dijo. Una
recomendación que ignora al cliente y llega a la misma conclusión es peor que no
haber preguntado, porque parece que escuchó.

### Interponerse reabre, no comenta

`holaamigo.interponer()` hace tres cosas en una transacción: guarda un
`human_input` con peso **2.0** (pesa más que la evidencia del sistema en la
próxima corrida, P1), lo agrega como turno visible, y **devuelve la deliberación
a `open` aunque estuviera resuelta**, contando la reapertura.

La recomendación anterior no se borra. Queda en el hilo como lo que el agente
pensaba antes de escuchar: borrarla haría que la próxima pareciera la primera, y
el cliente no podría ver que lo movió.

### El límite de siete

`holaamigo.priorizar_feed()` devuelve las tarjetas ordenadas, con un motivo por
cada una y una marca de mostrado/postergado. El límite es **cognitivo, no
técnico**: una cola de veinte no se prioriza, se abandona.

El puntaje es determinista y explicable en una frase:

```
severidad   alta 300 · normal 200 · baja 100
vencimiento <6 h +150 · <24 h +75      (lo que se va a decidir solo)
decidir     requires='approval' +50
antigüedad  +2/hora, tope 50           (lo viejo sube despacio, no se olvida)
```

"El feed muestra 7" sin decir por qué esas siete es una caja negra que el
cliente no puede discutir, y este producto se trata de que pueda discutirlas.

### "Ajustar" nunca abre una caja de texto

Es la regla de UX que más se nota. Cuando el cliente quiere aprobar *pero no
así*, la respuesta correcta no es pedirle un párrafo que después alguien tiene
que interpretar: son los dos o tres números reales de la propuesta, movibles.

El mecanismo es declarativo. La propuesta trae en su payload qué se puede
ajustar (`ajustes_disponibles`: sliders sobre números reales, checkboxes sobre
ítems reales), la pantalla lo pinta y `lib/feed/adjust.ts` lo aplica antes de
ejecutar. Un tipo de ajuste que el componente no sabe pintar **no se pinta**: no
hay caso `default` que caiga a texto libre.

El tipo en la ruta de API lo garantiza:
`z.record(z.string(), z.union([z.number(), z.array(z.string())]))`. Sin texto en
el tipo, "Ajustar" no puede convertirse con el tiempo en otra caja de texto con
otro nombre.

### El Capítulo: el modelo narra, el código cuenta

Las cifras se calculan antes de llamar al modelo y se le pasan como lista
cerrada. Si el texto devuelto trae un número que no está en esa lista, **se
descarta el texto** y se publica la versión determinista. No se reintenta: la
versión determinista ya dice lo mismo sin riesgo.

Un número inventado en el capítulo es peor que un capítulo sin números: el
cliente no tiene cómo saber cuál de los dos es cierto, y deja de creerle a los
dos.

## Consecuencias

- `DiagnosisSchema` gana `what_would_change_my_mind`, con ejemplos en el prompt
  de lo que cuenta y lo que no. En modo degradado hay una frase de respaldo que
  admite que el diagnóstico salió corto en vez de fingir una condición precisa.
- Cada diagnóstico abre una deliberación real: las notas de ruta que el modelo
  ya producía se atribuyen al agente de su dominio (WhatsApp y correo son
  ejecución → SALES; marca y contenido → CMO) y el rationale del President es el
  turno que decide. **No se inventan turnos**: se atribuyen los argumentos que ya
  existían.
- Si el modelo devuelve una frase corta, la deliberación **se queda abierta** en
  vez de resolverse con relleno. Es el resultado correcto y se ve así en La Sala.
- La cola optimista del feed: la tarjeta desaparece al instante y vuelve si el
  servidor falla. Un rebote visible es mejor que una espera muda.
- `/api/health` (`db:v6`) intenta resolver una deliberación con una frase de
  cinco letras y exige que la función responda con error de dominio.

## Lo que este ADR prohíbe

Renderizar una recomendación sin `what_would_change_my_mind`, y resolver una
deliberación con un `update` directo. El único camino es
`holaamigo.resolver_deliberacion()`, porque es donde vive la regla que no cabe
en un `check`.
