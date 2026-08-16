# 20 · Integraciones, CRM propio y registro de habilidades

> Los agentes pueden pedir habilidades nuevas. Nosotros decidimos cuáles
> existen y quién las alcanza.

Parte 6 y última del plan. Cierra el círculo: P2 dijo qué puede **hacer** un
agente, esto dice qué puede **usar**, y el CRM guarda quién hizo qué.

---

## El registro de habilidades

```sql
skills          el catálogo: proveedor, riesgo, nivel mínimo, plan, costo
skill_grants    quién la tiene encendida (org = null → todas)
skill_requests  lo que los agentes piden y todavía no tienen
```

### El tool list es una intersección

```
habilidades = otorgadas al rol
            ∩ habilitadas para esta org
            ∩ permitidas por el plan
            ∩ alcanzables con el nivel de capacidad actual
```

El cuarto conjunto es el que une P2 con P6 y usa **las mismas funciones del
motor de permisos**. De nada sirve tener LinkedIn habilitado si el agente no
tiene permiso para acciones de esa clase de riesgo.

```sql
select * from holaamigo.habilidades_activas('<org>', 'sales');
```

Consecuencias que la prueba deja explícitas:

| Cambio | Efecto |
|---|---|
| Subir la autonomía de la CMO | aparece la habilidad de voz, **sin desplegar** |
| Bajar el plan a `starter` | desaparece Apollo, aunque el grant siga ahí |
| Fila de la org con `enabled=false` | apaga para uno lo que está encendido para todos |

No se cachea, a propósito: habilitar desde el admin tiene que servir en la
siguiente corrida, y una caché de cinco minutos convierte "sin desplegar" en
"sin desplegar, pero esperá".

### La regla dura

Ninguna habilidad de clase `spend` o `irreversible` se enciende sin **operador**
y sin **sobre**. Lo impide un trigger:

```
la habilidad n8n.trigger es de clase irreversible y exige un sobre con
límites: sin tope no es un permiso, es una firma en blanco
```

### El catálogo inicial

| Habilidad | Rol | Riesgo | Nivel mínimo |
|---|---|---|---|
| LinkedIn · buscar personas | Sales, CMO | read | L3 |
| Apollo · construir listas | Sales | read | L4 |
| ElevenLabs · voz | CMO, Sales | external_comms | L3 |
| HubSpot · leer | todos | read | L4 |
| HubSpot · escribir | Sales | write | L3 |
| Stripe · leer ingresos | President | read | L5 |
| **Stripe · cobrar** | — | **spend** | deprecada |
| n8n · disparar | Sales | irreversible | L2 |
| Cal.com · agendar | Sales | write | L4 |

Las de lectura vienen encendidas para todos; el resto las enciende un operador,
cliente por cliente.

---

## El "intraer"

Cuando un agente se topa con un muro, deja constancia:

```ts
await conHabilidad(
  { organizationId, role: 'sales', skillId: 'hubspot.read_contacts',
    justification: 'Necesito leer los contactos para poder segmentar la base' },
  async () => sincronizar({ organizationId }),
);
// devuelve null y deja un skill_request si la habilidad no está
```

El pedido enlaza **la decisión que quedó bloqueada**, y esa parte es la que hace
la tarjeta útil: un pedido sin ella es una lista de deseos; con ella es
evidencia de producto. Aparece en `/admin/habilidades`.

Un índice único parcial evita que chocar contra el mismo muro genere cien
tarjetas idénticas.

> Los agentes empujan capacidades hacia sí mismos y nosotros decidimos cuáles
> existen. Ese loop es lo que hace que el sistema crezca solo — y lo que hace
> que no crezca solo del todo.

---

## HubSpot y la ingesta

```
conectar → sync incremental con cursor → staging_contacts
         → (lote de análisis) → leads
```

**Los contactos NO entran a operación hasta que se analicen.** Es deliberado:

1. Obliga a pasar por el paso que paga.
2. Evita que 8.000 contactos crudos aparezcan como leads trabajables — la forma
   más rápida de que alguien le escriba a quien no debía.

La credencial no se guarda en la tabla: `credentials_ref` guarda el **nombre** de
la variable de entorno. Una tabla con tokens en texto plano es una fuga esperando
a que alguien haga un `select *` durante un soporte.

El upsert por id externo hace que reimportar sea seguro. Sin él, tres corridas
del cron triplican la base.

---

## Los lotes

**El sistema propone el tamaño, no el cliente.**

> "De tus 5.000 contactos, empezá por los 1.200 que interactuaron en los últimos
> 18 meses. Son los más baratos de despertar: ya te conocen."

Un cliente al que se le pregunta "¿cuántos querés analizar?" elige mal en las dos
direcciones: o mil para probar y no ve señal, o los cinco mil de una y gasta el
trimestre en una corazonada.

| Profundidad | Créditos por contacto |
|---|---|
| `segment` — analizado y segmentado | 1 |
| `enrich` — enriquecido | 3 |
| `reactivate` — con plan personalizado | 5 |

