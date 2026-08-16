# ADR 0017 · Las lecciones se recuperan sin pgvector, y el destilador no llama al modelo

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Parte 1 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)

## Contexto

Las lecciones se inyectan en cada corrida: el agente recibe las 5–8 más
relevantes para lo que va a hacer. "Relevante" mezcla tres cosas —similitud con
la tarea, confianza de la lección y qué tan específico es su alcance—, y la
similitud pide vectores.

El diseño original del plan pedía `vector(1536)` con un índice `ivfflat`. Eso
implica `create extension vector`.

Dos problemas, y el segundo es el que decide:

1. **La extensión es un objeto de base de datos, no de schema.** Este proyecto de
   Supabase es compartido con Rentmies, que está en producción (ADR 0001). Todo
   lo que hacemos vive en `holaamigo` justamente para no tocar nada de allá.
2. **Las pruebas corren en PGlite**, que no trae pgvector cargado por defecto.
   `npm test` corre las migraciones contra Postgres de verdad, y ese es el
   mecanismo que atrapó el bug de las claves de upsert. Perderlo para el
   sustrato —la parte que más invariantes tiene— sería el peor cambio posible.

Aparte, había una segunda decisión pendiente: ¿quién redacta el enunciado de la
lección? El plan decía "propone una `lesson`", sin decir con qué.

## Alternativas consideradas

**A · pgvector + cargar la extensión en PGlite para las pruebas.** Es viable
(`@electric-sql/pglite/vector`). Descartada por el punto 1: sigue exigiendo
instalar una extensión en una base ajena en producción, y el beneficio real es
nulo a nuestro volumen.

**B · Una tabla de lecciones en otro proveedor de vectores.** Descartada de
plano: una dependencia externa más, un lugar más donde puede haber datos que no
cuadran con la base, y sincronización que mantener. Para cientos de filas.

**C · Vector en `jsonb`, coseno en TypeScript.** Elegida.

## Decisión

**El embedding se guarda como `jsonb` (arreglo de floats) y el coseno se calcula
en TypeScript** sobre el conjunto candidato, que ya viene filtrado por alcance y
estado.

El cálculo real: cientos de lecciones activas por organización en el peor caso,
1536 dimensiones, un producto punto cada una. Es del orden de un milisegundo,
dentro de una corrida que va a tardar entre 5 y 90 segundos llamando al modelo.
Optimizarlo con un índice sería optimizar el 0,001% del tiempo.

Cuando una organización pase de unos miles de lecciones activas, esto se vuelve
falso y hay que volver a mirarlo. Hoy no es el caso y no está cerca.

**Degrada, no rompe.** Si no hay `OPENAI_API_KEY` o la llamada de embeddings
falla, `recallLessons` cae a solape de palabras (Jaccard sobre tokens sin
acentos ni palabras vacías). Es peor y da igual: el orden aproximado de seis
lecciones alcanza para el bloque de contexto, y lo alternativo es no inyectar
nada.

**El destilador es SQL puro. No llama al modelo.** El lift, la n y la confianza
salen de `holaamigo.destilar_candidatas()` y se pueden verificar con una
consulta; el enunciado se arma con `format()` alrededor de esos números:

> En logistica·email, la opción «costo» rinde 2.4x sobre las demás en
> reply_rate (n=50).

Es la aplicación literal del ADR 0007 —ninguna cifra que el cliente lee sale de
un modelo— a la capa de aprendizaje, y además hace que todo el destilador sea
probable en PGlite: `scripts/test-sustrato.mjs` lo corre sobre 50 decisiones
sembradas y verifica los números.

Que el modelo redacte mejor la frase es una mejora futura con una condición
escrita de antemano: **el número que aparezca en el texto se valida contra el
número que salió del SQL antes de guardarlo.**

Consecuencia operativa: las lecciones nuevas nacen sin vector, porque SQL no
puede llamar a OpenAI. Hasta que `backfillEmbeddings()` pase —el mismo cron, un
paso después— se recuperan por solape de palabras. Es degradación explícita, no
un olvido.

## Consecuencias

- `lessons.embedding` es `jsonb`, no `vector`. No hay índice de similitud y no
  hace falta.
- `lessons.fingerprint` es un índice único **plano** (ADR 0015) para poder ser
  árbitro del `on conflict` del destilador. Sin `where`, sin funciones.
- El coseno y el Jaccard viven en `lib/learning/embed.ts` y no importan nada de
  servidor, así que se pueden probar y reusar en el navegador cuando P3 muestre
  "por qué te mostramos esta lección".
- El día que un cliente tenga miles de lecciones activas, la respuesta es
  materializar el ranking o cargar pgvector, y este ADR se revisa. El umbral
  está escrito para que la conversación no empiece de cero.
