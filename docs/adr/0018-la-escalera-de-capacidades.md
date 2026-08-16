# ADR 0018 · La escalera de capacidades y el sobre

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Parte 2 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)
- **Reemplaza** el modelo de permisos como texto de `agents.permissions`

## Contexto

Los permisos de los agentes existían como frases en español dentro de
`agents.permissions`:

```json
{ "cannot": ["publicar nada", "enviar nada", "contactar a nadie"] }
```

Ningún código las consultaba antes de actuar. Iban al prompt como contexto y
nada más. **Un permiso que no se evalúa antes de ejecutar no es un permiso: es
una promesa en la documentación.**

La única palanca real era `agents.autonomy`, un dial de tres posiciones para el
agente entero. Con un dial así solo hay dos respuestas posibles a "¿puede la CMO
buscar partnerships?": todo o nada. Y la respuesta correcta no es ninguna de las
dos — puede investigarlos, perfilarlos y hasta escribirles dentro de límites,
pero no puede firmar nada nunca.

## Alternativas consideradas

**A · Un permiso booleano por acción.** Es lo que hace casi todo el mundo.
Descartada porque el espacio real no es binario: entre "no puede contactar
partners" y "puede contactar partners" están "los identifica", "los puntúa",
"redacta el correo y lo deja listo", "lo manda pero con tope semanal". Con
booleanos, cada uno de esos estados es una bandera nueva y en seis meses hay
cuarenta banderas sin relación entre sí.

**B · Reglas por agente en su prompt.** Es lo que había. El modelo obedece casi
siempre, y "casi siempre" no es un modelo de permisos.

**C · Una escalera de seis niveles, igual para toda capacidad, con un sobre de
límites declarados para el nivel de ejecución libre.** Elegida.

## Decisión

### La escalera

| Nivel | Nombre | Qué puede hacer |
|---|---|---|
| L0 | Prohibida | Nada. Ni siquiera la menciona. |
| L1 | Proponer | Escribe una propuesta. No produce artefacto. |
| L2 | Preparar | Arma el artefacto completo y lo deja listo. No lo envía. |
| L3 | Con visto bueno | Ejecuta ítem por ítem, cada uno aprobado antes. |
| L4 | Dentro del sobre | Ejecuta libre dentro de límites declarados, y reporta. |
| L5 | Autónoma | Ejecuta y se audita por muestreo. |

El patrón que se repite en toda capacidad sensible:
**investigar es libre, comunicar es acotado, comprometer es humano.**

### Los tres diales

```
nivel_efectivo = MIN( techo_plataforma, techo_cliente, techo_plan )
```

El **techo de plataforma** lo definimos nosotros en la migración y no está en
ninguna pantalla. `partnership.commit` tiene techo L0: no hay plan, cliente ni
configuración que lo suba. El **techo del cliente** es el slider, acotado además
por `agents.autonomy`. El **techo del plan** es que L4 y L5 no existen abajo.

Subir el techo del cliente por encima del de plataforma no tiene efecto, y se
recorta **al escribir** además de al evaluar: si el panel muestra L5 y el motor
aplica L3, el cliente cree que autorizó algo que nunca pasó.

### La regla maestra de reversibilidad, corregida

El plan decía: *"toda acción cuya reversión tome más de 24 horas baja
automáticamente un nivel"*. Implementado literalmente, eso rompe el producto: casi
toda acción hacia afuera es irreversible, así que L4 quedaría inalcanzable y el
sobre —el mecanismo entero de P2— no se evaluaría nunca. Lo descubrió
`scripts/test-gobierno.mjs` en la primera corrida.

La regla que quedó es **tope en L4**:

> Una acción que no se puede deshacer nunca corre sin sobre.

