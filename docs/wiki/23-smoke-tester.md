# 23 · El smoke tester

Le escribimos por WhatsApp a la línea que el prospecto publica en su propio
sitio, como si fuéramos un cliente, dejamos que la conversación llegue hasta
donde llegue, y la calificamos.

Es la única parte del diagnóstico que **no es una proyección**. Todo lo demás
sale de aritmética sobre supuestos que el cliente puede mover; esto es una
conversación que pasó, con la hora a la que pasó.

La tesis está en [ADR 0025](../adr/0025-el-smoke-tester-como-evidencia.md) y
cabe en un renglón del diagnóstico:

> «Le escribimos a tu línea de ventas a las 2:03. Contestaron a las 2:19.
> Dieciséis minutos.»

---

## El recorrido completo

```
el cliente escribe su URL en la landing
   ↓
research: crawlea el sitio  →  `crawl_signals.whatsappNumbers` + `.phones`
   ↓
lanzarDesdeElDiagnostico()      ← acá arranca todo, no al terminar el quiz
   ├── extrae y normaliza hasta 3 números, con su fuente
   ├── authorize('smoketest.probe')
   ├── compila una prueba por plantilla, leyendo el research
   └── manda el primer mensaje de cada número, en primer plano
   ↓
… el cliente sigue en el quiz, 4–5 minutos …
   ↓
webhook ← el negocio contesta
   ├── correlaciona POR NÚMERO
   ├── anexa, reserva el turno, devuelve 200
   └── en segundo plano: espera silencio, redacta, manda
   ↓
cierre → auditoría (capa 2, gratis) → evaluación (capa 3, con modelo)
   ↓
el cliente llega al diagnóstico y ve la sección ya con contenido
```

La ventaja de arrancar con el research y no con el quiz es toda la gracia:
cuando el cliente llega al diagnóstico, la primera prueba **ya tiene respuesta
o ya sabemos que no la va a tener**. Es la diferencia entre mostrarle un
resultado y mostrarle un spinner.

---

## Las cinco tablas

`supabase/migrations/0014_smoke_tester.sql`.

| Tabla | Qué es |
|---|---|
| `smoke_channels` | Desde dónde escribimos: nuestro número y su `channel_uuid` de Callbell. Editable en caliente. |
| `smoke_templates` | Los moldes: `servicio`, `faq`, `ventas`. Lo que **no** depende del cliente. |
| `smoke_targets` | A quién le escribimos. Un número, una fila. Lleva el enfriamiento y el bloqueo. |
| `smoke_runs` | Una tanda. Agrupa las pruebas de un diagnóstico o de un disparo manual. |
| `smoke_probes` | Una conversación completa: transcripción, estado terminal, auditoría y evaluación. |

Cuatro decisiones de esquema que explican casi todo:

**`smoke_probes.target_phone` está denormalizado.** El webhook correlaciona por
número y no puede hacer un join para descubrirlo. El paquete del que sale esto
emparejaba contra «la conversación activa más reciente» y esa decisión le
costó no poder correr dos pruebas a la vez, nunca.

**`turno` y `turn_token` son columnas, no claves de un `jsonb`.** Como columna,
reclamar un turno es `update … where turn_token = $viejo`, que es atómico. En
un `jsonb` habría que leer-modificar-escribir, y dos webhooks simultáneos se
pisan.

**`segundos_primera_respuesta` es una columna que escribe el código.** Es la
cifra que el cliente lee, y ninguna cifra que el cliente lee sale de un modelo
([ADR 0007](../adr/0007-numeros-deterministas.md)).

**`auditoria_score` y `evaluacion_score` son dos columnas.** El auditor escribe
al cerrar y el evaluador califica después; con una sola, el segundo pisa al
primero y se pierde la única de las dos que es determinística.

---

## De dónde salen los números

