# 21 · El flujo inicial y su embudo

Cómo se siente el flujo de landing a diagnóstico, por qué se siente así, y
cómo se mira desde adentro.

La tesis está en [ADR 0023](../adr/0023-mostrar-el-trabajo.md) y cabe en una
frase:

> **La inteligencia se demuestra mostrando el trabajo, no generando más texto.**

---

## Los cuatro momentos

```
LANDING → submit
   ↓
QUIZ  ── arriba: la línea de tiempo del research, con tiempos reales
   ↓
   pregunta 5 (dormant_db) → LA PRIMERA CIFRA, y se queda en pantalla
   ↓
ENSAMBLAJE ── cronómetro real + estado real del research
   ↓
DIAGNÓSTICO ── la cascada de fugas · el embudo de la cuenta al revés
```

---

## 1 · La línea de tiempo del research

`components/research-ticker.tsx`.

`progress_log` guarda hasta 40 entradas de `{t, step, detail}` y esto mostraba
solo la última. Una línea que cambia cada tanto se lee como un spinner con
texto: no prueba nada. La lista con los tiempos reales sí — se ve que abrimos la
home, que después fuimos a precios, y cuánto tardó cada cosa.

Se muestran **las últimas cuatro**. Vive encima de la pregunta del quiz: si
crece más, empuja la pregunta fuera de la pantalla en un teléfono, y el quiz
pierde más de lo que el ticker gana.

Los pasos viejos se apagan al 45% en vez de desaparecer. Un paso que llega tiene
que **verse llegar**; si la lista solo se reemplaza, parece estática.

El transporte no cambió: SSE con fallback a polling ([ADR 0002](../adr/0002-sse-en-vez-de-realtime.md)).

---

## 2 · La primera cifra, en la pregunta 5

`lib/quiz/preview.ts` · se devuelve desde `/api/quiz/answer`.

En `dormant_db` el sistema ya tiene todo para calcular la primera fuga. Antes
esperaba hasta el diagnóstico. Ese silencio era la parte del flujo que se sentía
tonta: el cliente le acaba de dar al formulario el dato que más plata mueve y el
formulario responde pasando a la pregunta 6.

Ahora aparece la cifra, con su fórmula, y **se queda el resto del quiz**.
Aparecer y desaparecer la convertiría en una notificación; quedarse la convierte
en un marcador — el cliente responde las seis preguntas que faltan con su propio
número mirándolo.

### Las tres reglas que impiden que sea un truco

1. **Sale de `computeLeaks`**, no de una fórmula copiada. Si cambia el 4% de
   reactivación en `config/assumptions.ts`, cambia acá también.
2. **Solo la fuga de base dormida.** Es la única cuyo monto depende
   exclusivamente de lo respondido: `dormant_db × ticket_band`. Las otras tres
   necesitan `leads_per_month`, que se deriva de la facturación y de la tasa de
   cierre de la industria — y la industria la trae el research, que a esta
   altura puede no haber terminado. Adelantar un número que después se mueve es
   lo que destruye la confianza.
3. **Si respondió "No sé", no hay adelanto.** El punto medio de 800 contactos
   existe para que el diagnóstico no se quede sin cifra, no para decirle "tu
   base vale X" a alguien que acaba de decir que no sabe cuánta tiene.

### Dónde se calcula y por qué

En el servidor. `/api/quiz/answer` lo devuelve **solo en la respuesta que lo
desbloquea** (`ticket_band` o `dormant_db`) y emite `quiz_preview_shown`.
`/api/quiz/next` también lo devuelve —para que sobreviva a un refresco— pero
**sin evento**: contarlo ahí infla la métrica con recargas.

---

## 3 · La pantalla de ensamblaje ya no miente

`components/quiz-flow.tsx` · `Assembling`.

Antes rotaba cinco frases con `setInterval(4200)`. Los puntos marchaban solos,
sin relación con el servidor. Era la pantalla **más larga** del flujo
—`/api/diagnostic/generate` espera hasta 45 s al research y después llama al
modelo— y la única que mentía, justo debajo de un ticker que dice la verdad.

