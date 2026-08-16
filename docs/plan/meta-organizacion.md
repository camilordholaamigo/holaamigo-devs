# Plan de desarrollo — La Meta-Organización

**Producto:** tres agentes (President, CMO, Sales) que operan como una organización real, visible y gobernable, dentro de la empresa del cliente.
**Base:** PRD Motor de Ventas v1 (landing → research → quiz → diagnóstico → agentes provisionados).
**Formato:** seis partes secuenciales. Cada una es una orden de trabajo autocontenida para Claude Code, de ~1 semana, con criterios de aceptación verificables.

## Estado

| Parte | Estado | Dónde está |
|---|---|---|
| **P1 · Sustrato** | ✅ entregada — 2026-08-15 | [wiki/15](../wiki/15-sustrato-decisiones-y-aprendizaje.md) · [ADR 0016](../adr/0016-la-microdecision-como-unidad.md) · [ADR 0017](../adr/0017-lecciones-sin-pgvector.md) · `0006_sustrato.sql` |
| **P2 · Gobierno** | ✅ entregada — 2026-08-15 | [wiki/16](../wiki/16-gobierno-capacidades-y-sobres.md) · [ADR 0018](../adr/0018-la-escalera-de-capacidades.md) · `0007_gobierno.sql` |
| **P3 · La Sala** | ✅ entregada — 2026-08-16 | [wiki/17](../wiki/17-la-sala-el-feed-y-el-capitulo.md) · [ADR 0019](../adr/0019-la-deliberacion-como-objeto.md) · `0008_la_sala.sql` |
| **P4 · Presidente/CRO** | pendiente | |
| **P5 · CMO expandida** | pendiente | |
| **P6 · Integraciones y CRM** | pendiente | |

---

## Mapa de dependencias

```
P1  Sustrato          decisiones, trazas, memoria, costos
     ↓
P2  Gobierno          charters, escalera de capacidades, sobres, permisos
     ↓
P3  La Sala           deliberación visible, feed de decisiones, la novela
     ↓            ↘
P4  Presidente/CRO    P5  CMO expandida
     ↓            ↙
P6  Integraciones, CRM propio y registro de habilidades
```

**Regla de oro del plan:** P1 y P2 no producen nada visible para el cliente. Son invisibles y son el 60% del valor. Si se saltan o se hacen a medias, P3 a P6 se construyen sobre arena y hay que rehacerlos.

---

# PARTE 1 — El Sustrato

> Todo lo que un agente hace queda registrado como decisión, no como log. Y de esas decisiones la empresa aprende.

### Por qué va primero
No se puede monitorear, trazar, evaluar ni aprender de algo que no se registró con estructura. Un log de texto no permite calcular calibración ni retorno. Esta parte define la unidad atómica de todo el sistema: **la microdecisión**.

### Las tres capas de memoria

| Capa | Qué guarda | Volumen | Vida |
|---|---|---|---|
| **Traza** | Cada paso de ejecución: input, tool call, output, tokens, costo, latencia | Enorme | 90 días calientes, luego a frío |
| **Decisión** | Qué se decidió, por qué, con qué evidencia, qué alternativas se descartaron, **qué se predijo** y **qué pasó** | Media | Permanente |
| **Lección** | Regla destilada de N decisiones, con alcance, confianza y evidencia | Pequeña | Permanente, versionada |

El par `prediction` / `outcome` es lo que hace posible el aprendizaje. Sin predicción registrada antes del hecho, no hay forma de saber si el agente acertó o racionalizó después.

### Esquema