`lib/pruebas/numeros.ts`. **Ningún modelo elige un número.** El crawler ya
extrajo con regex los `wa.me/` y los `tel:` del sitio; acá se normalizan a
E.164, se ordenan por evidencia y se les pone la fuente.

| Evidencia | Confianza | Por qué |
|---|---|---|
| `wa.me/…` | 0,95 | El negocio publicó ese número **como** WhatsApp. Certeza. |
| `tel:` de celular | 0,60 | Probable WhatsApp. |
| `tel:` de fijo | — | **Se descarta.** No tiene WhatsApp; escribirle sería gastar un mensaje para reportar «no contestó», y eso sería mentira. |

El fallback a `+57` para números de diez dígitos que empiezan en 3 no es
chovinismo: `libphonenumber` rechaza `3001234567` sin país, y así está escrito
el celular en casi todos los sitios colombianos. Sin el fallback perderíamos la
mayoría de los números del mercado principal.

---

## Las plantillas, y qué les agrega el research

`smoke_templates` define lo que **no** depende del cliente: qué se mide, con
qué identidad se escribe, cuándo se da por terminada y cómo se califica.

| Molde | Qué mide | Turnos |
|---|---|---|
| `servicio` | ¿Contestan? ¿En cuánto? ¿Sirve la respuesta? | 8 |
| `faq` | ¿La línea dice lo mismo que el sitio? | 10 |
| `ventas` | ¿Cierran, o dejan la venta en el aire? | 14 |

`lib/pruebas/compilar.ts` las instancia contra un negocio concreto. El reparto
es el mismo de [ADR 0024](../adr/0024-el-agente-se-compila-del-diagnostico.md):

- **El código** arma la *ficha de verdad* leyendo `research_findings`: la
  oferta, los productos, los precios publicados, el horario, la cobertura, la
  promesa de respuesta. Cada hecho con su URL o marcado como inferido (§13.4).
- **El modelo** escribe cómo se pregunta, para que suene a una persona por
  WhatsApp y no a un cuestionario. `PruebaLenguajeSchema` **no tiene un solo
  `z.number()`**.

La especialización es el punto: si el sitio anuncia un evento, se pregunta por
el evento; si publica un precio, se pregunta el precio para ver si dicen el
mismo. Cada sonda marca `origen: 'research' | 'plantilla'`, y la proporción se
muestra en el admin — si baja del 30% de forma sostenida, el problema es el
research, no el compilador.

**Sin research la prueba corre igual**, con el molde crudo. Mide atención pero
no exactitud, `cobertura` queda en 0% y el admin lo ve. Degradar honestamente
en vez de fallar es lo que mantiene el arnés vivo cuando un sitio bloquea el
crawler.

---

## El motor

`lib/pruebas/motor.ts`. La idea central, y todo lo demás es consecuencia:
**nadie espera a nadie.** El estado vive en la base; cada mensaje entrante es
un evento que despierta el sistema, hace un turno y lo apaga.

No es una preferencia de estilo: Vercel corta la función a los 300 s y una
persona contesta un WhatsApp en 4, 20 o 40 minutos. Un runner que espera agota
su presupuesto en dos mensajes.

### El ciclo de un turno

```
llega un mensaje entrante
  ├─ 1. correlacionar por número               (webhook.ts)
  ├─ 2. anexar, bajar awaiting_reply, calcular los segundos si es el primero
  ├─ 3. RESERVAR el turno con un token nuevo   ← síncrono, antes de programar
  ├─ 4. after(avanzarTurno(id, token)) ── devolver 200 ──
  └─ 5. en segundo plano:
        a. acumular la ráfaga: 20 s de silencio, techo 90 s
        b. releer: ¿sigue viva? ¿el token sigue siendo el mío?
        c. ¿pidieron que paremos? → bloquear y cerrar
        d. ¿agendaron o cotizaron? → cerrar
        e. ¿se acabaron los turnos? → cerrar como incompleto
        f. el comprador redacta
        g. RECLAMAR el token justo antes de mandar
        h. marcar awaiting_reply ANTES de enviar, y recién ahí enviar
```

