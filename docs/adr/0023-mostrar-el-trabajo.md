# ADR 0023 · La inteligencia se demuestra mostrando el trabajo

**Fecha:** 2026-08-17
**Estado:** aceptado
**Contexto:** flujo inicial (landing → quiz → diagnóstico) y su medición

---

## El problema

El flujo inicial es donde el cliente decide, en menos de seis minutos, si esto
es un sistema que piensa o un formulario con IA de adorno. Estábamos tirando
casi toda la evidencia de que sí piensa:

- `research_runs.progress_log` guarda hasta 40 pasos reales con su timestamp.
  El ticker renderizaba **uno**.
- La pantalla de ensamblaje —la más larga del flujo, hasta 45 s esperando al
  research más la llamada al modelo— rotaba cinco frases con un
  `setInterval(4200)` sin ninguna relación con lo que el servidor estaba
  haciendo. Justo debajo de un ticker que sí decía la verdad.
- Las cuatro fugas, que son el corazón emocional del diagnóstico, se leían como
  cuatro renglones de texto sin proporción entre sí.
- `computeInverseMath` produce un embudo canónico y se renderizaba como `<ol>`.

Y al mismo tiempo no había forma de saber si algo de eso funcionaba:
`plg_events` nunca se agregaba en ninguna parte. `hasEvent()` y `eventsFor()`
estaban escritas y sin usar.

## Las alternativas

### A · Más modelo

Un comentario del CMO después de cada respuesta del quiz, texto generado en
vivo mientras el cliente avanza.

**Costo:** una llamada por pregunta sobre una meta de USD 1,20 por diagnóstico
(§11), y latencia de modelo en el único momento del producto donde el cliente
está mirando la pantalla sin hacer nada. Si el texto toca una cifra, viola el
ADR 0007.

**Por qué se descartó:** el quiz no aguanta esperar tokens entre pregunta y
pregunta, y la inteligencia percibida que se compra con texto generado es la
más barata que existe — cualquiera la copia en una tarde. La que no se copia
es la que viene de tener el dato.

### B · Mostrar el trabajo que ya hacemos · **elegida**

Cero IA adicional. Todo el material ya estaba persistido:

| Ya existía | Ahora se ve |
|---|---|
| `progress_log` con timestamps | Línea de tiempo con los tiempos reales de cada paso |
| `Leak[]` de `computeLeaks` | Cascada de fugas con proporción |
| `InverseMath` de `computeInverseMath` | Embudo de la cuenta al revés |
| `dormant_db × ticket_band` | La primera cifra, en la pregunta 5 del quiz |
| `plg_events` desde 0001 | `/admin/embudo` |
| `props.changed` de `assumption_edited` | Qué supuestos discute la gente |

**Costo:** código y superficie de UI. **Riesgo:** si el research falla hay menos
que mostrar, así que los estados vacíos honestos son obligatorios, no
opcionales.

### C · Solo cosmética

Animaciones, microinteracciones, mejor copy.

**Por qué se descartó:** el problema no es que se vea feo. Es que el trabajo es
invisible y que no había ninguna medición para saber si lo que hacíamos servía.

## La decisión

**Se muestra el trabajo, no se genera más texto.** Tres consecuencias que hay
que respetar de acá en adelante:

### 1 · Nada en pantalla finge progreso que no está pasando

La pantalla de ensamblaje ahora tiene exactamente dos cosas vivas y las dos son
reales: el estado del research y el cronómetro. Los cinco pasos siguen listados
—el cliente merece saber qué está corriendo— pero en presente y sin marcadores
de progreso por paso. Decir "qué hace el President" es honesto; fingir saber en
cuál va, no.

Si mañana `/api/diagnostic/generate` expone progreso real, los marcadores
vuelven. Hasta entonces, no.

### 2 · El adelanto del quiz sale de `computeLeaks`, no de una fórmula copiada

