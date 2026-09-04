# 25 · Integración con GTM Radar

## Qué conecta

Audit-GTM envía una selección aprobada de enlaces públicos de WhatsApp. Hola
Amigo hace el preflight, ejecuta la batería existente y devuelve un resumen sin
PII. No se sincronizan organizaciones ni se copian transcripciones.

## API M2M

- `POST /api/integrations/gtm-radar/smoke/preflight`: confirma canal, formato,
  bloqueo, enfriamiento y posibles organizaciones por dominio.
- `POST /api/integrations/gtm-radar/smoke/runs`: registra una solicitud durable
  e idempotente y responde `202`.
- `GET /api/integrations/gtm-radar/smoke/runs/{requestId}`: estado técnico.
- `GET /api/cron/gtm-radar-smoke`: reanuda cola, cierra resultados y entrega la
  outbox. Requiere `CRON_SECRET`.

Las tres rutas M2M firman el cuerpo exacto con `GTM_RADAR_MACHINE_HMAC_KEY` y
las cabeceras `x-growth-timestamp`, `x-growth-idempotency-key` y
`x-growth-signature`. La clave debe tener al menos 32 bytes.

## Despliegue

1. Ejecutar `supabase/migrations/0019_gtm_radar_smoke_integration.sql`.
2. Configurar la misma `GTM_RADAR_MACHINE_HMAC_KEY` en ambos proyectos.
3. Confirmar `NEXT_PUBLIC_SITE_URL`, `CRON_SECRET` y al menos un
   `smoke_channel` activo con transporte sano.
4. Desplegar con `GTM_RADAR_SMOKE_ENABLED=false` y probar preflight.
5. Cambiar el flag a `true` solo después de confirmar el callback en staging.

Para apagar nuevas ejecuciones, volver el flag a `false`. Las corridas ya
aceptadas y los callbacks pendientes se conservan y pueden terminar.

