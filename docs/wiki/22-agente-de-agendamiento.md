# 22 · El agente de agendamiento

> Cómo pasamos de "el cliente leyó su diagnóstico" a "el cliente tiene un agente
> que agenda citas por WhatsApp", sin que escriba nada.
>
> Decisión de fondo: [ADR 0024](../adr/0024-el-agente-se-compila-del-diagnostico.md).

---

## El recorrido, de punta a punta

```
quiz → diagnóstico → /conectar → [WhatsApp]
                                     │
                                     ▼
                          POST /api/agent/build   (NDJSON en vivo)
                                     │
              ┌──────────────────────┴──────────────────────┐
              ▼                                             ▼
    compilePlaybook()                            buildKnowledgeBase()
    · lee research + Brief + quiz                 · redacta 8-24 documentos
    · pide LENGUAJE al modelo                     · crea el vector store
    · pone los NÚMEROS con código                 · espera a que indexe
    · blanquea cifras no autorizadas              · si falla, el agente sigue
    · mide cobertura
    · guarda agent_playbooks v1
                                     │
                                     ▼
                              /agente/[orgId]
                    1. Háblale        (simulador, mismo runtime)
                    2. Confirma 4     (lo que inferimos, un tap)
                    3. Da tu número   (lo único que sigue tardando)
```

Todo lo de la columna izquierda pasaba antes por correo y tardaba dos semanas.

---

## El playbook

Es el manual de operación del setter: un objeto de datos versionado, no un
prompt. Vive en `holaamigo.agent_playbooks`, uno vigente por organización.

| Bloque | Qué guarda | Quién lo escribe |
|---|---|---|
| `oferta` | Qué vende la empresa, sus productos, y **qué vende el agente en esta conversación** (la cita, no el producto). Precio con su política. | Código, salvo la frase de "lo que vendemos acá" |
| `calificacion` | Las cuatro preguntas, en orden, con qué descalifica. Cuántas hacen falta antes de proponer horario. | Modelo escribe, código ordena y pone el mínimo |
| `objeciones` | Objeción → respuesta. Cinco obligatorias, existan o no en la salida del modelo. | Modelo, con respaldos del código |
| `faq` | Lo que preguntan siempre de ESE negocio, sacado del sitio. | Modelo, con fuente |
| `agendamiento` | Duración, zona, franja, link, modalidad, quién atiende, cuántos horarios por mensaje. | Código, desde el activo `scheduler` real |
| `guion` | Apertura fría, apertura inbound, puente a la cita, oferta de horarios, confirmación, tres seguimientos, cierre cortés. | Modelo |
| `escalamiento` | Qué manda la conversación a un humano. Nunca vacío. | Contrato de SALES + modelo |
| `prohibiciones` | Del Brief, duras. | Código |
| `tono` | Descripción, palabras prohibidas, tuteo o usted, emojis. | Brief + config de la CMO |
| `cobertura` | Qué se sostiene con fuente, qué inferimos, y la lista de "confirmá esto". | Código |

### La invariante que hay que poder verificar leyendo

`PlaybookLanguageSchema` en `lib/ai/schemas.ts` **no tiene un solo `z.number()`**.
El precio, la duración, la franja, los topes y las fechas los pone
`lib/playbook/compile.ts` desde el Brief y desde la configuración real del
agendador.

Y por si el modelo escribe una cifra en un campo de texto, `blanquearCifras()`
la borra. Solo sobreviven las que el research leyó textualmente en el sitio del
cliente y el ticket promedio del Brief. El resto se reemplaza por "lo hablamos
en la llamada", que además es lo que un setter debería estar diciendo cuando
aparece un precio.

Porcentajes y duraciones no se tocan: "en 15 minutos" no compromete plata.

### Lo que la base hace cumplir

Dos `check` constraints, porque el compilador puede tener un bug y el cliente
puede borrar el último renglón desde el editor:

- Un playbook **activo** sin disparadores de escalamiento no se guarda. Un guion
  que no escala es un agente que contesta todo, incluida la pregunta legal.
- Un playbook **activo** sin preguntas de calificación tampoco. Un setter que no
  califica es un contestador automático.

Un `draft` sí puede estar incompleto: es lo que permite guardar a mitad.

---

## El oficio, escrito una vez

`OFICIO_DEL_SETTER` en `config/prompts.ts` lo comparten el compilador (que
escribe el guion) y el runtime (que lo ejecuta). Si estuviera duplicado, un día
el guion diría una cosa y el agente haría otra — y el cliente ve el guion.

Los diez puntos, en corto:

1. **El objetivo es la cita, no la venta.** El momento en que empiezas a vender
   es el momento en que dejas de agendar.
