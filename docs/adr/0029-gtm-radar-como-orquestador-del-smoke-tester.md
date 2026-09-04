# ADR 0029 · GTM Radar orquesta corridas acotadas del Smoke Tester

**Estado:** aceptado · **Fecha:** 2026-09-03

## Contexto

Audit-GTM ya conoce la cohorte, la marca primaria y las superficies públicas de
cada marca. Hola Amigo ya sabe ejecutar y evaluar conversaciones de Smoke
Tester. Copiar cualquiera de esas capacidades produciría dos verdades y dos
lugares con datos sensibles.

## Alternativas consideradas

1. Mover el Smoke Tester a Audit-GTM. Reduce una llamada de red, pero duplica
   transporte, bloqueos, enfriamiento, rúbricas y transcripciones.
2. Hacer de Hola Amigo la fuente de verdad de la selección. Reutiliza su UI,
   pero obliga a crear organizaciones comerciales para competidores que solo
   son objetivos externos.
3. Mantener servicios separados con un contrato M2M. Agrega una frontera y una
   outbox, pero conserva una sola responsabilidad por sistema.

## Decisión

Se adopta la tercera alternativa. Audit-GTM es fuente de verdad de la conexión,
selección y resultado publicable. Hola Amigo es fuente de verdad de ejecución,
bloqueos, teléfonos, mensajes y transcripciones.

La conexión es opcional y humana: el operador selecciona entre uno y cinco
números encontrados únicamente en enlaces públicos `wa.me` o
`api.whatsapp.com`, incluyendo siempre la marca primaria. La batería es fija:
`servicio`, `faq`, `ventas` para la primaria y `servicio` para cada competidor.
Cada conexión dispara una sola corrida; no crea recurrencia.

Una coincidencia por dominio se propone, nunca se acepta sola. Si no existe una
organización confirmada, el objetivo queda externo (`organization_id = null`) y
no se crea una organización comercial.

Las llamadas usan HMAC SHA-256 sobre
`timestamp.idempotency-key.raw-body`, con ventana de cinco minutos y una clave
dedicada. Las solicitudes y callbacks son idempotentes y el resultado sale por
outbox durable.

El callback no puede contener teléfono, conversación, transcripción ni
mensajes. Solo lleva conteos, tiempos agregados, las seis dimensiones de la
evaluación y un enlace al admin autenticado. Audit-GTM publica únicamente la
evaluación de la marca primaria; las de competidores quedan en operación.

## Consecuencias

- Hay que desplegar `0019_gtm_radar_smoke_integration.sql` y configurar dos
  variables antes de activar el kill switch.
- El cron reintenta ejecuciones y callbacks; nunca vuelve a crear una batería
  por sí mismo.
- La disponibilidad del canal, el bloqueo global y el enfriamiento de 72 horas
  se vuelven a verificar justo antes de enviar.

