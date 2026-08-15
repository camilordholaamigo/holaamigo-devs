# ADR 0001 · Schema `holaamigo` en vez de `public`

- **Fecha:** 2026-08-15
- **Estado:** aceptada
- **Afecta:** todo el modelo de datos

## Contexto

Reciclamos el proyecto Supabase de Rentmies (`kkqzzdtdkrxdlfrllauy`). Rentmies
está **en producción y facturando**: su schema `public` tiene tablas vivas y
casi con certeza incluye nombres que Hola Amigo también necesita —
`organizations`, `leads`, `messages`, `campaigns`.

Una colisión no daría un error limpio. Daría algo peor: un `insert` de Hola
Amigo aterrizando en una tabla de Rentmies, o un `select` de Rentmies leyendo
filas nuestras. En una base con clientes reales, eso no es un bug, es un
incidente.

## Alternativas

**A · Prefijo `ha_` en `public`.** Cero configuración, funciona con PostgREST y
Realtime sin tocar nada. Pero contamina el schema de un producto en producción
con 20 tablas ajenas, y el aislamiento depende de que nadie se equivoque al
escribir un nombre.

**B · Proyecto Supabase nuevo.** Aislamiento perfecto. Pero pierde exactamente
lo que se pidió — reciclar el proyecto existente — y suma un proyecto más que
mantener, con sus propias credenciales, backups y facturación.

**C · Schema dedicado `holaamigo`.** Aislamiento a nivel de motor: `leads` de
Hola Amigo y `leads` de Rentmies son objetos distintos que no se pueden
confundir. Un `grant` explícito controla quién ve qué.

## Decisión

**C.** El cliente se construye con `db: { schema: 'holaamigo' }`, así que
`.from('leads')` **nunca** puede resolver a la tabla de Rentmies, ni siquiera
por error de tipeo. El aislamiento lo garantiza Postgres, no nuestra disciplina.

## Consecuencias

- **Un paso manual obligatorio:** hay que agregar `holaamigo` a *Exposed
  schemas* en Project Settings → Data API. Sin eso, PostgREST devuelve 404 en
  todo. Está en el CHANGELOG como paso 1 de despliegue.
- Los `grant` a `service_role` van explícitos en la migración: un schema nuevo
  no hereda los permisos que Supabase configura para `public`.
- Si algún día migramos a proyecto propio, es un `pg_dump -n holaamigo` y un
  restore. El schema dedicado hace la salida barata.
- Realtime sobre este schema exigiría agregarlo a la publicación. No nos afecta
  porque no usamos Realtime (ver ADR 0002).
