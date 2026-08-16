# 14 · Observabilidad

Lo que necesita ver alguien que opera Hola Amigo para ser dramáticamente más
productivo — sin ahogarse en datos.

**El criterio de qué entra y qué no: una métrica que no cambia una decisión es
ruido.** Y el ruido acá tiene un costo concreto: el operador deja de mirar la
pantalla.

Por eso no hay aperturas por hora, ni mapas de calor, ni gráficas de tendencia.
Hay cuatro preguntas.

---

## 1 · ¿Qué va a pasar y por qué?

Tabla `scheduled_actions`. Cada fila tiene tres campos obligatorios:

- `title` — qué va a pasar.
- `why` — para qué existe.
- `how_measured` — con qué métrica se va a juzgar.

**Si algo no tiene las tres, no debería estar programado.** Es la regla que
impide que la operación se llene de cosas corriendo que nadie sabe por qué
están corriendo.

Se crean al activar una campaña: una por paso de la secuencia, con la fecha real
de ejecución.

---

## 2 · ¿Se está pareciendo a lo que dijimos?

Lo esperado se congela en `campaigns.expected` cuando se propone la campaña. Lo
real se acumula en `campaign_metrics`.

La pantalla muestra las dos columnas juntas: `real / esperado` en respuestas y
citas, y la tasa de respuesta real contra la esperada. La diferencia entre esas
dos columnas es exactamente lo que dispara cada regla de iteración
([wiki 11](./11-campanas.md)).

También muestra el **próximo checkpoint**: qué KPI se revisa y qué día. Sale de
`measurement.points`, con fechas reales calculadas al aprobar — no "día 4", una
fecha que se puede poner en el calendario.

---

## 3 · ¿Algo se está rompiendo?

| Señal | Qué significa |
|---|---|
| Conversaciones esperándote | Hilos con `needs_human`. Si crece, el agente está escalando de más o nadie está mirando |
| Corridas fallidas · 7 días | `agent_runs` con status `failed` |
| Corridas degradadas · 7 días | El modelo no logró la salida al primer intento |
| Bandejas | Uso de hoy contra el tope, rebotes, quejas |

Los umbrales de las bandejas están dichos en pantalla, no escondidos: se pausa
sola por encima de 5% de rebotes o 0,3% de quejas.

---

## 4 · ¿En qué se está yendo la plata?

Dos cosas distintas, que no hay que confundir:

- **Créditos** — lo que consume el cliente. Saldo y consumo por tipo, 30 días.
- **Costo de IA** — lo que nos cuesta a nosotros correr los agentes, sumado de
  `agent_runs.cost_usd`.

Y al lado, lo que el sistema **generó**: ventas atribuidas (solo pagadas) y el
fee correspondiente. Poner el consumo y la generación en la misma fila es lo que
convierte la pantalla de números en una conversación sobre retorno y no sobre
gasto.

---

## Dónde mirar cada cosa

| Pregunta | Dónde |
|---|---|
| ¿Qué tengo que decidir hoy? | `/consola/[orgId]` — el feed |
| ¿Qué campañas hay y cómo van? | `/consola/[orgId]/campanas` |
| ¿Quién contestó y qué necesita respuesta? | `/consola/[orgId]/bandeja` |
| ¿Qué citas hay? | `/consola/[orgId]/agenda` |
| ¿Cuánto generaron los links? | `/consola/[orgId]/activos` |
| ¿Cuánto puede hacer solo el agente? | `/consola/[orgId]/agentes` |
| Todo lo de arriba, en números | `/consola/[orgId]/observabilidad` |

El operador interno además tiene `/admin`: cola global de aprobaciones, scoring
de prospectos, salud de agentes y corridas ([wiki 08](./08-scoring-plg.md)).

---

## Consultas útiles

```sql
-- ¿Qué está programado para las próximas 24 horas, y por qué?
select title, why, how_measured, run_at
from holaamigo.scheduled_actions
where status = 'scheduled' and run_at < now() + interval '24 hours'
order by run_at;

-- Esperado contra real, por campaña
select c.name,
       (c.expected->>'replies')::int as esperadas,
       sum(m.replied)                as reales,
       sum(m.sent)                   as enviados
from holaamigo.campaigns c
left join holaamigo.campaign_metrics m on m.campaign_id = c.id
where c.organization_id = :org
group by c.id, c.name, c.expected;

-- ¿En qué se fueron los créditos este mes?
select kind, sum(abs(delta)) as creditos
from holaamigo.credit_ledger
where organization_id = :org and delta < 0
  and created_at > now() - interval '30 days'
group by kind order by creditos desc;

-- Ventas atribuidas a una campaña, con evidencia
select o.created_at, o.buyer->>'email' as comprador,
       o.subtotal_usd, o.fee_usd, o.status, o.attribution
from holaamigo.orders o
where o.campaign_id = :campaign
order by o.created_at desc;

-- Bandejas: uso de hoy contra el tope
select address, status, sent_today, daily_cap, warmup_started_at,
       bounce_rate, complaint_rate
from holaamigo.mailboxes
where organization_id = :org;

-- Correos que no salieron y por qué
select error, count(*)
from holaamigo.messages
where status = 'skipped' and organization_id = :org
group by error order by count(*) desc;
```
