<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# Hola Amigo · instrucciones del proyecto

**Antes de escribir código, lee [`docs/PROCESO.md`](docs/PROCESO.md).** El
proceso es: debatir el problema → escoger la mejor solución → planear →
ejecutar → documentar. No se salta ningún paso, ni cuando hay prisa.

## Lo que hay que saber antes de tocar nada

| Regla | Dónde está el porqué |
|---|---|
| **Ninguna cifra que el cliente lee sale de un modelo.** El modelo aporta lenguaje y evidencia; el código aporta los números. | [ADR 0007](docs/adr/0007-numeros-deterministas.md) |
| **No hay cliente de Supabase en el navegador.** RLS es deny-by-default, todo pasa por código de servidor con `service_role`. | [ADR 0003](docs/adr/0003-rls-deny-by-default.md) |
| **Todo vive en el schema `holaamigo`**, nunca en `public`. El proyecto Supabase es compartido con Rentmies, que está en producción. | [ADR 0001](docs/adr/0001-schema-dedicado.md) |
| **Los esquemas Zod que van a OpenAI no usan `.optional()`, `.min()`, `.max()`, `.url()` ni `.email()`.** Usa `.nullable()` y valida rangos después. | `lib/ai/schemas.ts` |
| **`lib/diagnostic/math.ts` no puede importar nada de servidor.** Corre también en el navegador para el recálculo en vivo. | [wiki/06](docs/wiki/06-diagnostico-y-matematica.md) |
| **Los errores de telemetría nunca lanzan.** `track()`, `alertSlack()` y `sendDiagnosticEmail()` capturan y registran. | `lib/events.ts` |
| **Toda decisión de agente lleva predicción y al menos dos opciones.** Lo exige la base, no el código. Y el `outcome` solo se escribe con `holaamigo.cerrar_decision()`. | [ADR 0016](docs/adr/0016-la-microdecision-como-unidad.md) |
| **Ninguna acción de agente se ejecuta sin pasar por `authorize()`.** Capacidad nueva = fila en el catálogo de `0007_gobierno.sql`, en el mismo PR. Lo que no está en el catálogo se bloquea. | [ADR 0018](docs/adr/0018-la-escalera-de-capacidades.md) |
| **Ninguna recomendación se cierra sin decir qué la cambiaría, y si el humano habló hay que citarlo.** Lo exige `holaamigo.resolver_deliberacion()`. Y "Ajustar" nunca abre una caja de texto. | [ADR 0019](docs/adr/0019-la-deliberacion-como-objeto.md) |
| **El pre-registro de un experimento es inmutable una vez que arranca.** Lo impide un trigger. Si hay que cambiarlo, se aborta y se abre otro — y el intento fallido queda visible en el libro. | [ADR 0020](docs/adr/0020-pre-registro-y-economia-por-canal.md) |

## Los seis principios (PRD §13)

Cuando haya duda sobre cómo hacer algo, se resuelve mirando estos:

1. El agente que razona sobre dinero no toca dinero.
2. Un solo objeto de contexto: los agentes leen el Brief, no tienen prompts propios.
3. Nada se automatiza antes de haberse hecho tres veces a mano.
4. Toda afirmación sobre el negocio del cliente lleva fuente o se marca como inferida.
5. El skip siempre es visible.
6. La cola de decisiones es el producto.

## Comentarios

Explican **decisiones, no mecánica**. Si el comentario repite lo que la línea
siguiente ya dice, bórralo. Si explica por qué está así y qué pasaría si no,
déjalo.

## Antes de dar algo por terminado

```bash
npx tsc --noEmit
npm run lint          # el compilador de React es parte del linter y es estricto
npm run build
npm test              # migraciones y claves contra Postgres real (PGlite)
```

Y actualizar `docs/CHANGELOG.md` con qué cambió **y qué hay que hacer para
desplegarlo**.

## Dos trampas que ya nos costaron caro

**`supabase-js` no lanza: devuelve `{ error }`.** Un `await db().from(x).insert(...)`
sin mirar el error compila, corre y no escribe nada, en silencio. Usa
`mustWrite()` para lo que no se puede perder y `tryWrite()` para telemetría.
Nunca un `await` pelado.

**Una clave de `onConflict` tiene que ser un índice único plano.** Si el índice
tiene `where` o una función (`lower(...)`), Postgres no lo puede usar como
árbitro y la escritura falla con `42P10`. El `onConflict` y su
`create unique index` se escriben en el mismo PR.
Ver [ADR 0015](docs/adr/0015-claves-de-upsert-planas.md).