Ahora hay dos cosas vivas y las dos son reales:

| Elemento | De dónde sale |
|---|---|
| "Esperando el análisis" / "Análisis listo. Razonando" | `onFinished` del ticker |
| El cronómetro en segundos | `setInterval` local, y es de verdad el tiempo transcurrido |

Los cinco pasos siguen listados, en presente y sin marcador por paso: se dice
**qué está corriendo**, no se finge saber en cuál va. Pasados los 90 segundos el
mensaje de abajo cambia y reconoce que se está demorando.

> `onFinished` va envuelto en `useCallback`. El efecto del ticker lo tiene en sus
> dependencias, y una identidad nueva en cada render reabriría el `EventSource`
> en bucle.

---

## 4 · Los dos gráficos del diagnóstico

Los dos viven dentro de `MoneyPanel`, así que **se mueven con los controles**:
`computeLeaks` y `computeInverseMath` ya se recalculan en el navegador con cada
arrastre, y los gráficos son función de ese resultado.

### La cascada de fugas · `components/charts/leak-waterfall.tsx`

```
Techo alcanzable          ████████████████████████████  USD 47.000
Los que se abandonan…                        ██████     USD  8.400
Lo que entra de noche…                  ████            USD  5.880
El canal desatendido…                  ██               USD  2.520
La base dormida                       █                 USD  2.200
Lo que entra hoy          ████████████                  USD 28.000
```

Cada barra arranca donde termina la anterior — de ahí la escalera. La lectura es
una sola: arriba lo que entraría sin fugas, en naranja lo que se cae, en verde lo
que queda.

**Es HTML y CSS, no SVG.** Los nombres de las fugas son frases largas en español
("Los que se abandonan antes del quinto toque"): en SVG habría que truncarlas, y
truncar el nombre de la fuga más grande es perder el renglón que mueve la venta.

No tiene hooks a propósito: se usa dentro de `MoneyPanel` (cliente) **y** dentro
de la ficha 360 del admin (Server Component).

### El embudo de la cuenta al revés · `components/charts/inverse-funnel.tsx`

Tres bandas: contactos → reuniones → clientes, con la conversión de cada caída
escrita al lado.

**El embudo va al derecho aunque la cuenta vaya al revés.** El cálculo parte de
la meta y sube; el dibujo baja. Es el mismo número por los dos lados, y de
arriba hacia abajo es como se lee un embudo. La derivación con sus fórmulas
sigue debajo, sin cambios: quien quiera auditar el número lo audita ahí (§13.4).

**El ancho es lineal y la última banda es una astilla.** Con 5.600 → 280 → 70,
la banda de abajo mide 7 px de 300. Se podría comprimir en escala logarítmica
para que las tres se vean parecidas, y sería mentir con la geometría: el 1,25%
que sobrevive es exactamente el punto. Detrás de cada banda va un riel del ancho
completo — sin él, las dos de abajo se leen como un error de renderizado; con él
se leen como la fracción que son.

Debajo, el número accionable destacado: **contactos por semana**.

---

## El otro lado · `/admin/embudo`

Tres bloques, cada uno con su decisión escrita encima. El criterio de
[wiki/14](./14-observabilidad.md) se respeta al pie: *una métrica que no cambia
una decisión es ruido*. Por eso no hay series temporales ni conteos por día.

| Bloque | Pregunta | Decisión que cambia |
|---|---|---|
| Dónde se cae la gente | ¿Qué etapa pierde más? | Qué pantalla arreglar |
| En qué pregunta se cae | ¿Cuál es la última respuesta de los que abandonan? | Qué pregunta reescribir |
| Qué números no se creen | ¿Qué supuesto editan y hacia dónde? | Qué default de `config/assumptions.ts` mover |

Más tres cifras arriba: cuántos entraron, **cuánto dura de verdad el quiz contra
los 6 minutos que promete la landing**, y cuántos abandonaron adentro.

