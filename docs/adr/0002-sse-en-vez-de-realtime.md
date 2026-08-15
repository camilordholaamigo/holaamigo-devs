# ADR 0002 · SSE en vez de Supabase Realtime para el progreso del research

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Contradice:** PRD §8.3.3, que dice "el quiz se suscribe por Realtime"

## Contexto

El indicador vivo del quiz (§4.2) es lo que sostiene la atención durante tres
minutos. El PRD especifica Supabase Realtime sobre la tabla `research_runs`.

El problema es de seguridad, no de tecnología. **Realtime respeta RLS.** Para
que el navegador se suscriba, `anon` necesita una política de `SELECT` sobre
`research_runs`. Y el único secreto que el cliente tiene es el `runId`.

Eso significa una política del tipo `using (true)`: cualquiera con la anon key
—que es pública por definición— puede leer el `progress_log` de cualquier
corrida que logre adivinar. El log contiene el dominio que se está analizando.
Es decir: la lista de qué empresas están evaluando Hola Amigo, filtrada a un
UUID de distancia.

Además obliga a publicar `NEXT_PUBLIC_SUPABASE_ANON_KEY` y a cargar
`@supabase/supabase-js` en el bundle del cliente.

## Alternativas

**A · Realtime con `using (true)`.** Fiel al PRD. Abre lectura anónima a una
tabla y publica la anon key.

**B · Polling contra `/api/research/status/[runId]`.** Cero superficie nueva.
Pero ~120 requests por sesión de quiz y latencia visible entre pasos.

**C · SSE desde una ruta de servidor.** El servidor hace el polling contra la
base con `service_role` y empuja los eventos por `text/event-stream`. Una
conexión, cero políticas RLS, cero claves publicadas.

## Decisión

**C, con B como fallback automático.** `components/research-ticker.tsx` abre el
`EventSource`; si falla —proxy corporativo que corta streaming, navegador
viejo— cae solo a polling sin que el usuario note nada.

Resultado: RLS queda en deny-by-default sin excepciones (ver ADR 0003), no hay
cliente de Supabase en el navegador, y el efecto para el usuario es idéntico.

## Consecuencias

- Una función abierta ~2 minutos por sesión. Con Fluid Compute las
  invocaciones concurrentes comparten instancia, así que el costo es de CPU
  activo, no de tiempo de pared. Es despreciable.
- `maxDuration = 300` en la ruta del stream.
- Si algún día necesitamos empujar eventos a un panel de cliente autenticado,
  Realtime vuelve a ser la opción correcta: ahí sí hay una sesión con la cual
  escribir una política RLS de verdad.
