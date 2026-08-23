# 24 · Pruebas e informes

[wiki/23](./23-smoke-tester.md) cuenta cómo funciona **una conversación**. Esto
cuenta cómo se corren muchas a la vez y cómo eso se convierte en algo que se puede
mandar.

Son las dos mitades del mismo motor:

```
QA       · ¿a cuál de mis clientes se le rompió la IA esta semana?
GROWTH   · mandale a este prospecto lo que pasó cuando le escribimos
```

La tesis está en [ADR 0026](../adr/0026-el-lote-y-el-informe.md), y
[ADR 0027](../adr/0027-la-prueba-a-medida-y-las-lineas.md) generalizó el objeto.

## Una prueba es un producto cartesiano

En el código se llama `lote` y en la base `smoke_batches`; **en pantalla se llama
la prueba**, y es lo único que crea conversaciones a mano:

```
números × líneas × guiones = conversaciones
```

| Números | Líneas | Qué es |
|---|---|---|
| 1 | 1 | una conversación suelta |
| 1 | 3 | tres clientes distintos escribiéndole al mismo negocio a la vez |
| 30 | 1 | el barrido de prospección |
| 30 | 3 | lo mismo, tres veces más rápido |

Hasta ADR 0026 esto se llamaba «tanda» y solo modelaba la tercera fila. El nombre
describía el diseño y no el uso, y por eso nadie sabía qué hacía el botón. **La
palabra no se usa más.**

Con una sola conversación la pantalla siguiente es la transcripción, no el grupo:
una herramienta que no deja ver lo que acaba de hacer no se vuelve a usar.

---

## El recorrido

```
/admin/pruebas/nueva
   ├── a quién: un número a mano, varios pegados, u organizaciones de la lista
   ├── qué se dice: un guion a medida, o los moldes compilados del research
   ├── desde qué líneas nuestras: una o varias
   └── los dos frenos: cuántas a la vez, cada cuánto
   ↓
crearLote()
   ├── authorize() por organización (las que tengan una)
   ├── compila un plan por (objetivo × guion), en paralelo
   ├── lo cruza con las líneas → una conversación por (objetivo × guion × línea)
   ├── omite lo que no se puede, con su motivo
   └── avanzarLote() arranca las primeras
   ↓
… cada prueba que cierra libera un cupo y empuja la siguiente …
   ↓
«Generar los informes»
   ├── salud_de_linea()            las cifras
   ├── hallazgos_por_frecuencia()  qué falla y en cuántas de cuántas
   ├── citas_del_periodo()         las alucinaciones, textuales
   ├── CATALOGO                    qué recomendar
   └── el modelo                   cómo decirlo
   ↓
/informe/[shareToken] · público, imprimible, compartible por WhatsApp
   ↓
se cuentan las aperturas → a quién llamar mañana
```

---

## El lote

`lib/pruebas/lote.ts` · `holaamigo.smoke_batches`

### Los dos frenos, y por qué son la feature

Treinta clientes × tres pruebas = **noventa conversaciones desde una sola línea
de WhatsApp**. Abrirlas juntas es, para el clasificador de Meta, la firma exacta
de un emisor de spam. Lo que se pierde no es la prueba: es el número.

Varias líneas suben ese techo —cada una es un emisor distinto— pero **no lo
eliminan**: el tope sigue siendo del lote entero, no por línea, porque el riesgo
que se está administrando es el de nuestra cuenta.

| Control | Por defecto | Qué hace |
|---|---|---|
| `max_concurrentes` | 4 (techo 12) | Conversaciones vivas a la vez en todo el lote |
| `ritmo_segundos` | 45 | Entre un arranque y el siguiente, aunque haya cupo |

Son **columnas de la tabla**, no constantes: el día que algo huela mal se bajan
en caliente sin desplegar.

Están arriba en el formulario y con su explicación al lado, no escondidos en
«opciones avanzadas». La primera vez que alguien corre treinta clientes tiene
que ver qué está apretando.

### Quién empuja la cola

`avanzarLote()` es idempotente y lo llaman tres cosas:

| Quién | Cuándo | Alcance |
|---|---|---|
| `crearLote()` | al armar la prueba | arranca las primeras |
| El webhook | cada vez que una prueba cierra | libera un cupo y arranca la siguiente |
| La pantalla del lote | cada 5 s mientras esté abierta | **el motor real mientras alguien mira** |
| El cron | 1×/día en Hobby | despierta lo que se trabó entero |

**Es el único lugar del subsistema donde se duerme**, acotado por
`PRESUPUESTO_MS = 200 s`. Y ahí es correcto: no esperamos un evento externo,
espaciamos a propósito nuestros propios envíos. Si se acaba el presupuesto la
función se retira y el siguiente que pase sigue donde quedó.

### Serial por número, paralelo entre números

Dos conversaciones simultáneas contra la misma línea caen en el mismo hilo de
WhatsApp y ninguna mide nada. `siguientePendiente()` salta las líneas que ya
tienen una conversación viva **de cualquier lote**.

