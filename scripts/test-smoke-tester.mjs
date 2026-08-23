#!/usr/bin/env node
/**
 * El smoke tester, contra Postgres real y contra el propio código.
 *
 *   node scripts/test-smoke-tester.mjs
 *
 * Dos mitades, y la segunda es tan importante como la primera:
 *
 *   1. EL ESQUEMA. Que 0014 aplique sobre el esquema real, que los índices
 *      parciales existan, que las claves de upsert sirvan de árbitro, que la
 *      semilla no pise ediciones, y que `resumen_de_pruebas()` cuente lo que
 *      dice contar.
 *
 *   2. LAS INVARIANTES DEL CÓDIGO. Hay tres cosas que este subsistema promete
 *      y que no se pueden verificar con un tipo ni con una prueba de
 *      integración: que ningún esquema que va a OpenAI pida una cifra, que
 *      ninguna escritura del camino del producto sea un `await` pelado, y que
 *      el `onConflict` de cada upsert apunte a un índice que existe en la
 *      migración. Se verifican leyendo los archivos, que es feo y es la única
 *      forma que hay. Ver ADR 0024, que hace lo mismo con el playbook.
 *
 * Lo que NO cubre, dicho para que nadie se confíe: el motor por eventos
 * —turnos, acumulado de ráfagas, correlación— no se ejercita acá. Necesita un
 * proveedor de WhatsApp respondiendo, y simularlo probaría la simulación. Eso
 * se verifica a mano con el procedimiento de docs/wiki/23-smoke-tester.md.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const carpeta = join(raiz, 'supabase', 'migrations');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      \x1b[31m${detail}\x1b[0m` : ''}`);
  }
}

const db = new PGlite();
await db.exec(`
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`);

const archivos = (await readdir(carpeta)).filter((f) => f.endsWith('.sql')).sort();
for (const archivo of archivos) {
  await db.exec(await readFile(join(carpeta, archivo), 'utf8'));
}

console.log('\n\x1b[1mSmoke tester · Postgres real (PGlite)\x1b[0m');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El orden: 0014 sin 0007 tiene que fallar diciendo qué falta\x1b[0m');

{
  const solo = new PGlite();
  await solo.exec(`
    do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
    do $$ begin create role anon;          exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
  `);
  await solo.exec(await readFile(join(carpeta, '0001_init.sql'), 'utf8'));

  let mensaje = null;
  try {
    await solo.exec(await readFile(join(carpeta, '0014_smoke_tester.sql'), 'utf8'));
  } catch (err) {
    mensaje = err.message;
  }

  check('no se aplica sin 0007', Boolean(mensaje), 'la aceptó sin el catálogo de capacidades');
  check(
    'nombra el archivo que falta, no la tabla',
    /0007_gobierno\.sql/.test(mensaje ?? ''),
    mensaje ?? '',
  );
  check(
    'no dejó tablas a medio crear',
    (await solo.query(`select count(*)::int as n from information_schema.tables
                       where table_schema = 'holaamigo' and table_name like 'smoke_%'`))
      .rows[0].n === 0,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · Lo que 0014 tenía que dejar\x1b[0m');

{
  const { rows: tablas } = await db.query(`
    select table_name from information_schema.tables
    where table_schema = 'holaamigo' and table_name like 'smoke_%' order by 1`);
  check(
    'las cinco tablas',
    tablas.map((r) => r.table_name).join(',') ===
      'smoke_channels,smoke_probes,smoke_runs,smoke_targets,smoke_templates',
    tablas.map((r) => r.table_name).join(','),
  );

  // El índice parcial sobre `awaiting_reply` es lo que mantiene la búsqueda del
  // webhook en O(conversaciones activas) en vez de O(todas las pruebas
  // históricas). Sin él, el webhook se degrada solo con el tiempo y nadie se
  // entera hasta que ya hay 50.000 filas.
  const { rows: indices } = await db.query(`
    select indexname from pg_indexes
    where schemaname = 'holaamigo'
      and indexname in ('smoke_probes_awaiting_idx','smoke_probes_awaiting_phone_idx',
                        'smoke_targets_phone_key','smoke_channels_provider_key')
    order by 1`);
  check(
    'los índices que sostienen la correlación',
    indices.length === 4,
    indices.map((r) => r.indexname).join(', '),
  );

  // `turn_token` como COLUMNA, no como clave de un jsonb. Es lo que permite
  // reclamar un turno con un update condicional, que es atómico.
  const { rows: cols } = await db.query(`
    select column_name from information_schema.columns
    where table_schema='holaamigo' and table_name='smoke_probes'
      and column_name in ('turn_token','turno','updated_at','target_phone','segundos_primera_respuesta')
    order by 1`);
  check(
    'turno, turn_token, updated_at, target_phone y los segundos son columnas',
    cols.length === 5,
    cols.map((r) => r.column_name).join(', '),
  );

  const { rows: trig } = await db.query(`
    select tgname from pg_trigger
    where tgrelid = 'holaamigo.smoke_probes'::regclass and not tgisinternal`);
  check('smoke_probes tiene su trigger de updated_at', trig.length >= 1);

  const { rows: plantillas } = await db.query(
    `select id from holaamigo.smoke_templates where es_semilla order by 1`,
  );
  check(
    'las tres pruebas de fábrica',
    plantillas.map((r) => r.id).join(',') === 'faq,servicio,ventas',
    plantillas.map((r) => r.id).join(','),
  );

  const { rows: cap } = await db.query(
    `select platform_ceiling, risk_class, min_plan from holaamigo.capabilities
     where id = 'smoketest.probe'`,
  );
  check('la capacidad está en el catálogo', cap.length === 1);
  check(
    'escribirle a un tercero es external_comms y no llega a L5',
    cap[0]?.risk_class === 'external_comms' && cap[0]?.platform_ceiling === 4,
    JSON.stringify(cap[0] ?? {}),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · La semilla no pisa lo que el equipo editó\x1b[0m');

{
  await db.exec(`
    update holaamigo.smoke_templates
       set objetivo = 'OBJETIVO EDITADO A MANO', max_turnos = 6
     where id = 'servicio'`);

  await db.exec(await readFile(join(carpeta, '0014_smoke_tester.sql'), 'utf8'));

  const { rows } = await db.query(
    `select objetivo, max_turnos from holaamigo.smoke_templates where id = 'servicio'`,
  );
  check(
    'volver a correr la migración conserva la edición',
    rows[0].objetivo === 'OBJETIVO EDITADO A MANO' && rows[0].max_turnos === 6,
    JSON.stringify(rows[0]),
  );

  // El catálogo de capacidades SÍ se pisa, y es lo correcto: es nuestro, no del
  // cliente, y así se actualiza junto con el código que lo usa.
  // Los dos a la vez: `capabilities_default_bajo_techo` no deja que el nivel
  // por defecto pase el techo, y bajar solo uno reventaría por esa restricción
  // en vez de por lo que esta prueba quiere ver.
  await db.exec(
    `update holaamigo.capabilities set platform_ceiling = 1, default_level = 1
      where id = 'smoketest.probe'`,
  );
  await db.exec(await readFile(join(carpeta, '0014_smoke_tester.sql'), 'utf8'));
  const { rows: cap } = await db.query(
    `select platform_ceiling, default_level from holaamigo.capabilities
      where id = 'smoketest.probe'`,
  );
  check(
    'el catálogo de capacidades sí se re-siembra',
    cap[0].platform_ceiling === 4 && cap[0].default_level === 4,
    JSON.stringify(cap[0]),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Las claves de upsert son índices planos y sirven de árbitro\x1b[0m');

{
  const { rows: org } = await db.query(
    `insert into holaamigo.organizations (website_url) values ('https://acme-pruebas.co')
     returning id`,
  );
  const orgId = org[0].id;

  // Dos veces el mismo número: la segunda actualiza, no duplica ni revienta.
  for (const nombre of ['Acme', 'Acme Ventas']) {
    await db.query(
      `insert into holaamigo.smoke_targets (organization_id, nombre, phone_e164, origen, confianza)
       values ($1, $2, '+573001112233', 'research', 0.9)
       on conflict (phone_e164) do update set nombre = excluded.nombre`,
      [orgId, nombre],
    );
  }
  const { rows: targets } = await db.query(
    `select nombre from holaamigo.smoke_targets where phone_e164 = '+573001112233'`,
  );
  check(
    'on conflict (phone_e164) funciona y quedó una sola fila',
    targets.length === 1 && targets[0].nombre === 'Acme Ventas',
    JSON.stringify(targets),
  );

  let errorCanal = null;
  try {
    await db.query(
      `insert into holaamigo.smoke_channels (label, provider, phone_e164, channel_uuid)
       values ('otro', 'callbell', '+573054182637', '124902a5f0fa43289fe1fa7a4c23fe0d')
       on conflict (provider, channel_uuid) do nothing`,
    );
  } catch (err) {
    errorCanal = err.message;
  }
  check('on conflict (provider, channel_uuid) es un árbitro válido', errorCanal === null, errorCanal ?? '');

  // El bloqueo NO se revierte con un upsert. Un número que pidió que no le
  // escribamos no se desbloquea porque alguien volvió a correr el diagnóstico.
  await db.query(
    `update holaamigo.smoke_targets set bloqueado = true, bloqueado_motivo = 'pidió parar'
     where phone_e164 = '+573001112233'`,
  );
  await db.query(
    `insert into holaamigo.smoke_targets (organization_id, nombre, phone_e164, origen, confianza)
     values ($1, 'Acme', '+573001112233', 'research', 0.9)
     on conflict (phone_e164) do update set nombre = excluded.nombre`,
    [orgId],
  );
  const { rows: bloq } = await db.query(
    `select bloqueado from holaamigo.smoke_targets where phone_e164 = '+573001112233'`,
  );
  check('un upsert no desbloquea un número que pidió parar', bloq[0].bloqueado === true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · resumen_de_pruebas() cuenta lo que dice contar\x1b[0m');

{
  const { rows: org } = await db.query(
    `insert into holaamigo.organizations (website_url) values ('https://resumen-pruebas.co')
     returning id`,
  );
  const { rows: run } = await db.query(
    `insert into holaamigo.smoke_runs (organization_id, origen) values ($1, 'manual') returning id`,
    [org[0].id],
  );
  const { rows: target } = await db.query(
    `insert into holaamigo.smoke_targets (organization_id, phone_e164, origen)
     values ($1, '+573009998877', 'manual') returning id`,
    [org[0].id],
  );
  const { rows: canal } = await db.query(`select id from holaamigo.smoke_channels limit 1`);

  const insertar = (estado, cerroCon, segundos, auditoria) =>
    db.query(
      `insert into holaamigo.smoke_probes
         (run_id, target_id, template_id, channel_id, target_phone, max_turnos,
          estado, cerro_con, segundos_primera_respuesta, auditoria_score, enviado_at,
          primera_respuesta_at)
       values ($1,$2,'servicio',$3,'+573009998877',8,$4,$5,$6::int,$7::int, now(), $8::timestamptz)`,
      [
        run[0].id,
        target[0].id,
        canal[0].id,
        estado,
        cerroCon,
        segundos,
        auditoria,
        segundos === null ? null : new Date().toISOString(),
      ],
    );

  await insertar('completed', 'objetivo_cumplido', 60, 80);
  await insertar('completed', 'objetivo_cumplido', 120, 60);
  await insertar('timeout', 'sin_respuesta', null, 20);
  // Una cancelada por nosotros no dice nada del negocio del cliente: si entrara
  // en la mediana, la ensuciaría con un evento que provocamos nosotros.
  await insertar('cancelled', null, 9999, 0);

  const { rows } = await db.query(
    `select * from holaamigo.resumen_de_pruebas(now() - interval '1 day')`,
  );
  const f = rows.find((r) => r.template_id === 'servicio');

  check('cuenta las enviadas sin las canceladas', Number(f.enviadas) === 3, JSON.stringify(f));
  check('cuenta las que contestaron', Number(f.contestaron) === 2);
  check('cuenta las que no contestaron', Number(f.sin_respuesta) === 1);
  check(
    'la mediana ignora las canceladas',
    f.mediana_segundos === 90,
    `mediana = ${f.mediana_segundos}, se esperaba 90`,
  );
  check(
    'el promedio de auditoría también',
    Math.round(Number(f.auditoria_promedio)) === 53,
    `promedio = ${f.auditoria_promedio}, se esperaba ~53,3`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m6 · Las invariantes del código\x1b[0m');

{
  /**
   * Los chequeos de acá corren sobre el código SIN COMENTARIOS.
   *
   * No es una sutileza: este archivo describe sus propias invariantes en prosa
   * —«no tienen un solo z.number()», «corre dentro de after()»— y una búsqueda
   * ingenua encuentra la frase que explica la regla y la reporta como si fuera
   * la violación. El primer intento falló exactamente así.
   */
  const sinComentarios = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const leer = async (ruta) => sinComentarios(await readFile(join(raiz, ruta), 'utf8'));

  // (a) Ningún esquema del smoke tester pide una cifra. El compilador y el
  //     comprador porque lo que escriben sale por WhatsApp sin revisión
  //     humana; el evaluador porque su nota la lee el cliente (ADR 0007).
  // El marcador de la sección ES un comentario, así que se recorta sobre el
  // archivo crudo y recién después se quitan los comentarios del recorte.
  const schemasCrudo = await readFile(join(raiz, 'lib/ai/schemas.ts'), 'utf8');
  const inicio = schemasCrudo.indexOf('// SMOKE TESTER');
  check('la sección del smoke tester existe en schemas.ts', inicio > 0);
  const bloque = sinComentarios(schemasCrudo.slice(inicio));
  check(
    'ningún z.number() en los esquemas del smoke tester',
    !/z\.number\(/.test(bloque),
    'alguien agregó una cifra a un esquema que va a OpenAI',
  );
  check(
    'el evaluador califica con juicios, no con números',
    /JuicioSchema = z\.enum/.test(bloque) && /exactitud: JuicioSchema/.test(bloque),
  );

  // (b) Ninguna escritura del camino del producto es un `await` pelado.
  //     `supabase-js` no lanza: devuelve `{ error }`, y un await sin mirar el
  //     error compila, corre y no escribe nada, en silencio.
  const fuentes = [
    'lib/pruebas/motor.ts',
    'lib/pruebas/lanzar.ts',
    'lib/pruebas/evaluador.ts',
    'lib/pruebas/numeros.ts',
  ];
  for (const ruta of fuentes) {
    // Se mira una ventana ANTES de cada `await db()`, no la línea: la consulta
    // casi siempre se parte en varias líneas y el `unwrap(` o el `mustWrite(`
    // quedan en la de arriba. Buscar por línea daba un falso positivo por cada
    // escritura correctamente envuelta, que es peor que no chequear nada.
    const src = (await leer(ruta)).replace(/\s+/g, ' ');
    const pelados = [];
    for (const m of src.matchAll(/await db\(\)/g)) {
      const antes = src.slice(Math.max(0, m.index - 160), m.index);
      const envuelto =
        /(mustWrite|tryWrite|unwrap)\(\s*$/.test(antes) ||
        /(const|let)\s+[\w{}[\],:\s]+=\s*$/.test(antes);
      if (!envuelto) pelados.push(src.slice(m.index, m.index + 90));
    }
    check(`sin await pelado en ${ruta}`, pelados.length === 0, pelados.join('\n      '));
  }

  // (c) El webhook siempre devuelve 200 cuando no matchea. Un 500 hace que el
  //     proveedor reintente o desactive el webhook, y se pierde la
  //     conversación entera por un error transitorio.
  const webhook = await leer('app/api/webhooks/callbell/route.ts');
  const status500 = /status:\s*5\d\d/.test(webhook);
  check('el webhook nunca devuelve 5xx', !status500);
  check(
    'y loguea la forma del payload antes de parsear',
    webhook.indexOf('resumirPayload') < webhook.indexOf('parsearEntrante(raw)'),
  );

  // (d) El primer mensaje sale en primer plano. Es el único momento en que hay
  //     alguien mirando, y donde falla el 90 % de los problemas de
  //     configuración.
  const motor = await leer('lib/pruebas/motor.ts');
  check(
    'arrancarPrueba manda el primer mensaje sin after()',
    /export async function arrancarPrueba/.test(motor) && !/after\(/.test(motor),
  );
  check(
    'y marca awaiting_reply antes de enviar',
    motor.indexOf('awaiting_reply: true') < motor.indexOf('const envio = await enviarMensaje'),
  );

  // (e) La correlación es por número. Es la deuda número uno del paquete del
  //     que viene esto y la razón por la que allá nunca se pudo paralelizar.
  const correlacion = await leer('lib/pruebas/webhook.ts');
  check(
    'la correlación empareja por teléfono, no por "la más reciente"',
    /mismoNumero\(c, p\.target_phone\)/.test(correlacion),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mEl smoke tester aplica limpio y respeta sus invariantes.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} chequeo(s) fallaron.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
