# 16 · Gobierno: capacidades, sobres y la única puerta

> La CMO puede buscar partnerships. No puede firmarlos. Y quién define hasta
> dónde llega es una decisión de tres niveles.

Esta es la Parte 2 del plan de la meta-organización. Como P1, no tiene pantallas
todavía: es la máquina que hace que "el agente no puede hacer X" deje de ser una
frase en la documentación y pase a ser algo que un `if` evalúa antes de actuar.

---

## La escalera

Toda capacidad de todo agente vive en uno de seis niveles. Seis y no tres,
porque el espacio real entre "no puede" y "puede" tiene escalones:

| Nivel | Nombre | Qué puede hacer |
|---|---|---|
| **L0** | Prohibida | Nada. Ni siquiera la menciona. |
| **L1** | Proponer | Escribe una propuesta. No produce artefacto. |
| **L2** | Preparar | Arma el artefacto completo y lo deja listo. No lo envía. |
| **L3** | Con visto bueno | Ejecuta ítem por ítem, cada uno aprobado antes. |
| **L4** | Dentro del sobre | Ejecuta libre dentro de límites declarados, y reporta. |
| **L5** | Autónoma | Ejecuta y se audita por muestreo. |

El patrón que se repite en toda capacidad sensible:

> **Investigar es libre. Comunicar es acotado. Comprometer es humano.**

### El ejemplo trabajado: partnerships de la CMO

| Capacidad | Techo plataforma | Por defecto |
|---|---|---|
| `partnership.research` | L5 | L5 |
| `partnership.score` | L5 | L5 |
| `partnership.draft_outreach` | L4 | L2 |
| `partnership.send_outreach` | L4 | L3 |
| `partnership.negotiate` | **L2** | L2 |
| `partnership.commit` | **L0** | L0 |

`partnership.commit` en L0 no es una configuración: es el catálogo. Ningún plan,
ningún cliente y ninguna combinación de sliders lo sube. Existe en la lista para
que el cliente lo vea apagado.

---

## Los tres diales

```
nivel_efectivo = MIN( techo_plataforma, techo_cliente, techo_plan )
```

| Dial | Quién lo mueve | Dónde vive |
|---|---|---|
| **Plataforma** | nosotros | `capabilities.platform_ceiling`, en la migración |
| **Cliente** | el cliente | `capability_grants.granted_level` + `agents.autonomy` |
| **Plan** | el contrato | `holaamigo.techo_de_plan(plan)` |

| Plan | Techo |
|---|---|
| `diagnostico` | L2 — puede preparar, no sale nada |
| `starter` | L3 — ejecuta con visto bueno |
| `growth` | L4 — ejecuta dentro de sobres |
| `enterprise` | L5 |

Subir el techo del cliente por encima del de plataforma **no tiene efecto**, y se
recorta al escribir además de al evaluar (trigger `capability_grants_recorte`).
Si el panel mostrara L5 mientras el motor aplica L3, el cliente creería que
autorizó algo que nunca pasó.

### El dial grueso, y qué cambió en P2

`agents.autonomy` sigue existiendo y ahora es parte del techo del cliente:

| Autonomía | Techo |
|---|---|
| `propose` | L1 |
| `approve_each` | L3 |
| `auto_within_limits` | L4 |
| `sampled` | L5 — **no está en el formulario**, la abre un operador |

**El dial grueso gobierna lo que sale del edificio.** Las capacidades de clase
`read` y `write` —investigar, puntuar, mantener el Brief, actualizar el CRM— no
lo tocan: no afectan a ningún tercero y se deshacen editando.

Y cambió algo que estaba escrito antes: **la CMO ya no está forzada a
`propose`**. El principio §13.1 sigue intacto y ahora es más preciso — el
President, que es quien razona sobre dinero, tiene `budget.shift` con techo L2
(prepara la reasignación; moverla es humano) y su autonomía queda fija.

---

## El sobre

Es el objeto que hace posible L4: ejecutar libre **dentro de límites
declarados**.

```json
{
  "max_amount_usd": 0,
  "max_volume_per_week": 10,
  "forbidden_commitments": ["exclusividad", "uso_de_marca", "descuento"],
  "forbidden_counterparties": ["competidores_directos"],
  "requires_disclosure": true,
  "expires_at": "2026-11-30"
}
```

El sobre del cliente se superpone al nuestro: puede apretar un límite, y lo que
no toque conserva el default del catálogo.

Un sobre violado **bloquea y pide**. No degrada en silencio a "pedir permiso":
degradar haría que el sobre pareciera una sugerencia, y el punto del sobre es
que sea un límite. La tarjeta es la forma de levantarlo.

Todos los campos son opcionales y lo que no se declara no se limita. Un sobre
con veinte reglas que nadie entiende protege menos que tres que el cliente puede
leer en voz alta.

---

## La regla maestra de reversibilidad

> **Una acción que no se puede deshacer nunca corre sin sobre.**

Se evalúa en **runtime**, no en configuración: la misma capacidad es reversible o
no según lo que se esté haciendo. Pausar una campaña se deshace en un clic;
contestarle a 200 personas no.

```ts
await authorize({
  organizationId, capabilityId: 'outreach.reply',
  payload: { reversibility_hours: 72, discloses_agent: true },
});
// grant L5 → nivel efectivo 4, verdict 'downgraded'
```

