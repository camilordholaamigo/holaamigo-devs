# ADR 0008 · SendGrid para campañas, Resend para el producto

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Reemplaza parcialmente:** el webhook genérico de `app/api/webhooks/email`

## Contexto

v1 mandaba un solo tipo de correo: el diagnóstico terminado, por Resend. v2
agrega el motor de campañas — miles de correos comerciales a terceros, con
respuestas que hay que recibir, clasificar y contestar.

Tres opciones reales:

| Opción | Costo |
|---|---|
| **A · Todo por Resend** | Un proveedor, una integración. Pero Resend no tiene Inbound Parse equivalente ni herramientas de gestión de reputación por subusuario, y sobre todo: mezcla el pool de envío. |
| **B · Todo por SendGrid** | Un proveedor, con recepción y eventos firmados. Habría que migrar el correo transaccional que ya funciona, sin ganar nada. |
| **C · SendGrid para campañas, Resend para transaccional** | Dos integraciones que mantener. A cambio, dos reputaciones separadas. |

## Decisión

**C.** El correo del producto —el diagnóstico, los avisos al operador— sigue
por Resend (`lib/notify.ts`). El correo de campañas de los clientes sale y
entra por SendGrid (`lib/email/*`).

## Por qué

**1 · Separación de reputación, que es la razón de fondo.** Una campaña de un
cliente puede generar quejas de spam. Si comparte pool con el correo que le
avisa a alguien que su diagnóstico está listo, ese correo empieza a caer en
spam — y el diagnóstico es el producto. El día que pase, no lo vamos a
diagnosticar rápido: los problemas de entregabilidad se manifiestan como "menos
gente entra al link", no como un error.

**2 · Recepción de verdad.** La Inbound Parse enruta un dominio completo a un
webhook. Sin eso, las respuestas quedan en el Gmail del cliente y el agente no
se entera de que alguien contestó — que es exactamente el problema que el
módulo existe para resolver.

**3 · Eventos firmados.** El Signed Event Webhook usa ECDSA y lo verificamos en
`verifyEventSignature`. Sin firma, cualquiera con la URL puede reportar rebotes
falsos y meter contactos a la lista de supresión.

**4 · Cuenta propia por cliente.** `lib/email/sendgrid.ts` busca primero la API
key del cliente en `integrations`. Un cliente grande entra con su reputación,
su factura y su control, sin migrar nada.

## Consecuencias

- Dos claves que configurar: `RESEND_API_KEY` y `SENDGRID_API_KEY`. Sin
  ninguna de las dos el producto corre igual y registra en el log.
- El webhook viejo `/api/webhooks/email` se queda para eventos de Resend.
  Los de campañas van a `/api/webhooks/sendgrid/events`.
- La lista de supresión es **nuestra**, no la de SendGrid: vale para todos los
  canales y sobrevive a un cambio de proveedor. El link de baja del pie de cada
  correo apunta a `/api/baja/[messageId]`, no al de SendGrid.

## Lo que este ADR prohíbe

Mandar un correo de campaña por Resend, o un correo del producto por SendGrid.
Si aparece un tercer tipo de correo, se decide a qué pool pertenece antes de
escribir la primera línea.
