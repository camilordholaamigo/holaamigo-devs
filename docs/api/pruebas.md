# API interna · el smoke tester

**Para quién es este documento:** alguien que no escribió este código y tiene
que adaptarlo, extenderlo o portarlo a otra aplicación.

No es una lista de firmas — eso lo da el editor. Es el contrato de cada pieza:
qué recibe, qué devuelve, **qué escribe en la base**, qué lanza, y cuál es la
invariante que no se puede romper sin romper el producto.

Regla general del subsistema, y vale para todo lo de abajo:

> **Ninguna función de acá lanza hacia afuera salvo las que dicen que lanzan.**
> Un fallo del smoke tester no puede tumbar el diagnóstico de un cliente. Lo que
> falla, se registra y devuelve un estado degradado.

Y el vocabulario, que era la mitad del problema hasta ADR 0027 y ahora queda
fijo:

| En pantalla | En el código | En la base |
|---|---|---|
| **la prueba** — un guion contra N números desde M líneas | `lote` | `smoke_batches` |
| **la conversación** — una transcripción, un veredicto | `prueba` | `smoke_probes` |
| **nuestras líneas** — los números desde los que escribimos | `canal` | `smoke_channels` |
| **el molde** — lo que no depende del cliente | `plantilla` | `smoke_templates` |

«Tanda» no se usa más. La palabra describía un diseño que ya no existe y por eso
nadie sabía qué hacía el botón.

Índice de módulos:

| Módulo | De qué se ocupa |
|---|---|
| [`types.ts`](#typests) | Los contratos y las constantes de tiempo |
| [`transporte.ts`](#transportets) | Quién manda el mensaje: elige proveedor |
| [`callbell.ts`](#callbellts) | El transporte de Callbell, y la tabla de líneas |
| [`wzap.ts`](#wzapts) | El transporte de wzap |
| [`numeros.ts`](#numerosts) | De dónde salen los números |
| [`compilar.ts`](#compilarts) | Plantilla + research → prueba concreta |
| [`guion.ts`](#guionts) | Formulario → prueba concreta, sin modelo y sin base |
| [`comprador.ts`](#compradorts) | El comprador sintético |
| [`motor.ts`](#motorts) | El motor por eventos |
| [`webhook.ts`](#webhookts) | Correlación de entrantes |
| [`auditor.ts`](#auditorts) | Capa 2 · determinística |
| [`evaluador.ts`](#evaluadorts) | Capa 3 · con modelo |
| [`lanzar.ts`](#lanzarts) | El disparo, con sus frenos |
| [`resumen.ts`](#resuments) | Lo que el cliente ve en vivo |
| [`lote.ts`](#lotets) | Muchas líneas a la vez, con tope |
| [`informe.ts`](#informets) | El análisis y el entregable |

---

## Las seis costuras

Si vas a portar esto a otra aplicación, esto es lo único que hay que
reemplazar. Todo lo demás compila tal cual.

| # | Qué | Dónde | Dificultad |
|---|---|---|---|
| 1 | El cliente de base | `@/lib/supabase/admin` → `db()`, `unwrap()`, `mustWrite()`, `tryWrite()` | Trivial si usás Supabase; mecánico si no |
| 2 | El proveedor de WhatsApp | `callbell.ts` entero | **La importante** |
| 3 | La envoltura del modelo | `@/lib/ai/client` → `runStructured()` | Trivial |
| 4 | La telemetría | `@/lib/events` → `track()` | Trivial (o borrar) |
| 5 | El gobierno | `@/lib/governance/authorize` → `authorize()` | Se puede reemplazar por `() => true` y perder los frenos |
| 6 | Las constantes de tiempo | `types.ts` | **Hay que medirlas contra tu mercado** |

`guion.ts` no está en la lista a propósito: es puro y compila tal cual. Es el
archivo por el que empezar si querés el subsistema andando en una tarde sin
research ni modelo.

**Sobre la 1:** todo lo que se escribe pasa por `mustWrite()` o `tryWrite()` y
nunca por un `await` pelado. No es estilo: `supabase-js` **no lanza**, devuelve
`{ error }`, así que un `await db().from(x).insert(...)` sin mirar el error
compila, corre y no escribe nada en silencio. Si tu cliente de base sí lanza,
podés colapsar las dos en una — pero conservá la distinción semántica:
`mustWrite` es «esto no se puede perder», `tryWrite` es «esto es telemetría».

**Sobre la 6:** las constantes están calibradas para líneas **humanas** de
negocios colombianos. Un bot contesta en 3 segundos y manda ráfagas; una
persona contesta en 4 minutos y manda un párrafo. Copiarlas sin medir es la
forma más rápida de tener un arnés que reporta timeouts falsos.

---

## `types.ts`

Sin lógica. Los contratos y las constantes.

### Contratos que importan

```ts
interface Mensaje { role: 'comprador' | 'negocio'; text: string; timestamp: string }
```

**El formato canónico de la transcripción, y nada más adentro.** Sobrevivió
tres rediseños sin cambiar. Meterle el id del proveedor o el estado de entrega
lo habría matado: cada consumidor tendría que saber qué campos ignorar. Lo que
no es texto y hora va en columnas.

```ts
interface PlanDePrueba { … }
```

La prueba compilada contra un negocio concreto. **Es datos, no un prompt** — se
muestra campo por campo, se versiona y se diffea. Un prompt generado no permite
ninguna de las tres.

Cuatro campos son **opcionales porque las filas escritas antes de ADR 0027 no los
tienen**, y ésa es la única razón:

| Campo | Qué es |
|---|---|
| `modo` | `'conversar'` \| `'guion'`. **No se lee directo: se lee con `modoDelPlan(plan)`.** Un `undefined` colándose a un `switch` deja una conversación vieja sin avanzar y sin decir por qué. |
| `guion` | Solo en modo guion: los mensajes en orden. `guion[0]` **es** `apertura`, duplicado a propósito — `apertura` es el contrato con que el motor arranca cualquier prueba, y derivarlo obligaría a todos los consumidores a saber en qué modo está. |
| `contexto` | Lo que el equipo sabe del negocio, escrito a mano. Va al prompt del comprador y **no a la ficha**: la ficha es lo que se puede citar con URL, y sin fuente no se puede acusar a nadie de inventar un dato (§13.4). |
| `instrucciones` | Cómo se comporta el comprador. Ajusta el tono, nunca los hechos. |

```ts
type ModoDePrueba = 'conversar' | 'guion'
modoDelPlan(plan): ModoDePrueba
```

| | `conversar` | `guion` |
|---|---|---|
| Quién escribe cada turno | el comprador sintético | el operador, de antemano |
| Costo en modelo | ~1 llamada barata por turno | **cero** |
| Detectores de cierre | paran la conversación | **no la paran** — se corren una vez al final |
| Cuándo termina | objetivo cumplido, cierre detectado o topes | se acabaron los mensajes |

```ts
type CerroCon = 'agendado' | 'cotizacion' | 'objetivo_cumplido'
              | 'incompleto' | 'sin_respuesta' | 'bloqueado'
```

El veredicto de negocio, **separado** de `EstadoPrueba` (la salud técnica). Si
`estado` es `failed`, la culpa es nuestra; `cerro_con` habla del negocio.
Mezclarlos deja sin poder distinguir «el agente no cierra» de «se nos cayó el
proveedor».

### Constantes

| Constante | Valor | Cómo recalibrar |
|---|---|---|
| `SILENCIO_MS` | 20 s | p95 del hueco entre dos mensajes seguidos del negocio |
| `SILENCIO_TOPE_MS` | 90 s | Techo por si no paran de escribir |
| `VENTANA_RAFAGA_MS` | 60 s | Cuándo un entrante sigue siendo la misma respuesta |
| `ESTANCADA_MS` | 25 min | 3–4× la peor latencia observada |
| `ZOMBI_MS` | 90 min | Cuándo una prueba viva sin actividad es basura |
| `ENTRE_PRUEBAS_MS` | 90 s | Que el negocio «olvide» la conversación anterior |

---

## `transporte.ts`

El despachador. Existe desde ADR 0028, cuando aparecieron dos proveedores.

```ts
enviarMensaje(spec: EnvioSpec): Promise<ResultadoEnvio>
```

Mira `spec.canal.provider` y llama a `enviarPorWzap()` o a `enviarPorCallbell()`.
**Nadie más en el subsistema mira ese campo.** `motor.ts` pide «mandá este texto
por este canal» y no sabe por qué API salió — y no tiene por qué: agregar un
tercer proveedor es un `case` acá y un archivo nuevo.

`usarPlantilla` se ignora en las líneas de wzap, en silencio y a propósito: el
motor lo manda siempre en el primer turno y no tiene que saber que wzap conecta
por QR y no tiene plantillas.

```ts
faltaParaProveedor(provider: ProveedorDeLinea): Record<string, true>
faltaParaCanal(canal: CanalRow): Record<string, true>
hayTransportePara(canal: CanalRow): boolean
faltaParaLineas(canales: CanalRow[]): Record<string, true>          // sync
faltaParaCanalesPedidos(ids?: string[] | null): Promise<Record<string, true>>
```

Cuatro formas de la misma pregunta, y la diferencia entre ellas es qué se sabe en
el punto donde se llama. `faltaParaLineas()` es sync y sobre filas ya leídas
—las dos pantallas que lo muestran ya cargaron los canales para pintarlos—;
`faltaParaCanalesPedidos()` es la que corre en el POST que crea una prueba, donde
solo hay ids.

**Lo que ya no existe es una pregunta global.** `faltaParaEnviar()` sin argumentos
se fue: con dos proveedores, «falta la llave» solo tiene sentido respecto de la
línea que se va a usar. Y **el canal se resuelve antes de preguntar**: al revés
se abortaba por la llave de un proveedor una prueba que iba a salir por el otro.

---

## `callbell.ts`

El transporte. **Asíncrono**: mandamos un HTTP y la respuesta llega minutos
después por un webhook. Todo `motor.ts` existe para sobrevivir a eso.

```ts
llaveCallbell(): string | null
faltaParaEnviar(): Record<string, true>
hayTransporte(): boolean
```

Precheque de entorno. Se llama **antes** de crear nada. Un 400 con
`{ falta: { CALLBELL_API_KEY: true } }` ahorra horas frente a una prueba que se
creó y «no hizo nada». Desde ADR 0028 la función es
`faltaParaEnviarCallbell()` y el que decide a quién preguntarle vive en
[`transporte.ts`](#transportets).

`llaveCallbell()` es la llave **normalizada**, y el header no lee `process.env`:
lo lee de acá. El panel de Callbell muestra el token ya escrito como cabecera
—`Bearer EmbeccJyn…`— y así es como se copia y pega en Vercel. Con el prefijo
adentro de la variable el header sale `Bearer Bearer …` y la API contesta
`401 {"error":"not authorized"}`, que es indistinguible de una llave vencida:
las dos cosas se ven como «Callbell rechazó la llave». Le sacamos el prefijo, así
que **las dos formas funcionan**. Hay una prueba que verifica que el header no
vuelva a leer la variable directo, porque es el único punto donde el bug puede
regresar. Y `faltaParaEnviar()` mira la cadena normalizada: una variable que solo
contiene `Bearer ` es una variable que falta, y el precheque tiene que decirlo
antes de crear la prueba, no después del 401.

```ts
canalActivo(canalId?: string | null): Promise<CanalRow | null>
canalPorId(canalId: string): Promise<CanalRow>   // lanza si no existe
```

De qué número escribimos. Vive en `smoke_channels` y no en variables de entorno
porque lo cambia alguien de operaciones sin desplegar. La llave de la API sí es
variable: eso es un secreto, esto es un dato.

**El orden es `prioridad` y el menor gana**, con `created_at` de desempate. Hasta
0018 era `created_at` a secas, que con un solo proveedor era exactamente
correcto; con dos, la antigüedad de la fila es un accidente del día que se cargó.
Y `channel_uuid` guarda el `channel_uuid` de Callbell **o el `device` de wzap**,
según el proveedor de la fila.

```ts
enviarPorCallbell(spec: EnvioSpec): Promise<ResultadoEnvio>
// → { ok, messageId, error, pista }
```

Se llama a través de `enviarMensaje()` de [`transporte.ts`](#transportets), nunca
directo. **Nunca lanza.** Devuelve `pista`, que es un texto accionable («Callbell rechazó
la llave. Revisá CALLBELL_API_KEY»), no el error crudo. Es lo que hace que el
que ve el problema no necesite acceso a los logs.

`usarPlantilla: true` solo hace algo si el canal tiene `template_uuid`. Con una
línea por QR queda en null y se abre con texto libre; con WhatsApp Business API
oficial, el primer mensaje a un número sin conversación abierta **tiene** que
ser una plantilla aprobada por Meta.

```ts
describirFalloDeRed(err: unknown): { mensaje: string; pista: string }
```

Desempaca `err.cause`. El `fetch` de Node envuelve todo error de red en un
`TypeError` cuyo mensaje es literalmente «fetch failed»; sin esto, un incidente
de DNS y uno de firewall se ven idénticos.

```ts
parsearEntrante(raw: unknown): Entrante | null
// → { candidatos: string[], texto, direccion, nombre, proveedorId, recibidoAt }
```

**`candidatos` es TODOS los teléfonos del payload, no uno.** La documentación de
Callbell muestra, para un mensaje recibido, `to` y `contact.phoneNumber` con el
número del contacto y `from` con el nuestro — al revés de la intuición. Y este
webhook además recibe reenvíos de otra aplicación que puede reordenarlos. En
vez de apostar a un campo, se juntan todos y se prueba cada uno.

Tolerante por diseño: extractor recursivo de profundidad 4 sobre nombres de
campo conocidos. Un parser estricto perdería mensajes en silencio, que es el
peor modo de fallo posible acá — sin el entrante la conversación se cuelga y el
número queda reportado como «no contestó», que sería mentira.

```ts
resumirPayload(raw: unknown): Record<string, unknown>
```

La **forma** del payload sin su contenido. Se loguea siempre, antes de parsear.
Es lo único que queda cuando el proveedor cambia el formato sin avisar.

---

### Varias líneas

```ts
canalActivo(canalId?): Promise<CanalRow | null>     // la primera activa
canalesActivos(): Promise<CanalRow[]>               // todas, por orden de creación
canalPorId(canalId): Promise<CanalRow>              // lanza
```

Desde ADR 0027 **varias líneas es la unidad de escala**: cada una abre su propio
hilo de WhatsApp, así que tres líneas permiten ver si el agente de un negocio les
contesta igual a tres clientes a la vez, y suben el techo diario sin acercarse al
umbral de spam de Meta.

`canalActivo()` sigue existiendo y sigue devolviendo **una**: el camino automático
del diagnóstico no tiene por qué elegir. Con una sola línea configurada —el estado
de partida— todo se comporta exactamente igual que antes.

`Entrante` gana un campo por esto:

```ts
interface Entrante { candidatos: string[]; canalUuid: string | null; … }
```

`canalUuid` es lo que desambigua cuando dos de NUESTRAS líneas tienen una
conversación viva contra el mismo negocio. Se busca en `channel_uuid`,
`channelUuid`, `channel_id`, `channelId` y `channel.uuid`, recursivo hasta
profundidad 3, porque la aplicación que reenvía usa una forma distinta de la de
Callbell. Devuelve `null` sin drama: la desambiguación tiene otro camino y no
puede depender de que el proveedor no cambie nunca el nombre del campo.

---

## `wzap.ts`

El segundo transporte. `POST https://api.wzap.chat/v1/messages`, cabecera
`Token: <llave>` **sin prefijo**.

El contrato de acá no salió de la documentación del proveedor —pide sesión— sino
de tres llamadas contra la API real, y la tabla de cómo se verificó está en
[ADR 0028](../adr/0028-dos-transportes.md).

```ts
llaveWzap(): string | null
faltaParaEnviarWzap(): Record<string, true>
```

`llaveWzap()` le saca el prefijo `Token ` a la variable, por el mismo incidente
que `llaveCallbell()` con `Bearer`: el panel muestra el secreto ya escrito como
cabecera y así es como se copia. Con el prefijo adentro el header sale
`Token Token …` y la API contesta 401, indistinguible de una llave vencida.

```ts
enviarPorWzap(spec: { canal, to, texto }): Promise<ResultadoEnvioWzap>
```

**Falla antes de tocar la red si el canal no trae `device`.** No es una guarda de
tipos: el `device` es opcional en la API de wzap, y omitirlo hace que el proveedor
elija la línea. La misma llave ve **todas** las líneas de la cuenta, incluidas las
de otros negocios — en la cuenta con la que se puso esto en marcha había cuatro
devices y tres eran líneas de atención reales. Un POST sin `device` es un mensaje
de prueba saliendo desde la línea de un cliente.

Las pistas se derivan del `errorCode` que devuelve wzap (`phone:invalid`,
`device:invalid`) y no solo del status, que es lo que las hace accionables.

```ts
parsearEntranteWzap(raw: unknown): Entrante | null
```

Devuelve el **mismo** `Entrante` que el parser de Callbell, así que
`correlacionar()` no sabe de proveedores. Dos diferencias que importan:

- **La dirección sale del nombre del evento** (`message:in:new` contra
  `message:out:new`), no de la ausencia de un campo. Es la peor adivinanza del
  parser de Callbell y acá no existe.
- **`canalUuid` sale del `device`**, que es lo que `smoke_channels.channel_uuid`
  guarda para las filas de wzap. Así la desambiguación por línea de
  [`webhook.ts`](#webhookts) sigue funcionando sin cambios.

Devuelve `null` si no reconoce la forma, y la ruta cae al parser genérico de
Callbell dejando un `warn` en el log. Eso es deliberado: la forma exacta del
payload no está verificada contra un mensaje real todavía, y perder un entrante
en silencio cuelga la conversación y reporta al negocio como «no contestó» — una
cifra falsa en el informe de un cliente.

```ts
resumirPayloadWzap(raw: unknown): Record<string, unknown>
pistasDeBotones(raw: unknown): string[]
```

`pistasDeBotones()` devuelve qué claves del payload huelen a mensaje interactivo
(`buttons`, `listMessage`, `interactive`, `sections`…). **No clasifica, no puntúa
y no escribe nada**: solo deja en el log si el puente de wzap nos entrega la
estructura de un mensaje con botones o si la aplana a texto. Es la pregunta que
originó ADR 0028 y todavía no tiene respuesta — un menú que llega como texto
plano y uno que llega con sus opciones adentro se ven idénticos en la
transcripción. Cuando haya payloads reales, qué hacer con esto va en otro ADR.

---

## `interactivos.ts`

```ts
extraerInteractivo(data: unknown): { texto, opciones, clase }
conOpciones(texto: string | null, opciones: OpcionInteractiva[]): string
opcionesDelTexto(texto: string): OpcionInteractiva[]
elegirOpcion(respuesta: string, opciones: OpcionInteractiva[]): string
```

Mensajes con botones, listas o encuestas. **Puro**: no importa nada de servidor
ni lee `process.env`, y hay una prueba que lo verifica.

Nació de un payload real que rompía el parser: una encuesta entrante llega con
`body: null` y todo el contenido colgando de `poll.name` + `poll.options[]`. Como
`parsearEntranteWzap` exigía texto, el mensaje se descartaba, la conversación
quedaba esperando y el negocio salía reportado como «no contestó».

**Las opciones se renderizan al texto, numeradas desde 1.** No se guardan aparte
porque `Mensaje` es `{role, text, timestamp}` y ese array no lleva metadata
(ADR 0026). `opcionesDelTexto()` las vuelve a leer cuando hace falta contestar:
es más barato que una columna y no puede desincronizarse del texto, porque **es**
el texto.

**`elegirOpcion()` es cómo se aprieta un botón.** El schema de `POST /v1/messages`
se enumeró campo por campo contra su validador y no existe ningún campo para
responder una opción: no hay `replyTo`, `quoted`, `selectedId` ni `payload`. Se
puede MANDAR un menú, no se puede CONTESTAR uno. Así que se manda el texto de la
opción, aceptando que el modelo la nombre por número o por texto aproximado. Si
no matchea ninguna, devuelve lo que el modelo escribió: forzar una opción que
nadie eligió es peor que una frase libre.

El motor lo aplica **solo en el camino del modelo**. En modo `guion` el mensaje
del operador sale tal cual — el guion es el contrato (ADR 0027).

---

## `numeros.ts`

```ts
aE164(raw: string, country: CountryCode | null): string | null
numerosDelResearch(orgId): Promise<{ numeros, pais, negocio }>
registrarObjetivos(orgId, numeros, nombreNegocio): Promise<void>
MAX_NUMEROS = 3
```

**NINGÚN MODELO ELIGE UN NÚMERO.** El crawler ya extrajo los `wa.me/` y `tel:`
con regex; acá se normalizan, ordenan y se les pone la fuente. Un teléfono es
exactamente el dato que ADR 0007 prohíbe que salga de un modelo: el cliente lo
lee en su diagnóstico, y si está mal le escribimos a un tercero.

Orden por evidencia: `wa.me` (0,95) → `tel:` móvil (0,60) → `tel:` fijo **se
descarta**. Un fijo no tiene WhatsApp; escribirle es gastar un mensaje para
reportar «no contestó», y eso sería falso.

`registrarObjetivos` hace upsert sobre `phone_e164` (índice único **plano**, ver
ADR 0015) y **nunca toca `bloqueado`**.

---

## `compilar.ts`

```ts
compilarPrueba(args): Promise<PlanDePrueba>   // nunca lanza
contextoDelNegocio(orgId): Promise<ContextoDelNegocio | null>
resolverRubrica(raw, ficha): CriterioRubrica[]
plantilla(id): Promise<PlantillaRow>          // lanza si no existe
plantillasActivas(): Promise<PlantillaRow[]>
```

El código pone los hechos (la ficha de verdad con sus URLs), el modelo pone el
lenguaje. `PruebaLenguajeSchema` **no tiene un solo `z.number()`**.

**Sin research corre igual** con el molde crudo: mide atención pero no
exactitud, `cobertura` queda en 0% y el admin lo ve.

### El mini-lenguaje de `chequeo`

Vive en la tabla `smoke_templates.rubrica`, no en TypeScript, para que agregar
un criterio no exija un despliegue.

```
hubo_respuesta            respondio_antes_de:300      dio_precio
propuso_paso_siguiente    pregunto_al_menos:1         menciona:<clave>
no_menciona:a,b,c
```

Un `chequeo` que apunte a una clave que la ficha no tiene se resuelve a `null`,
**no a «no cumplió»**. El criterio pasa a la capa 3 y el informe dice «no se
pudo verificar». Reprobar a un negocio porque nosotros no pudimos leer su sitio
sería inventar un resultado.

---

## `guion.ts`

```ts
planALaMedida({ entrada, rubrica, ficha? }): PlanDePrueba
validarAMedida(entrada): string | null
turnosDe(entrada): number
moldeDelModo(modo): 'a-medida' | 'guion'
cifrasDelPlan(plan): string[]
aperturaSugerida(negocio, producto): string
objetivoSugerido(producto): string
MAX_SONDAS = 6 · MAX_GUION = 8 · PERSONA_POR_DEFECTO
```

`compilar.ts` produce un plan leyendo el research con ayuda de un modelo. **Esto
produce el mismo objeto leyendo un formulario.** Río abajo nadie se enteró: el
motor, el auditor, el evaluador y el informe leen el plan y les da igual quién lo
escribió (ADR 0027, decisión 1).

**ES PURO, Y ES UNA COSTURA MÁS.** No importa la base, ni el cliente de IA, ni
`resolverRubrica` — la rúbrica llega ya resuelta desde el llamador. Dos razones,
y la primera no es negociable:

1. La vista previa del formulario tiene que mostrar **exactamente** lo que se va
   a mandar, y para eso este módulo corre en el navegador. Un preview que se
   calcula distinto de lo que se manda es peor que no tener preview.
2. Se puede probar sin levantar nada.

Si portás el subsistema, este archivo compila tal cual.

**No le pasa `blanquearCifras()` al texto del operador.** La red de cifras existe
para que un MODELO no invente un precio (ADR 0007/0024); acá los números los
escribió una persona que sabe qué está preguntando, y taparle el «¿cuánto vale el
tratamiento de 4 sesiones?» convertiría la herramienta en un adivinador. Lo que
sí hace es declararlas permitidas —`cifrasDelPlan()`— para que el comprador pueda
repetirlas y **ninguna otra**.

`validarAMedida` corre en el cliente para apagar el botón y **otra vez en el
servidor** antes de mandar un mensaje. No es paranoia: la petición del cliente es
un dato de entrada, y del otro lado del botón hay un WhatsApp real.

En modo guion, `sondas` son los mensajes `2..n`. No es una traducción caprichosa:
es lo que permite que el evaluador diga «no contestó la pregunta 3» y que el
informe agrupe por pregunta entre veinte negocios.

---

### Reintentar una prueba

```ts
aMedidaDelPlan(plan: PlanDePrueba): EntradaAMedida
```

El inverso de `planALaMedida()`. Es lo que hace posible el botón **«Reintentar
con el mismo plan»** de `/admin/pruebas/[pruebaId]` sin volver a escribir las
preguntas.

Reintentar **vuelve a mandar el mismo plan; no recompila**. Recompilar contra el
research daría otras preguntas y las dos corridas dejarían de ser comparables,
que es lo único que se quiere de un reintento. Por eso el cuerpo va como
`aMedida` aunque la prueba haya nacido de un molde.

El botón no crea nada por su cuenta: arma un cuerpo y lo manda a
`POST /api/admin/pruebas`, que sigue siendo la única forma de crear una prueba a
mano (ADR 0027).

Lo que **no** viaja en la entrada son la ficha y la rúbrica: se derivan de la
organización del objetivo, así que el cuerpo repite el mismo `organizationId` y
`compilarUnidad()` las vuelve a resolver igual. Sin eso el reintento mediría
atención pero dejaría de medir exactitud.

El botón aparece **solo con la prueba terminada**: dos conversaciones vivas de la
misma línea contra el mismo número son un hilo pisando al otro, y la unidad de
ocupación es el par `(línea, número)`.

---

## `comprador.ts`

```ts
siguienteTurno(args): Promise<TurnoDelComprador>
// → { mensaje, terminar, motivo, fuente: 'ia' | 'heuristico' }
```

**Nunca lanza.** Sin `OPENAI_API_KEY` cae a un comprador de reglas: peor
conversación, mismo flujo completo. Un arnés que se cae cuando falta una
variable deja de usarse a la semana.

Tres cosas lo hacen funcionar, y ninguna es el modelo:

1. **Identidad fija.** Mismo nombre y correo toda la conversación. No es
   realismo: es lo que hace **verificable** la prueba — el dueño puede ir a su
   CRM y confirmar que el lead llegó con ese correo exacto.
2. **Un objetivo.** Sin él la conversación deriva y no llega a un cierre.
3. **Criterio de cierre propio.** Evita dar vueltas hasta agotar los turnos.

Todo lo que devuelve pasa por `blanquearCifras()`: un comprador que se inventa
«vi que cuesta $2.400.000» invalida la prueba entera, porque el negocio
contesta a un dato falso y después el evaluador lo califica por esa respuesta.

---

## `motor.ts`

El corazón. **Nadie espera a nadie**: el estado vive en la base y cada entrante
despierta el sistema, hace un turno y lo apaga.

No es preferencia de estilo. Vercel corta a los 300 s y una persona contesta un
WhatsApp en 4, 20 o 40 minutos: un runner que espera agota su presupuesto en
dos mensajes, muere, y deja la prueba en `running` para siempre envenenando la
correlación de todas las siguientes.

```ts
arrancarPrueba(pruebaId): Promise<{ ok: boolean; error?: string }>
```

Manda el primer mensaje **en primer plano, a propósito**. Es el único momento
donde alguien mira la pantalla, y donde falla el 90% de los problemas de
configuración.

Escribe: `estado='running'`, `conversation[0]`, `turno=1`, `awaiting_reply=true`,
`enviado_at` — **todo antes de enviar**. Armar el receptor antes que el emisor.

```ts
registrarEntrante(pruebaId, texto): Promise<string | null>   // → turn_token
```

Anexa la respuesta y **reserva el turno de forma síncrona**. Es lo que hace que,
de los tres o cuatro webhooks que dispara una ráfaga, gane el último — el que
vio la respuesta completa. Calcula `segundos_primera_respuesta` una sola vez.

```ts
avanzarTurno(pruebaId, token): Promise<void>   // en after(), nunca suelto
```

En **modo guion** la rama del guion corre ANTES de los detectores de cierre, y
ése es todo el punto: si el negocio agenda en el mensaje dos, las preguntas tres y
cuatro se mandan igual — es lo que pidió el que armó el guion, y es lo que hace
comparables veinte conversaciones. Lo único que sigue mandando por encima es
`pidioNoEscribir`. Al agotarse el guion se corre `detectarCierreDeNegocio` UNA vez
sobre `todoDelNegocio(conversation)`, para que `cerro_con` signifique lo mismo en
los dos modos y el embudo siga sumando.

**Hay una prueba que vigila ese orden** (`scripts/test-smoke-tester.mjs`, §8): es
una invariante de posición, y un refactor la rompe sin cambiar una línea.

El trabajo de fondo. Se retira en silencio si otro chunk se llevó el turno —
eso es lo normal, no un error. Orden interno, y los tres detalles que importan:

- **(b) releer el estado** después del settle: pudieron pasar 90 s;
- **(g) reclamar el token tan tarde como se pueda**: redactar tarda segundos y
  en esa ventana puede llegar otro chunk;
- **(h) `awaiting_reply=true` antes de enviar**: si contestan rapidísimo, el
  webhook tiene que encontrar la fila ya armada.

```ts
cerrarPrueba(pruebaId, { estado, cerroCon, motivo, despedida? }): Promise<void>
```

**El único camino de salida, y toda condición pasa por acá.** Corre la
auditoría (capa 2, gratis), escribe el estado terminal, actualiza el
enfriamiento del objetivo y avanza la cola. No existe camino que deje una
prueba abierta — y si existiera, esa prueba sería un zombi.

```ts
avanzarCola(runId, targetId): Promise<void>
```

Serial por número, paralelo entre números. **El espaciado es una guarda, no un
`sleep`**: pregunta «¿cerró hace poco?» y si sí se retira. Dormir acá rompía el
GET de estado (techo 60 s), el stream, y el cron.

```ts
recogerSiEstancada(prueba): Promise<boolean>
cancelarVivasContra(targetPhone, exceptoRunId?): Promise<number>
bloqueDelNegocio(conversation): string
pidioNoEscribir(texto): boolean
detectarCierreDeNegocio(texto): CerroCon | null
formatoDuracion(segundos): string
```

`detectarCierreDeNegocio` es **conservador a propósito**: prefiere no detectar
un cierre a inventar uno. Decirle a un cliente «te agendaron una cita» cuando le
dijeron «te escribo luego» destruye lo único que este producto vende.

`cancelarVivasContra` **necesita** `exceptoRunId` cuando se llama desde la
creación de un lote: sin él, el lote se cancela a sí mismo las pruebas que
acaba de insertar en `pending`.

---

### Lo que se serializa, y por qué el par

```ts
avanzarCola(runId, targetId, canalId): Promise<void>
cancelarVivasContra(targetPhone, canalId: string | null, exceptoRunId?): Promise<number>
todoDelNegocio(conversation): string
```

**La unidad de ocupación es el par (nuestra línea, su número), no el número.** Dos
conversaciones simultáneas desde la MISMA línea al MISMO negocio caen en el mismo
hilo de WhatsApp y ninguna mide nada; desde líneas distintas son hilos distintos y
las dos valen — que es justo la capacidad que ADR 0027 vino a habilitar.

Los dos parámetros nuevos no son adorno:

- sin `canalId` en `avanzarCola`, la conversación de la línea B veía «ya hay una
  corriendo» —la de la línea A— y **nunca arrancaba**;
- sin `canalId` en `cancelarVivasContra`, arrancar la línea B **cancelaba** la de
  la línea A contra el mismo negocio.

`canalId: null` en `cancelarVivasContra` cancela contra ese número desde todas las
líneas. Es lo que usa el botón «Cancelar» del admin, donde la intención es «parale
a todo lo que le estemos escribiendo a este señor».

El espaciado de `ENTRE_PRUEBAS_MS` también es por par: lo que confunde al que
contesta es ver dos hilos seguidos del MISMO número, no que le escriban dos
personas distintas.

`todoDelNegocio` existe al lado de `bloqueDelNegocio` y la diferencia importa:
`bloque` mira el último bloque —correcto para decidir el turno siguiente— y `todo`
mira la conversación entera, que es lo correcto para el veredicto final de un
guion. Si agendaron en el mensaje dos, agendaron.

---

## `webhook.ts`

```ts
correlacionar(entrante): Promise<ResultadoCorrelacion>
mismoNumero(a: string, b: string): boolean
```

**Se empareja por el PAR (nuestra línea, su número)**, y es la decisión con más
consecuencias del subsistema. El paquete original emparejaba contra «la
conversación activa más reciente», lo que impedía correr dos pruebas a la vez
**para siempre**. Emparejar por número arregló eso; el par agregó el otro eje —
tres de NUESTRAS líneas contra el MISMO negocio, donde el número ya no alcanza
porque las tres conversaciones lo comparten.

La desambiguación tiene tres escalones, en orden:

1. el `channel_uuid` del payload;
2. **nuestro propio número** — para un entrante, Callbell lo manda en `from` (al
   revés de lo que dice la intuición) y el parser lo junta con los demás;
3. **a ciegas**: la más reciente que espera respuesta, y queda escrito en el log
   con las palabras `desambiguación a ciegas entre líneas`. Buscá esa frase el día
   que dos conversaciones simultáneas cruzen un mensaje.

El escalón 3 no es una rendición: es el comportamiento que había antes de que
existieran varias líneas, y **con una sola línea es exactamente correcto**.

`porLinea()` **nunca devuelve una lista vacía.** Si el payload trae un
`channel_uuid` que no coincide con ninguna candidata, lo más probable no es que el
mensaje no sea de ninguna: es que el proveedor cambió el nombre del campo.
Descartar ahí perdería el entrante en silencio, que es el peor modo de fallo del
subsistema — sin el entrante la conversación se cuelga y el negocio queda
reportado como «no contestó».

Dos caminos, después de desambiguar:
1. la conversación espera respuesta de ese número;
2. **continuación de ráfaga** — el primer chunk ya bajó `awaiting_reply` y los
   siguientes no tendrían a quién pegarse. Sin este camino la transcripción
   queda mutilada y el evaluador califica media respuesta.

Sin match devuelve `{ tipo: 'sin_match', detalle }` con **el estado del mundo**:
qué conversaciones estaban vivas y contra qué número. Ese log es el que resuelve
los incidentes.

`mismoNumero` compara los últimos 8–12 dígitos. Ocho y no seis: con seis, dos
negocios distintos colisionan y un mensaje se anexa a la conversación
equivocada — peor que perderlo.

---

## `auditor.ts`

```ts
auditar({ plan, conversation, segundosPrimeraRespuesta }): Auditoria
```

**Función pura.** Cero llamadas a modelo, cero varianza, sin dependencias
externas: no puede fallar. Corre al cerrar cada prueba.

```
score = round(pesoLogrado / pesoVerificable × 100) − críticos×10 − advertencias×3
```

Tres invariantes:

- **`paso: null` ≠ `paso: false`.** Null es «no se pudo verificar» y **se
  excluye del denominador**.
- **`verificables === 0` → la interfaz dice «no se pudo verificar», no un cero.**
  Un cero se lee como «lo hiciste pésimo» y lo que pasó fue que no pudimos leer
  su sitio.
- **Crítico ≠ advertencia.** Crítico es «hizo algo que no puede hacer»;
  advertencia es «lo hizo distinto». Mezclarlos deja sin poder distinguirlos.

`verificarMencion` tiene **tres** desenlaces: coincide / contradice (crítico) /
no lo tocaron (`null`). Sin el tercero, un negocio al que nunca se le llegó a
preguntar el precio aparecería reprobado por «no coincide» — una acusación
falsa.

---

## `evaluador.ts`

```ts
evaluarPrueba(pruebaId): Promise<Evaluacion | null>   // nunca lanza
evaluarCerradasSinEvaluar(runId): Promise<number>
```

**El modelo no devuelve números.** Devuelve cinco juicios cualitativos
(`excelente|bien|regular|mal|pesimo`) y el código los convierte con una tabla
fija. Pedirle un 78 es falsa precisión: la misma transcripción le saca 74 y 79.
Con juicios, la varianza se ve y la nota es **una función pura de ellos**.

Sin `ficha` en el plan, `exactitud` y `ausencia_de_invenciones` **no entran en
la nota**: el evaluador no tendría contra qué comparar.

`evaluarCerradasSinEvaluar` existe —y no una llamada desde `cerrarPrueba`—
porque el evaluador importa `leerPrueba` del motor y habría un ciclo. La
consecuencia práctica es buena: cerrar una prueba nunca espera a un modelo.

---

## `lanzar.ts`

```ts
lanzarDesdeElDiagnostico({ organizationId, sessionId }): Promise<ResultadoLanzamiento>
configDePruebas(): Promise<Config>
CLAVE_CONFIG = 'pruebas.bateria'
```

**`lanzarDesdeAdmin()` se fue a `crearLote()` en ADR 0027.** No fue una mudanza
estética: hacía casi lo mismo con otras palabras, y tener dos formas de crear una
prueba a mano era la mitad de la confusión que esa decisión vino a arreglar. Hoy
todo lo manual pasa por `crearLote()`; una conversación suelta es su caso 1×1×1.

Lo que queda acá es el camino **automático**, que es el único que tiene los cuatro
frenos completos — porque es el único donde no hay nadie mirando.

`lanzarDesdeElDiagnostico` **nunca lanza** y se llama al terminar el research.
Ese momento es el primero donde existen los números y el material, y da 4–5
minutos de ventaja sobre el cliente.

**Los cuatro frenos**, y ninguno es opcional:

1. `authorize('smoketest.probe')` — `self_outreach`, techo de plataforma **4**.
   **No** `external_comms`: esa clasificación la dejó bloqueada siempre, porque
   el plan y la autonomía del prospecto la topaban en nivel 1. Ver `0016`.
2. **Propiedad del número** — en el camino automático tiene que estar publicado
   en el sitio de esa organización. Le escribimos al dueño, no a un tercero.
3. **Enfriamiento 72 h**, global por número.
4. **Bloqueo** — ningún camino automático lo revierte.

Apagado sin desplegar: `settings['pruebas.bateria'].activo = false`.

### Lo que rige en cada camino, sin eufemismos

Los cuatro frenos se escribieron pensando en el disparo automático. El camino
manual tiene otros, y hay que decirlo en voz alta (ADR 0027, decisión 5):

| Freno | Automático | Manual (`crearLote`) |
|---|---|---|
| `authorize('smoketest.probe')` | siempre | **solo si hay organización vinculada** |
| Número publicado en el sitio de esa organización | siempre | nunca — lo eligió una persona |
| Enfriamiento de 72 h | siempre | no |
| Bloqueo («no me escriban») | siempre | **siempre, y no lo levanta nada** |
| Espaciado 90 s por par (línea, número) | siempre | siempre |
| Apagado de emergencia en `settings` | siempre | no |

Los tres primeros **no pueden** aplicar al camino manual: no hay organización
contra la que autorizar cuando el operador escribe un número suelto, y el
enfriamiento existe para que cinco recargas de la landing no manden cinco
mensajes — acá hay una persona que apretó un botón una vez, y que muchas veces
necesita volver a probar el mismo número después de haberle cambiado algo al
agente. Lo que se paga a cambio: el bloqueo es terminal en los dos caminos, la
cuenta de mensajes va escrita en el botón, y `GET /api/admin/pruebas?telefono=…`
le dice al operador cuándo fue la última prueba contra ese número **antes** de
mandar.

**El tercer caso: manual pero con organización.** Es el que produce el botón
«Probar como en el diagnóstico» de `/admin/pruebas/nueva`, y no es ninguno de los
dos anteriores: lo aprieta una persona, pero el objetivo lleva
`organizationId`, así que `authorize('smoketest.probe')` **sí** corre y las
preguntas las compila `compilar.ts` leyendo el research de esa organización.
Reproduce a mano el escenario del disparo automático, salvo dos frenos que no
puede tener por definición: el enfriamiento de 72 h (una persona que vuelve a
probar el mismo cliente después de cambiarle algo al agente es el caso de uso, no
el abuso) y la propiedad del número **cuando el research no encontró ninguno** —
ahí lo escribe el operador y queda registrado con `origen: 'manual'` y
`source_url: null`, que es la columna con la que después se distingue una prueba
defendible de una que eligió una persona.

Que un cliente no publique WhatsApp es lo normal, no la excepción, y filtrar la
pantalla por «tiene número conocido» la dejaba vacía justo para los clientes que
sí tienen análisis. La lista sale de `organizations`; el número es un campo que
puede faltar.

---

## `resumen.ts`

```ts
resumenDeCorrida(runId): Promise<ResumenDeCorrida | null>
resumenPorOrganizacion(orgId): Promise<ResumenDeCorrida | null>
```

Lo que el cliente ve en vivo. **Todas las cifras las calcula este archivo**
restando timestamps; el modelo solo aporta prosa, y su esquema no tiene
`z.number()`.

`avance` (0–100) sube **solo con hechos que tienen hora**: 0 → 15 (salió) → 45
(contestaron) → +45 repartido por turno → 100. Entre dos hechos no se mueve. Lo
que corre es el cronómetro, y es real.

---

## `lote.ts`

```ts
crearLote({
  nombre, proposito, objetivos,
  canales?,            // nuestras líneas. vacío = la primera activa
  plantillas?,         // camino A · moldes compilados contra el research
  aMedida?,            // camino B · el guion que escribió una persona
  maxConcurrentes, ritmoSegundos, creadoPor, notas?,
}): Promise<ResultadoLote>
avanzarLote(loteId): Promise<{ arrancadas: number }>
cerrarLoteSiTerminó(loteId): Promise<void>
pausarLote(loteId, estado): Promise<void>
estadoDelLote(loteId): Promise<EstadoDelLote>
objetivosDeOrganizaciones(orgIds): Promise<ObjetivoDeLote[]>
lotesRecientes(limite?): Promise<LoteRow[]>
```

En pantalla esto se llama **la prueba**, y es lo único que crea conversaciones a
mano desde ADR 0027:

```
números × líneas × guiones = conversaciones
```

| Números | Líneas | Qué es |
|---|---|---|
| 1 | 1 | una conversación suelta |
| 1 | 3 | tres clientes distintos escribiéndole a la vez |
| 30 | 1 | el barrido de prospección |
| 30 | 3 | lo mismo, tres veces más rápido |

`ResultadoLote.conversaciones` trae los ids en orden de arranque. Con uno solo, la
pantalla siguiente es la transcripción y no el grupo: una herramienta que no deja
ver lo que acaba de hacer no se vuelve a usar (decisión 6).

**El orden de inserción no es cosmético.** Las filas se agrupan por OBJETIVO y no
por línea, porque `avanzarLote` arranca en orden de creación: así un tope de
concurrencia de 3 abre las tres líneas contra el primer negocio antes de pasar al
segundo. Eso da dos cosas — es exactamente el escenario que se quiere medir cuando
hay varias líneas, y en un barrido de treinta hace que el primer negocio esté
completo y legible en minutos en vez de al final.

`siguientePendiente` mira la ocupación **por par (línea, número)**. Bloquear por
número dejaría dos de las tres líneas esperando para siempre a una conversación
que nunca las libera.

**`max_concurrentes` y `ritmo_segundos` no son afinación.** Treinta clientes por
tres pruebas son 90 conversaciones desde UNA línea de WhatsApp; para el
clasificador de Meta eso es un emisor de spam, y lo que se pierde no es el lote:
es el número. Son columnas y no constantes para poder bajarlas en caliente.

`avanzarLote` es **idempotente** y lo llaman tres cosas: la creación, el cierre
de cada prueba (vía webhook) y la pantalla del admin. Es el único lugar del
subsistema donde se duerme, y está acotado por `PRESUPUESTO_MS = 200 s`: no
esperamos un evento externo, espaciamos a propósito nuestros propios envíos.

`crearLote` **omite en vez de fallar**: si una compilación falla, ese par sale de
la prueba con su motivo. Una prueba de 30 clientes que muere en el cuarto no
sirve. Los motivos se devuelven en `omitidos` y **hay que mostrarlos**.

Un plan se compila por **(objetivo × unidad)**, no por línea: las tres líneas
mandan el mismo guion, que es justamente lo que hace comparables las tres
respuestas.

---

## `informe.ts`

```ts
generarInforme({ organizationId, desde, batchId? }): Promise<InformeRow | null>
informePorToken(token): Promise<InformeRow | null>
informePorId(id): Promise<InformeRow>            // lanza
informesDeOrganizacion(orgId, limite?): Promise<InformeRow[]>
informesRecientes(limite?): Promise<…>
registrarVista(informe): Promise<void>           // nunca lanza
despublicar(id): Promise<void>
```

Devuelve `null` cuando no hay conversaciones: un informe vacío es peor que
ninguno.

**El reparto:** el código pone las cifras (`salud_de_linea`), los hallazgos con
su frecuencia (`hallazgos_por_frecuencia`), las citas (`citas_del_periodo`) y
**decide qué recomendar** (el `CATALOGO`). El modelo pone las palabras.

**La frecuencia se cuenta sobre los criterios de la rúbrica, no sobre el texto
del modelo.** «Falló en 4 de 5» y «falló en 1 de 5» piden cosas distintas, y esa
distinción es todo el valor del análisis. Solo funciona con claves estables: los
criterios tienen `id`, las alucinaciones son texto libre y nunca agruparían. Por
eso las citas van **aparte, textuales y sin contar** — una cita resumida deja de
ser prueba.

`impactoDe(fallo, de, peso)` es una **función pura**. Si el impacto lo pusiera
el modelo, el mismo problema saldría «alto» en un cliente y «medio» en otro, y
el orden de la lista —que es lo que decide qué se arregla primero— dejaría de
significar algo.

`registrarVista` usa `tryWrite`: perder una vista es un dato menos; una
excepción le rompe el informe al cliente en la cara.

---

## Las funciones SQL

Toda agregación vive en SQL y no en el render (ADR 0023): se puede probar contra
Postgres real, y deja la página tonta.

| Función | Devuelve | Invariante |
|---|---|---|
| `resumen_de_pruebas(desde)` | Por plantilla: enviadas, contestaron, medianas, promedios | Excluye canceladas |
| `salud_de_linea(org, desde)` | Las cifras del encabezado del informe | Excluye canceladas y sin enviar |
| `hallazgos_por_frecuencia(org, desde)` | Qué falló y en cuántas de cuántas | **Agrupa por `id`**; ignora `paso = null` |
| `citas_del_periodo(org, desde, limite)` | Alucinaciones textuales | No agrupa ni cuenta |
| `estado_del_lote(lote)` | Contadores del lote | Una sola consulta: la usa el avanzador |

---

## Cómo probar que no lo rompiste

```bash
node scripts/test-smoke-tester.mjs      # esquema, claves, invariantes del código
node scripts/test-lotes-e-informes.mjs  # la aritmética del informe
```

Los dos verifican **invariantes leyendo el código fuente** además del esquema:
que ningún esquema que va a OpenAI pida una cifra, que no haya `await` pelado, que
el webhook nunca devuelva 5xx, que la correlación desambigue entre líneas, que
`avanzarLote` respete el tope, que `guion.ts` no importe nada de servidor —si lo
hiciera, la vista previa del formulario dejaría de calcularse igual que lo que se
manda— y que **la rama del guion siga corriendo antes de los detectores de
cierre**. Esa última es una invariante de posición: un refactor la rompe sin
cambiar una línea, y sin la prueba nadie se enteraría hasta que un guion de cuatro
preguntas mandara dos.

Es feo leer el código fuente desde una prueba, y es la única forma que hay de que
esas reglas no se erosionen.

**Lo que NO cubren:** el motor por eventos. Turnos, ráfagas y correlación
necesitan un proveedor respondiendo, y simularlo probaría la simulación. Se
verifica a mano con el procedimiento de
[wiki/23](../wiki/23-smoke-tester.md#puesta-en-marcha).

---

## El contrato HTTP del admin

| Ruta | Método | Para qué |
|---|---|---|
| `/api/admin/pruebas` | **POST** | **La única forma de crear una prueba a mano.** `números × líneas × guiones`. Devuelve `destino`: la transcripción si dio una conversación, la pantalla de la prueba si dio más. Dos cuerpos válidos: con `aMedida` el guion lo escribió una persona; con `plantillas` los compila el sistema leyendo el research de cada objetivo — es el cuerpo que manda el botón «Probar como en el diagnóstico» y el mismo que arma el disparo automático |
| `/api/admin/pruebas` | GET | `?telefono=…` — si está bloqueado, cuándo fue la última prueba, si ya lo conocemos con nombre y organización. Es lo que reemplaza al enfriamiento en el camino manual |
| `/api/admin/pruebas` | PATCH | cancelar · recalificar · desbloquear un número |
| `/api/admin/pruebas/redactar` | POST | El **borrador** de un guion a partir de dos líneas escritas a las apuradas. Nunca falla hacia afuera: sin llave devuelve las sugerencias determinísticas de `guion.ts` con `degradado: true` |
| `/api/admin/pruebas/lotes/[loteId]` | GET | Estado de la prueba **y su motor**: empuja la cola en `after()` |
| `/api/admin/pruebas/lotes/[loteId]` | PATCH | pausar · reanudar · cancelar lo que falta |
| `/api/admin/pruebas/canales` | POST / DELETE | Nuestras líneas. El DELETE apaga, no borra: las conversaciones viejas apuntan al canal con una clave foránea |
| `/api/admin/pruebas/diagnose` | GET / POST | Qué variables faltan · mandar un mensaje de prueba desde una línea |
| `/api/pruebas/estado/[runId]` | GET | El estado en vivo **y la red de seguridad real** del motor |
| `/api/webhooks/wzap` | POST | La entrada de wzap. Un menú entra por acá como todo lo demás: **no hay evento de webhook para botones**. Secreto en la cabecera `x-webhook-secret`, o en `?k=` / `?secret=`. El 401 dice cómo mandarlo. **Siempre devuelve 200** |
| `/api/webhooks/callbell` | POST | La entrada de Callbell. Secreto en `?k=`. **Siempre devuelve 200** |

`POST /api/admin/pruebas/lotes` **ya no existe**. Era el segundo camino de
creación y era la mitad de la confusión; hay una prueba que verifica que no
vuelva.

---

## Referencias

- [ADR 0025 · El smoke tester como evidencia](../adr/0025-el-smoke-tester-como-evidencia.md)
- [ADR 0026 · El lote y el informe](../adr/0026-el-lote-y-el-informe.md)
- [ADR 0027 · La prueba a medida, y varias líneas](../adr/0027-la-prueba-a-medida-y-las-lineas.md)
- [wiki/23](../wiki/23-smoke-tester.md) · [wiki/24](../wiki/24-lotes-e-informes.md)
- [`docs/api/README.md`](README.md) — el contrato HTTP
- `docs/referencia/smoke-tester/` — el paquete del que sale esto, con sus 12
  bugs de producción documentados
