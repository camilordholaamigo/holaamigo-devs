# ADR 0026 · El lote y el informe

**Fecha:** 2026-08-23
**Estado:** aceptado
**Contexto:** el smoke tester deja de ser una prueba y pasa a ser una herramienta

---

## El problema

[ADR 0025](0025-el-smoke-tester-como-evidencia.md) dejó el motor: le escribimos
a **una** línea y calificamos la conversación. Eso resuelve un prospecto, y no
resuelve ninguna de las dos cosas que el producto tiene que hacer ahora:

**QA.** Tenemos treinta y pico de clientes con agentes en producción. La
pregunta operativa de cada semana es «¿a cuál se le rompió la IA?», y hoy la
respuesta es abrir treinta conversaciones a mano. Nadie lo hace, así que nos
enteramos cuando se queja el cliente.

**Growth.** El diagnóstico ya produce evidencia irrebatible sobre un prospecto
—tardaron 34 minutos, dijeron un precio que no está en su web— y esa evidencia
muere en una pantalla que solo miramos nosotros. No hay forma de mandársela, ni
de saber si la miró.

Y hay un problema de escala que no es obvio hasta que se cuenta: **treinta
clientes por tres pruebas son noventa conversaciones desde una sola línea de
WhatsApp**.

## Las alternativas

### A · Un botón «correr todas»

Iterar la lista y disparar. Dos días de trabajo.

**Por qué se descartó, y no por elegante:** noventa conversaciones abiertas
desde el mismo número en el mismo minuto es, para el clasificador de Meta, la
firma exacta de un emisor de spam. Lo que se pierde cuando eso sale mal no es
la tanda — es el número, y un número quemado no se recupera con un rollback ni
con una apelación. Un lote sin tope de concurrencia no es una feature a medio
hacer: es una forma de perder el activo.

### B · Varias líneas de WhatsApp

Comprar tres o cuatro números y repartir.

Resuelve el techo de verdad y **no es incompatible con nada de lo que se
construyó**: la correlación ya es por número, así que soporta N canales sin
tocar una línea. Se descartó **por ahora** por costo y por orden: primero hay
que saber cuántas conversaciones diarias aguanta una línea antes de comprar la
segunda. La puerta queda abierta.

### C · Un lote con tope, y un informe compartible ✅

Un objeto `lote` que es una cola con `max_concurrentes` y `ritmo_segundos`, y un
objeto `informe` con enlace público que agrega lo que pasó.

## La decisión

**Se elige C.** Dos objetos nuevos, y cuatro decisiones dentro.

### 1 · El tope es la feature, no un ajuste

`max_concurrentes` (1–12, por defecto 4) y `ritmo_segundos` (por defecto 45) son
**columnas de la tabla**, no constantes del código. La razón es operativa: el
día que algo huela mal hay que poder bajarlos en caliente, sin desplegar.

El techo de 12 no es arbitrario. Por encima de eso, una línea empieza a
parecerse a lo que no queremos parecer.

`avanzarLote()` es idempotente y lo empujan tres cosas: la creación del lote, el
cierre de cada prueba, y la pantalla del admin mientras alguien la mira. Es el
mismo patrón de `avanzarCola()` — en serverless nadie puede esperar a que una
cola avance sola.

**Es el único lugar del subsistema donde se duerme**, acotado a 200 s. Y es
correcto porque no estamos esperando un evento externo: estamos espaciando a
propósito nuestros propios envíos.

### 2 · La frecuencia se cuenta sobre claves estables

Ésta es la decisión de análisis, y la que más se puede hacer mal.

La lección del paquete de referencia es que **«un error en 5 de 5 conversaciones
es un problema del prompt; uno en 1 de 5 es ruido del modelo»**. Esa distinción
es todo el valor: sin ella un informe es una lista de reclamos, y una lista de
reclamos no se lee dos veces.

Pero solo funciona sobre claves estables. Y las salidas del evaluador son de dos
naturalezas distintas:

| | Naturaleza | Qué se hace |
|---|---|---|
| Criterios de la rúbrica | `id` estable, definido por nosotros | **Se agrupan y se cuentan** en SQL |
| Alucinaciones, errores, sugerencias | Texto libre de un modelo | **Se listan textuales, sin contar** |

Agrupar las alucinaciones por texto no agruparía nunca —el modelo escribe
distinto cada vez— y agruparlas con un modelo perdería la cita, que es la única
parte del informe que el cliente puede verificar abriendo su propio WhatsApp.
**Una cita resumida deja de ser prueba.**

Corolario que se llevó una decisión de esquema: `hallazgos_por_frecuencia()`
**ignora los criterios con `paso = null`**. Null es «no se pudo verificar», no
«no cumplió». Reprobar a alguien porque nosotros no pudimos leer su sitio es la
forma más rápida de que el informe pierda toda credibilidad — y la prueba que
lo verifica está en `scripts/test-lotes-e-informes.mjs`.

### 3 · Qué recomendar lo decide el código; cómo decirlo, el modelo

`CATALOGO` en `lib/pruebas/informe.ts` mapea cada criterio fallido a una acción
concreta. Vive en el repositorio por la misma razón que el playbook: es el
consejo que le damos a un cliente y tiene que ser **el mismo consejo todas las
veces**, discutible en un pull request.

