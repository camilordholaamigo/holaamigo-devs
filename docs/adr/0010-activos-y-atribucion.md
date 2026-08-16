# ADR 0010 · Activos brandeados y atribución de la unidad económica

- **Fecha:** 2026-08-15
- **Estado:** aceptada

## Contexto

El producto sabe mandar correos y recibir respuestas. Eso genera
*conversaciones*. Pero el negocio no se cobra por conversaciones: la conversación
que queremos vender es "te generamos 100 ventas, nos llevamos el 10%".

Para poder decir eso hace falta que la conversión ocurra en una superficie
nuestra, con un evento registrado. Si el contacto responde el correo y compra
por WhatsApp tres días después, la venta es real y nuestra atribución es una
suposición.

Alternativas consideradas:

| Opción | Costo |
|---|---|
| **A · Píxel y UTM en el sitio del cliente** | Exige tocar su web, romperse con cada rediseño, y no funciona si vende por WhatsApp o en persona. |
| **B · Confiar en lo que el cliente reporte** | Cero trabajo. También cero base para cobrar por resultado, y una conversación mensual incómoda. |
| **C · Darle herramientas nuestras que él quiera usar** | Hay que construirlas y mantenerlas. A cambio, la conversión pasa por casa. |

## Decisión

**C.** Hola Amigo entrega mini-herramientas al cliente, con su marca y en un
link nuestro:

- **Agendador** (`/agendar/[slug]`) — el mini-Calendly. No cobra fee.
- **Botón de pago** (`/pagar/[slug]`) — checkout sobre su inventario. Fee por
  defecto: 10% de lo que genere.

Cada uno vive en `assets`, cada interacción en `asset_events`, y lo que
producen en `bookings` y `orders` — con `campaign_id`, `lead_id` y `message_id`
del correo que trajo a esa persona.

## Por qué

**1 · El activo se lo queda el cliente, y por eso lo usa.** El link es suyo: lo
pone en su firma, en su bio de Instagram, en su WhatsApp. El agente lo reparte
además, no en vez de. Un activo que solo usa nuestro agente convierte una
fracción de lo que convierte uno que el cliente adopta.

**2 · Demuestra valor en el momento exacto.** La primera cita agendada desde el
link es cuando el cliente entiende que esto funciona. Por eso el agendador
**no cobra fee**: cobrar por el momento en que se genera la confianza es
miope.

**3 · Ataca la unidad económica del cliente, no la nuestra.** Una empresa de
eventos no necesita "más leads": necesita entradas vendidas. El checkout le
resuelve eso, y de paso nos deja el numerador y el denominador.

**4 · El fee se congela en la orden.** `orders.fee_pct` y `fee_usd` se calculan
al crear y no se recalculan. Si mañana subimos el fee, lo ya vendido no se
reescribe: una factura que cambia hacia atrás es una demanda.

## Consecuencias

- El `slug` de un activo **no se puede cambiar** después de creado. Está dentro
  de correos ya enviados: romperlo convierte cada link repartido en un 404 y
  cada venta futura en una venta sin origen.
- Los links públicos no piden cuenta ni contraseña. Son links que llegan por
  correo a gente que no nos conoce; cualquier fricción extra la paga la tasa de
  conversión. A cambio, lo único que exponen es el nombre del activo y, en el
  checkout, el catálogo: nunca la agenda existente ni datos de otros.
- El agendador registra `view` en cada visita. Sin visitas no hay tasa de
  conversión, y sin tasa no se puede mejorar el activo.
- Los pagos van en placeholder hasta el ADR 0013.

## Qué activos vienen después

La lista no es cerrada. El criterio para agregar uno: **¿resuelve una unidad
económica concreta de un tipo de cliente, y la conversión pasa por nosotros?**
Candidatos naturales: formulario de cotización con precio calculado, link de
reserva con abono, catálogo de propiedades con solicitud de visita.