```sql
create table traces (
  id bigserial primary key,
  organization_id uuid not null,
  agent_id uuid, run_id uuid,
  parent_trace_id bigint,
  step_type text check (step_type in ('think','tool_call','tool_result','output','error')),
  name text,
  input jsonb, output jsonb,
  model text, tokens_in int, tokens_out int, cost_usd numeric(10,6),
  duration_ms int,
  created_at timestamptz default now()
);
create index on traces (organization_id, created_at desc);
create index on traces (run_id);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  agent_id uuid not null,
  created_at timestamptz default now(),

  kind text not null,               -- angle_select | budget_shift | segment_pick | outreach_send | pause | escalate ...
  question text not null,           -- en lenguaje natural, legible por el cliente
  options_considered jsonb not null, -- [{option, pros, cons, est_cost, est_impact}]
  chosen jsonb not null,
  rationale text not null,

  evidence jsonb default '[]',      -- [{type:'metric'|'lesson'|'human'|'source', ref, weight}]
  lesson_ids uuid[],                -- lecciones que influyeron
  human_input_ids uuid[],

  prediction jsonb,                 -- {metric, expected_value, horizon_days, confidence}
  outcome jsonb,                    -- {metric, actual_value, measured_at}
  calibration numeric,              -- |predicho-real| normalizado; null hasta medir

  reversible boolean default true,
  cost_usd numeric(10,6),
  experiment_id uuid,
  approval_id uuid
);
create index on decisions (organization_id, created_at desc);
create index on decisions (kind, outcome) where outcome is not null;

create table lessons (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('agent','organization','industry','global')),
  scope_ref text,                   -- org_id, industry slug, o role
  statement text not null,          -- "En logística, el ángulo de costo supera al de urgencia 2.4x"
  applies_to jsonb,                 -- {kinds:[], channels:[], segments:[]}
  supporting_decisions uuid[],
  n_support int not null,
  confidence numeric not null,
  status text default 'candidate' check (status in ('candidate','active','retired','rejected')),
  promoted_by text, promoted_at timestamptz,
  version int default 1,
  embedding vector(1536),
  created_at timestamptz default now()
);
create index on lessons using ivfflat (embedding vector_cosine_ops);

create table human_inputs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  author text not null,             -- email
  author_type text check (author_type in ('client','operator')),
  body text not null,
  attachments jsonb default '[]',
  scope jsonb,                      -- {agents:[], kinds:[], until: date}
  weight numeric default 1.0,       -- >1 = tiene prioridad sobre evidencia del sistema
  status text default 'active',
  created_at timestamptz default now()
);
```

### El destilador (job)

Corre cada noche por organización:

1. Busca decisiones con `outcome` ya medido y `calibration` calculado.
2. Agrupa por `kind` + contexto (industria, segmento, canal).
3. Donde hay ≥8 decisiones con señal consistente, propone una `lesson` en estado `candidate`.
4. Las lecciones de alcance `organization` se activan solas si `confidence > 0.7`.
5. **Las lecciones de alcance `global` o `industry` requieren aprobación humana nuestra.** Un cliente raro no puede envenenar a los demás.
6. Lecciones cuya evidencia se invierte (nueva data las contradice) pasan a `retired` con nota.

### Inyección en tiempo de ejecución

Las lecciones **no se hornean en el prompt**. En cada corrida, el agente recibe un bloque `## Lo que hemos aprendido` con las 5–8 lecciones más relevantes, recuperadas por: alcance (agent → org → industry → global) + similitud del embedding contra la tarea actual + confianza. Se registra en `traces` cuáles se inyectaron, para poder atribuir después.

### Contabilidad de costos
Cada `trace` lleva costo. `decisions.cost_usd` = suma de las trazas de su corrida. Vista materializada `cost_rollup` por org / agente / día / tipo de decisión. Esto alimenta P4.

### Criterios de aceptación
- Una corrida de agente produce ≥1 `decision` con `options_considered` de mínimo 2 elementos y `prediction` no nula.
- El destilador genera al menos una lección `candidate` sobre un set semilla de 50 decisiones.
- Una lección activa aparece en el `traces` de la siguiente corrida como evidencia inyectada.
- `cost_rollup` cuadra contra la suma cruda de trazas con diferencia < 0,5%.

### Fuera de alcance en P1
UI. Nada de esto se ve todavía. Se valida por SQL y por tests.

---

# PARTE 2 — Gobierno: flexibilidad con correa

> La CMO puede buscar partnerships. No puede firmarlos. Y quién define hasta dónde llega es una decisión de tres niveles.

### La escalera de capacidades

Toda capacidad de todo agente vive en uno de seis niveles:

