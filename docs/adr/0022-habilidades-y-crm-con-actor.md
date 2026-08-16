# ADR 0022 · Qué puede usar un agente, y un CRM que sabe quién hizo qué

- **Fecha:** 2026-08-16
- **Estado:** aceptada
- **Parte 6 del plan de la meta-organización** (`docs/plan/meta-organizacion.md`)

## Contexto

P2 definió **qué puede hacer** un agente: seis niveles, tres diales, un sobre.
Lo que no definió es **qué puede usar**. Son dos preguntas distintas, y con solo
la primera se llega a un absurdo concreto: un agente con permiso L4 para
contactar partners y sin forma de buscarlos tiene una autorización que no puede
ejercer.

Y hay un segundo problema, del lado del cliente. Los contactos que trae de
HubSpot son suyos, pero llegan crudos: sin segmentar, sin temperatura, sin saber
a quién conviene escribirle primero. Si aparecen directamente como leads
trabajables, lo más probable que pase es que alguien mande una campaña a los
8.000 y queme la base entera en una tarde.

## Alternativas consideradas

**A · Una lista fija de herramientas por rol, en código.** Descartada porque
convierte "darle LinkedIn a este cliente" en un despliegue, y porque no deja
lugar donde registrar que un agente lo pidió.

**B · Que el agente use cualquier herramienta y el permiso lo resuelva la
herramienta.** Descartada: cada integración tendría que reimplementar el modelo
de permisos, y la primera que lo haga distinto abre el hueco.

**C · Un registro con intersección en runtime, y un loop donde los agentes
piden.** Elegida.

## Decisión

### El tool list es una intersección de cuatro conjuntos

```
habilidades = otorgadas al rol
            ∩ habilitadas para esta org
            ∩ permitidas por el plan
            ∩ alcanzables con el nivel de capacidad actual
```

El cuarto conjunto es el que une P2 con P6, y se calcula con **las mismas
funciones del motor de permisos** (`techo_de_plan`, `techo_de_autonomia`,
`rango_de_plan`). De nada sirve tener LinkedIn habilitado si el agente no tiene
permiso para acciones de esa clase de riesgo.

Consecuencia que la prueba deja explícita: subir la autonomía de la CMO hace
aparecer una habilidad de comunicación externa **sin desplegar nada**, y bajar
el plan la hace desaparecer aunque el grant siga ahí.

`skill_grants.organization_id = null` significa "todas las organizaciones", y la
fila específica de una organización **le gana** a la global — así se apaga una
habilidad para un cliente sin tocar a los demás.

El índice único usa una columna generada `scope_key = coalesce(organization_id,
uuid_cero)`, exactamente el patrón de `quiz_responses.answer_key` (ADR 0015): un
índice con `coalesce` adentro es de expresión y no puede arbitrar un
`on conflict`. El UUID cero no puede ser el default de la columna real porque hay
una clave foránea a `organizations`.

### La regla dura, hecha cumplir por un trigger

Ninguna habilidad de clase `spend` o `irreversible` se enciende:

- por el sistema (solo un operador), ni
- sin un sobre con límites.

```
la habilidad stripe.charge es de clase spend: solo la enciende un operador
la habilidad n8n.trigger es de clase irreversible y exige un sobre con límites:
  sin tope no es un permiso, es una firma en blanco
```

La ruta de admin atrapa el caso antes para dar un mensaje que dice qué hacer, en
vez de dejar salir el error crudo de Postgres — pero **el que lo impide es el
trigger**, no la ruta.

### El "intraer": los agentes empujan capacidades hacia sí mismos

Cuando un agente se topa con un muro, deja un `skill_request` con su
justificación y **la decisión que quedó bloqueada**. Esa segunda parte es la que
hace la tarjeta útil: un pedido sin la decisión que frenó es una lista de
deseos; con ella es evidencia de producto.

`conHabilidad()` es el patrón hecho función, porque el patrón correcto tiene que
ser el más corto de escribir. Un llamador que comprueba la habilidad a mano y se
olvida de registrar el pedido deja al agente mudo contra el mismo muro todas las
corridas, y nadie se entera nunca.

Un índice único parcial evita que chocar contra el mismo muro genere cien
tarjetas idénticas.

