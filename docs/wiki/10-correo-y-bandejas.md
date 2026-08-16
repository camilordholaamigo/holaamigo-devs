# 10 · Correo: bandejas, envío y recepción

Cómo sale un correo de Hola Amigo, cómo vuelve la respuesta, y qué evita que
quememos el dominio de un cliente.

Proveedor: **SendGrid** para campañas, Resend para el correo del producto. El
porqué está en [ADR 0008](../adr/0008-sendgrid-y-separacion-de-reputacion.md).

---

## Las bandejas

Un cliente no envía desde una dirección: envía desde varias. Esa es la
diferencia entre operar y quemarse. 500 correos al día desde `hola@empresa.com`
es un dominio muerto en tres semanas; 500 repartidos entre seis bandejas con
tope y calentamiento es una operación.

Cada fila de `mailboxes` tiene:

| Campo | Para qué |
|---|---|
| `address` | Desde dónde sale |
| `daily_cap` | Tope duro que puso el operador |
| `warmup_started_at` | De acá sale el tope de calentamiento |
| `inbound_address` | Alias nuestro al que llegan las respuestas |
| `sent_today` / `sent_today_date` | Contador que se reinicia solo |
| `bounce_rate` / `complaint_rate` | Salud, calculada sobre los últimos 500 envíos |

### Los dos topes

El despachador toma **el menor** de:

- `daily_cap`, y
- el tope de calentamiento: 20 el primer día, +30% diario.

Una campaña aprobada **no levanta ninguno de los dos**. La aprobación autoriza
el gasto; no autoriza la imprudencia.

La rampa es deliberadamente lenta. Los servicios de "warmup automático"
arrancan en 50 y suben más rápido; también son los que generan los casos de
dominios quemados que después hay que explicar en una llamada.

### Rotación

`pickMailbox` elige la bandeja con cupo que lleve **más tiempo sin enviar**.
Repartir parejo importa más que llenar una bandeja antes de pasar a la
siguiente: los envíos en ráfaga son el primer patrón que marcan los filtros.

Además, entre correo y correo hay 45 segundos de separación
(`SECONDS_BETWEEN_SENDS`). 500 correos saliendo en el mismo minuto parecen una
máquina; uno cada 45 segundos parece una persona trabajando.

### Salud

Un buzón se pausa solo por encima de **5% de rebotes** o **0,3% de quejas**. El
umbral de quejas parece absurdamente bajo y no lo es: Gmail empieza a filtrar
justo ahí.

---

## Cómo sale un correo

`lib/campaigns/dispatch.ts`, cada 5 minutos desde `/api/cron/dispatch`.

Por **cada** correo, aunque la campaña esté aprobada:

1. ¿El contacto está en la lista de supresión global? → se salta y se marca el
   lead como suprimido.
2. ¿Ya respondió? Quien contesta sale de la secuencia.
3. ¿Hay bandeja con cupo hoy? Si no, el correo **se queda programado** y sale
   mañana. No es un fallo: es el tope funcionando.
4. ¿Hay saldo de créditos? Si llegó a cero, se pausa la campaña y se avisa en el
   feed.
5. ¿La campaña sigue activa?

Recién ahí se renderiza el cuerpo con los datos del contacto y se envía.

### El cuerpo se renderiza al enviar, no al aprobar

`messages` guarda el paso y la hora, no el texto. Congelar el copy al aprobar
haría inútil cualquier iteración sobre una campaña ya lanzada.

### Cómo se ve el correo

HTML casi plano: sin tablas, sin banner, sin botón de 300 píxeles, sin logo
arriba. Un correo comercial que parece newsletter se va a Promociones y se
responde mucho menos que uno que parece escrito por una persona. El correo
bonito es para el transaccional; este es para que le contesten.

Lo único con estructura es el pie: firma, quién envía, y el link de baja.

### La baja es nuestra

El pie apunta a `/api/baja/[messageId]`, no al link de SendGrid. Motivos:

