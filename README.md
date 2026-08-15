# Hola Amigo · Motor de Ventas

Diagnóstico comercial autoservicio. El visitante entra con una URL y sale, seis
minutos después, con un diagnóstico de su negocio, la cuenta de cuánta plata
está dejando sobre la mesa, y tres agentes de IA esperando permiso para
trabajar.

**Stack:** Next.js 16 · TypeScript · Supabase · Vercel · OpenAI Responses API.

---

## Arrancar

```bash
npm install
cp .env.example .env.local     # llenar las claves
npm run dev
```

**Antes de eso**, dos pasos en Supabase que no se pueden saltar:

1. Dashboard → Project Settings → **Data API** → *Exposed schemas* → agregar
   `holaamigo`.
2. SQL Editor → correr `supabase/migrations/0001_init.sql` y luego
   `0002_seed_quiz.sql`. Son idempotentes.

Sin el paso 1, PostgREST devuelve 404 en todo y nada funciona. Es el primer
sitio donde mirar si la app falla entera.

## Verificar

```bash
npx tsc --noEmit    # tipos
npm run build       # build de producción
```

---

## Documentación

Toda en `docs/`. Empieza por [`docs/wiki/00-indice.md`](docs/wiki/00-indice.md).

| Dónde | Qué |
|---|---|
| [`docs/PROCESO.md`](docs/PROCESO.md) | Cómo trabajamos: debatir → decidir → planear → ejecutar → documentar |
| [`docs/PRD.md`](docs/PRD.md) | El alcance acordado, vivo |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Qué cambió y qué hay que hacer para desplegarlo |
| [`docs/wiki/`](docs/wiki/) | Cómo funciona cada parte, en prosa |
| [`docs/adr/`](docs/adr/) | Las decisiones estructurales y por qué |
| [`docs/api/README.md`](docs/api/README.md) | Contrato de cada endpoint |

**Si vas a tocar código, lee primero [`docs/PROCESO.md`](docs/PROCESO.md).**

---

## Mapa rápido

```
app/          Páginas y rutas de API
lib/          Lógica: research, quiz, diagnóstico, agentes, leads, scoring
config/       Modelos, prompts, supuestos y rutas — editables sin desplegar
components/   UI. Solo 9 son 'use client', cada uno por una razón concreta
supabase/     Migraciones SQL, idempotentes
docs/         Proceso, PRD, changelog, wiki, ADRs, API
```

## Las tres decisiones que explican casi todo

1. **[ADR 0007](docs/adr/0007-numeros-deterministas.md) — el modelo aporta
   lenguaje, el código aporta números.** Ninguna cifra que el cliente lee sale
   de un modelo. Por eso se puede defender, recalcular en el navegador y
   reproducir.
2. **[ADR 0003](docs/adr/0003-rls-deny-by-default.md) — RLS deny-by-default.**
   No hay cliente de Supabase en el navegador. Todo pasa por código de servidor.
3. **[ADR 0001](docs/adr/0001-schema-dedicado.md) — schema `holaamigo`.** El
   proyecto Supabase es compartido con Rentmies, que está en producción.

## Operación

Runbook completo en
[`docs/wiki/09-operacion-y-runbook.md`](docs/wiki/09-operacion-y-runbook.md):
despliegue, prueba de humo, qué hacer cuando algo se rompe, y las consultas SQL
de las métricas.