| Nivel | Nombre | Qué puede hacer |
|---|---|---|
| **L0** | Prohibida | Nada. Ni siquiera la menciona. |
| **L1** | Proponer | Escribe una propuesta en el feed. No produce artefacto. |
| **L2** | Preparar | Arma el artefacto completo (correo, term sheet, campaña) y lo deja listo. No lo envía. |
| **L3** | Ejecutar con visto bueno | Ejecuta ítem por ítem, cada uno con aprobación previa. |
| **L4** | Ejecutar dentro de un sobre | Ejecuta libremente **dentro de límites declarados** y reporta después. |
| **L5** | Autónoma | Ejecuta y se audita por muestreo. |

### El sobre (envelope) — el objeto que hace posible L4

```json
{
  "max_amount_usd": 0,
  "max_volume_per_day": 50,
  "allowed_counterparties": ["no_competidores", "empresas_b2b_latam"],
  "forbidden_counterparties": ["lista_negra_cliente", "competidores_directos"],
  "forbidden_commitments": ["exclusividad", "uso_de_marca", "descuento", "plazo>90d"],
  "expires_at": "2026-11-30",
  "reversibility_hours": 24,
  "requires_disclosure": true
}
```

### Los tres diales

```
nivel_efectivo = MIN( techo_plataforma, techo_cliente, techo_plan )
```

- **Techo de plataforma** — lo definimos nosotros. Es el máximo que este producto permite jamás para esa capacidad. No negociable por cliente.
- **Techo del cliente** — el cliente lo mueve en su panel, con un slider por capacidad y una explicación en lenguaje simple de qué se abre y qué se arriesga.
- **Techo del plan** — L4 y L5 solo existen en tiers superiores.

### Regla maestra de reversibilidad

> **Toda acción cuya reversión tome más de 24 horas baja automáticamente un nivel.**

Esto se evalúa en tiempo de ejecución, no en configuración. Enviar un correo a 50 personas es irreversible → nunca L5. Pausar una campaña es reversible → puede ser L5.

### Ejemplo trabajado: partnerships para la CMO

| Capacidad | Techo plataforma | Por defecto | Notas |
|---|---|---|---|
| `partnership.research` | L5 | L5 | Identificar y perfilar candidatos |
| `partnership.score` | L5 | L5 | Rankear por encaje estratégico |
| `partnership.draft_outreach` | L4 | L2 | Redactar el primer contacto |
| `partnership.send_outreach` | L4 | L3 | Sobre: sin compromiso económico, sin exclusividad, sin uso de marca, máximo 10/semana |
| `partnership.negotiate` | **L2** | L2 | Prepara term sheet. **Nunca lo envía.** |
| `partnership.commit` | **L0** | L0 | Firmar, comprometer marca o dinero. Jamás. |

Ese patrón se repite para toda capacidad sensible: **investigar es libre, comunicar es acotado, comprometer es humano.**

### Esquema

```sql
create table capabilities (
  id text primary key,              -- 'partnership.send_outreach'
  agent_role text not null,
  display_name text not null,
  description text not null,
  client_explanation text not null, -- lenguaje simple para el slider del cliente
  risk_class text check (risk_class in ('read','write','external_comms','spend','irreversible')),
  platform_ceiling int not null check (platform_ceiling between 0 and 5),
  default_level int not null,
  min_plan text
);

create table capability_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  capability_id text references capabilities(id),
  granted_level int not null check (granted_level between 0 and 5),
  envelope jsonb default '{}',
  granted_by text not null,
  granted_by_type text check (granted_by_type in ('client','operator','system')),
  reason text,
  expires_at timestamptz,
  created_at timestamptz default now(),
  unique (organization_id, capability_id)
);

create table guard_events (
  id bigserial primary key,
  organization_id uuid, agent_id uuid,
  capability_id text,
  requested_level int, effective_level int,
  verdict text check (verdict in ('allowed','downgraded','blocked')),
  reason text,
  envelope_check jsonb,
  decision_id uuid,
  created_at timestamptz default now()
);
```

### El motor de permisos

Una única función pura, llamada antes de cada acción:

```ts
authorize({ orgId, agentId, capabilityId, payload })
  → { verdict, effectiveLevel, envelopeViolations[], requiresApproval, approvalKind }
```

**Ninguna herramienta se ejecuta sin pasar por ahí.** Todo resultado va a `guard_events` — eso da la auditoría completa de qué se intentó y qué se bloqueó, que es tan valiosa como lo que sí pasó.