Tres detalles que parecen menores y no lo son:

**(b) Releer.** Entre el settle y el turno pueden haber pasado 90 segundos. La
prueba pudo cancelarse o cerrarse. Confiar en lo que se leyó al entrar es cómo
se resucitan pruebas muertas.

**(g) Reclamar tan tarde como se pueda.** Redactar tarda segundos, y en esa
ventana puede llegar otro mensaje que reprograme el turno. Reclamando al
principio, contestaríamos con información vieja. **Gana el último**, que es el
que vio la respuesta completa.

**(h) `awaiting_reply` antes de enviar.** Si el negocio contesta rapidísimo, el
webhook tiene que encontrar la fila ya armada. Al revés se pierde la respuesta
y no hay reintento.

### Serial por número, paralelo entre números

Dos conversaciones simultáneas contra la misma línea caen en el mismo hilo de
WhatsApp y ninguna mide nada. Contra números distintos no hay problema, porque
la correlación es por número. De ahí `avanzarCola()`: una prueba viva por
número, y la siguiente no arranca hasta 90 segundos después de que cerró la
anterior.

Ese espaciado es **una guarda, no un `sleep`**. La primera versión dormía y
rompía tres cosas: el GET de estado tiene techo de 60 s y moría a mitad de
respuesta, el stream se quedaba mudo minuto y medio, y el cron con cinco colas
pendientes sumaba siete minutos contra un techo de cinco. Ahora se pregunta
«¿cerró hace poco?» y, si sí, no se hace nada: quien vuelva a pasar la arranca
—el GET cada pocos segundos mientras el cliente mira, el cron cada cinco
minutos si no. Nadie se queda esperando, que es la misma regla que gobierna el
motor entero.

### Las tres redes de seguridad

Si el negocio nunca contesta no hay webhook, y sin webhook no hay quien cierre
la prueba.

| Red | Dónde | Cuándo | Qué tan confiable |
|---|---|---|---|
| Recolección en el GET | `/api/pruebas/estado/[runId]` y el stream | cada 2–6 s mientras alguien mira | **La real.** Corre con la frecuencia del problema. |
| Auto-cancelación | `cancelarVivasContra()` al arrancar | cada prueba nueva | Muy confiable, solo limpia el mismo número. |
| Cron | `/api/cron/pruebas`, 1×/día en Hobby | siempre | Recoge lo de los clientes que cerraron la pestaña. Ver la nota de puesta en marcha. |

El cron cubre cuatro casos: estancadas, colas huérfanas, **zombis** (running sin
actividad hace 90 min — son los que se llevan los mensajes de las siguientes) y
cerradas sin calificar.

---

## Las tres capas de veredicto

| Capa | Qué contesta | Cómo | Costo | Determinística |
|---|---|---|---|---|
| 1 · Estado terminal | ¿Contestaron? ¿En cuánto? | Restar timestamps | 0 | Sí |
| 2 · Auditoría | ¿Cumplió los criterios? | Regex sobre la transcripción | 0 | Sí |
| 3 · Evaluación | ¿Estuvo bien hecho? | Modelo contra la ficha | ~USD 0,02 | No |

**Con la capa 1 sola ya hay producto.** Las otras dos suman.

### Capa 1 · `cerro_con`

| Valor | Significa |
|---|---|
| `sin_respuesta` | Nadie contestó. El hallazgo más vendedor que tenemos. |
| `objetivo_cumplido` | El comprador dio la conversación por terminada. |
| `agendado` / `cotizacion` | El negocio propuso cita con fecha y hora, u ofreció cotización. |
| `incompleto` | Se agotaron los turnos sin llegar a nada. |
| `bloqueado` | Pidieron que no escribiéramos más. Terminal y respetado. |

Los detectores de `agendado` y `cotizacion` son **conservadores a propósito**:
prefieren no detectar un cierre a inventar uno. Decirle a un cliente «te
agendaron una cita» cuando le dijeron «te escribo luego» destruye lo único que
este producto vende.