### Omitir en vez de fallar

Si una compilación falla, ese par sale de la prueba **con su motivo** y el resto
sigue. Un lote de treinta que muere en el cuarto por un research incompleto no
sirve para nada.

Los motivos se muestran uno por uno:

```
+573001112233 — pidió que no le escribiéramos
+573009998877 — gobierno: blocked
+57300111     — número ilegible
```

Un lote que dice «no se pudo» sin decir qué pasó con cada línea es un lote que
nadie vuelve a usar.

### `proposito` no es una etiqueta

| | `qa` | `prospeccion` |
|---|---|---|
| Quién | Nuestros clientes | Gente que no nos conoce |
| Permiso | Nos contrataron | Los cuatro frenos de ADR 0025 |
| Números | De `smoke_targets` | Publicados en su propio sitio |

Lo que **no** cambia entre los dos: el bloqueo. Si alguien pidió que no le
escribamos, no le escribe ningún lote.

---

## El informe

`lib/pruebas/informe.ts` · `holaamigo.smoke_reports`

### El reparto

| | Qué pone |
|---|---|
| **El código** | Las cifras, los hallazgos con su frecuencia, las citas, y **qué recomendar** |
| **El modelo** | La narrativa, cómo se dice cada recomendación, y el borrador del correo |

`InformeLenguajeSchema` no tiene un solo `z.number()`, y al modelo se le dice
explícitamente que **no repita las cifras**: la pantalla las muestra al lado, y
un texto que dice «el 60% de las veces» debajo de un número que dice 60% es
relleno — y si se equivoca al copiarlo, contradice al número que está tres
centímetros más arriba.

### La frecuencia es todo, y por eso agrupa por `id`

> «Falló en 4 de 5» y «falló en 1 de 5» piden cosas distintas: la primera es un
> problema del guion, la segunda es una conversación mala.

Sin esa distinción el informe es una lista de reclamos. Pero solo funciona con
claves estables, y las salidas del evaluador son de dos naturalezas:

| Qué | Naturaleza | Qué se hace |
|---|---|---|
| Criterios de la rúbrica | `id` estable, nuestro | **se agrupan y se cuentan** en SQL |
| Alucinaciones | Texto libre del modelo | **se listan textuales, sin contar** |

Agruparlas por texto no agruparía nunca. Agruparlas con un modelo perdería la
cita — y la cita es la única parte del informe que el cliente puede verificar
abriendo su propio WhatsApp.

**`paso = null` no cuenta como fallo.** Es «no se pudo verificar». Reprobar a
alguien porque nosotros no pudimos leer su sitio es la forma más rápida de que
el informe pierda credibilidad. Hay una prueba que lo verifica.

### El catálogo de recomendaciones

`CATALOGO` mapea criterio fallido → acción concreta. Vive en el repositorio
porque es el consejo que le damos a un cliente y tiene que ser el mismo todas
las veces.

**La prueba que tiene que pasar cada entrada:** ¿esto lo puede hacer el dueño
esta semana? «Poner el precio en la página» sí. «Ajustar el prompt» no — él no
tiene un prompt, y puede que quien contesta su WhatsApp sea su cuñado.

`impactoDe(fallo, de, peso)` es una función pura: dos informes con los mismos
hallazgos ordenan igual.

---

## La página pública

`/informe/[shareToken]` · `app/informe/[shareToken]/page.tsx`

Público por token de 64 caracteres, igual que el diagnóstico y por la misma
razón: el cliente lo reenvía a su socio y ese reenvío es distribución.

### El orden es la decisión

1. **Una frase** con lo que pasó. Si solo lee esto, ya recibió el mensaje.
2. **Las cifras**, grandes. Hechos con hora, no proyecciones.
3. **Qué falló**, con los puntitos de frecuencia — cinco puntos con cuatro
   llenos se entienden sin leer.
4. **Las citas**, textuales. Va **antes** de los consejos: primero la prueba,
   después la opinión.
5. **Qué hacer**, ordenado por impacto.
6. **Las conversaciones**, plegadas. Están porque un informe que afirma sin
   poder mostrar es una opinión con tipografía bonita.

### Las barras de tiempo

Escala **lineal** contra el peor tiempo de la prueba, no logarítmica. Con una
conversación de 2 minutos y otra de 40, la primera queda como una astilla — y
esa astilla **es** la información. Comprimirla para que «se vean bien las dos»
sería mentir con la geometría.

Las que no contestaron llevan la barra completa en rojo: «no contestaron» no es
un tiempo largo, es otra cosa, y una barra corta las haría ver mejor que a las
lentas.

### El titular lo escribe el código

Parece prosa y contiene cifras, así que no lo escribe el modelo (ADR 0007).
Prioriza el peor resultado sobre el promedio: un negocio con dos líneas buenas y
una muerta tiene un problema, y promediarlo lo escondería.

---

## Compartir