### Escalamiento y expiración
Cada `approvals.kind` declara su **acción por defecto al vencer el SLA**:
- `campaign_launch` → vence en 48 h → **rechaza** (fail-safe)
- `pause_losing_campaign` → vence en 4 h → **aprueba** (fail-open)

Así el sistema no se congela cuando el humano está de vacaciones.

### Criterios de aceptación
- Intentar `partnership.commit` produce `verdict='blocked'` sin importar la configuración.
- Subir el techo del cliente por encima del de plataforma no tiene efecto.
- Una acción marcada irreversible con grant L5 se ejecuta como L4 y queda registrada como `downgraded`.
- Un envelope violado (11º outreach de la semana) bloquea y genera una tarjeta de aprobación.

---

# PARTE 3 — La Sala: deliberación visible y el feed

> El cliente no ve un dashboard. Ve a su organización pensando, discutiendo y decidiendo — y puede meter la mano cuando quiera.

### Tres superficies distintas

| Superficie | Para qué | Ritmo |
|---|---|---|
| **El Feed** | Decidir. Cola de tarjetas que esperan al humano. | Cuando hay algo |
| **La Sala** | Leer. Narrativa cronológica de la conversación entre agentes. | Continuo |
| **El Capítulo** | Entender. Resumen diario/semanal narrado. | Diario, 7 a.m. |

### La deliberación como objeto

```sql
create table deliberations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  opened_by uuid references agents(id),
  question text not null,
  context jsonb,
  status text default 'open' check (status in ('open','resolved','escalated','abandoned')),
  recommendation jsonb,
  confidence numeric,
  what_would_change_my_mind text not null,  -- campo obligatorio
  dissent jsonb default '[]',               -- [{agent, position, argument}]
  decision_id uuid,
  opened_at timestamptz default now(),
  resolved_at timestamptz
);

create table deliberation_turns (
  id bigserial primary key,
  deliberation_id uuid references deliberations(id) on delete cascade,
  speaker text not null,            -- 'president' | 'cmo' | 'sales' | 'client' | 'operator'
  speaker_type text check (speaker_type in ('agent','human')),
  body text not null,
  evidence jsonb default '[]',
  stance text check (stance in ('propose','support','object','question','concede','decide')),
  created_at timestamptz default now()
);
```

**Dos decisiones de diseño que no se negocian:**

1. **`what_would_change_my_mind` es obligatorio.** Ninguna recomendación se renderiza sin él. Es lo que convierte al agente en asesor y no en oráculo, y es donde el cliente sabe exactamente qué evidencia aportar.
2. **El desacuerdo se muestra, no se resuelve en silencio.** Si la CMO quiere subir presupuesto de marca y el Sales quiere más buzones, el hilo muestra las dos posiciones y el argumento del President para escoger. Eso es lo que hace que se sienta una organización y no un chatbot.

### El Feed — anatomía de una tarjeta

```
┌──────────────────────────────────────────────────────────┐
│ ● CMO                                    hace 12 min  ⚠  │
│                                                          │
│ Quiero contactar a 8 empresas para un co-marketing       │
│ del evento de noviembre.                                 │
│                                                          │
│ Los 3 ángulos actuales saturaron su segmento — la tasa   │
│ de respuesta cayó 40% en dos semanas. Un partner con      │
│ audiencia propia nos abre 12.000 contactos nuevos sin     │
│ costo de lista.                                          │
│                                                          │
│ ▸ Ver la deliberación (3 turnos · Sales objetó)          │
│                                                          │
│ [ Aprobar ]  [ Ajustar ]  [ Rechazar ]  [ Preguntar ]    │
│                                                          │
│ Si no respondes en 48 h: se rechaza automáticamente.     │
└──────────────────────────────────────────────────────────┘
```

**Reglas de UX del feed:**
- **"Ajustar" nunca abre una caja de texto.** Abre checkboxes y sliders sobre el payload real: cuáles de las 8 empresas, cuántos por semana, con qué límite.
- Selección múltiple + aprobar en lote para tarjetas de baja severidad.
- Atajos de teclado: `J`/`K` navegar, `A` aprobar, `R` rechazar, `E` expandir. Las herramientas serias tienen teclado.
- Máximo **7 tarjetas activas simultáneas** por organización. Si hay más, el President las consolida o las prioriza. El límite es cognitivo, no técnico.
- Severidad visual sobria: un punto de color, no banners. Serio, no alarmista.

