# 13 · El feed del President y la autonomía de los agentes

Cómo el sistema le habla al humano, y cuánto puede hacer sin él.

Decisión de fondo en [ADR 0012](../adr/0012-feed-y-cola-de-decisiones.md).

---

## Dos tablas, dos trabajos

- **`approvals`** — el registro de decisiones. La auditoría. No cambió.
- **`feed_items`** — cómo el President habla. Cinco tipos.

Un `feed_item` de tipo `proposal` **siempre** crea su fila en `approvals`. La
decisión se audita en un solo lugar.

| Tipo | Qué es | Requiere |
|---|---|---|
| `proposal` | "Propongo enviar a X personas, cuesta Y créditos. ¿Apruebas?" | Aprobación |
| `ask` | "Grábame 40 segundos y lo editamos" | Insumo del humano |
| `digest` | "Ayer salieron 340 correos y contestaron 21" | Nada |
| `alert` | "Pausé la campaña: los rebotes pasaron del 3%" | Nada |
| `win` | "Cita agendada con Juan para el jueves" | Nada |

---

## El briefing diario

`runDailyBriefing()`, una vez al día desde `/api/cron/dispatch`. Seis pasos:

1. **El resumen de ayer.** Enviados, respuestas, citas, ventas, créditos.
2. **Reglas de iteración.** Si alguna campaña se salió de rango, alerta — y
   pausa si la regla lo dice.
3. **Saldo bajo.** Por debajo del umbral, aviso antes de proponer nada más.
4. **¿Hay espacio en la cabeza del operador?** Si no, se calla y termina acá.
5. **La propuesta de envío.**
6. **Lo que necesita del humano.**

### No saturar es una regla, no un detalle

`MAX_OPEN_ITEMS` (4 por defecto, configurable). Si ya hay cuatro cosas
esperando decisión, el President **no propone una quinta**.

Esto no es una optimización de interfaz: es la diferencia entre un humano
involucrado y uno que aprueba sin leer. El día que alguien aprueba sin leer, el
modelo de "el humano decide" se volvió teatro y el sistema queda operando con la
apariencia de supervisión y ninguna supervisión real.

Por la misma razón hay `dedupe_key`: un digest por día, una alerta por regla por
campaña por día, una propuesta por campaña por día. El cron corre cada 5
minutos; solo el primero del día publica.

### Se propone lo que realmente cabe

La propuesta usa `min(audiencia disponible, capacidad de las bandejas hoy)`.
Proponer 2.000 envíos cuando las bandejas aguantan 180 es pedir permiso para
algo que no va a pasar.

### El President redacta, no estima

Todas las cifras llegan calculadas en el `input`: audiencia, créditos, saldo
antes y después, respuestas y citas esperadas. El prompt lo dice explícito: *"si
una cifra no está en el input, no existe y no se menciona"*.

Un agente que inventa el costo de su propia propuesta es un agente que pide
permiso para gastar una cantidad que no conoce. Ver
[ADR 0007](../adr/0007-numeros-deterministas.md) y
[ADR 0011](../adr/0011-creditos.md).

Si el modelo falla, hay una propuesta de respaldo con las mismas cifras y peor
prosa. Nunca se pierde la propuesta por un fallo de redacción.

---

## Responder

| Decisión | Qué pasa |
|---|---|
| `approved` | Se activa la campaña, se materializan los envíos, se marca la aprobación |
| `rejected` | **Exige nota.** Campaña archivada, envíos cancelados |
| `answered` | Guarda el payload (el link del video, el dato pedido) |
| `dismissed` | Cierra el item sin efecto |

Aprobar es un clic; rechazar exige nota. La fricción está del lado del rechazo a
propósito: aprobar sin pensar es barato de revertir, rechazar sin explicar
destruye la única señal de aprendizaje que tenemos sobre por qué algo no servía.

La evidencia va **siempre visible** en la tarjeta, no detrás de un "ver
detalles". Pedir permiso con la cifra escondida es pedir un cheque en blanco.

---

## La autonomía

`lib/agents/config.ts`.

### Contrato vs configuración

| | Qué es | ¿Editable? |
|---|---|---|
| **Contrato** | Objetivo, presupuesto, permisos, escalamiento | **No.** Ni por el admin |
| **Configuración** | Cómo trabaja dentro del contrato | Sí, por el cliente |

Si "prohibido enviar sin aprobación" se pudiera apagar en un formulario,
dejaría de ser una prohibición y sería una sugerencia con mala prensa. Por eso
la pantalla de agentes muestra el bloque **PROHIBIDO** justo debajo del
formulario, en gris y sin controles: el cliente tiene que ver dónde termina su
capacidad de configurar.

### Los tres niveles

| Nivel | Qué puede hacer solo |
|---|---|
| `propose` | Nada. Propone todo. **Es el default.** |
| `approve_each` | Agendar. Lo demás lo pasa al humano. |
| `auto_within_limits` | Agendar y responder lo que sabe responder. |

Ni en `auto_within_limits` el agente lanza una campaña, cambia un precio o
escribe a alguien sin base legal. Eso es contrato, no autonomía.

**El President y el CMO están fijos en `propose`.** No ejecutan nunca — §13.1,
el agente que razona sobre dinero no toca dinero. `sanitizeAutonomy` lo fuerza
aunque llegue otra cosa en el formulario.

### Lo que sí se configura

- **President:** hora del resumen, cuántas cosas abiertas tolera, si propone
  envíos.
- **CMO:** cómo suena la marca, qué nunca dice, idioma.
- **SALES:** si agenda solo, si responde solo, tope diario propio, franja
  horaria y días de envío.

La franja horaria la respeta el cron antes de armar el lote. Un correo comercial
que llega un domingo a las 11 de la noche dice más de nosotros que su contenido.
Los mensajes fuera de franja no se pierden: esperan a la mañana.

Todos los topes se acotan **en el servidor**, no en la UI, y la respuesta
devuelve lo que quedó guardado para que el formulario muestre el valor real.