`lib/quiz/preview.ts` llama a la misma función que produce el diagnóstico. Si
cambia el 4% de reactivación, cambia en los dos lados. **Un adelanto que no
coincide con el número final es peor que no dar adelanto**, y solo se muestra la
fuga de base dormida porque es la única cuyo monto depende exclusivamente de lo
ya respondido — las otras tres necesitan la industria, que la trae el research y
puede no haber llegado.

Si respondió "No sé" a `dormant_db`, no hay adelanto. El punto medio de 800
sirve para que el diagnóstico no se quede sin cifra; presentárselo como "tu base
vale X" a quien acaba de decir que no sabe es inventarle un dato.

### 3 · La agregación del embudo vive en SQL, no en el render

Tres funciones en `holaamigo` (`0012_flujo_inicial.sql`), no consultas armadas
dentro del Server Component:

- **Se puede probar.** `scripts/test-flujo-inicial.mjs` las corre contra
  Postgres real con datos sembrados a mano. Una agregación escrita en el render
  de una página no se prueba nunca.
- **La página queda tonta.** Una vista que solo pinta lo que la base devuelve no
  se puede desincronizar de la definición del embudo.
- **Son ventanas y percentiles.** Traer las filas a Node para contarlas en
  JavaScript es mover datos para hacer aritmética que Postgres ya sabe hacer.

La excepción documentada es `duracionDelQuiz()`: dos restas y una mediana sobre
las sesiones completadas de la ventana no justifican una cuarta función.

## Lo que esto NO cambia

**Sigue sin haber cliente de Supabase en el navegador** (ADR 0003) y **sigue sin
haber cifras salidas de un modelo** (ADR 0007). Los gráficos nuevos consumen
exactamente los mismos objetos que ya producía `lib/diagnostic/math.ts`; ninguno
introduce un número que no existiera antes.

**Sigue sin haber librería de gráficos.** La cascada es HTML y CSS porque los
nombres de las fugas son frases largas en español que en SVG habría que truncar;
el embudo es SVG porque la silueta que se cierra es la información. Meter
recharts para eso serían 40 KB en el bundle del cliente para dibujar seis
rectángulos y tres polígonos.

**`/admin/embudo` no tiene series temporales.** Se respeta el criterio de
wiki/14 al pie: *una métrica que no cambia una decisión es ruido*. Cada bloque
lleva escrita encima la decisión que cambia — qué pantalla arreglar, qué
pregunta reescribir, qué default de `config/assumptions.ts` mover. Si un bloque
no puede escribir su frase, no va.

## Lo que sigue sin poder medirse, y está dicho en pantalla

No existe evento de visita a la landing, así que **la conversión visitante →
submit que la propia landing declara en §4.1 (≥35%) no se puede calcular**. El
embudo arranca en `landing_submit` y la pantalla lo dice.

Se evaluó agregar un `POST /api/track` público con lista blanca de eventos. Se
descartó por ahora: es una superficie de escritura pública nueva sobre
`plg_events` a cambio de una métrica, y §13.3 pide no automatizar lo que no se
ha hecho tres veces a mano. Dibujar una primera barra al 100% que parezca que sí
medimos habría sido peor que la ausencia.

## Consecuencias

- Capacidad nueva de análisis del flujo inicial = función en `holaamigo` con su
  caso en `scripts/test-flujo-inicial.mjs`, en el mismo PR.
- `assumption_edited` ahora lleva `from` y `to`. Los eventos anteriores a la
  3.6.0 no los tienen y quedan fuera de `supuestos_discutidos()` — se cuenta lo
  que se puede sostener, no lo que se puede estimar.
- Cualquier pantalla nueva del flujo inicial que muestre un estado tiene que
  poder demostrarlo. Si el dato no existe, se dice que no existe.

## Referencias

- [ADR 0007 · Números deterministas](0007-numeros-deterministas.md)
- [ADR 0002 · SSE en vez de Realtime](0002-sse-en-vez-de-realtime.md)
- [wiki/06 · Diagnóstico y matemática](../wiki/06-diagnostico-y-matematica.md)
- [wiki/21 · El flujo inicial y su embudo](../wiki/21-flujo-inicial-y-embudo.md)