- Entra a `suppressions`, que es **global**: quien se da de baja del correo
  tampoco recibe WhatsApp.
- Cancela en el acto los correos futuros de la secuencia.
- Sobrevive a un cambio de proveedor.

Acepta GET (clic en el pie) y POST (`List-Unsubscribe-Post`, el clic que Gmail
ejecuta sin abrir el navegador). Que un GET mute estado es incorrecto en
general y correcto acá: una pantalla intermedia de confirmación hace que la
gente se rinda y marque spam, que cuesta muchísimo más.

---

## Cómo vuelve la respuesta

`/api/webhooks/sendgrid/inbound` → `lib/email/inbound.ts`.

### Por qué las respuestas no llegan al buzón del cliente

El `Reply-To` de cada correo es el `inbound_address` de la bandeja: un alias
nuestro en el dominio de la Inbound Parse. Si apuntara al correo real del
cliente, la respuesta se quedaría en su Gmail y el agente nunca se enteraría —
que es exactamente el problema que este módulo existe para resolver.

### Emparejar la respuesta con su hilo

Dos caminos, en orden:

1. `In-Reply-To` / `References` contra el `Message-ID` que pusimos nosotros.
   Es exacto y sobrevive a que la persona cambie el asunto.
2. Correo del remitente + bandeja. Es el respaldo para cuando el cliente de
   correo del contacto no propaga los headers, que pasa más de lo que debería.

### Qué hace el agente con la respuesta

El agente SALES clasifica y decide una de cinco acciones: `book`, `reply`,
`escalate`, `suppress`, `ignore`.

**Sin IA configurada, todo escala.** Es el modo degradado correcto de un sistema
que le habla a clientes: que conteste una persona.

Lo único que el agente cierra solo, sin aprobación previa, es **agendar**: no
gasta dinero, no promete precio y es reversible con un correo. Todo lo demás
depende de la autonomía configurada ([wiki 13](./13-feed-y-autonomia.md)).

El principio: **escala de más, no de menos**. Un escalamiento innecesario cuesta
dos minutos de un humano; una respuesta automática a alguien que pedía hablar
con el dueño cuesta el cliente.

---

## Seguridad de los webhooks

| Webhook | Autenticación |
|---|---|
| Eventos | Firma ECDSA del Signed Event Webhook. En producción, sin firma válida se rechaza. |
| Inbound Parse | Secreto en la URL (`?k=`). SendGrid no firma este webhook. |

El secreto en la URL es débil y lo sabemos. Lo que lo hace aceptable: sin él no
se procesa nada, y lo peor que logra alguien con el secreto es inyectar una
respuesta falsa en un hilo — molesto, no destructivo, y visible en la bandeja.

El webhook de inbound **siempre devuelve 200**, incluso al fallar: si
respondiéramos error, SendGrid reintenta 72 horas y termina duplicando
respuestas en el hilo.

---

## Configurar todo esto por primera vez

1. `SENDGRID_API_KEY` en el entorno.
2. Autenticar el dominio de envío en SendGrid (SPF, DKIM, DMARC). Para los
   primeros clientes esto se hace **con ellos en una llamada de 15 minutos** —
   §13.3, no se automatiza hasta haberlo hecho tres veces.
3. Apuntar un subdominio (`parse.tudominio.co`) a `mx.sendgrid.net` y crear la
   Inbound Parse hacia
   `https://TU_DOMINIO/api/webhooks/sendgrid/inbound?k=SENDGRID_INBOUND_SECRET`.
   Ponerlo en `EMAIL_INBOUND_DOMAIN`.
4. Activar el Signed Event Webhook hacia
   `https://TU_DOMINIO/api/webhooks/sendgrid/events` y copiar la clave pública a
   `SENDGRID_WEBHOOK_PUBLIC_KEY`.
5. Registrar la primera bandeja desde la consola. Va a llegar un correo de
   verificación a esa dirección: no podemos verificar una casilla ajena y no lo
   vamos a evadir.