2. **Una pregunta por mensaje.** Dos preguntas reciben una respuesta, siempre la
   fácil.
3. **Nunca "¿cuándo te queda bien?".** Dos horarios concretos que existan.
4. **Máximo 45 palabras.** Si necesita punto y aparte, es un correo disfrazado.
5. **Contesta antes de preguntar.** Ignorar la pregunta para seguir el guion es
   cómo se consiguen bloqueos.
6. **Di de dónde salió el número** en el primer mensaje en frío. Ley 1581 de
   2012, y además desarma la objeción más común antes de que aparezca.
7. **Nunca dos mensajes seguidos** sin respuesta. Tres seguimientos como máximo
   y el tercero ofrece una salida limpia.
8. **Un emoji como máximo.**
9. **"No me escribas más" se obedece al instante**, sin una última oferta.
10. **No inventes disponibilidad, precios ni nombres.**

### Los cuatro ejes, en este orden

`dolor → encaje → momento → decisor`. El orden lo impone el código
(`ORDEN_DE_EJES`), no el modelo, aunque el prompt también lo pida.

El dolor va primero porque es lo único que al contacto le interesa contestar en
el primer minuto; las otras tres las contesta porque ya está conversando. Un
setter que abre preguntando quién decide recibe un "¿y tú quién eres?".

Hacen falta **tres de cuatro** para proponer horario. Exigir las cuatro
convierte la conversación en un interrogatorio, y el `decisor` casi siempre se
descubre solo en la cita.

---

## Las herramientas

El tool list es una **intersección calculada en runtime** contra
`holaamigo.habilidades_activas` (ver [wiki/20](./20-integraciones-crm-y-habilidades.md)).
Si una herramienta no está en la intersección, el agente ni siquiera la ve — que
es distinto de verla y que le digan que no. Un agente que sabe que existe una
herramienta prohibida la va a mencionar.

| Herramienta | Qué hace | Capacidad que la gobierna |
|---|---|---|
| `consultar_horarios` | Lee cupos reales del activo `scheduler`, en la zona del contacto | `meeting.offer_slots` |
| `agendar_cita` | Crea la reserva, manda la confirmación, la deja en el CRM | `meeting.book` |
| `registrar_calificacion` | Anota un eje apenas se descubre | — |
| `escalar_a_humano` | Crea la tarjeta en la cola de decisiones | `escalate` (siempre encendida) |
| `no_contactar` | Supresión inmediata y global | `suppression.add` (siempre encendida) |

Las dos últimas **no se consultan contra el catálogo**. Tienen techo de
plataforma L5 por diseño; condicionarlas a una lectura de base sería crear la
posibilidad de que un error de red deje a un agente sin poder pedir ayuda.

### Por qué los horarios son una herramienta y no texto

La alternativa —meter los cupos disponibles en la instrucción de sistema— es más
simple y está mal. La lista se arma al empezar el turno y el contacto puede
tardar cuarenta minutos en contestar, así que el agente ofrece un cupo que ya no
existe. Un contacto que acepta un horario y recibe "ay, se ocupó" es una cita
perdida y una marca dañada, las dos por el mismo bug.

---

## El runtime

`lib/whatsapp/setter.ts`. Un turno = un mensaje adentro, un mensaje afuera.

**La continuidad es `previous_response_id`**, no un historial reenviado. El
turno 20 cuesta lo mismo que el turno 2. La contra es que el historial vive 30
días en OpenAI; por eso `conversation_turns` guarda nuestra copia.

**El estado se reinyecta en cada turno.** `previous_response_id` conserva la
conversación, no el estado de la base: si una herramienta anotó el `dolor` en el
turno 3, el turno 4 tiene que saberlo aunque el modelo lo haya olvidado.

**La autorización se pide por turno, no por conversación.** Entre el turno 3 y
el 4 pueden pasar dos días, y en dos días el cliente puede haber pausado al
agente desde la consola.

**El tope de 55 palabras se aplica en código.** El modelo respeta la regla casi
siempre, y "casi siempre" no alcanza: el mensaje de 200 palabras es el que hace
que el contacto deje de leer. Se corta en la última frase completa.

**La apertura no pasa por el modelo.** Es texto del playbook, que el cliente ya
revisó. Es el único mensaje que sale sin que nadie haya escrito antes — o sea,
el de mayor riesgo — y ser determinista significa que el cliente puede leer
exactamente lo que se va a enviar.

### El orden de los efectos

La supresión gana sobre todo, incluido un agendamiento en el mismo turno. Si
alguien dice "agéndame y no me escribas más", lo segundo es lo que hay que
obedecer.

