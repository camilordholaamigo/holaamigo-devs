# ADR 0004 · Caché de research por dominio, con puntero en vez de copia

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Responde a:** PRD §10, "Costo del research por visitante anónimo"

## Contexto

El research cuesta entre USD 0,30 y 0,80 por corrida y lo dispara **cualquier
visitante anónimo**, sin tarjeta y sin cuenta. Tres personas de la misma empresa
probando el producto el mismo día son tres corridas pagas del mismo sitio.

El PRD pide caché por `domain` durante 30 días.

## Alternativas

**A · Tabla `research_cache` aparte.** Explícita, pero duplica los hallazgos y
crea el problema clásico: dos fuentes de verdad que se desincronizan.

**B · Copiar las filas de `research_findings` al run nuevo.** El run nuevo queda
autocontenido. Pero duplica datos y borra la trazabilidad de que fue reutilizado.

**C · Puntero: `research_runs.reused_from_run_id`.** El run nuevo existe, tiene
su `progress_log`, su `session_id` y su estado, pero apunta al run original para
los hallazgos.

## Decisión

**C.** `findingsForOrganization()` sigue el puntero de forma transparente. El
run reutilizado registra `cost_usd = 0`, lo que hace que la métrica de "costo
por diagnóstico" en `/admin/runs` refleje el costo real y no uno inflado.

El puntero además nos deja responder una pregunta que la copia no podría: *¿qué
porcentaje de los diagnósticos se sirvieron de caché?* Basta con contar
`reused_from_run_id is not null`.

## Detalles

- **Ventana:** 30 días (`CACHE_DAYS` en `lib/research/run.ts`).
- **Clave:** `organization_id`, que es único por `domain` gracias al índice
  único sobre la columna generada. La unicidad del dominio es lo que hace que
  la caché funcione sin una tabla extra.
- **Elegibles:** runs en estado `done` o `partial` que no sean a su vez
  reutilizados (`reused_from_run_id is null`). Así nunca se encadenan punteros.
- **Rate limit encima:** 5 intakes por IP/hora y 3 por dominio/día. La caché
  ahorra costo; el rate limit corta el abuso.

## Consecuencias

- Si una empresa rehace su sitio dentro de los 30 días, ve el análisis viejo.
  Aceptable: es exactamente lo que pasa con cualquier caché, y 30 días es corto
  frente a la frecuencia real con que un negocio rehace su web.
- Un borrado en cascada del run original dejaría al reutilizado sin hallazgos.
  Por eso la FK es `on delete set null` y no `cascade`: preferimos un run sin
  hallazgos —que el diagnóstico maneja como `partial`— a una fila que desaparece.
