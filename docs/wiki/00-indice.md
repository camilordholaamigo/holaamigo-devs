# Wiki · Hola Amigo

Esta wiki explica **cómo funciona el sistema y por qué está hecho así**, en
prosa, para que un humano la entienda sin leer el código.

No es documentación de API — eso está en `docs/api/README.md`. Es la
explicación de las partes y de las decisiones.

## Por dónde empezar

Si es tu primer día: lee `01-arquitectura.md` completo, después el recorrido de
abajo, y salta a la página específica cuando necesites tocar algo.

## El recorrido del usuario, y dónde vive cada parte

```
Landing            app/page.tsx · components/intake-form.tsx
   ↓ POST /api/intake                         → 02, 04
Research           lib/research/{run,crawl}.ts → 04
   ↓ SSE
Quiz               lib/quiz/* · components/quiz-flow.tsx → 05
   ↓
Diagnóstico        lib/diagnostic/* · config/routes.ts → 06
   ↓
Conectar canal     app/conectar/[sessionId]
   ↓
Cargar leads       lib/leads/ingest.ts → 07
   ↓
Panel + Admin      app/panel · app/admin → 08
```

## Índice

| # | Página | De qué trata |
|---|---|---|
| 01 | [Arquitectura](./01-arquitectura.md) | El stack, por qué cada pieza, cómo corre el trabajo en background |
| 02 | [Modelo de datos](./02-modelo-de-datos.md) | Las 20 tablas, las relaciones, los índices que importan |
| 03 | [Los agentes](./03-agentes.md) | Los tres contratos, el ruteo de modelos, el cliente de IA |
| 04 | [Motor de research](./04-motor-de-research.md) | El crawler, el progreso en vivo, la caché, los modos de falla |
| 05 | [Quiz adaptativo](./05-quiz-adaptativo.md) | Fijas, adaptadas, cierre, y qué pasa si el modelo falla |
| 06 | [Diagnóstico y matemática](./06-diagnostico-y-matematica.md) | Las fórmulas de las fugas y de la cuenta al revés |
| 07 | [Pipeline de leads](./07-leads-pipeline.md) | Parseo, mapeo, normalización, dedup, base legal |
| 08 | [Scoring PLG](./08-scoring-plg.md) | FIT, INTENT, bandas, cuándo entra un humano |
| 09 | [Operación y runbook](./09-operacion-y-runbook.md) | Desplegar, variables, qué hacer cuando algo se rompe |

## Los seis principios que gobiernan todo

Del PRD §13. Cuando haya duda sobre cómo hacer algo, se resuelve mirando estos:

1. **El agente que razona sobre dinero no toca dinero.** President y CMO nunca
   ejecutan.
2. **Un solo objeto de contexto.** Los agentes no tienen prompts propios: leen
   el Brief. Cambiar un precio se hace en un lugar.
3. **Nada se automatiza antes de haberse hecho tres veces a mano.**
4. **Toda afirmación sobre el negocio del cliente lleva fuente o se marca como
   inferida.**
5. **El skip siempre es visible.** La fricción escondida convierte peor y
   enseña desconfianza.
6. **La cola de decisiones es el producto.** Los gráficos son consulta; la cola
   es el trabajo.