### Las tres funciones

`supabase/migrations/0012_flujo_inicial.sql`. La agregación va en SQL y no en el
render por tres razones, todas en el ADR: se puede probar, deja la página tonta,
y son ventanas y percentiles que Postgres ya sabe hacer.

**`embudo_inicial(p_desde)`** — cuenta **organizaciones**, no sesiones. La
pregunta del embudo es "de los negocios que entraron, cuántos llegaron acá", y
un negocio que hizo el quiz dos veces es un negocio. Además `leads_uploaded` se
registra sin `session_id`, así que un embudo por sesión perdería la última
etapa o tendría que inventarse una atribución.

La ventana se ancla al **primer** `landing_submit` de cada organización. Si
alguien entró hace 40 días y volvió ayer, su cohorte es la de hace 40 días. Un
embudo que reasigna cohortes cuando alguien vuelve no se puede comparar consigo
mismo.

**`caida_por_pregunta(p_desde)`** — `abandonos` es el número que decide: sesiones
cuya **última** respuesta fue esa y que nunca completaron. El conteo de sesiones
dice cuántos llegaron; el de abandonos dice dónde se rompió. La mediana de
segundos es el hueco contra la respuesta anterior — mediana y no promedio,
porque una pestaña abierta toda la noche arrastra cualquier promedio.

**`supuestos_discutidos(p_desde)`** — un supuesto que **suben** siempre es uno
donde somos demasiado conservadores; uno que **bajan** siempre es uno donde no
nos creen. Las dos lecturas piden lo contrario del default.

> Solo cuenta ediciones con `from` y `to` numéricos. Las anteriores a la 3.6.0
> guardaban el objeto completo de supuestos sin el valor previo, así que su
> dirección es irrecuperable — y una dirección inventada es peor que una fila de
> menos.

### En la ficha 360

`/admin/prospects/[orgId]` ganó cuatro cosas:

- **Los dos gráficos que él está viendo**, con los supuestos vigentes. Cuando
  alguien llama a un prospecto ATTACK, la primera frase útil es su cifra más
  grande; leerla de una tabla de JSON antes de marcar no es viable.
- **Fit e intent sobre una barra de 100**, con los umbrales 45 y 70 dibujados.
  Eran el texto `"32 / 25"` — dos números con techos distintos (60 y 40) leídos
  como fracción. La pregunta que importa es *¿le falta negocio o le falta
  ganas?*, y esa respuesta cambia qué se hace: fit bajo se descarta, intent bajo
  se trabaja.
- **Qué números no se creyó**, con dirección. Es el mejor gancho para la llamada.
- **De dónde llegó**: `utm` y `referrer` se venían seleccionando y no se
  renderizaban nunca.

---

## Lo que todavía no se puede medir

**La conversión visitante → submit.** No existe evento de visita a la landing,
así que la métrica que la propia landing declara en §4.1 (≥35%) no se puede
calcular. El embudo arranca en `landing_submit` y la pantalla lo dice.

Se evaluó un `POST /api/track` público con lista blanca. Se descartó por ahora:
es una superficie de escritura pública nueva sobre `plg_events` a cambio de una
métrica, y §13.3 pide no automatizar lo que no se ha hecho tres veces a mano.
Dibujar una primera barra al 100% que pareciera que sí medimos habría sido peor
que la ausencia.

---

## Cómo depurar

1. `/admin/embudo` — ¿en qué etapa se cae la cohorte?
2. Si es dentro del quiz, el segundo bloque dice en qué pregunta exacta.
3. `/admin/prospects/[orgId]` — la ficha de uno que se cayó ahí: timeline,
   respuestas, corridas con costo.
4. En la base:
   ```sql
   select progress_log from holaamigo.research_runs where session_id = '…';
   select * from holaamigo.caida_por_pregunta(now() - interval '7 days');
   ```
5. `node scripts/test-flujo-inicial.mjs` — 18 chequeos de las tres funciones
   contra Postgres real.
