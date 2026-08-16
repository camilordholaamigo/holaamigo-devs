# ADR 0013 · Pagos en placeholder: la atribución primero, el cobro después

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Aplica:** PRD §13.3 — nada se automatiza antes de haberse hecho tres veces a mano

## Contexto

El checkout (ADR 0010) necesita cobrar para cerrar el ciclo. Conectar una
pasarela —Wompi, Mercado Pago, Stripe— implica cuenta de comercio del cliente,
onboarding con KYC, split de pagos para nuestro fee, manejo de reembolsos,
conciliación y un webhook con reintentos.

Eso es entre una y tres semanas, y no se puede hacer bien sin haber visto cómo
cobra realmente el primer cliente.

## Decisión

**Se construye todo el flujo menos el cobro.**

Lo que funciona hoy:

- El checkout valida inventario y **reserva el cupo**.
- Crea la orden con el comprador, los ítems y el subtotal.
- Calcula y **congela** nuestro fee.
- Guarda la atribución completa: campaña, correo, contacto, activo, timestamp.
- Registra el evento de conversión y actualiza la métrica de la campaña.

Lo que no:

- No hay cobro. La orden queda en `pending` con `provider: 'placeholder'`.
- Una persona la marca pagada desde la consola (`markPaid`).
- El comprador lo ve dicho en pantalla: *"reservamos tu cupo y te escribimos con
  el link de pago"*.

## Por qué

**1 · La parte difícil es la atribución, no el cobro.** Cobrar es un problema
resuelto por terceros. Poder demostrar que una venta salió de un correo nuestro
es lo que hace posible el modelo de negocio, y es lo que hay que tener corriendo
antes de poder cobrar por resultado.

**2 · Fingir un pago sería peor que no tenerlo.** Un flujo de checkout completo
que en realidad no cobra produce un comprador que cree que pagó y un cliente
furioso. Decirlo en pantalla cuesta una tasa de conversión más baja y cero
incidentes.

**3 · Todavía no sabemos cómo cobra el cliente.** ¿Wompi? ¿Transferencia?
¿Link de Bold que ya usa? Elegir pasarela antes de saberlo es elegir mal.
Cobrar a mano tres veces nos lo va a decir.

## Consecuencias

- `orders.status` distingue `pending` de `paid`. El ingreso atribuido que se
  muestra en la consola cuenta **solo las pagadas**; las pendientes van en una
  columna aparte. Contar como ingreso algo que no se cobró sería mentirle al
  cliente con su propio dinero.
- El inventario se reserva al crear la orden, no al pagarla. Puede dejar cupos
  bloqueados por órdenes que nunca se pagan — es el error más barato de los dos,
  y un barrido de órdenes vencidas lo resuelve.
- `markPaid` tiene la firma que va a usar el webhook de la pasarela. Cuando se
  conecte, lo único que cambia es quién la llama.
- La ruta manual se queda para siempre: siempre va a haber ventas cobradas por
  fuera.

## Qué falta para cerrar esto

1. Elegir pasarela con datos de los primeros clientes reales.
2. Onboarding de comercio y split de fee.
3. Webhook de confirmación → `markPaid`.
4. Reembolsos y su efecto sobre el fee ya facturado.