### Capa 2 · el mini-lenguaje de los chequeos

Cada criterio de la rúbrica lleva un `chequeo` que el compilador resuelve
contra la ficha:

```
hubo_respuesta            ¿contestaron algo?
respondio_antes_de:300    ¿en menos de N segundos?
dio_precio                ¿dijeron alguna cifra de dinero?
propuso_paso_siguiente    ¿ofrecieron cita, visita, llamada o cotización?
pregunto_al_menos:1       ¿preguntaron algo de vuelta?
menciona:<clave>          ¿dijeron lo que la ficha dice en esa clave?
no_menciona:a,b,c         ¿evitaron estas palabras?
```

Vive en la tabla y no en TypeScript para que agregar un criterio no exija un
despliegue.

`menciona` tiene tres desenlaces y la diferencia entre los dos últimos es la
que decide si acusamos a alguien:

- **coincide** → pasa;
- **contradice** (dieron un dato del mismo tipo pero distinto) → crítico;
- **no lo tocaron** → `null`, no se puede juzgar.

Sin el tercero, un negocio al que nunca se le llegó a preguntar el precio
aparecería reprobado por «no coincide», que es una acusación falsa.

La nota: `pasados/verificables × 100 − críticos×10 − advertencias×3`, acotada a
[0, 100]. **Si no hay nada verificable, `verificables` es 0 y la interfaz dice
«no se pudo verificar» en vez de pintar un cero** — un cero se lee como «lo
hiciste pésimo» y lo que pasó fue que no pudimos leer su sitio.

### Capa 3 · el evaluador no devuelve números

`EvaluacionPruebaSchema` pide cinco juicios —`excelente`, `bien`, `regular`,
`mal`, `pesimo`— y el código los convierte con una tabla fija:

```
excelente 95 · bien 80 · regular 55 · mal 30 · pesimo 10
```

Pedirle un 78 a un modelo es comprar falsa precisión: la misma transcripción le
saca 74 y 79 en dos corridas. Con juicios, la varianza se ve y la nota es una
función pura de ellos.

**Sin ficha, `exactitud` y `ausencia_de_invenciones` no entran en la nota.** El
evaluador no tendría contra qué comparar; lo que devolviera sería una opinión
sobre plausibilidad.

Lo que de verdad se lee no son las notas sino las tres listas:
`alucinaciones` (cita textual de cada dato inventado), `errores` y
`sugerencias` — dirigidas al **dueño del negocio**, no a nosotros.

---

## Lo que ve el cliente

`components/smoke-live.tsx`, dentro del diagnóstico, entre las cifras y las
tres rutas. Ese lugar es la decisión de producto: antes competiría con la fuga
más grande; después de las rutas llegaría cuando el cliente ya decidió.

**La barra no se mueve sola.** Cada tramo lo gana un hecho con hora en la base:

```
  0 %   la prueba existe, el mensaje no salió
 15 %   el mensaje salió
 45 %   contestaron          ← el salto grande, porque es el dato que importa
45–90 % un tramo por turno completado
100 %   cerrada
```

Entre dos hechos se queda quieta, y eso es a propósito. Lo que sí corre es el
cronómetro de al lado, y es real.

**La conversación se ve crecer.** Los globos que aparecen solos son la prueba
de que hay alguien trabajando, y valen más que cualquier animación.

El transporte es SSE con caída a polling, igual que el ticker del research
([ADR 0002](../adr/0002-sse-en-vez-de-realtime.md)). El reloj de la pantalla es
un `useSyncExternalStore` con snapshot de servidor en 0: nada que dependa de la
hora se renderiza antes de montar. Eso no es purismo — es el bug 7 del paquete
de referencia, donde un desajuste de hidratación por el borde del minuto
dejaba los botones sin manejadores.

---

## Lo que ve el equipo

