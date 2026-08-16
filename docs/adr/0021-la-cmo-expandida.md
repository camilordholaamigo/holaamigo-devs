# ADR 0021 · La CMO detecta restricciones, no vende

- **Fecha:** 2026-08-16
- **Estado:** aceptada
- **Parte 5 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)

## Contexto

Agentificar una CMO tiene una versión obvia y una que sirve. La obvia es
conectar canales y publicar más. La que sirve es hacer **lo que hoy nadie hace
porque no da el tiempo**:

- vigilar a los competidores todas las semanas y notar el cambio que importa,
- darse cuenta de que el copy que está saliendo ya no dice lo que la marca dice
  ser,
- escribir el caso de estudio del cliente que acaba de ganar, mientras todavía
  está contento,
- retirar un ángulo que se quemó antes de gastar tres semanas más en él.

Ninguna de esas cuatro es difícil. Las cuatro son trabajo constante de bajo
volumen y alto valor, que es exactamente lo primero que se cae cuando alguien
tiene que elegir en qué gastar su martes.

Y hay una quinta cosa, que es la delicada: la CMO ve la cuenta del cliente desde
adentro y **sabe qué servicio nuestro le vendría bien**.

## Alternativas consideradas

**A · Que la CMO le proponga servicios al cliente directamente.** Es lo eficiente
y es lo que destruye el producto. El día que el cliente sospecha que el agente
que le recomienda cosas también nos está vendiendo, deja de creerle a todo lo
demás — incluida la recomendación de ruta, el ángulo y el P&G. La confianza es
lo único que no se reconstruye con una migración.

**B · No detectar nada y esperar a que el cliente pida.** Descartada por lo
contrario: la CMO ve restricciones reales (responden y no cierran; la base es
más grande que la capacidad) y callarlas es dejar valor en la mesa por
timidez.

**C · Detectar siempre, ofrecer nunca sin filtro humano nuestro.** Elegida.

## Decisión

### La escalera de las señales de upsell

```
detected → proposed_internal → proposed_client → won | lost
```

El salto a `proposed_client` exige `internal_approved_by`, y es un `check`:

```sql
constraint upsell_al_cliente_exige_visto_bueno check (
  status not in ('proposed_client','won','lost') or internal_approved_by is not null)
```

**Toda señal aparece primero en NUESTRO admin** (`/admin/senales`). Un humano
mira la cuenta y decide si eso se ofrece. No es prudencia excesiva: es la
diferencia entre una herramienta que trabaja para el cliente y un vendedor
disfrazado de herramienta.

En la consola del cliente, las señales aprobadas aparecen **al final, sin
énfasis y con la evidencia visible**, diciendo explícitamente que alguien de
nuestro equipo las revisó antes de mostrárselas.

Cada señal se sostiene con dos números y su referencia. Si no se puede sostener
con datos, no es una señal — no hay camino para que el modelo "intuya" que este
cliente necesita marca.

Un índice único parcial impide que la misma restricción se apile mientras siga
viva. Sin eso el admin se vuelve ilegible en un mes y la disciplina se rompe
sola: nadie revisa una lista de doscientas señales repetidas.

### El posicionamiento es medible, no un PDF

Se versiona (no se edita) y trae **dos listas**: lo que la marca dice y lo que
la marca **nunca** dice. La segunda es la mitad útil: un posicionamiento que solo
enumera virtudes no sirve para detectar deriva, porque todo copy las cumple de
alguna forma.

`holaamigo.deriva_de_copy()` compara el copy que está saliendo contra el
documento vigente, y **compara distinto según el lado**:

| | Cómo se compara | Por qué |
|---|---|---|
| Claims prohibidos | literal | son frases que prometimos no decir; una prohibición difusa no es una prohibición |
| Diferenciadores | por raíz de palabra | el copy conjuga: el documento dice "responde en 60 segundos" y el correo dice "te respondemos en 60 segundos" |

Lo encontró la prueba en la primera corrida: con comparación literal, una pieza
perfectamente alineada marcaba deriva, y **a la tercera falsa alarma nadie
vuelve a mirar la alerta**. El "stemmer" son los primeros 5 caracteres de cada
palabra de 4 o más; es crudo, tiene falsos positivos entre palabras de raíz
común, y para medir si una pieza habla de lo que la marca dice ser, alcanza.