Tres botones, y la ausencia de un cuarto:

| | |
|---|---|
| **Enviar por WhatsApp** | `wa.me/?text=…` con el link. Se previsualiza y **se mide**. |
| **Copiar enlace** | Con caída a `window.prompt()` si el navegador niega el portapapeles. |
| **Guardar como PDF** | `window.print()` con el CSS de impresión. Cero dependencias. |
| ~~Adjuntar PDF~~ | **No existe, a propósito.** |

Un PDF adjunto pesa, no se previsualiza, y sobre todo **no se puede medir**.
`smoke_reports.vistas` y `visto_at` no son telemetría: saber que el prospecto
abrió el informe tres veces es la señal de compra más barata que tenemos, y es
lo que decide a quién llamar. Un adjunto es un agujero negro comercial.

---

## El correo

El modelo redacta el borrador; **una persona lo manda** desde `/admin/pruebas`.
Misma disciplina que las señales de upsell (ADR 0021).

Va por **Resend, no por SendGrid**. SendGrid es el motor de las campañas de los
clientes y su reputación está atada a lo que ellos envían; meter nuestro
outbound ahí contamina un dominio que no es nuestro para ensuciar (ADR 0008).

El enlace se saca del cuerpo y va al botón: una URL cruda en medio de un párrafo
es una de las señales que más pesan en los filtros de spam.

El destinatario viene con el correo que la organización dejó en la landing y **es
editable**. No es comodidad: el que llenó el formulario casi nunca es el que
decide.

---

## Cómo se usa · el ciclo de QA semanal

1. `/admin/pruebas` → **Nueva prueba**.
2. En «QA de clientes», **todas** las organizaciones. Una línea nuestra, 4
   concurrentes, 45 s. Treinta números ≈ hora y media.
3. Dejar la pestaña abierta si se puede — es lo que más rápido la empuja.
4. Al terminar: **Generar los informes**.
5. Ordenar por hallazgos y llamar a los tres peores.

Para prospección, lo mismo apuntando a números escritos a mano y revisando el
borrador de correo antes de mandarlo.

### Y el ciclo que antes no existía

**Auditar un bot ajeno en treinta segundos.** `/admin/pruebas/nueva`, el número,
dos líneas de contexto, tres preguntas, «Redactar borrador con IA», y listo. Sin
research, sin organización, sin desplegar. Es lo que convierte esto de una parte
del diagnóstico en un motor de prospección: hay millones de negocios con un bot
contestando su WhatsApp y ninguna certeza de que funcione.

**La misma pregunta a veinte negocios.** Modo guion, tres mensajes, veinte números
pegados. Cero llamadas a modelo, y veinte respuestas comparables palabra por
palabra porque salieron de las mismas palabras.

**¿Aguanta tres clientes a la vez?** Un número, tres de nuestras líneas. La
pantalla de la prueba pone las tres transcripciones lado a lado.

---

## Cómo depurar

1. **La pantalla de la prueba** — el registro de abajo dice qué arrancó, cuándo y
   **desde qué línea**.
2. **¿No avanza?** Casi siempre es que los hilos están ocupados por otra prueba.
   El hilo es el par `(channel_id, target_phone)`, no el teléfono:
   `select channel_id, target_phone, estado from holaamigo.smoke_probes where estado='running'`.
3. **¿Con varias líneas solo arrancó una?** La ocupación se está mirando por
   número y no por par. Corré `node scripts/test-smoke-tester.mjs`: hay un chequeo
   para eso.
4. **¿El informe salió vacío?** `generarInforme` devuelve `null` cuando no hay
   conversaciones. Un informe vacío es peor que ninguno.
5. **¿Sin narrativa ni correo?** Falta `OPENAI_API_KEY`. Las cifras y los
   hallazgos están igual: no dependen del modelo.
5. En la base:
   ```sql
   select * from holaamigo.estado_del_lote('<lote>'::uuid);
   select * from holaamigo.hallazgos_por_frecuencia('<org>'::uuid, now() - interval '30 days');
   select nombre, vistas, visto_at from holaamigo.smoke_reports r
     join holaamigo.organizations o on o.id = r.organization_id
    order by r.created_at desc limit 20;
   ```
6. `node scripts/test-lotes-e-informes.mjs` — 35 chequeos sobre la aritmética.

---

## Lo que todavía no hace

**Una sola línea es el techo.** Con 4 concurrentes y 12 minutos por
conversación, 90 pruebas son ~4,5 horas. Es un trabajo nocturno. La correlación
ya es por número, así que agregar una segunda línea en `smoke_channels` no
necesita cambios de código — falta repartir el lote entre canales.

**No hay comparación entre corridas.** «El cliente X empeoró respecto del mes
pasado» es la pregunta natural de QA y hoy hay que mirar dos informes al lado.
Los datos están; falta la vista.

**No hay recordatorio.** Un informe que nadie abrió en cinco días debería
avisarnos. `visto_at` ya se guarda.