```
suprimir  →  agendado  →  escalar
```

### El simulador

Corre por el **mismo** camino, con `channel = 'simulador'`. Lo único que cambia
es que las herramientas que tocan a terceros no escriben hacia afuera: no
reserva un cupo real, no crea supresiones, no manda tarjetas.

Un banco de pruebas con su propio código no prueba el agente: prueba el banco, y
el día del estreno aparecen las diferencias.

---

## La base de conocimiento

Un vector store en OpenAI por organización, en `holaamigo.knowledge_bases`.

Un archivo por tema y no un archivote con todo: `file_search` devuelve
fragmentos, y un fragmento que empieza en la mitad de precios y termina en
competidores confunde más de lo que ayuda.

```
negocio.md              oferta, ICP, a quién NO le sirve, diferenciadores
precios.md              lo publicado en el sitio + la política
competencia.md          quién más, qué prometen
objeciones.md           el playbook, otra vez, a propósito
preguntas-frecuentes.md
la-cita.md              duración, modalidad, qué pasa, cómo se cancela
sitio-N-*.md            el texto de cada página, en las palabras del cliente
```

Las objeciones se indexan **además** de estar en la instrucción, y no es
duplicación: la búsqueda semántica encuentra la objeción parecida que el modelo
no relacionó. El contacto no escribe "¿de dónde sacaste mi número?", escribe
"quién te dio mis datos".

El texto de las páginas se persiste desde `0013` en la sección `pages` de
`research_findings`. Antes pasaba por el crawler y moría ahí.

**Si esto falla, el agente sigue funcionando.** Los hechos están en el playbook.

---

## Qué mide, y dónde se mira

| Función SQL | Responde |
|---|---|
| `embudo_del_setter(org, desde)` | De las que abrieron, cuántas contestaron, calificaron, recibieron horario y agendaron |
| `objeciones_que_matan(org, desde)` | En qué escalón se caen y con qué tasa cierra cada uno |
| `embudo_inicial(desde)` | El embudo completo, ahora con "Armó su agente" y "Habló con su agente" |

El embudo cuenta el **escalón más alto alcanzado** (`stage_alcanzado`), no el
actual. Es una marca de agua monótona que mantiene un trigger, y existe por un
bug que encontró la prueba: `cerrar_conversacion()` pone `stage = 'cerrado'`, así
que una conversación que llegó a proponer horario y después escaló quedaba
contada como si nunca hubiera pasado de la apertura. El embudo contaba de menos
exactamente en las conversaciones que más interesan.

El simulador queda fuera. Un embudo que incluye las pruebas del propio cliente
no mide nada.

Dónde se ve: `/consola/[orgId]/agentes` (el embudo del cliente y la instrucción
textual completa) y `/admin/embudo` (el embudo inicial de todos).

---

## Lo que sigue siendo manual, y por qué

Verificar un número con Meta tarda de 24 a 48 horas. Es la cola de revisión de
Meta, no nuestra.

Lo que sí dejó de ser manual es **preguntar**. `WhatsappHandoff` pide los tres
datos que un operador iba a mandar por correo mañana —qué número, si es suyo o
necesita uno, quién atiende las citas— mientras el cliente está mirando su
agente funcionar. La alerta de Slack los lleva, junto con la versión del guion y
su cobertura.

Y el discurso está invertido a propósito: **el agente ya está listo; lo que falta
es el número.** El cliente espera por algo que vio funcionar.

---

## Archivos

```
supabase/migrations/0013_agente_de_agendamiento.sql

lib/playbook/types.ts        la forma, sin imports de servidor
lib/playbook/compile.ts      el compilador y la red que atrapa cifras
lib/playbook/render.ts       playbook → instrucción, función pura
lib/playbook/knowledge.ts    el vector store
lib/playbook/store.ts        leer y corregir el vigente

lib/whatsapp/tools.ts        las herramientas y sus manejadores
lib/whatsapp/setter.ts       el runtime de un turno
lib/ai/client.ts             runConversation() — el bucle de herramientas

app/api/agent/build          NDJSON en vivo, una línea por fase terminada
app/api/agent/chat           el simulador
app/api/agent/playbook       leer y corregir campos

app/agente/[orgId]           háblale · confirma · da tu número
components/agent-builder.tsx     progreso que no finge
components/setter-sandbox.tsx    el chat, con las herramientas visibles
components/playbook-review.tsx   "confirmá cuatro cosas"
components/whatsapp-handoff.tsx  lo único que sigue tardando
components/setter-panel.tsx      el embudo y la instrucción, en la consola

scripts/test-agente-agendamiento.mjs
```
