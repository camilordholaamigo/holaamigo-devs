# ADR 0012 · El feed del President y la cola de decisiones

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Tensiona con:** PRD §13.6 — "la cola de decisiones es el producto"

## Contexto

v2 le da voz al President: propone envíos, pide cosas al humano, resume lo que
pasó y avisa cuando algo se rompe. Cuatro tipos de mensaje muy distintos.

`approvals` ya existía y es la cola de decisiones: el registro auditable de
quién aprobó qué y por qué. La tentación es meter todo ahí — un tipo más de
`kind` y listo.

## Decisión

**Dos tablas con dos trabajos distintos:**

- **`approvals`** — el registro de decisiones. No cambia. Es la auditoría.
- **`feed_items`** — cómo el President le habla al humano. Cinco tipos:
  `proposal`, `ask`, `digest`, `alert`, `win`.

Un `feed_item` de tipo `proposal` **siempre** crea su fila en `approvals` y
guarda el `approval_id`. La decisión se audita en un solo lugar.

## Por qué

**1 · La mitad de lo que el President dice no es una decisión.** "Ayer salieron
340 correos y contestaron 21" no se aprueba ni se rechaza. "Pausé la campaña
porque los rebotes pasaron del 3%" tampoco: ya pasó. Meterlos en la cola de
decisiones convierte la cola en un timeline, y ahí muere el principio §13.6 —
si la cola tiene items que no se deciden, deja de ser una cola.

**2 · El feed necesita cosas que una aprobación no tiene:** un tipo de insumo
pedido (`input_kind: 'video'`), una respuesta con payload (el link del video),
una clave de deduplicación (un digest por día), una severidad visual.

**3 · La auditoría no se puede partir en dos.** Por eso las propuestas escriben
en las dos tablas y `respondFeedItem` actualiza ambas en la misma operación.

## El principio operativo: no saturar

`MAX_OPEN_ITEMS` (4 por defecto, configurable por el cliente). Si ya hay cuatro
cosas esperando decisión, **el President no propone una quinta**.

Esto no es una optimización de UI: es la diferencia entre un humano involucrado
y uno que aprueba sin leer. El día que alguien aprueba sin leer, todo el modelo
de "el humano decide" se volvió teatro, y el sistema queda operando con la
apariencia de supervisión y ninguna supervisión real.

Por la misma razón hay deduplicación por día en `dedupe_key`: un digest diario,
una alerta por regla por campaña por día, una propuesta por campaña por día.

## Consecuencias

- Aprobar es un clic. Rechazar exige nota. Misma asimetría que
  `/api/approvals/[id]/decide`: rechazar sin explicar destruye la única señal de
  aprendizaje que tenemos.
- La evidencia va **siempre visible** en la tarjeta, no detrás de un "ver
  detalles". Pedir permiso con la cifra escondida es pedir un cheque en blanco.
- Un `ask` sin responder no se vuelve a pedir: se pregunta una vez por campaña.
- El admin sigue viendo `approvals` en `/admin/approvals`. El cliente ve el feed
  en `/consola/[orgId]`. Misma decisión, dos superficies, un registro.