Ese loop es lo que hace que el sistema crezca solo — y también lo que hace que no
crezca solo del todo: **los agentes piden, nosotros decidimos cuáles existen.**

### Los contactos importados no entran a operación

Aterrizan en `staging_contacts` y se quedan ahí hasta que se corra un lote de
análisis. Es deliberado por dos razones, y la segunda es la importante:

1. Obliga a pasar por el paso que paga.
2. Evita que 8.000 contactos crudos aparezcan como leads trabajables, que es la
   forma más rápida de que alguien le escriba a quien no debía.

**El sistema propone el tamaño del lote, no el cliente.** Un cliente al que se le
pregunta "¿cuántos querés analizar?" elige mal en las dos direcciones: o mil
para probar y no ve señal, o los ocho mil de una y gasta el trimestre en una
corazonada. La regla es explicable en una frase —los que interactuaron en los
últimos 18 meses, acotado a lo que el saldo alcanza— y por eso se puede
discutir.

Nunca se propone un lote que el saldo no cubre: pedirle al cliente que compre
créditos antes de haber visto que esto sirve es el orden equivocado.

El cobro (`holaamigo.cobrar_lote`) es **atómico en SQL**: entre leer el saldo y
escribir el débito, dos aprobaciones simultáneas lo dejarían en negativo. El
estado del lote es el candado que impide cobrarlo dos veces.

La clasificación de temperatura es **por reglas de recencia, no por modelo**
(ADR 0007). Un contacto que escribió hace un mes está más cerca de comprar que
uno que no contesta hace dos años: no hace falta un modelo para saberlo, y con
reglas el cliente puede discutir el umbral.

### El CRM: trazabilidad de actor

Lo que lo distingue no es el pipeline. Es que cada toque sabe **quién** lo hizo
—agente o humano—, **qué decisión** lo originó y **cuánto costó**:

```
la CMO propuso el ángulo → SALES envió → el lead respondió →
el agente calificó → EL HUMANO ENTRÓ ACÁ → se agendó → se cerró
```

Ningún CRM del mercado puede pintar esa línea, porque ninguno tiene el concepto
de "esta acción la tomó un agente por esta decisión". Y `origin_decision_id` es
lo que después contesta la quinta pregunta de P4: *¿qué decisión de hace 60 días
funcionó?*

La vista `lead_timeline` resuelve el costo por paso: sale del toque si lo tiene,
y si no, de la decisión que lo originó (donde P1 lo imputó). Se resuelve en la
vista y no en el llamador porque es la pregunta que se hace **siempre** al mirar
un lead: "¿cuánto nos costó perseguir a este?".

Las probabilidades por etapa son constantes declaradas, no un modelo: con menos
de cien oportunidades cerradas, cualquier probabilidad "aprendida" es ruido con
decimales. Que sea una tabla de constantes hace obvio que es una convención.

## Consecuencias

- La tabla `integrations` ya existía desde `0003` (SendGrid, Instantly). Se
  **extiende**, no se recrea: un `create table if not exists` sobre una tabla con
  otra forma no falla, simplemente no hace nada — y el error aparece después, en
  la primera escritura, con un mensaje que no dice por qué. Lo encontró la
  prueba.
- Los proveedores nuevos usan `credentials_ref` (el nombre de la variable de
  entorno) en vez de `credentials` (el secreto en la tabla). Los viejos se migran
  cuando se toquen.
- `/api/cron/datos` sincroniza, propone lotes y corre los aprobados. El sync pasa
  por `conHabilidad`, así que una organización cuyo agente no alcanza la
  habilidad deja un pedido en el admin en vez de fallar en silencio.
- Los lotes corren en el cron y no al aprobar: el cliente aprueba desde el feed y
  esa petición tiene que contestar rápido. Analizar 1.200 contactos no cabe en el
  tiempo de un clic.

## Lo que este ADR prohíbe

Encender una habilidad de clase `spend` o `irreversible` desde código, un job o
la UI de admin. Y promover contactos de staging a `leads` sin que hayan pasado
por un lote analizado: la promoción vive en `promoverAnalizados()` y solo mira
los que están en estado `analyzed`.