### La Sala — el modo novela

Vista cronológica, tipografía de lectura, ancho de columna cómodo. Renderiza `deliberation_turns` como diálogo atribuido. El cliente puede **interponerse en cualquier punto del hilo**: su mensaje entra como `speaker_type='human'` con `weight` alto, se guarda como `human_input`, y **reabre la deliberación** si ya estaba resuelta.

Eso es el titiritero: no está mandando órdenes a un formulario, está entrando a la sala.

### El Capítulo
Job diario a las 7 a.m. El President escribe 150–250 palabras: qué hizo la organización ayer, sobre qué discutió, qué decidió, qué cambió de opinión y qué necesita del humano hoy. Se manda por correo y por WhatsApp, y queda archivado como serie.

### Criterios de aceptación
- Una deliberación con desacuerdo real entre CMO y Sales se renderiza mostrando ambas posiciones.
- El cliente responde en La Sala → se crea `human_input` con weight 2.0 → la deliberación pasa a `open` → nueva recomendación cita ese input en `evidence`.
- Aprobar con teclado desde el feed dispara la acción y cierra la tarjeta en <500 ms.
- Con 12 aprobaciones pendientes, el feed muestra 7 y el President explica por qué esas.

---

# PARTE 4 — El Presidente como CRO

> El agente más valioso de SaaStr empezó como dashboard y terminó proponiendo campañas porque tenía finanzas, marketing y CRM en la misma cabeza. Aquí se construye esa cabeza.

### Lo que el President tiene que poder responder

1. ¿Cuánto entró, cuánto salió y en qué se fue, este mes?
2. ¿Cuánto cuesta un cliente por canal y en cuánto se paga solo?
3. ¿Dónde está el próximo dólar mejor invertido?
4. ¿Vamos a llegar a la meta del trimestre? ¿Con qué probabilidad?
5. ¿Qué decisión de las que tomamos hace 60 días funcionó, y cómo lo sé?

### Esquema

```sql
create table revenue_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  opportunity_id uuid,
  amount_usd numeric not null,
  kind text check (kind in ('new','expansion','renewal','refund','churn')),
  channel_id uuid, occurred_at timestamptz not null,
  source text check (source in ('manual','hubspot','stripe','wompi','agent')),
  external_ref text
);

create table cost_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  amount_usd numeric not null,
  category text check (category in ('ads','tooling','data','agent_compute','human_ops','infra','credits')),
  channel_id uuid, vendor text, agent_id uuid,
  occurred_at timestamptz not null,
  decision_id uuid                  -- qué decisión causó este gasto
);

create table channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  kind text,                        -- outbound_email | whatsapp | ads | partnerships | content | referral
  status text default 'active'
);

create materialized view channel_economics as
select c.id, c.organization_id, c.name,
  date_trunc('month', coalesce(r.occurred_at, k.occurred_at)) as month,
  sum(r.amount_usd) as revenue,
  sum(k.amount_usd) as cost,
  count(distinct r.opportunity_id) as customers,
  sum(k.amount_usd) / nullif(count(distinct r.opportunity_id),0) as cac,
  sum(r.amount_usd) / nullif(sum(k.amount_usd),0) as roas
from channels c
left join revenue_events r on r.channel_id = c.id
left join cost_events   k on k.channel_id = c.id
group by 1,2,3,4;

create table allocation_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  period text not null,
  current_allocation jsonb not null,   -- {channel_id: usd}
  proposed_allocation jsonb not null,
  expected_delta jsonb not null,       -- {revenue, cac, payback_days}
  confidence numeric,
  reasoning text not null,
  supporting_experiments uuid[],
  status text default 'pending',
  deliberation_id uuid
);

create table forecasts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  horizon_end date not null,
  scenario text check (scenario in ('conservative','base','aggressive')),
  metric text, value numeric,
  probability numeric,
  assumptions jsonb,
  created_at timestamptz default now()
);
```

### El motor de experimentos — pre-registro obligatorio

> **Ninguna acción consecuente se ejecuta sin declarar antes qué esperamos, cómo lo mediremos y cuándo decidiremos.**