Se cumple lo que el plan quería (*"enviar un correo a 50 personas es
irreversible → nunca L5"*) sin vaciar de sentido al nivel donde vive la
protección. Lo que sí protege contra lo demasiado irreversible es el techo de
plataforma: publicar, cotizar un precio y preparar un term sheet están en L2, y
ningún runtime los sube.

Se evalúa en **runtime**, no en configuración: la misma capacidad es reversible o
no según el payload. Pausar una campaña se deshace en un clic; contestarle a 200
personas no.

### El sobre

```json
{
  "max_amount_usd": 0,
  "max_volume_per_week": 10,
  "forbidden_commitments": ["exclusividad", "uso_de_marca", "descuento"],
  "forbidden_counterparties": ["competidores_directos"],
  "requires_disclosure": true
}
```

Un sobre violado **bloquea y pide**, no degrada en silencio. Degradar haría que
el sobre pareciera una sugerencia; el punto del sobre es que sea un límite, y la
tarjeta es la forma de levantarlo.

### El motor vive en SQL

`holaamigo.autorizar()` decide **y escribe la auditoría en la misma
transacción**. Tres razones, en orden de importancia:

1. Es imposible de saltar sin dejar hueco visible. Un motor en la aplicación se
   puede llamar y olvidar de registrar.
2. El conteo de volumen del sobre es una consulta; en TypeScript serían dos
   viajes con una carrera en el medio.
3. Se prueba contra Postgres real en PGlite, como todo el resto del plan.

**Falla cerrado.** Una capacidad desconocida da `blocked`. Si el motor no
responde, `authorize()` devuelve bloqueo. Es incómodo —una caída de la base frena
a los agentes— y es la única opción defendible: la alternativa es que un timeout
se convierta en permiso para escribirle a mil personas.

### El dial grueso, reconciliado

`agents.autonomy` no se elimina: pasa a ser una de las entradas del techo del
cliente. **Gobierna lo que sale del edificio**: `read` y `write` internos (el
Brief, el CRM, un borrador) no lo tocan. Sin esa distinción, la CMO en `propose`
no podría ni mirar el sitio de un competidor.

Se agrega una cuarta posición, `sampled` (L5), que **no está en el formulario del
cliente**: la abre un operador a mano, cliente por cliente. Nada se automatiza
antes de haberse hecho tres veces a mano (§13.3).

Y cambia una cosa que estaba escrita: **la CMO deja de estar forzada a
`propose`.** El principio §13.1 —el agente que razona sobre dinero no toca
dinero— sigue intacto y ahora se aplica con precisión: el President tiene
`budget.shift` con techo de plataforma L2 (prepara la reasignación, no la
ejecuta) y su autonomía queda fija. La CMO nunca razonó sobre el presupuesto; lo
que la frenaba era la falta de granularidad, no el principio.

### El SLA de las tarjetas

Cada tipo declara qué pasa si el humano no contesta:

| Tipo | SLA | Al vencer |
|---|---|---|
| `campaign_launch` | 48 h | rechaza (fail-safe) |
| `envelope_exceeded` | 24 h | rechaza |
| `pause_losing_campaign` | 4 h | **aprueba** (fail-open) |
| `suppression_add` | 4 h | **aprueba** |

La regla: **si no contestar puede hacer daño, se rechaza; si no contestar ES el
daño, se aprueba.** Sin esto el sistema se congela cuando el cliente está de
vacaciones, que es cuando más falta hace que siga funcionando.

## Consecuencias

- `activateCampaign()` y `dispatchDue()` pasan por el motor. El despachador gana
  una sexta verificación por lote: la aprobación autorizó la campaña una vez, el
  sobre limita el ritmo todos los días. Un cliente que aprobó 5.000 correos no
  aprobó 5.000 hoy.
- Toda acción nueva de agente tiene que declarar su `capability_id` en el
  catálogo de `0007_gobierno.sql` **en el mismo PR** que la implementa. Una
  capacidad que no está en el catálogo da `blocked`, así que el olvido se nota
  enseguida — pero se nota en producción, y ese es el momento equivocado.
- `guard_events` es la respuesta a "¿qué frenó la correa?", y para el cliente
  que duda de abrirle más autonomía a un agente es el argumento más convincente
  que tenemos.
- `/api/health` (`db:v5`) le pregunta al motor por `partnership.commit` y exige
  `blocked`. No comprueba que las tablas existan: comprueba que el motor diga
  que no.

## Lo que este ADR prohíbe

Ejecutar una acción de agente sin pasar por `authorize()`. Y subir un techo de
plataforma para desbloquear a un cliente puntual: si un cliente necesita más, se
mueve su grant o su plan. El techo de plataforma es la promesa que le hacemos a
todos los demás.