**`/admin/pruebas`** — tres bloques, cada uno con la decisión que cambia:

| Bloque | Pregunta | Decisión |
|---|---|---|
| Qué tan vivas están las líneas | ¿El canal sirve o hablamos solos? | Seguir o parar |
| Las últimas 40 conversaciones | ¿A qué prospecto llamo ahora? | A quién marcar |
| Configuración | — | Desde qué número, con qué moldes |

La agregación sale de `holaamigo.resumen_de_pruebas(p_desde)`, no de contar
filas en el render (ADR 0023). Ignora las canceladas: una prueba que
reemplazamos nosotros no dice nada del negocio del cliente y ensuciaría la
mediana.

**`/admin/pruebas/[pruebaId]`** — transcripción primero, después el plan
compilado (qué se preguntó, por qué, contra qué ficha), después los veredictos.
Una nota sola arriba de todo invitaría a leer solo la nota.

---

## Los cuatro frenos

Escribirle por WhatsApp a un negocio que no nos escribió primero es la acción
más delicada del producto.

1. **`authorize('smoketest.probe')`** — `external_comms`, techo de plataforma
   **4**, no 5. Un número quemado por Meta no se recupera con un rollback.
2. **Propiedad del número** — en el camino automático tiene que estar publicado
   en el sitio de la organización que pidió el diagnóstico.
3. **Enfriamiento de 72 h**, global por número.
4. **Bloqueo** — si piden que paremos, se corta en ese turno y **ningún camino
   automático lo desbloquea**. Solo una persona desde el admin.

El apagado de emergencia no necesita despliegue:

```sql
update holaamigo.settings
   set value = jsonb_set(value, '{activo}', 'false')
 where key = 'pruebas.bateria';
```

---

## Puesta en marcha

1. **Variables.** `CALLBELL_API_KEY` y `CALLBELL_WEBHOOK_SECRET` en Vercel.
2. **La línea.** `/admin/pruebas` → «Nuestra línea»: número y `channel_uuid`.
3. **El envío, aislado.** El botón «Probar el envío» manda un mensaje a tu
   propio celular. **No sigas hasta que lo veas llegar.** Ahí vive la mitad de
   los problemas de configuración, y salen todos en dos segundos.
4. **El webhook.** Apuntá Callbell —o la aplicación que reenvía— a
   `https://TU_DOMINIO/api/webhooks/callbell?k=EL_SECRETO`. El `GET` de esa
   misma URL devuelve `{ok: true}` si el secreto es correcto.
5. **Una conversación entera, a mano.** Creá una prueba contra tu propio
   celular y contestá vos. Verificá mensaje por mensaje que la transcripción
   quede completa y que la prueba cierre sola.
6. **El cron.** `/api/cron/pruebas` ya está en `vercel.json`. Hoy corre **una
   vez al día** (11:30 UTC) porque el plan Hobby de Vercel no permite más. El
   arnés funciona igual: la red real es el GET de estado, que la interfaz
   consulta cada pocos segundos. Lo que se pierde es que una prueba de alguien
   que cerró la pestaña queda `running` hasta el otro día. Con Pro, volver a
   su cron de cada cinco minutos es la única línea que hay que cambiar.

---

## Calibrar contra tu mercado

Las constantes de `lib/pruebas/types.ts` están calibradas para líneas **humanas**
de negocios colombianos, que es un régimen muy distinto al de un bot: un bot
contesta en 3 segundos y manda ráfagas; una persona contesta en 4 minutos y
manda un párrafo.

| Constante | Valor | Cómo recalibrarla |
|---|---|---|
| `SILENCIO_MS` | 20 s | El p95 del hueco entre dos mensajes seguidos del negocio |
| `SILENCIO_TOPE_MS` | 90 s | Techo por si no paran de escribir |
| `VENTANA_RAFAGA_MS` | 60 s | Cuándo un entrante sigue siendo la misma respuesta |
| `ESTANCADA_MS` | 25 min | 3–4× la peor latencia observada |
| `ENTRE_PRUEBAS_MS` | 90 s | Que el negocio «olvide» la conversación anterior |