```sql
create table experiments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  decision_id uuid,
  hypothesis text not null,
  primary_metric text not null,
  expected_effect numeric not null,
  guardrail_metric text,             -- lo que no puede empeorar
  guardrail_threshold numeric,
  min_sample int not null,
  decision_rule text not null,       -- declarada ANTES de correr
  status text default 'running'
    check (status in ('running','won','lost','inconclusive','aborted')),
  actual_effect numeric,
  cost_usd numeric,
  started_at timestamptz default now(),
  readout_at timestamptz
);
```

El pre-registro es lo que impide que el agente racionalice el resultado después. Al alcanzar `min_sample`, un job calcula el readout aplicando `decision_rule` literalmente, y escribe `outcome` en la `decision` asociada — cerrando el ciclo de aprendizaje de P1.

### El libro de resultados (descargable)

Reporte mensual generado por el President, exportable en **CSV y PDF**:

1. Resumen narrado — 200 palabras
2. P&G por canal con CAC, payback y ROAS
3. Todas las decisiones del periodo con costo, predicción, resultado y calibración
4. Experimentos: ganados, perdidos, no concluyentes
5. Lecciones nuevas activadas
6. Propuesta de reasignación para el siguiente periodo

**La columna de calibración es el diferenciador.** Ningún competidor le muestra al cliente qué tan bien predice su propia IA.

### Criterios de aceptación
- `channel_economics` cuadra contra la suma cruda de eventos con error < 0,1%.
- Una `allocation_proposal` genera una deliberación con al menos dos alternativas y evidencia de experimentos.
- Un experimento que alcanza `min_sample` produce readout automático y escribe `outcome` en su decisión.
- El libro de resultados descarga en PDF y CSV con los mismos números.

---

# PARTE 5 — La CMO expandida

> Sin tocar conexión de canales. El valor de la CMO agentificada está en lo que hoy nadie hace porque no da el tiempo.

### Las seis funciones

**1. Posicionamiento vivo**
Mantiene el documento de posicionamiento como objeto versionado. Detecta deriva: cuando el copy que se está enviando se aleja de la posición declarada, avisa. Cuando un competidor se mueve a tu terreno, propone reposicionamiento con evidencia.

**2. Inteligencia competitiva continua**
Job semanal: crawl de sitios, precios, ofertas de empleo (señal fuerte de hacia dónde van), presencia en medios. Diff contra el snapshot anterior. Solo alerta lo que cambió y por qué importa — no reporta ruido.

**3. La fábrica de ángulos**
Ángulos como objetos de primera clase con hipótesis, variantes, segmento y estadísticas vivas. La CMO propone ángulos nuevos cuando detecta saturación (caída sostenida de respuesta en un segmento) y los retira cuando mueren.

**4. Prueba social industrializada** ← la más subestimada
Detecta eventos de éxito en el CRM (deal cerrado, meta cumplida, hito del cliente) → genera borrador de caso de estudio con los números reales → pide aprobación al cliente final → deposita el activo en la biblioteca → lo enruta a los ángulos que lo necesitan.
**Esto es puro trabajo humano que nunca se hace porque nadie tiene tiempo. Agentificado, compone.**

**5. Partnerships y co-marketing**
Con la escalera de P2. Investiga, perfila, puntúa por encaje, redacta el acercamiento, ejecuta dentro del sobre, prepara el term sheet, **nunca compromete**.

**6. Media play (enterprise)**
Detecta el activo de data propietaria del cliente y propone convertirlo en reporte publicable. Identifica ángulos de prensa, pódcast y escenarios donde su fundador encaja. Genera el brief, no la publicación.

### La máquina de upsell

Esta es la parte sofisticada. La CMO no vende — **detecta restricciones y genera propuestas con evidencia.**

```sql
create table upsell_signals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  signal text not null,
  evidence jsonb not null,
  constraint_type text check (constraint_type in ('volume','conversion','brand','proof','positioning','capacity')),
  proposed_service text,       -- agency_brand | agency_content | media_play | fdo | credits
  estimated_value_usd numeric,
  confidence numeric,
  status text default 'detected'
    check (status in ('detected','proposed_internal','proposed_client','won','lost','dismissed')),
  created_at timestamptz default now()
);
```

**Reglas de detección:**

