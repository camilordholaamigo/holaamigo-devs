# 11 · Campañas: playbooks, proyección e iteración

Una campaña en Hola Amigo no es una lista de correos programados. Es un plan
con cuatro partes que se escriben **antes** de enviar nada:

1. A quién le pegamos y por qué ese segmento.
2. Qué esperamos que pase, con números.
3. Cómo lo vamos a medir y cuándo lo miramos.
4. Qué cambiamos si no pasa.

Sin la cuarta, una campaña que no funciona se queda corriendo hasta que alguien
se acuerda de mirarla. Por eso las reglas de iteración son parte del playbook y
no una buena intención del operador.

---

## Los cuatro playbooks

`config/campaigns.ts`.

| Playbook | A quién | Promesa de 24 h | Activo que reparte |
|---|---|---|---|
| **Reactivación** | Base dormida, 90+ días sin contacto | ✅ sí | Agendador |
| **Rescate** | Conversaciones sin cierre, 14–120 días | ✅ sí | Agendador |
| **Conquista** | Frío, segmento nuevo | ❌ exige calentamiento | Agendador |
| **Lanzamiento** | Toda la base, awareness | ✅ sí | Checkout |

**Reactivación** es la que hace real la promesa del PRD: sale del dominio del
propio cliente, con relación previa, sin calentar nada.

**Conquista** es la única que exige `requires_warmup`. `activateCampaign` la
bloquea si todas las bandejas llevan menos de 14 días calentando. No es una
advertencia: no arranca. Prometer 24 horas en frío quema el dominio y no se
recupera.

**Lanzamiento** es el pilar de marca dentro del motor, y la única que pide algo
al humano: un video de 40 segundos. El President lo pregunta en el feed; no lo
asume.

### Cuáles tres se proponen

`selectPlaybooks()` es una función **pura y determinista**. Dos clientes con el
mismo diagnóstico reciben la misma propuesta, y siempre se puede explicar por
qué salió cada una. Si esto lo eligiera un modelo, *"¿por qué me propusiste
conquista?"* no tendría respuesta.

Criterios: contactos dormidos ≥50 → reactivación · tibios ≥15 → rescate · ruta
recomendada `brand_content` o claridad de marca <55 o tiene productos →
lanzamiento · fríos ≥100 o ruta `email` → conquista. Relleno determinista para
siempre entregar tres.

---

## Los números: quién calcula qué

Igual que en el diagnóstico ([ADR 0007](../adr/0007-numeros-deterministas.md)):

| Qué | Quién |
|---|---|
| Qué tres campañas | `config/campaigns.ts` — determinista |
| A quién y cuántos son | `lib/campaigns/segment.ts` — una consulta |
| Qué esperamos y cuánto cuesta | `lib/campaigns/math.ts` — aritmética |
| El texto de los correos | El CMO |

`lib/campaigns/math.ts` no importa nada de servidor, por la misma razón que
`lib/diagnostic/math.ts`: corre igual en el navegador, y el cliente puede mover
el tamaño de la audiencia y ver el número recalcularse en vivo.

### La proyección

`projectCampaign()` corre el embudo con los benchmarks del playbook:

```
audiencia → entregados → aperturas → respuestas → útiles → citas → cierres
```

Dos detalles que importan:

- **Los envíos no son audiencia × pasos.** Quien responde sale de la secuencia.
  El mismo descuento se aplica al costo en créditos, para que la proyección y el
  costo hablen del mismo envío.
- **El resultado se muestra como rango**, ±40% alrededor del central. No es
  estadística: es honestidad sobre que un benchmark de industria aplicado a un
  negocio concreto tiene esa varianza. **Prometemos la banda baja.**

### Los benchmarks

Conservadores y anotados uno por uno en `config/campaigns.ts`. Reactivación al
6% de respuesta es alto para correo y bajo para reactivación: la mayoría de los
benchmarks públicos reporta 8–12%, y los publica quien queda bien en ellos.

---

## La audiencia

`resolveAudience()`. Tres exclusiones que **nunca** se saltan, ni con la campaña
aprobada:

1. Lista de supresión global.
2. Contactos ya suprimidos en `leads.status`.
3. Contactos con un envío ya programado por otra campaña — nadie recibe dos
   correos nuestros el mismo día desde el mismo cliente.

Un contacto sin `last_interaction_at` entra si la regla tiene piso (busca
dormidos) y no entra si tiene techo (busca recientes). Adivinar una fecha sería
inventar el segmento.

---

## De la propuesta al envío

```
proposeCampaigns()          → 3 filas en `campaigns` con status `proposed`
   ↓  el cliente aprueba
activateCampaign()          → materializa la cola completa
   ↓
messages (status scheduled) → una fila por contacto y por paso
scheduled_actions           → una fila por paso, con por qué y cómo se mide
   ↓  cada 5 minutos
dispatchDue()               → envía lo vencido
```

### Por qué se materializa la cola completa

Podríamos generar cada paso el día que toca y ahorrar filas. Entonces *"¿qué
está programado para esta semana?"* no se podría contestar con una consulta — y
esa pregunta es la mitad de la observabilidad que el operador necesita.

### Qué pasa al rechazar

`rejectCampaign` cancela los envíos programados **en el acto**. Una campaña
rechazada que sigue mandando correos es la peor forma posible de perder la
confianza.

---

## La iteración

`evaluateIteration()` compara lo real contra las reglas del playbook. Corre en
el briefing diario del President.

Ejemplos reales:

| Si | Entonces | ¿Pausa sola? |
|---|---|---|
| Rebote >3% en los primeros 200 envíos | La base está sucia: se valida antes de seguir | ✅ |
| Respuesta <2% al día 4 (reactivación) | El CMO reescribe el paso 1 con otro ángulo | ❌ |
| Positivas >8% | Subir volumen y ampliar el segmento a 60 días | ❌ |
| Entregabilidad <90% (conquista) | Revisar DNS, bajar volumen, recalentar | ✅ |
| Más de 2 quejas de spam (rescate) | Revisión humana | ✅ |

Cada regla que dispara publica una alerta en el feed **con el número que la
disparó**. Sin eso, "la campaña se pausó sola" es magia; con eso, es una
decisión revisable.

La función devuelve **todas** las reglas, disparadas o no, y la UI muestra el
estado de cada una: si alguien agrega una regla al playbook y olvida su
evaluación, se ve que está ahí y no dispara.

---

## Las métricas

`campaign_metrics` es un rollup diario por campaña: enviados, entregados,
rebotados, aperturas, clics, respuestas, positivas, citas, órdenes, ingreso,
créditos.

Se actualiza desde tres lados: el despachador (enviados), el webhook de eventos
(entregas, aperturas, clics, rebotes) y el inbound (respuestas, positivas,
citas). Es un rollup y no una vista porque la observabilidad tiene que responder
rápido con meses de historia.
