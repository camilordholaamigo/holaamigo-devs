# 12 · Activos: el agendador, el checkout y la atribución

Además de mandar correos, Hola Amigo le entrega al cliente **mini-herramientas
suyas** que viven en un link brandeado y que el agente reparte dentro de las
conversaciones.

El porqué está en [ADR 0010](../adr/0010-activos-y-atribucion.md). Resumido: un
correo genera una respuesta; un link con evento registrado genera una **unidad
económica atribuible**. Sin eso, *"te generamos 100 ventas"* es una afirmación;
con eso, es una consulta SQL.

---

## Los dos activos de hoy

| | Agendador | Botón de pago |
|---|---|---|
| Ruta pública | `/agendar/[slug]` | `/pagar/[slug]` |
| Produce | `bookings` | `orders` |
| Fee | **0%** | 10% por defecto |
| Estado | Completo | Cobro en placeholder ([ADR 0013](../adr/0013-pagos-en-placeholder.md)) |

El agendador no cobra fee a propósito: es el activo que demuestra que esto
funciona. La primera cita agendada desde el link es el momento en el que el
cliente entiende el producto, y cobrar por ese momento es miope.

---

## El link y la atribución

Cuando el agente mete el link en un correo, le agrega tres parámetros:

```
/agendar/mi-empresa?c=<campaign_id>&l=<lead_id>&m=<message_id>
```

Eso es toda la atribución. Sin esos parámetros, una cita agendada desde el link
es una cita de origen desconocido.

Cada interacción queda en `asset_events`: `view` al abrir la página, `converted`
al agendar o comprar, `abandoned` cuando falla. Sin visitas no hay tasa de
conversión, y sin tasa no se puede mejorar el activo.

> **El `slug` no se puede cambiar.** Está dentro de correos ya enviados.
> Cambiarlo convierte cada link repartido en un 404 y cada venta futura en una
> venta sin origen.

---

## El agendador

### Cálculo de horarios

`lib/scheduling/slots.ts` — puro, sin importaciones de servidor, igual que
`lib/diagnostic/math.ts`. Corre en el navegador de quien está agendando, que es
lo que permite reordenar los horarios por zona horaria sin ida y vuelta.

Zonas horarias sin librería: `Intl` da el desfase real de la zona en una fecha
concreta, y `zonedTimeToUtc` hace dos pasadas porque el desfase depende del
instante y el instante depende del desfase. La segunda pasada corrige el cambio
de horario de verano.

### Configuración

En `assets.config`: duración, buffer, zona horaria del anfitrión, días
laborales, hora de inicio y fin, anticipación mínima, cuántos días adelante.

Por defecto: 30 minutos, buffer de 15, lunes a viernes, 9 a 17, mínimo 4 horas
de anticipación, hasta 21 días adelante. Se muestran máximo 10 días con cupo:
tres semanas de horarios vacíos hacen que el agendador se sienta abandonado.

### Tres decisiones que definen si convierte

1. **Los horarios se muestran en la zona de quien agenda**, detectada del
   navegador. Hacer que alguien calcule "las 10 de Bogotá qué hora es acá" es la
   forma más barata de perder una reunión.
2. **Nombre y correo se piden después de escoger el horario.** Pedirlos antes
   convierte el agendador en un formulario, y los formularios se abandonan.
3. **Sin cuenta, sin contraseña, sin verificación.** Es un link que llegó por
   correo a alguien que no nos conoce.

### Validación doble

El horario se revalida en el servidor aunque el navegador ya haya filtrado: la
lista que vio el que agenda puede tener dos minutos de vieja. El índice único
sobre `(asset_id, starts_at)` es la última red, pero un error de base de datos
es mala experiencia y el chequeo previo lo evita casi siempre.

### Qué pasa al agendar

- Si el que agenda no está en la base, **se crea como lead**. Una persona que
  agendó una llamada es un lead; dejarla fuera porque llegó por un link en vez
  de por un CSV es perder el hilo.
- El lead pasa a `booked`.
- Se publica un `win` en el feed y una alerta en Slack.
- Se registra `converted` en `asset_events`, con la campaña y el correo que la
  trajeron.

### Agendar desde una respuesta

El agente SALES puede cerrar una cita solo, sin aprobación, cuando el contacto
propone día y hora concretos. Si dijo que quiere reunirse pero no dijo cuándo,
manda el link en vez de inventar un horario.

---

## El checkout y el inventario

### Productos

`products` es deliberadamente mínimo: nombre, precio, tipo, inventario. No es un
catálogo de e-commerce y no queremos que lo sea — el cliente ya tiene dónde
vender. Lo que no tiene es una forma de cobrar **dentro de la conversación** que
el agente está teniendo.

`inventory` en `null` = ilimitado (un curso, un servicio). Un número = cupos de
verdad (las entradas de un evento), y el checkout deja de aceptar órdenes cuando
se acaban.

El primer producto **crea automáticamente el link de pago**. Sin eso, cargar un
producto no produce nada visible y el cliente no entiende para qué lo hizo.

### Reserva de inventario

Se reserva al **crear la orden**, no al pagarla. Si reserváramos al pagar, dos
personas podrían comprar la última entrada mientras la primera está en la
pasarela. Reservar antes puede dejar cupos bloqueados por órdenes que nunca se
pagan — es el error más barato de los dos.

Si la orden no se puede guardar, el inventario se devuelve. Un cupo bloqueado
por una orden que no existe es el peor tipo de bug: no se ve hasta que alguien
reclama que el evento dice "agotado".

### El fee

Se calcula al crear la orden y **se congela**: `fee_pct` y `fee_usd` no se
recalculan. Si mañana subimos el fee, lo ya vendido no se reescribe.

### El cobro

No existe todavía. La orden queda en `pending` y una persona la marca pagada
desde la consola. El comprador lo ve dicho en pantalla: *"reservamos tu cupo y
te escribimos con el link de pago"*.

Fingir un flujo de pago completo produciría un comprador que cree que pagó y un
cliente furioso. El detalle completo está en el
[ADR 0013](../adr/0013-pagos-en-placeholder.md).

En la consola, el ingreso atribuido cuenta **solo las órdenes pagadas**; las
pendientes van en una columna aparte. Contar como ingreso algo que no se cobró
sería mentirle al cliente con su propio dinero.

---

## Qué activos vienen después

El criterio para agregar uno: **¿resuelve una unidad económica concreta de un
tipo de cliente, y la conversión pasa por nosotros?**

Candidatos naturales: formulario de cotización con precio calculado, link de
reserva con abono, catálogo de propiedades con solicitud de visita.
