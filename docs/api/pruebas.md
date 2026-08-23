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

Índice de módulos:

| Módulo | De qué se ocupa |
|---|---|
| [`types.ts`](#typests) | Los contratos y las constantes de tiempo |
| [`callbell.ts`](#callbellts) | El transporte: mandar y parsear |
| [`numeros.ts`](#numerosts) | De dónde salen los números |
| [`compilar.ts`](#compilarts) | Plantilla + research → prueba concreta |
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

## `callbell.ts`

El transporte. **Asíncrono**: mandamos un HTTP y la respuesta llega minutos
después por un webhook. Todo `motor.ts` existe para sobrevivir a eso.

```ts
faltaParaEnviar(): Record<string, true>
hayTransporte(): boolean
```

Precheque de entorno. Se llama **antes** de crear nada. Un 400 con
`{ falta: { CALLBELL_API_KEY: true } }` ahorra horas frente a una prueba que se
creó y «no hizo nada».

```ts
canalActivo(canalId?: string | null): Promise<CanalRow | null>
canalPorId(canalId: string): Promise<CanalRow>   // lanza si no existe
```

De qué número escribimos. Vive en `smoke_channels` y no en variables de entorno
porque lo cambia alguien de operaciones sin desplegar. La llave de la API sí es
variable: eso es un secreto, esto es un dato.

```ts
enviarMensaje(spec: EnvioSpec): Promise<ResultadoEnvio>
// → { ok, messageId, error, pista }
```

**Nunca lanza.** Devuelve `pista`, que es un texto accionable («Callbell rechazó
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

## `webhook.ts`

```ts
correlacionar(entrante): Promise<ResultadoCorrelacion>
mismoNumero(a: string, b: string): boolean
```

**Se empareja POR NÚMERO**, y es la decisión con más consecuencias del
subsistema. El paquete original emparejaba contra «la conversación activa más
reciente», lo que impedía correr dos pruebas a la vez **para siempre**.

Dos caminos:
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
lanzarDesdeAdmin(args): Promise<ResultadoLanzamiento & { error?: string }>
configDePruebas(): Promise<Config>
CLAVE_CONFIG = 'pruebas.bateria'
```

`lanzarDesdeElDiagnostico` **nunca lanza** y se llama al terminar el research.
Ese momento es el primero donde existen los números y el material, y da 4–5
minutos de ventaja sobre el cliente.

**Los cuatro frenos**, y ninguno es opcional:

1. `authorize('smoketest.probe')` — `external_comms`, techo de plataforma **4**.
2. **Propiedad del número** — en el camino automático tiene que estar publicado
   en el sitio de esa organización. Le escribimos al dueño, no a un tercero.
3. **Enfriamiento 72 h**, global por número.
4. **Bloqueo** — ningún camino automático lo revierte.

Apagado sin desplegar: `settings['pruebas.bateria'].activo = false`.

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
crearLote(args): Promise<ResultadoLote>
avanzarLote(loteId): Promise<{ arrancadas: number }>
cerrarLoteSiTerminó(loteId): Promise<void>
pausarLote(loteId, estado): Promise<void>
estadoDelLote(loteId): Promise<EstadoDelLote>
objetivosDeOrganizaciones(orgIds): Promise<ObjetivoDeLote[]>
lotesRecientes(limite?): Promise<LoteRow[]>
```

**`max_concurrentes` y `ritmo_segundos` no son afinación.** Treinta clientes por
tres pruebas son 90 conversaciones desde UNA línea de WhatsApp; para el
clasificador de Meta eso es un emisor de spam, y lo que se pierde no es el lote:
es el número. Son columnas y no constantes para poder bajarlas en caliente.

`avanzarLote` es **idempotente** y lo llaman tres cosas: la creación, el cierre
de cada prueba (vía webhook) y la pantalla del admin. Es el único lugar del
subsistema donde se duerme, y está acotado por `PRESUPUESTO_MS = 200 s`: no
esperamos un evento externo, espaciamos a propósito nuestros propios envíos.

`crearLote` **omite en vez de fallar**: si una compilación falla, ese par sale
de la tanda con su motivo. Un lote de 30 clientes que muere en el cuarto no
sirve. Los motivos se devuelven en `omitidos` y **hay que mostrarlos**.

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
que ningún esquema que va a OpenAI pida una cifra, que no haya `await` pelado,
que el webhook nunca devuelva 5xx, que la correlación siga siendo por teléfono,
y que `avanzarLote` siga respetando el tope. Es feo y es la única forma que hay
de que esas reglas no se erosionen.

**Lo que NO cubren:** el motor por eventos. Turnos, ráfagas y correlación
necesitan un proveedor respondiendo, y simularlo probaría la simulación. Se
verifica a mano con el procedimiento de
[wiki/23](../wiki/23-smoke-tester.md#puesta-en-marcha).

---

## Referencias

- [ADR 0025 · El smoke tester como evidencia](../adr/0025-el-smoke-tester-como-evidencia.md)
- [ADR 0026 · El lote y el informe](../adr/0026-el-lote-y-el-informe.md)
- [wiki/23](../wiki/23-smoke-tester.md) · [wiki/24](../wiki/24-lotes-e-informes.md)
- [`docs/api/README.md`](README.md) — el contrato HTTP
- `docs/referencia/smoke-tester/` — el paquete del que sale esto, con sus 12
  bugs de producción documentados
