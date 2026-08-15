# 04 · Motor de research

## Qué hace

Toma una URL y produce hechos verificables sobre el negocio: qué vende, a
quién, si publica precios, contra quién compite, por qué canales lo contactan.
Todo con fuente citable.

Corre en background mientras el usuario responde el quiz.

## Por qué tenemos crawler propio

La opción obvia era darle la URL al modelo con `web_search` y dejar que él
busque. No lo hicimos, por tres razones:

**1 · Progreso real.** El indicador vivo del quiz es lo que sostiene la
atención durante tres minutos, y el PRD (§4.2) dice explícitamente que **no
puede ser decorativo**. Una sola llamada al modelo de 90 segundos produce dos
eventos: "empezó" y "terminó". El crawler produce seis eventos verdaderos:

```
Vamos a analizar acme.com
Abriendo acme.com
Leímos la home · canales visibles: WhatsApp, formulario
Leyendo su página de precios
Leyendo su página de servicios
Buscando con quién te comparan
Encontramos 4 competidores · 9 fuentes
```

Cada línea corresponde a algo que de verdad pasó. Si el research se demora, el
ticker se queda quieto — y eso también es información honesta.

**2 · Aterrizaje.** El modelo con el texto real del sitio alucina muchísimo
menos que el modelo buscando el sitio por su cuenta. Y como el requisito §13.4
es que toda afirmación lleve fuente, la diferencia entre "leí esto en su home"
y "creo recordar algo así" es la diferencia entre un producto que se puede
defender y uno que no.

**3 · Costo.** Leer HTML es gratis. Cada token que el modelo no gasta buscando
lo gasta razonando.

## Cómo funciona el crawler

`lib/research/crawl.ts`. **Sin dependencias**: extracción por regex. Para lo que
necesitamos —título, texto visible, links— un parser de DOM completo sería peso
muerto en el bundle del servidor.

1. `fetch` de la home con timeout de 9 s, User-Agent identificado, tope de 900 KB.
2. Extracción de texto: se quitan `script`, `style`, `noscript`, `svg`,
   comentarios y tags; se decodifican entidades; se colapsa el espacio.
3. **Detección de señales:** números de WhatsApp en `wa.me`, widgets de chat
   (Intercom, Drift, Tawk, Crisp, HubSpot, Zendesk, Tidio, ManyChat),
   formularios, teléfonos en `tel:`, correos, redes, `hreflang`, y **promesas de
   tiempo de respuesta** en el texto ("respondemos en 24 horas").
4. **Elección de subpáginas:** hasta 3, priorizadas — precios, servicios,
   nosotros, casos. Se leen en ese orden porque ese es el orden de valor.
5. Se arma un bloque de contexto (`crawlToPrompt`) con las señales técnicas y el
   texto de cada página.

Ese bloque va al modelo junto con `web_search` activo, que se encarga de la
parte que el crawler no puede hacer: encontrar competidores.

## Los hallazgos

Se guardan en `research_findings`, una fila por sección:

| Sección | Qué contiene |
|---|---|
| `offer` | Resumen de la oferta, productos, confianza |
| `pricing` | Si publica precios, precios observados, notas |
| `icp` | Descripción del cliente ideal, segmentos |
| `competitors` | Lista con promesa, posicionamiento, si publican precios |
| `positioning` | Claim central, diferenciadores, debilidades |
| `channels` | Canales detectados + señales crudas del crawler |
| `social_proof` | Testimonios, casos de éxito |
| `meta` | Nombre, país, industria, idioma, si el crawl funcionó |

Cada fila lleva `confidence` (0–1) y `sources`. Las fuentes son la unión de lo
que citó `web_search` y lo que leímos nosotros, deduplicadas por URL, tope 25.

**Enriquecimiento lateral:** lo que aprendemos del sitio se escribe también en
`organizations` — nombre, industria, país y **moneda**. Es lo que hace que las
cifras del diagnóstico salgan en pesos y no en dólares (ADR 0006).

## Estados y modos de falla

```
queued → running → done      crawl OK y ≥3 competidores
                 → partial   algo salió, pero incompleto
                 → failed    nada
       ← queued            reintento del cron (máx. 2)
```

Los modos de falla y qué hace cada uno:

| Qué falla | Qué pasa |
|---|---|
| El sitio bloquea o da timeout | `crawl.ok = false`. El prompt le dice al modelo que busque la marca por fuera y marque `crawl_ok` en false. Estado: `partial`. |
| El modelo devuelve JSON inválido | Dos reintentos, luego esquema mínimo (`ResearchMinimalSchema` + `inflateResearch`). Run marcado `degraded`. |
| El modelo falla del todo | Si el crawl sí funcionó, `persistCrawlOnly()` guarda el título, la descripción y las señales. Un diagnóstico con la oferta del cliente y sin competencia sigue sirviendo. |
| La función se muere a mitad | El run queda en `running`. El cron lo detecta a los 5 minutos y reintenta. |
| Se agotan los reintentos | `partial` si el crawl funcionó, `failed` si no. **El diagnóstico se genera igual.** |

## Caché

Por dominio, 30 días, con puntero (`reused_from_run_id`) en vez de copia. El
razonamiento completo está en ADR 0004. Un run reutilizado registra
`cost_usd = 0`, así la métrica de costo por diagnóstico no miente.

## Rate limit

`lib/ratelimit.ts`, ventana fija en Postgres:

- **5 intakes por IP por hora.** Una persona probando 3 negocios distintos es
  legítima; 20 no.
- **3 intakes por dominio por día.** Corta el refresco compulsivo de la landing.

Si el rate limit no se puede evaluar por un error nuestro, **deja pasar**.
Preferimos gastar un research de más que rechazar a un cliente real.

## Cómo depurar una corrida

1. `/admin/runs` — busca la corrida por hora. Mira `status`, `model`, `cost_usd`.
2. Si dice `failed`, el campo `error` tiene el mensaje (hover en el estado).
3. `/admin/prospects/[orgId]` — la ficha muestra todas las corridas de esa
   organización con su costo.
4. En la base: `select progress_log from holaamigo.research_runs where id = '…'`
   te da la secuencia exacta de pasos y dónde se detuvo.