La prueba que tiene que pasar cada entrada: **¿esto lo puede hacer el dueño esta
semana?** «Poner el precio en la página» sí. «Ajustar el prompt» no — él no
tiene un prompt, y puede que quien contesta su WhatsApp sea su cuñado.

`impactoDe(fallo, de, peso)` es una función pura. Si el impacto lo pusiera el
modelo, el mismo problema saldría «alto» en un cliente y «medio» en otro, y el
orden de la lista —que es lo que decide qué se arregla primero— dejaría de
significar nada.

Y como en todo el subsistema: `InformeLenguajeSchema` **no tiene un solo
`z.number()`**.

### 4 · Un link, no un PDF

El pedido era «que se pueda mandar por WhatsApp». La respuesta obvia —generar un
PDF y adjuntarlo— es la peor de las tres opciones:

- un PDF de dos megas por WhatsApp lo abre menos gente que un link;
- no se previsualiza: llega como un ícono gris con un nombre de archivo;
- y **no se puede medir**.

Ese tercer punto es el que decide. `smoke_reports.vistas` y `visto_at` no son
telemetría: **son producto**. Saber que un prospecto abrió su informe tres veces
es la señal de compra más barata que vamos a tener nunca, y es lo que decide a
quién llamar mañana. Un adjunto es un agujero negro comercial.

El PDF sigue existiendo para quien lo necesite: es `window.print()` con el CSS
de impresión de la misma página, cero dependencias. Mismo argumento que
`components/print-button.tsx`.

### El correo se redacta solo y lo manda una persona

`smoke_reports.correo` es un **borrador**. El modelo lo escribe, una persona lo
lee en `/admin/pruebas` y aprieta enviar. Es la disciplina de
[ADR 0021](0021-la-cmo-expandida.md): el sistema detecta y redacta, un humano
decide qué sale del edificio.

Un correo automático diciéndole a un prospecto que su equipo contesta mal es
exactamente el tipo de mensaje que hay que leer antes de mandar.

Va por **Resend y no por SendGrid**, y esa elección no es indiferente
([ADR 0008](0008-sendgrid-y-separacion-de-reputacion.md)): SendGrid es el motor
de las campañas **de los clientes** y su reputación está atada a lo que ellos
envían. Meter nuestro outbound ahí contamina un dominio que no es nuestro para
ensuciar.

## Lo que esto NO cambia

**Los cuatro frenos de ADR 0025 siguen enteros.** El lote agrega el propósito
(`qa` | `prospeccion`) que gobierna cuáles aplican, pero **el bloqueo no lo
levanta ningún lote**: eso lo pidió el que está del otro lado.

**Ninguna cifra sale de un modelo.** Ni las del informe, ni el impacto, ni el
titular de la página pública —que parece prosa y lo escribe el código,
justamente porque contiene números.

**La agregación vive en SQL** (ADR 0023). Cuatro funciones nuevas, todas con su
caso en `scripts/test-lotes-e-informes.mjs`.

## Consecuencias

**Buenas**

- «¿A cuál cliente se le rompió la IA?» pasa de treinta conversaciones a mano a
  una tanda nocturna y una tabla ordenada por frecuencia de fallo.
- El diagnóstico gana un entregable que el prospecto reenvía a su socio, y ese
  reenvío se mide.
- QA y growth comparten motor. Lo único que cambia es a quién y con qué frenos.
- `docs/api/pruebas.md` documenta el subsistema función por función, con las
  seis costuras a reemplazar para portarlo.

**Malas, y asumidas**

- **Una sola línea es el techo real.** Con 4 concurrentes y 12 minutos por
  conversación, 90 pruebas son unas cuatro horas y media. Es un trabajo
  nocturno, no algo que se corre antes de una reunión. La alternativa B —más
  números— está a un `smoke_channels` de distancia y sin cambios de código.
- **El lote depende de que algo lo empuje.** Cada cierre empuja el siguiente,
  pero si todo el lote se traba a la vez, con el cron diario del plan Hobby
  espera hasta el otro día. Con Pro esto desaparece.
- Superficie nueva: dos tablas, cuatro funciones SQL, dos módulos, cinco rutas,
  tres pantallas.
- El costo por informe es una llamada de modelo más por organización.

## Lo que nos haría cambiar de opinión

Si una tanda de treinta tarda más de seis horas de punta a punta, el cuello es
la línea única y toca comprar la segunda — el código ya lo soporta.

Si los informes se abren menos del 30% de las veces, el problema no es el
informe sino el correo que lo lleva, y hay que trabajar el asunto antes que el
contenido.

Si el catálogo de recomendaciones empieza a devolver consejos que el dueño no
puede ejecutar solo, dejamos de estar en el negocio del diagnóstico y pasamos al
de la consultoría — y eso es otra decisión, no un ajuste del catálogo.

## Referencias

- [ADR 0025 · El smoke tester como evidencia](0025-el-smoke-tester-como-evidencia.md)
- [ADR 0021 · La CMO expandida](0021-la-cmo-expandida.md) — la disciplina del borrador
- [ADR 0008 · SendGrid y la separación de reputación](0008-sendgrid-y-separacion-de-reputacion.md)
- [ADR 0023 · Mostrar el trabajo](0023-mostrar-el-trabajo.md)
- [wiki/24 · Lotes e informes](../wiki/24-lotes-e-informes.md)
- [`docs/api/pruebas.md`](../api/pruebas.md) — el contrato módulo por módulo