### La inteligencia competitiva alerta solo lo que cambió

Snapshot por competidor y sección, con hash. Si no cambió, no hay diff ni
llamada al modelo — el 90% de las semanas no cambia nada, y ahí está el ahorro.

**La primera captura no alerta.** Alertar la línea base llenaría el feed de
"cambió todo" el día que se agrega un competidor, que es justo cuando el cliente
no quiere ruido.

El texto se normaliza antes de hashear (espacios colapsados, minúsculas): sin
eso, un rediseño que solo mueve saltos de línea dispara "cambió el precio".

Las **ofertas de empleo** son la señal más subestimada del set: una empresa que
abre tres vacantes de vendedores enterprise está diciendo hacia dónde va, y lo
dice seis meses antes de que se vea en su sitio.

### La fábrica de ángulos necesitaba una columna que no existía

`angles.sent` y `angles.replied` estaban en el esquema desde `0001` y **nunca se
escribieron**, porque ningún mensaje guardaba de qué ángulo salía. Una fábrica de
ángulos que no puede medir un ángulo no es una fábrica.

`messages.angle_id` cierra el hueco, y se estampa **solo si la campaña prueba
exactamente un ángulo**. Con dos, la atribución sería una repartija inventada, y
una tasa de respuesta repartida a ojo es peor que ninguna: la fábrica retiraría
el ángulo que funciona por culpa del que no. Mejor una campaña sin atribución
—que se ve como un hueco— que una con atribución falsa, que se ve como un dato.

La saturación se mide en SQL comparando dos ventanas de 14 días, con muestra
mínima de 30 por ventana. Con 12 envíos, una respuesta de más o de menos mueve
la tasa 8 puntos, y ese ruido dispararía una propuesta de ángulo nuevo todas las
semanas.

Cuando el modelo no puede escribir el reemplazo, **no se propone nada**. Un
ángulo genérico se aprueba, se envía y quema el segmento de verdad; que el
cliente vea que nadie le propuso un reemplazo es un fallo visible y barato.

### La prueba social tiene dos candados

1. **Los números salen del CRM.** El borrador lleva el nombre de una empresa real
   y se le va a pedir permiso a una persona real: una cifra inflada no es un
   texto flojo, es un problema.
2. **Nada se publica sin que el cliente final apruebe**, y es un `check`. Publicar
   los números de alguien que no dijo que sí no es marketing agresivo, es un
   problema legal.

Un índice único sobre `revenue_event_id` impide que el job diario redetecte el
mismo deal y mande el mismo borrador siete noches seguidas.

El umbral de "deal grande" es **relativo** (el doble del ticket promedio, con
piso): USD 24.000 es enorme para un negocio de tickets de 800 y rutina para uno
de 20.000.

### El media play se dispara a mano, a propósito

La detección del activo de data es automática y el brief también. Quién decide
que este cliente vale un media play es un humano nuestro (§13.3): hoy solo
sabríamos automatizar nuestra corazonada. Cuando lo hayamos hecho tres veces,
sabremos qué automatizar.

Y el brief es el brief: `content.publish` tiene techo de plataforma **L2** y no
hay plan que lo suba. Lo que sale a nombre de la marca de alguien no se
despublica de verdad.

## Consecuencias

- `/api/cron/cmo` corre diario (casos de estudio y saturación de ángulos) con
  rama semanal los lunes (competencia y señales). Un solo cron y no dos: la
  mitad diaria y la semanal comparten el recorrido de organizaciones y los
  mismos errores de red.
- La consola gana **Marca**; el admin gana **Señales**. Que estén en pantallas
  distintas es la decisión de este ADR hecha interfaz.
- Proponer un ángulo pasa por `authorize('angle.propose')` aunque sea de las
  capacidades más inocuas del catálogo. **La primera acción que se salta el
  motor es la que enseña que el motor es opcional.**
- `/api/health` (`db:v8`) verifica las tablas y la función de comparación por
  raíz.

## Lo que este ADR prohíbe

Que una señal de upsell llegue al cliente sin pasar por `/admin/senales`. Y
publicar un caso de estudio sin la aprobación del cliente final — las dos cosas
están protegidas por la base, no por la disciplina de quien escriba el próximo
llamador.