El plan original decía "baja un nivel". Aplicado literal, L4 quedaba inalcanzable
para todo lo que sale hacia afuera —casi todo es irreversible— y el sobre no se
evaluaba nunca. Lo encontró la prueba en la primera corrida. La regla que quedó
es tope en L4; lo que protege contra lo *demasiado* irreversible es el techo de
plataforma, no un descuento en runtime. Ver [ADR 0018](../adr/0018-la-escalera-de-capacidades.md).

---

## La única puerta

```ts
const auth = await authorize({
  organizationId,
  capabilityId: 'partnership.send_outreach',
  payload: { volume: 1, discloses_agent: true, counterparty_tags: ['b2b_latam'] },
  approvalId,          // si el humano ya dijo que sí, no se le pregunta otra vez
  decisionId,          // enlaza el gobierno (P2) con el aprendizaje (P1)
});

if (auth.accion_permitida !== 'ejecutar') return;
```

O, cuando el patrón correcto tiene que ser el más corto de escribir:

```ts
const { auth, result } = await withAuthorization(args, async () => enviar());
```

`holaamigo.autorizar()` decide **y escribe la auditoría en la misma
transacción**. Falla cerrado: una capacidad desconocida da `blocked`, y si el
motor no responde, `authorize()` también. Es incómodo y es la única opción
defendible — la alternativa es que un timeout se convierta en permiso.

### Qué devuelve

```json
{
  "verdict": "blocked",
  "effective_level": 4,
  "requested_level": 4,
  "ceilings": { "platform": 4, "client": 4, "plan": 5, "autonomy": 4 },
  "requires_approval": true,
  "approval_id": "…",
  "accion_permitida": "pedir",
  "envelope_violations": [
    { "rule": "max_volume_per_week",
      "detail": "lleva 10 esta semana y pide 1 más; el sobre permite 10" }
  ]
}
```

`accion_permitida` es lo que el llamador mira: `ejecutar`,
`ejecutar_con_visto_bueno`, `pedir`, `preparar`, `proponer`, `nada`.

---

## Dónde está cableado hoy

| Camino | Capacidad | Qué pasa si frena |
|---|---|---|
| `activateCampaign()` | `campaign.launch` | no se programa ni una fila y queda tarjeta |
| `dispatchDue()` | `outreach.send_email` | los correos del lote se marcan `skipped` con el motivo |

El despachador gana una **sexta** verificación por lote. No es redundante con la
aprobación de la campaña: la aprobación autorizó la campaña una vez; el sobre
limita el ritmo todos los días. **Un cliente que aprobó 5.000 correos no aprobó
5.000 hoy.**

Se autoriza por lote y no por correo: el sobre se mide en volumen, y pedir
permiso 60 veces para lo mismo llenaría la auditoría de eventos idénticos.

---

## Cuando el humano no contesta

Cada tipo de tarjeta declara su SLA y qué pasa al vencer. La regla:

> **Si no contestar puede hacer daño, se rechaza.**
> **Si no contestar ES el daño, se aprueba.**

| Tipo | SLA | Al vencer |
|---|---|---|
| `campaign_launch` | 48 h | rechaza |
| `envelope_exceeded` | 24 h | rechaza |
| `escalation` | 24 h | rechaza |
| `pause_losing_campaign` | 4 h | **aprueba** |
| `pause_agent` | 4 h | **aprueba** |
| `suppression_add` | 4 h | **aprueba** |

Corre en el barrido de cada 2 minutos, no una vez al día: el SLA más corto es de
4 horas, y revisarlo cada 24 lo convertiría en un SLA de 24 h con letra chica.

Las tarjetas vencidas quedan firmadas por `sistema:sla`, nunca por un humano
fantasma.

---

## Cómo verificar que la correa está viva

```bash
curl -s "$SITE/api/health?key=$CRON_SECRET" | jq '.checks[] | select(.name=="db:v5")'
```

Ese chequeo no mira las tablas: **le pregunta al motor por `partnership.commit` y
exige `blocked`.**

```sql
-- ¿Qué frenó la correa esta semana?
select capability_id, verdict, count(*)
from holaamigo.guard_events
where created_at > now() - interval '7 days'
group by 1, 2 order by 3 desc;

-- ¿Qué tiene otorgado este cliente, y contra qué techo?
select g.capability_id, g.granted_level, c.platform_ceiling, c.risk_class
from holaamigo.capability_grants g
join holaamigo.capabilities c on c.id = g.capability_id
where g.organization_id = '<org>';
```

Y `node scripts/test-gobierno.mjs`: los cuatro criterios de aceptación del plan
más lo que los sostiene, contra Postgres real.

---

## Lo que NO hay todavía

- **El panel de sliders del cliente.** `matrizDeCapacidades()` ya devuelve todo
  lo que esa pantalla necesita —nivel actual, techo disponible, explicación en
  español, si el plan lo bloquea— pero la pantalla es de P3.
- **Cableado en los demás caminos.** Hoy pasan por el motor el lanzamiento de
  campañas y el envío de correo. Cada acción nueva declara su capacidad en el
  catálogo y llama a `authorize()` en el mismo PR.
- **Consumo de un solo uso de las aprobaciones.** Una aprobación desbloquea
  mientras esté `approved` y no vencida; quien evita el doble uso es la máquina
  de estados del llamador. Está anotado en la función.