La consulta para medirlo con datos que ya tenés:

```sql
select
  jsonb_array_length(conversation)                          as mensajes,
  segundos_primera_respuesta,
  (conversation->-1->>'timestamp')::timestamptz
    - (conversation->0->>'timestamp')::timestamptz          as duracion
from holaamigo.smoke_probes
where estado = 'completed'
order by created_at desc
limit 30;
```

---

## Cómo depurar

1. **`/api/admin/pruebas/diagnose`** — qué variables están presentes (booleanos,
   nunca sus valores), qué canal está activo, las últimas diez pruebas con su
   error, y los números bloqueados. Es lo primero.
2. **El log del webhook.** Cada entrante deja una línea con la **forma** del
   payload antes de parsear, y cuando no matchea nada deja otra con el estado
   del mundo: qué conversaciones estaban vivas y contra qué número. Ese segundo
   log es el que resuelve los incidentes.
3. **`/admin/pruebas/[id]`** — transcripción completa, plan compilado y las dos
   calificaciones.
4. En la base:
   ```sql
   select id, estado, cerro_con, turno, awaiting_reply, turn_token, error
     from holaamigo.smoke_probes
    where estado in ('pending','running')
    order by updated_at desc;

   select * from holaamigo.resumen_de_pruebas(now() - interval '30 days');
   ```
5. `node scripts/test-smoke-tester.mjs` — esquema, claves, la función de
   resumen, y las invariantes del código.

### Síntomas y causas

| Síntoma | Casi siempre es |
|---|---|
| La prueba se creó y «no hizo nada» | Falta `CALLBELL_API_KEY`, o el `channel_uuid` está mal. Lo dice `/diagnose`. |
| Contestaron pero no aparece en la transcripción | El webhook no llegó (secreto mal en la URL) o no matcheó. Buscá `ningún match` en el log. |
| La conversación quedó a medias | El comprador cayó al heurístico por falta de `OPENAI_API_KEY`. Sigue funcionando, peor. |
| Todas las pruebas dicen `sin_respuesta` | Revisá que el número de pruebas no esté bloqueado en Callbell. |
| `cobertura` en 0% siempre | El research está fallando: sin ficha no hay exactitud que medir. |

---

## Lo que este subsistema todavía no hace

**El motor por eventos no está cubierto por pruebas automáticas.** Turnos,
acumulado de ráfagas y correlación necesitan un proveedor respondiendo, y
simularlo probaría la simulación. Se verifica con el paso 5 de la puesta en
marcha. Es la deuda más grande que dejó este trabajo.

**No hay métrica de estabilidad del propio arnés.** Nadie mide cuántas pruebas
terminan en `failed` por culpa nuestra y no del negocio. Sin ese número no
sabemos qué tan confiables son los resultados. La consulta existe
—`select count(*) from smoke_probes where estado = 'failed'`— pero no está en
ninguna pantalla.

**No se le avisa al cliente cuando termina.** Si cerró la pestaña antes de que
cerrara la última prueba, tiene que volver al enlace del diagnóstico. Un correo
con el resultado es lo obvio que sigue, y Resend ya está conectado.

---

## Referencias

- [ADR 0025 · Le escribimos a su línea antes de venderle nada](../adr/0025-el-smoke-tester-como-evidencia.md)
- [ADR 0007 · Números deterministas](../adr/0007-numeros-deterministas.md)
- [ADR 0023 · Mostrar el trabajo](../adr/0023-mostrar-el-trabajo.md)
- `docs/referencia/smoke-tester/` — el paquete portable del que sale esto, con
  sus doce bugs de producción documentados. Si vas a tocar el motor, leé el 05.
- [Callbell · POST /messages/send](https://docs.callbell.eu/es/api/reference/messages_api/post_send_messages)
