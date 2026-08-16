# ADR 0011 · Créditos, y un ledger inmutable

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Depende de:** ADR 0007 (los números los calcula el código)

## Contexto

El President propone envíos varias veces por semana. Cada propuesta necesita un
costo que el dueño pueda evaluar en tres segundos, y el sistema necesita una
forma de frenar cuando no hay con qué pagar.

Dos preguntas separadas:

1. ¿En qué unidad se le habla al cliente? ¿Dólares o créditos?
2. ¿Cómo se guarda el saldo?

## Decisión

**1 · Créditos, anclados a "1 crédito = 1 correo enviado".**

`config/credits.ts` tiene la tabla completa. Todo se cotiza contra el correo,
que es la acción más frecuente y la que el cliente entiende sin explicación.

**2 · Ledger de partida simple, inmutable. El saldo es la suma.**

`credit_ledger` solo acepta inserts. No hay columna `balance` en ninguna parte.
La función `holaamigo.credit_balance(uuid)` suma.

**3 · El débito ocurre en el envío real, no en la aprobación.**

## Por qué

**Créditos y no dólares:** "Esto cuesta 1.240 créditos, te quedan 8.000" se
decide de un vistazo. "Esto cuesta USD 24,80 más el prorrateo de
infraestructura" abre una conversación sobre márgenes que no queremos tener
cada martes.

**Ledger y no columna:** un saldo guardado se desincroniza el primer día que
dos envíos corren a la vez. Una suma sobre un ledger inmutable se puede auditar
línea por línea cuando el cliente pregunte "¿en qué se me fueron 3.000
créditos?" — que va a preguntar.

**Cobrar al enviar y no al aprobar:** aprobar es autorizar un presupuesto, no
gastarlo. Si cobráramos por adelantado tendríamos que devolver por cada correo
que no salió —porque el contacto se dio de baja, porque contestó antes, porque
la bandeja se pausó—, y "devolver créditos" es una operación que no quiero
tener que explicar ni construir.

**Las cifras las calcula el código (ADR 0007):** el President recibe el costo
ya calculado y solo lo redacta. Un agente que estima el costo de su propia
propuesta es un agente que pide permiso para gastar una cantidad que no conoce.

## Consecuencias

- `creditsForCampaign` descuenta a los que responden en cada paso: quien
  contesta sale de la secuencia. Estimar de más hace que el cliente rechace
  propuestas que en realidad puede pagar.
- El bloqueo por saldo va **antes**, en el despachador, no dentro de `debit`.
  Frenar a mitad de un envío dejaría una secuencia partida, que es peor que un
  saldo en rojo.
- El agendamiento y el checkout **cuestan 0 créditos**. Son los activos que
  demuestran valor (ADR 0010).
- Al provisionar los agentes se otorgan `WELCOME_CREDITS`, idempotente. Alcanzan
  para una reactivación completa de una base mediana sin poner tarjeta.
- Por debajo de `LOW_BALANCE_CREDITS` el President avisa en el feed antes de
  proponer nada más.

## Lo que este ADR prohíbe

Guardar el saldo en una columna. Actualizar o borrar filas de `credit_ledger`.
Pedirle a un modelo que calcule un costo en créditos.
