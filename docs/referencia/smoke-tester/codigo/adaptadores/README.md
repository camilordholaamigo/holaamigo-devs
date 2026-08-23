# Adaptadores — las 6 costuras que hay que reemplazar

El código de `lib/smoke-tester/` es portable salvo por **seis dependencias**
del monolito Rentmies. Esta carpeta trae una versión mínima e independiente de
cada una, para que puedas copiar `lib/smoke-tester/*` **tal cual** y solo
cambiar los imports.

| # | Dependencia original | Qué hace | Reemplazo aquí |
|---|---|---|---|
| 1 | `lib/supabase/admin` | cliente Postgres que salta RLS | `db.ts` |
| 2 | `lib/logger` | log estructurado a consola + tabla `admin_logs` | `logger.ts` |
| 3 | `lib/phone-utils` | normaliza teléfonos a solo dígitos | `phone-utils.ts` |
| 4 | `lib/agent-openai/responses-client` | llama a OpenAI Responses (y registra consumo) | `openai-responses.ts` |
| 5 | `lib/smoke-tester/wzap` | manda WhatsApp por wzap.chat | `transporte.ts` |
| 6 | `lib/supabase/server` + `profiles.empresa_id` | auth y multi-tenant en las rutas | ver §5 de `04-COMO-SE-CONSTRUYE.md` |

## Cómo aplicarlos

```ts
// buyer-ai.ts — original
import { callResponses } from '../agent-openai/responses-client'
import { logger } from '../logger'

// buyer-ai.ts — portado
import { callResponses } from '../adaptadores/openai-responses'
import { logger } from '../adaptadores/logger'
```

Ninguno de los adaptadores cambia la **firma** de lo que reemplaza, así que no
hay que tocar el cuerpo de los módulos originales.

## La costura más importante: el transporte

`transporte.ts` es la que decide qué tan complicado es todo el sistema.

- **Transporte asíncrono** (WhatsApp, SMS, email): la respuesta llega por
  webhook minutos después → necesitás el motor por eventos completo
  (`conversation-engine.ts`), el `turn_token`, el settle de ráfagas y los
  watchdogs.
- **Transporte síncrono** (HTTP contra el agente, WebSocket, SDK): la
  respuesta vuelve en el mismo `await` → el sistema se reduce a un `for` loop.
  Ver `transporte.ts` → `TransporteSincrono` y §6 de `04-COMO-SE-CONSTRUYE.md`.

Si tu agente se puede probar por HTTP, **usá el modo síncrono**. La mitad del
código de esta carpeta existe solo para sobrevivir al asincronismo de WhatsApp.