| Señal observada | Restricción | Servicio propuesto |
|---|---|---|
| Respuesta alta + cierre bajo | Prueba / credibilidad | Media play o casos de estudio |
| Tráfico alto + conversión baja en landing | Marca / mensaje | Agencia — marca |
| Ángulos saturados en todos los segmentos | Posicionamiento | Agencia — reposicionamiento |
| ICP enterprise sin activos de prueba | Prueba | Media play |
| Volumen tope alcanzado y meta lejos | Capacidad | Créditos o FDO |
| Puntaje de salud del operador en caída | Operación | Forward-Deployed Operator |

**Disciplina que hay que respetar:** toda señal aparece primero en **nuestro** admin (`proposed_internal`). Solo pasa a `proposed_client` con visto bueno humano. Un agente que le vende servicios al cliente sin filtro destruye la confianza que hace que el resto funcione.

### Criterios de aceptación
- Cambio de precio en el sitio de un competidor genera una alerta con diff en menos de 7 días.
- Un deal cerrado con valor sobre el umbral genera borrador de caso de estudio en <24 h.
- Saturación simulada de un ángulo (respuesta cae 40% en 14 días) dispara propuesta de ángulo nuevo.
- Ninguna señal de upsell llega al cliente sin `proposed_internal` aprobado.

---

# PARTE 6 — Integraciones, CRM propio y registro de habilidades

> Los agentes pueden pedir habilidades nuevas. Nosotros decidimos cuáles existen y quién las alcanza.

### 6A — El registro de habilidades

```sql
create table skills (
  id text primary key,                 -- 'linkedin.search_people'
  provider text not null,              -- mcp | rest | internal
  provider_config jsonb,               -- {server_url, auth_type, ...}
  display_name text not null,
  description text not null,
  input_schema jsonb not null,
  output_schema jsonb not null,
  risk_class text not null check (risk_class in ('read','write','external_comms','spend','irreversible')),
  min_grant_level int not null,
  cost_model jsonb,                    -- {unit:'call'|'credit', price_usd}
  status text default 'available' check (status in ('available','beta','deprecated'))
);

create table skill_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,                -- null = global por rol
  agent_role text not null,
  skill_id text references skills(id),
  enabled boolean default true,
  envelope jsonb default '{}',
  granted_by text, created_at timestamptz default now(),
  unique (organization_id, agent_role, skill_id)
);

create table skill_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid, agent_id uuid,
  skill_id text,
  justification text not null,         -- "necesito X para lograr Y"
  blocked_decision_id uuid,
  status text default 'pending',
  created_at timestamptz default now()
);
```

**El tool list en runtime** es la intersección de cuatro conjuntos:

```
skills_activas = grants_por_rol
               ∩ habilitadas_para_esta_org
               ∩ permitidas_por_el_plan
               ∩ risk_class_permitida_por_el_grant_de_capacidad_actual
```

**El "intraer":** cuando un agente se topa con un muro, crea un `skill_request` con justificación y la decisión que quedó bloqueada. Aparece en nuestro admin como tarjeta. Los agentes empujan capacidades hacia sí mismos y nosotros decidimos. Ese loop es lo que hace que el sistema crezca solo.

**Catálogo inicial:**

| Habilidad | Rol | Clase de riesgo | Nivel mínimo |
|---|---|---|---|
| LinkedIn (MCP) — búsqueda y perfilado | Sales, CMO | read | L3 |
| Apollo / Apify — construcción de listas | Sales | read | L4 |
| ElevenLabs — voz para contenido y follow-up | CMO, Sales | external_comms | L3 |
| HubSpot — lectura de contactos y deals | Todos | read | L4 |
| HubSpot — escritura | Sales | write | L3 |
| Stripe / Wompi — lectura de ingresos | President | read | L5 |
| Stripe / Wompi — cobros | — | **spend** | **L0 en v1** |
| n8n / Make — disparar automatizaciones | Sales | irreversible | L2 |
| Cal.com — agendamiento | Sales | write | L4 |

> **Regla dura:** ninguna habilidad de clase `spend` o `irreversible` se otorga automáticamente. Requiere acción explícita de admin y un sobre propio.

### 6B — HubSpot y la ingesta