Nunca se propone un lote que el saldo no cubre: pedirle al cliente que compre
créditos antes de haber visto que esto sirve es el orden equivocado.

### Cotización → aprobación → cobro

En ese orden. El cobro es **atómico en SQL** (`holaamigo.cobrar_lote`): entre
leer el saldo y escribir el débito, dos aprobaciones simultáneas lo dejarían en
negativo. El estado del lote es el candado contra el doble cobro.

La propuesta va al feed con su evidencia completa y se registra como decisión con
predicción (P1): valor proyectado a 45 días, con 8% de respuesta y 12% de cierre
sobre esa respuesta — los benchmarks del producto, no una estimación optimista
para que la cotización se vea mejor.

### La clasificación es por reglas, no por modelo

| Días desde la última interacción | Temperatura |
|---|---|
| ≤ 90 | `hot` |
| ≤ 365 | `warm` |
| ≤ 730 | `cold` |
| > 730 o sin fecha | `dead` — **no contactar** |

Un contacto que escribió hace un mes está más cerca de comprar que uno que no
contesta hace dos años: no hace falta un modelo para saberlo, y con reglas el
cliente puede discutir el umbral.

---

## El CRM propio

Lo que lo distingue no es el pipeline. Es la **trazabilidad de actor**.

```
la CMO propuso el ángulo → SALES envió → el lead respondió →
el agente calificó → EL HUMANO ENTRÓ ACÁ → se agendó → se cerró
```

```sql
select * from holaamigo.lead_timeline where lead_id = '<lead>' order by occurred_at;
```

Cada paso trae `actor_type` (agente / humano / sistema), `actor_ref`,
`decision_id` y el **costo**. El costo sale del toque si lo tiene, y si no, de la
decisión que lo originó — donde P1 lo imputó. Se resuelve en la vista porque es
la pregunta que se hace siempre al mirar un lead: *¿cuánto nos costó perseguir a
este?*

`opportunities.origin_decision_id` es lo que después contesta la quinta pregunta
de P4: **¿qué decisión de hace 60 días funcionó?**

Las probabilidades por etapa son constantes declaradas (5% → 10% → 25% → 40% →
60%), no un modelo: con menos de cien oportunidades cerradas, cualquier
probabilidad "aprendida" es ruido con decimales.

El pipeline muestra el valor bruto **y** el ponderado, uno al lado del otro: solo
el ponderado esconde de cuánto se está hablando; solo el bruto promete lo que no
va a entrar.

---

## Las pantallas

| Quién | Dónde | Qué |
|---|---|---|
| Cliente | `/consola/[orgId]/crm` | pipeline, staging, lotes y la línea de tiempo |
| Nosotros | `/admin/habilidades` | pedidos del "intraer" y el catálogo completo |

---

## El cron

`/api/cron/datos`, 15:00 UTC (10 a.m. Bogotá):

1. Sincroniza integraciones conectadas → staging.
2. Propone el lote con el que conviene empezar.
3. Corre los lotes ya aprobados y pagados.

Los lotes corren acá y no al aprobar: el cliente aprueba desde el feed y esa
petición tiene que contestar rápido. Analizar 1.200 contactos no cabe en el
tiempo de un clic.

---

## Cómo verificar

```bash
curl -s "$SITE/api/health?key=$CRON_SECRET" | jq '.checks[] | select(.name=="db:v9")'
```

```sql
-- ¿Qué puede usar SALES hoy?
select skill_id, nivel_disponible, min_grant_level
from holaamigo.habilidades_activas('<org>', 'sales');

-- ¿Qué están pidiendo los agentes?
select r.agent_role, r.skill_id, r.justification, d.question as bloqueo
from holaamigo.skill_requests r
left join holaamigo.decisions d on d.id = r.blocked_decision_id
where r.status = 'pending';

-- ¿Cuánto costó perseguir a este lead?
select sum(costo_usd) from holaamigo.lead_timeline where lead_id = '<lead>';
```

Y `node scripts/test-integraciones.mjs`: 30 chequeos con los cinco criterios.

---

## Lo que NO hay todavía

- **OAuth de HubSpot.** Hoy la credencial se configura como variable de entorno
  y se referencia por nombre. El OAuth es trabajo de una tarde y hasta que no
  haya tres clientes con HubSpot no sabemos qué scopes pedir de verdad (§13.3).
- **MCP real.** `skills.provider = 'mcp'` y `provider_config` guardan el servidor
  y el tool; `toolListFor()` es el punto donde se traducirán a definiciones de
  tool cuando conectemos. Que exista ya —aunque hoy solo formatee texto— es lo
  que hace que haya un solo lugar que sepa qué puede usar un agente.
- **⌘K y filtros guardados en el CRM.** La tabla densa está; la paleta de
  comandos llega cuando haya suficientes oportunidades para que buscar valga la
  pena.
- **Stripe y Wompi como fuente de ingresos.** El esquema de P4 los acepta con
  `external_ref` idempotente y las habilidades están en el catálogo; el conector
  se escribe cuando el primer cliente lo pida.
