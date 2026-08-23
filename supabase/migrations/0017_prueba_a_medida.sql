-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 · La prueba a medida, y varias líneas contra el mismo número
--
-- 0014, 0015 y 0016 dejaron un smoke tester que solo sabe apuntarle a un
-- negocio que ya está en nuestra base con research corrido: las preguntas las
-- escribe el compilador leyendo `research_findings`. Falta el caso más pedido:
--
--   «Probá la Clínica Mirla, +57…, clínica estética en Bogotá. Que la IA haga
--    tres preguntas sobre sus tratamientos. O mandá estas tres exactas.»
--
-- Sin organización, sin research, sin desplegar. Eso es una prueba A MEDIDA.
--
-- TRES DECISIONES QUE EXPLICAN EL ARCHIVO:
--
--   1. EL PLAN SIGUE SIENDO EL CONTRATO. Una prueba a medida no trae tablas
--      nuevas: trae un `PlanDePrueba` escrito a mano en vez de compilado. El
--      motor, el auditor, el evaluador y el informe leen el plan y les da igual
--      quién lo escribió. Lo único que hace falta acá son dos filas semilla en
--      `smoke_templates`, porque `smoke_probes.template_id` es clave foránea —
--      y así `resumen_de_pruebas()` sigue agrupando por tipo de prueba en vez
--      de mezclar todo en un balde.
--
--   2. LA UNIDAD DE OCUPACIÓN PASA A SER (NUESTRA LÍNEA, SU NÚMERO). Dos de
--      nuestras líneas escribiéndole al mismo negocio son dos hilos de WhatsApp
--      distintos y los dos son legítimos — es justo lo que hace falta para ver
--      si su agente contesta igual a tres clientes a la vez. Hasta 0016, «ese
--      número está ocupado» se preguntaba solo por `target_phone`, así que la
--      segunda línea cancelaba la primera. El índice de abajo es el que hace
--      que esa pregunta, ahora por par, siga costando lo mismo.
--
--   3. EL MOLDE «GUION» NO TIENE SONDAS NI OBJETIVO DE VERDAD. En modo guion
--      los mensajes los escribe el operador y no hay comprador sintético que
--      decida nada; el molde existe solo para satisfacer la clave foránea y
--      para llevar la rúbrica con que se califica. Se deja explícito acá para
--      que nadie intente «arreglarlo» llenándole las sondas.
--
-- Ver docs/adr/0027-la-prueba-a-medida-y-las-lineas.md
--
-- Idempotente. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

-- ═══════════════ 0 · LO QUE TIENE QUE ESTAR ANTES ═══════════════

do $$
begin
  if to_regclass('holaamigo.smoke_batches') is null then
    raise exception
      E'0017 no se puede aplicar todavía: falta correr 0015_lotes_e_informes.sql antes.\n\n'
      'El orden es 0014_smoke_tester.sql → 0015_lotes_e_informes.sql →\n'
      '0016_la_prueba_no_la_gobierna_el_plan.sql → 0017_prueba_a_medida.sql.\n'
      'Las cuatro son idempotentes: si alguna ya corrió, correrla de nuevo no hace daño.';
  end if;
end $$;

-- ═══════════════ 1 · LA OCUPACIÓN, POR PAR ═══════════════
--
-- «¿Hay algo vivo desde ESTA línea contra ESE número?» es la pregunta que se
-- hace en cada arranque: en `avanzarCola()` del motor y en
-- `siguientePendiente()` del lote. Parcial sobre los dos estados vivos porque
-- el 99 % de las filas están cerradas y no tienen nada que hacer acá.

create index if not exists smoke_probes_linea_idx
  on holaamigo.smoke_probes (channel_id, target_phone)
  where estado in ('pending', 'running');

-- El webhook, cuando el payload trae el `channel_uuid` o nuestro propio
-- número, desambigua entre las conversaciones vivas contra el mismo negocio.
-- Sin este índice esa desambiguación barre las cincuenta filas más recientes.
create index if not exists smoke_probes_awaiting_linea_idx
  on holaamigo.smoke_probes (target_phone, channel_id)
  where awaiting_reply;

-- ═══════════════ 2 · LOS DOS MOLDES A MEDIDA ═══════════════
--
-- `do nothing`, como los tres de 0014 y por lo mismo: la rúbrica se ajusta
-- desde el admin y una migración corrida dos veces no puede pisar ese ajuste.
--
-- La rúbrica de `a-medida` es deliberadamente corta y toda determinística: sin
-- research no hay ficha, así que no hay ningún `menciona:` que se pueda
-- resolver, y un criterio que no se puede verificar sumaría un `null` que no
-- aporta. Cinco criterios que se contestan solos valen más que doce que
-- quedan en manos del modelo.
--
-- `dio_precio` NO está en ninguna de las dos. Es binario y no sabe si se llegó
-- a preguntar por plata: reprobar a un negocio por no dar un precio que nadie
-- le pidió es inventar un resultado, que es la única cosa que este producto no
-- se puede permitir.

insert into holaamigo.smoke_templates
  (id, nombre, descripcion, que_mide, objetivo, persona, apertura,
   sondas, rubrica, criterios_cierre, max_turnos, es_semilla)
