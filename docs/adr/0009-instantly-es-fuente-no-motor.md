# ADR 0009 · Instantly es fuente de datos, no motor de envío

- **Fecha:** 2026-08-15
- **Estado:** aceptada

## Contexto

Instantly ya resuelve buena parte de lo que estamos construyendo: listas,
buzones, calentamiento, secuencias, envío. Varios clientes potenciales ya
pagan una cuenta.

La opción fácil existe y es tentadora: usar su API para crear campañas allá,
lanzarlas allá, y leer los resultados por API. Construir eso toma dos días en
vez de dos semanas.

## Decisión

**Traemos sus listas y sus leads. El envío, la secuencia, la clasificación de
respuestas y la medición se quedan en Hola Amigo.**

`lib/integrations/instantly.ts` solo lee: `/lead-lists` y `/leads/list`. No
crea campañas, no lanza envíos, no lee resultados de campañas de allá.

## Por qué

**1 · La unidad económica tiene que pasar por una superficie nuestra.** El
modelo de negocio es cobrar por resultado demostrado: citas agendadas, ventas
atribuidas (ADR 0010). Si la campaña corre en Instantly, la conversión ocurre
allá y lo único que podemos hacer es creerle a su reporte. "Generamos 100
ventas" pasa de ser una consulta SQL a ser una afirmación.

**2 · El agente necesita las respuestas crudas.** El valor de SALES está en
clasificar lo que contestó cada persona, agendar cuando corresponde y escalar
cuando hay que escalar. Eso exige recibir el correo, no un evento
`reply_received` de un tercero.

**3 · Un cliente que se va no debería poder apagarnos.** Si la operación vive
en su cuenta de Instantly, revocar una API key apaga el producto entero.

**4 · Sus datos son buenos; su secuencia no es diferencial.** Lo que hace mejor
que nosotros hoy es construir listas. Eso es exactamente lo que importamos.

## Consecuencias

- Los leads de Instantly entran a `leads` con `temperature: 'cold'` y
  `source: 'instantly'`, y el lote queda con `source: 'instantly'` en
  `lead_batches`. Nunca los marcamos tibios: son prospectos, no la base del
  cliente, y marcarlos tibios los sacaría del playbook de conquista — que es el
  único que exige calentamiento de dominios.
- La importación **exige base legal**, igual que subir un CSV. Que los
  contactos lleguen por API no los hace más contactables.
- Su API se mueve (v1 → v2, campos que cambian de nombre). Todo lo que se lee
  se valida defensivamente: si cambian un campo, importamos de menos, no
  reventamos.
- Si algún día hace falta lanzar en Instantly —por ejemplo, un cliente que
  exige quedarse con su operación allá— será un modo explícito y degradado, con
  un aviso de que la atribución no va a existir.

## Lo que este ADR prohíbe

Llamar a cualquier endpoint de Instantly que cree, modifique o lance una
campaña.
