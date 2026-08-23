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

## Y después del diagnóstico: el motor de correo (v2)

```
3 campañas         lib/campaigns/plan.ts → 11
   ↓ el cliente aprueba en la consola
Envío              lib/campaigns/dispatch.ts · lib/email/* → 10
   ↓
Respuestas         lib/email/inbound.ts → 10
   ↓
Cita o venta       lib/scheduling · lib/commerce → 12
   ↓
El President habla lib/feed/president.ts → 13
   ↓
Los números        lib/observability/summary.ts → 14
```

## Y debajo de todo: el sustrato (v3, en construcción)

```
Cada paso            lib/traces/record.ts       → 15
   ↓
Cada decisión        lib/decisions/record.ts    → 15   con predicción, siempre
   ↓ se mide
Cada lección         lib/learning/distill.ts    → 15   destilada en SQL, de noche
   ↓ se inyecta
La siguiente corrida lib/learning/context.ts    → 15
```

Y antes de cada acción, la correa:

```
authorize()          lib/governance/authorize.ts → 16
   ↓ MIN(plataforma, cliente, plan) − irreversibilidad
ejecutar · pedir · preparar · proponer · nada
   ↓ todo queda
guard_events                                     → 16
```

## Índice

| # | Página | De qué trata |
|---|---|---|
| 01 | [Arquitectura](./01-arquitectura.md) | El stack, por qué cada pieza, cómo corre el trabajo en background |
| 02 | [Modelo de datos](./02-modelo-de-datos.md) | Las tablas, las relaciones, los índices que importan y las claves de upsert |
| 03 | [Los agentes](./03-agentes.md) | Los tres contratos, el ruteo de modelos, el cliente de IA |
| 04 | [Motor de research](./04-motor-de-research.md) | El crawler, el progreso en vivo, la caché, los modos de falla |
| 05 | [Quiz adaptativo](./05-quiz-adaptativo.md) | Fijas, adaptadas, cierre, y qué pasa si el modelo falla |
| 06 | [Diagnóstico y matemática](./06-diagnostico-y-matematica.md) | Las fórmulas de las fugas y de la cuenta al revés |
| 07 | [Pipeline de leads](./07-leads-pipeline.md) | Parseo, mapeo, normalización, dedup, base legal |
| 08 | [Scoring PLG](./08-scoring-plg.md) | FIT, INTENT, bandas, cuándo entra un humano |
| 09 | [Operación y runbook](./09-operacion-y-runbook.md) | Desplegar, variables, qué hacer cuando algo se rompe |
| 10 | [Correo y bandejas](./10-correo-y-bandejas.md) | SendGrid, calentamiento, topes, envío y recepción, la baja |
| 11 | [Campañas](./11-campanas.md) | Playbooks, segmentos, proyección, medición e iteración |
| 12 | [Activos: agenda y checkout](./12-activos-agenda-y-checkout.md) | El mini-Calendly, el botón de pago, inventario y atribución |
| 13 | [Feed y autonomía](./13-feed-y-autonomia.md) | Cómo habla el President, cuánto puede hacer solo cada agente |
| 14 | [Observabilidad](./14-observabilidad.md) | Qué está programado, esperado vs real, salud y consumo |
| 15 | [El sustrato](./15-sustrato-decisiones-y-aprendizaje.md) | Decisiones con predicción, trazas, lecciones destiladas y costo por decisión |
| 16 | [Gobierno](./16-gobierno-capacidades-y-sobres.md) | La escalera L0–L5, los tres diales, los sobres y la única puerta |
| 17 | [La Sala, el Feed y el Capítulo](./17-la-sala-el-feed-y-el-capitulo.md) | La deliberación visible, el límite de siete, el teclado y la serie diaria |
| 18 | [El President como CRO](./18-el-president-como-cro.md) | P&G por canal, CAC y payback, pre-registro de experimentos y el libro de resultados |
| 19 | [La CMO expandida](./19-la-cmo-expandida.md) | Posicionamiento medible, competencia, fábrica de ángulos, prueba social y upsell con escalera |
| 20 | [Integraciones, CRM y habilidades](./20-integraciones-crm-y-habilidades.md) | El tool list como intersección, el "intraer", los lotes por créditos y el CRM con actor |
| 21 | [El flujo inicial y su embudo](./21-flujo-inicial-y-embudo.md) | La línea de tiempo del research, la primera cifra en la pregunta 5, la cascada, el embudo y `/admin/embudo` |
| 22 | [El agente de agendamiento](./22-agente-de-agendamiento.md) | Del diagnóstico al setter de WhatsApp: el playbook compilado, el vector store, las herramientas de agenda y el simulador |
| 23 | [El smoke tester](./23-smoke-tester.md) | Le escribimos a la línea del prospecto y le contamos qué pasó: el motor por eventos, las tres capas de veredicto y los cuatro frenos |
| 24 | [Lotes e informes](./24-lotes-e-informes.md) | Treinta líneas a la vez con tope de concurrencia, el análisis por frecuencia, y el informe público que se manda por WhatsApp |

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