values
  -- ── a-medida · conversación con objetivo escrito a mano ────────────────
  ('a-medida',
   'A medida',
   'La escribe el operador: el saludo, el objetivo y las preguntas. El comprador sintético conversa hasta llegar ahí. No necesita research.',
   'Le escribimos como un cliente y dejamos que la conversación llegue hasta donde llegue.',
   'Obtener respuesta a lo que se preguntó y llegar a un paso siguiente concreto.',
   '{"nombre": "Camila Restrepo", "correo": "camila.restrepo.pruebas@gmail.com", "telefono": "3054182637", "ciudad": "Bogotá"}',
   'Hola, buenas 🙂 Vi {negocio} y quería preguntar una cosa',
   '[]',
   '[{"id": "contesto", "dimension": "respuesta", "criterio": "Contestaron algo", "peso": 3, "chequeo": "hubo_respuesta"},
     {"id": "tiempo", "dimension": "respuesta", "criterio": "Contestaron en menos de 5 minutos", "peso": 3, "chequeo": "respondio_antes_de:300"},
     {"id": "califico", "dimension": "proceso", "criterio": "Preguntaron algo de vuelta en vez de solo despachar", "peso": 2, "chequeo": "pregunto_al_menos:1"},
     {"id": "propuso", "dimension": "iniciativa", "criterio": "Propusieron un paso siguiente concreto", "peso": 3, "chequeo": "propuso_paso_siguiente"},
     {"id": "completitud", "dimension": "contenido", "criterio": "Contestaron cada pregunta entera, sin esquivar", "peso": 2, "chequeo": null}]',
   '["Contestaron todo lo que se preguntó",
     "Propusieron una cita, una llamada o una cotización",
     "Dijeron que un humano se contacta después y no hay nada más que hacer",
     "La conversación empezó a dar vueltas"]',
   10, true),

  -- ── guion · los mensajes exactos, uno tras otro ────────────────────────
  --
  -- `sondas` vacío y `objetivo` casi vacío A PROPÓSITO: en modo guion los
  -- mensajes están en el plan y nadie redacta nada en vivo. Ver decisión 3.
  ('guion',
   'Preguntas fijas',
   'Los mensajes exactos que escribió el operador, uno tras otro, sin importar qué contesten. Cero llamadas a modelo. Sirve para hacerle la MISMA pregunta a veinte negocios y comparar.',
   'Le hicimos las mismas preguntas que a todos los demás, para poder comparar.',
   'Mandar las preguntas del guion y registrar lo que contestaron.',
   '{"nombre": "Camila Restrepo", "correo": "camila.restrepo.pruebas@gmail.com", "telefono": "3054182637", "ciudad": "Bogotá"}',
   'Hola, buenas 🙂',
   '[]',
   '[{"id": "contesto", "dimension": "respuesta", "criterio": "Contestaron algo", "peso": 3, "chequeo": "hubo_respuesta"},
     {"id": "tiempo", "dimension": "respuesta", "criterio": "Contestaron en menos de 5 minutos", "peso": 3, "chequeo": "respondio_antes_de:300"},
     {"id": "propuso", "dimension": "iniciativa", "criterio": "Propusieron un paso siguiente concreto", "peso": 2, "chequeo": "propuso_paso_siguiente"},
     {"id": "completitud", "dimension": "contenido", "criterio": "Contestaron cada pregunta del guion, no solo la primera", "peso": 3, "chequeo": null}]',
   '["Se mandaron todas las preguntas del guion"]',
   12, true)
on conflict (id) do nothing;

-- ═══════════════ 3 · EL VOCABULARIO ═══════════════
--
-- La mitad del problema que arregla 0017 era de nombres: «tanda» describía el
-- diseño viejo —la misma batería contra muchas líneas— y por eso nadie sabía
-- qué hacía el botón. Queda fijo, y los comentarios de las tablas son el único
-- lugar donde eso no se puede desincronizar del esquema.

comment on table holaamigo.smoke_batches is
  'LA PRUEBA: un guion contra N números desde M de nuestras líneas. El producto cartesiano son las conversaciones. 1x1 es una conversación suelta; 1xM prueba si su agente aguanta varios clientes a la vez; Nx1 es el barrido de prospección.';

comment on table holaamigo.smoke_probes is
  'LA CONVERSACIÓN: una transcripción completa contra un número real desde una de nuestras líneas, con su veredicto. La unidad de ocupación es el par (channel_id, target_phone): dos de nuestras líneas contra el mismo negocio son dos hilos distintos y los dos valen.';

comment on table holaamigo.smoke_channels is
  'NUESTRAS LÍNEAS: los números desde los que escribimos. Varias a la vez es la unidad de escala (ADR 0027). Editable en caliente desde /admin/pruebas.';

comment on column holaamigo.smoke_probes.plan is
  'El PlanDePrueba compilado. `modo` decide quién escribe cada turno: conversar = el comprador sintético; guion = los mensajes de `plan.guion`, en orden, sin llamar a ningún modelo. Las filas escritas antes de 0017 no tienen `modo` y se leen como conversar.';