Flujo: OAuth → descubrimiento de objetos y propiedades → UI de mapeo asistido por IA → sync incremental con cursor → staging → normalización → deduplicación contra `leads` existentes.

Los contactos llegan a `staging_contacts` y **no entran a operación hasta que se corra un lote de análisis**. Eso es deliberado: obliga a pasar por el paso que paga.

### 6C — Créditos y lotes de reactivación

```sql
create table credit_ledger (
  id bigserial primary key,
  organization_id uuid not null,
  delta int not null,               -- + compra, − consumo
  reason text not null,
  batch_id uuid, skill_id text,
  balance_after int not null,
  created_at timestamptz default now()
);

create table analysis_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  source text,                      -- hubspot | upload | apollo
  contact_count int not null,
  credits_quoted int not null,
  credits_charged int,
  status text default 'quoted'
    check (status in ('quoted','approved','running','done','failed')),
  results jsonb,                    -- {by_temperature, by_segment, top_opportunities, projected_value}
  reactivation_plan jsonb,
  started_at timestamptz, finished_at timestamptz
);
```

**Tarifa de referencia:** 1 crédito por contacto analizado y segmentado · 3 por contacto enriquecido · 5 por contacto con plan de reactivación personalizado.

**El sistema propone el tamaño del lote**, no el cliente. El President mira volumen, ticket y presupuesto y recomienda: *"de tus 8.400 contactos, empieza con los 1.200 que interactuaron en los últimos 18 meses — 1.200 créditos, valor proyectado $34.000. Si funciona, seguimos con el resto."* Cotización primero, aprobación, después se cobra.

### 6D — El CRM propio

Lo que lo hace distinto no es el pipeline. Es la **trazabilidad de actor**.

```sql
create table opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id uuid references leads(id),
  name text, value_usd numeric, currency text default 'USD',
  stage text not null,
  probability numeric,
  channel_id uuid,
  origin_decision_id uuid,          -- qué decisión de agente originó esta oportunidad
  owner_type text check (owner_type in ('agent','human')),
  owner_ref text,
  expected_close date,
  created_at timestamptz default now(), closed_at timestamptz,
  outcome text check (outcome in ('won','lost'))
);

create table touchpoints (
  id bigserial primary key,
  organization_id uuid not null,
  lead_id uuid, opportunity_id uuid,
  actor_type text not null check (actor_type in ('agent','human','system')),
  actor_ref text not null,
  action text not null,
  channel text,
  decision_id uuid,
  payload jsonb,
  occurred_at timestamptz default now()
);
create index on touchpoints (lead_id, occurred_at);
```

La vista de un lead es una línea de tiempo intercalada: la CMO propuso el ángulo → el Sales envió → el lead respondió → el agente calificó → **el humano entró aquí** → se agendó → se cerró. Cada paso enlaza a su `decision` y a su costo.

**Feel avanzado:** paleta de comandos (`⌘K`), navegación por teclado, tabla densa con columnas configurables, filtros guardados, exportación de cualquier vista a CSV.

### Criterios de aceptación
- Conectar HubSpot con 5.000 contactos produce mapeo, staging y cotización de lote sin intervención.
- Aprobar un lote descuenta créditos exactos y produce plan de reactivación segmentado.
- Un agente sin habilidad LinkedIn genera `skill_request` con la decisión bloqueada enlazada.
- Habilitar la habilidad desde admin la hace disponible en la siguiente corrida sin desplegar.
- La línea de tiempo de una oportunidad muestra actores humanos y de agente intercalados con costo por paso.

---

## Cómo entregarle esto a Claude Code

Una parte por sesión. Al abrir cada una:

1. Pegar únicamente esa sección más el mapa de dependencias.
2. Pedir migración + tipos + funciones puras + tests **antes** de cualquier UI.
3. Exigir que los criterios de aceptación se conviertan en tests que corran.
4. No pasar a la siguiente parte hasta que los criterios pasen.

**Lo que no se puede recortar:** P1 y P2. Son invisibles, no se ven en ninguna demo, y son lo único que hace que P3 a P6 tengan sentido. Todo el producto —la trazabilidad, el aprendizaje, la calibración, los sobres, la deliberación visible— descansa sobre la microdecisión estructurada y el motor de permisos. Recortarlos es construir otra herramienta de agentes más.
