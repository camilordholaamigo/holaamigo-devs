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
| **Todo vive en el schema `holaamigo`**, nunca en `public`, y el schema tiene que estar expuesto en la API de Supabase. Nació de compartir proyecto con Rentmies; se conserva con proyecto propio porque es lo que impide que un `.from('leads')` toque una tabla ajena el día que vuelva a compartirse. | [ADR 0001](docs/adr/0001-schema-dedicado.md) |
| **Los esquemas Zod que van a OpenAI no usan `.optional()`, `.min()`, `.max()`, `.url()` ni `.email()`.** Usa `.nullable()` y valida rangos después. | `lib/ai/schemas.ts` |
| **`lib/diagnostic/math.ts` no puede importar nada de servidor.** Corre también en el navegador para el recálculo en vivo. | [wiki/06](docs/wiki/06-diagnostico-y-matematica.md) |
| **Los errores de telemetría nunca lanzan.** `track()`, `alertSlack()` y `sendDiagnosticEmail()` capturan y registran. | `lib/events.ts` |
| **Toda decisión de agente lleva predicción y al menos dos opciones.** Lo exige la base, no el código. Y el `outcome` solo se escribe con `holaamigo.cerrar_decision()`. | [ADR 0016](docs/adr/0016-la-microdecision-como-unidad.md) |
| **Ninguna acción de agente se ejecuta sin pasar por `authorize()`.** Capacidad nueva = fila en el catálogo de `0007_gobierno.sql`, en el mismo PR. Lo que no está en el catálogo se bloquea. | [ADR 0018](docs/adr/0018-la-escalera-de-capacidades.md) |
| **Ninguna recomendación se cierra sin decir qué la cambiaría, y si el humano habló hay que citarlo.** Lo exige `holaamigo.resolver_deliberacion()`. Y "Ajustar" nunca abre una caja de texto. | [ADR 0019](docs/adr/0019-la-deliberacion-como-objeto.md) |
| **El pre-registro de un experimento es inmutable una vez que arranca.** Lo impide un trigger. Si hay que cambiarlo, se aborta y se abre otro — y el intento fallido queda visible en el libro. | [ADR 0020](docs/adr/0020-pre-registro-y-economia-por-canal.md) |
| **Ninguna señal de upsell llega al cliente sin pasar por `/admin/senales`.** Lo exige un `check`. Y ningún caso de estudio se publica sin la aprobación del cliente final. | [ADR 0021](docs/adr/0021-la-cmo-expandida.md) |
| **El tool list de un agente es una intersección que se calcula en runtime**, y una habilidad de clase `spend` o `irreversible` no se enciende sin operador y sin sobre. | [ADR 0022](docs/adr/0022-habilidades-y-crm-con-actor.md) |
| **Nada en pantalla finge progreso que no está pasando**, y toda cifra adelantada sale de la misma función que produce la final. La agregación del embudo vive en SQL, no en el render. | [ADR 0023](docs/adr/0023-mostrar-el-trabajo.md) |
| **El agente de agendamiento se compila del diagnóstico, y ningún número suyo lo escribe un modelo.** El esquema que va a OpenAI no tiene un solo `z.number()`, y `blanquearCifras()` borra las que se cuelen en el texto. El plan comercial ya no topa lo que el agente hace con sus propios objetos: solo lo que sale del edificio. | [ADR 0024](docs/adr/0024-el-agente-se-compila-del-diagnostico.md) |
| **Un lote sin tope de concurrencia quema el número.** `max_concurrentes` y `ritmo_segundos` son columnas, no constantes. Y en el informe, la frecuencia se cuenta sobre los `id` de la rúbrica: las alucinaciones van textuales y sin agrupar, porque una cita resumida deja de ser prueba. | [ADR 0026](docs/adr/0026-el-lote-y-el-informe.md) |
| **Al smoke tester le escribe gente real: cuatro frenos, no uno.** `authorize()`, el número tiene que estar publicado en el sitio de esa organización, 72 h de enfriamiento, y un bloqueo que ningún camino automático revierte. Los tres primeros rigen el **camino automático**; el manual solo lleva el bloqueo, y eso es diseño — la tabla completa está en ADR 0027. Y el evaluador no devuelve notas: devuelve juicios, y la nota la calcula el código. | [ADR 0025](docs/adr/0025-el-smoke-tester-como-evidencia.md) |
| **El plan de una prueba es el contrato; quién lo escribió es un detalle.** El compilador y el formulario del admin producen el MISMO `PlanDePrueba`, y `lib/pruebas/guion.ts` es puro para que la vista previa muestre exactamente lo que se va a mandar. La unidad de ocupación es el par `(nuestra línea, su número)`: dos de nuestras líneas contra el mismo negocio son dos hilos y los dos valen. En modo `guion` los detectores de cierre NO paran la conversación. | [ADR 0027](docs/adr/0027-la-prueba-a-medida-y-las-lineas.md) |
| **Hay dos transportes y el que elige es `transporte.ts`, leyendo `canal.provider`.** Ningún otro módulo mira ese campo. El `device` de wzap nunca es implícito: la misma llave ve las líneas de otros negocios. Y «qué falta» se pregunta por línea, nunca por sistema. | [ADR 0028](docs/adr/0028-dos-transportes.md) |

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

Y si tocaste `lib/pruebas/`, actualizar también
[`docs/api/pruebas.md`](docs/api/pruebas.md): es el contrato que permite que
otro equipo tome este subsistema y lo adapte. Una firma que cambió y no está
ahí es una hora perdida de alguien que no escribió el código.

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
