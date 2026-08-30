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
import { register } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

// Resuelve `@/` para poder importar el modulo REAL en vez de una copia.
// Ver scripts/alias-hooks.mjs.
register('./alias-hooks.mjs', import.meta.url);
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
  // Se verifica que estén LAS CINCO de 0014, no que sean las únicas. La
  // primera versión comparaba contra la lista completa de tablas `smoke_%` y
  // se rompió en cuanto 0015 agregó dos más — una prueba que falla porque el
  // proyecto creció no está probando nada, solo pidiendo mantenimiento.
  const esperadas = [
    'smoke_channels',
    'smoke_probes',
    'smoke_runs',
    'smoke_targets',
    'smoke_templates',
  ];
  const { rows: tablas } = await db.query(
    `select table_name from information_schema.tables
      where table_schema = 'holaamigo' and table_name = any($1) order by 1`,
    [esperadas],
  );
  check(
    'las cinco tablas de 0014',
    tablas.length === esperadas.length,
    `faltan: ${esperadas.filter((t) => !tablas.some((r) => r.table_name === t)).join(', ')}`,
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

  // Se verifica que ESTÉN las tres de 0014, no que sean las únicas — mismo
  // error que ya cometí con la lista de tablas. Una migración posterior que
  // agregue un molde de fábrica no puede romper esta prueba: si lo rompiera,
  // el chequeo estaría pidiendo mantenimiento en vez de proteger algo.
  const moldes = ['faq', 'servicio', 'ventas'];
  const { rows: plantillas } = await db.query(
    `select id from holaamigo.smoke_templates where es_semilla and id = any($1) order by 1`,
    [moldes],
  );
  check(
    'las tres pruebas de fábrica de 0014',
    plantillas.length === moldes.length,
    `faltan: ${moldes.filter((m) => !plantillas.some((r) => r.id === m)).join(', ')}`,
  );

  const { rows: cap } = await db.query(
    `select platform_ceiling, risk_class, min_plan from holaamigo.capabilities
     where id = 'smoketest.probe'`,
  );
  check('la capacidad está en el catálogo', cap.length === 1);
  check(
    'el mensaje sale del edificio y el techo de plataforma no llega a L5',
    cap[0]?.risk_class === 'self_outreach' && cap[0]?.platform_ceiling === 4,
    JSON.stringify(cap[0] ?? {}),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2b · La correa DEJA correr la prueba en el escenario real\x1b[0m');

// Esta sección existe por un bug de producción: el smoke tester automático no
// corrió NUNCA. `smoketest.probe` estaba clasificada como `external_comms`, y
// para eso el plan `diagnostico` topa en 2 y la autonomía `propose` topa en 1
// — o sea nivel efectivo 1, bloqueado. Y ése es exactamente el único escenario
// donde la capacidad se usa: un prospecto que acaba de llegar, en plan gratis,
// sin agentes configurados.
//
// El síntoma era una línea de log que nadie miraba. Estas dos comprobaciones
// son las que lo habrían gritado. Ver la migración 0016.
{
  const { rows: org } = await db.query(
    `insert into holaamigo.organizations (website_url) values ('https://correa-test.co')
     returning id`,
  );
  const orgId = org[0].id;

  const autorizar = async (capacidad) => {
    const { rows } = await db.query(
      'select holaamigo.autorizar($1, $2, $3::jsonb, null, false) as r',
      [orgId, capacidad, '{}'],
    );
    return rows[0].r;
  };

  const { rows: plan } = await db.query(
    `select plan from holaamigo.organizations where id = $1`,
    [orgId],
  );
  check(
    'el prospecto arranca en el plan gratis, como en la vida real',
    plan[0].plan === 'diagnostico',
    `plan = ${plan[0].plan}`,
  );

  const prueba = await autorizar('smoketest.probe');
  check(
    'un prospecto en plan gratis SÍ se puede probar',
    prueba.accion_permitida === 'ejecutar',
    `${prueba.accion_permitida} · nivel ${prueba.effective_level} · ${prueba.reason ?? ''}`,
  );
  check(
    'y llega al nivel 4, no más',
    prueba.effective_level === 4,
    `nivel ${prueba.effective_level}`,
  );

  // El otro lado de la moneda: lo que SÍ tiene que seguir topado por el plan.
  // Si esto pasara a 'ejecutar', la clase nueva estaría abriendo de más.
  const responder = await autorizar('outreach.reply');
  check(
    'pero contestarle a un contacto SUYO sigue topado por el plan gratis',
    responder.accion_permitida !== 'ejecutar',
    `${responder.accion_permitida} · nivel ${responder.effective_level}`,
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
console.log('\n\x1b[1m7 · La prueba a medida y las varias líneas (0017)\x1b[0m');

{
  // (a) Los dos moldes semilla. `smoke_probes.template_id` es clave foránea, así
  //     que sin estas filas una prueba escrita a mano no se puede insertar — y
  //     el síntoma sería un 23503 en el momento de mandar, no antes.
  const { rows: moldes } = await db.query(
    `select id, max_turnos, jsonb_array_length(rubrica) as criterios
       from holaamigo.smoke_templates
      where id in ('a-medida', 'guion')
      order by id`,
  );
  check(
    'los moldes a-medida y guion existen',
    moldes.length === 2,
    JSON.stringify(moldes.map((m) => m.id)),
  );
  check(
    'y traen rúbrica: sin criterios, la auditoría no tendría nada que verificar',
    moldes.every((m) => m.criterios >= 4),
    JSON.stringify(moldes),
  );

  // (b) `dio_precio` NO está en la rúbrica de los dos moldes a medida. Es
  //     binario y no sabe si se llegó a preguntar por plata: reprobar a un
  //     negocio por no dar un precio que nadie le pidió es inventar un
  //     resultado, que es lo único que este producto no se puede permitir.
  const { rows: precio } = await db.query(
    `select count(*)::int as n
       from holaamigo.smoke_templates t,
            jsonb_array_elements(t.rubrica) c
      where t.id in ('a-medida', 'guion') and c->>'chequeo' = 'dio_precio'`,
  );
  check('ningún molde a medida reprueba por no dar un precio que nadie pidió', precio[0].n === 0);

  // (c) Los índices por par (nuestra línea, su número). Son los que hacen que
  //     «¿está ocupado este hilo?» siga costando lo mismo con varias líneas.
  const { rows: idx } = await db.query(
    `select indexname from pg_indexes
      where schemaname = 'holaamigo'
        and indexname in ('smoke_probes_linea_idx', 'smoke_probes_awaiting_linea_idx')`,
  );
  check('los dos índices por par (línea, número) existen', idx.length === 2, JSON.stringify(idx));

  // (d) Dos de nuestras líneas contra el MISMO número tienen que poder convivir.
  //     Es la capacidad entera de ADR 0027, y si algún día alguien le pone un
  //     índice único a (target_phone) donde no va, esto lo agarra.
  const { rows: canal2 } = await db.query(
    `insert into holaamigo.smoke_channels (label, provider, phone_e164, channel_uuid)
     values ('Callbell · línea 2', 'callbell', '+573001119999', 'canal-de-prueba-2')
     returning id`,
  );
  const { rows: canal1 } = await db.query(
    `select id from holaamigo.smoke_channels where channel_uuid = '124902a5f0fa43289fe1fa7a4c23fe0d'`,
  );
  const { rows: t } = await db.query(
    `insert into holaamigo.smoke_targets (nombre, phone_e164, origen)
     values ('Mirla', '+573002221100', 'manual') returning id`,
  );
  const { rows: r } = await db.query(
    `insert into holaamigo.smoke_runs (origen, estado) values ('manual', 'running') returning id`,
  );

  let convivencia = null;
  try {
    for (const canalId of [canal1[0].id, canal2[0].id]) {
      await db.query(
        `insert into holaamigo.smoke_probes
           (run_id, target_id, template_id, channel_id, target_phone, plan, estado, awaiting_reply)
         values ($1, $2, 'a-medida', $3, '+573002221100', '{}'::jsonb, 'running', true)`,
        [r[0].id, t[0].id, canalId],
      );
    }
  } catch (err) {
    convivencia = err.message;
  }
  check(
    'dos líneas nuestras pueden tener una conversación viva contra el mismo número',
    convivencia === null,
    convivencia ?? '',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m8 · Las invariantes del código que trajo 0017\x1b[0m');

{
  const leer = (rel) => readFile(join(raiz, rel), 'utf8');

  // (a) La cola y la cancelación son por par. Sin el canal, arrancar la
  //     conversación de la línea B cancelaba la de la línea A contra el mismo
  //     negocio — que es exactamente lo que se quiere permitir.
  const motor = await leer('lib/pruebas/motor.ts');
  check(
    'avanzarCola recibe el canal: la cola es por par (línea, número)',
    /export async function avanzarCola\([\s\S]{0,600}?canalId: string,/.test(motor),
  );
  check(
    'y filtra por channel_id al buscar lo vivo y lo pendiente',
    (motor.match(/\.eq\('channel_id', canalId\)/g) ?? []).length >= 3,
  );
  check(
    'cancelarVivasContra recibe el canal',
    /export async function cancelarVivasContra\([\s\S]{0,900}?canalId: string \| null,/.test(motor),
  );

  // (b) En modo guion los detectores de cierre NO paran la prueba. Si el negocio
  //     agenda en el mensaje dos, las preguntas tres y cuatro se mandan igual:
  //     es lo que pidió el que armó el guion y es lo que hace comparables veinte
  //     conversaciones. Se verifica por posición porque es una invariante de
  //     ORDEN, y un refactor que mueva la rama la rompe sin cambiar una línea.
  check(
    'la rama del guion corre antes de los detectores de cierre',
    motor.indexOf("modoDelPlan(plan) === 'guion'") <
      motor.indexOf('const cierre = detectarCierreDeNegocio(bloque)'),
  );
  check(
    'y el guion no llama al comprador: el mensaje siguiente ya está escrito',
    /async function avanzarGuion\([\s\S]*?\n\}/.test(motor) &&
      !/async function avanzarGuion\([\s\S]*?siguienteTurno\(/.test(
        motor.slice(motor.indexOf('async function avanzarGuion')),
      ),
  );

  // (c) `guion.ts` tiene que poder correr en el navegador: la vista previa del
  //     formulario muestra lo que se va a mandar usando las MISMAS funciones que
  //     arman el plan en el servidor. Un import de base de datos acá haría que
  //     el preview se calcule distinto de lo que se manda, y una pantalla que
  //     miente es peor que no tener pantalla.
  const guion = await leer('lib/pruebas/guion.ts');
  check(
    'guion.ts no importa nada de servidor: la vista previa usa las mismas funciones',
    !/supabase|runStructured|@\/lib\/ai|process\.env/.test(guion),
  );
  // Se busca el IMPORT y no la palabra: el encabezado del archivo explica con
  // nombre y paréntesis por qué la red de cifras no corre acá, y una prueba que
  // se rompe porque alguien documentó su propia decisión enseña a no documentar.
  check(
    'y no le pasa blanquearCifras al texto del operador',
    !/^import[^;]*blanquearCifras/m.test(guion),
  );

  // (d) La correlación desambigua entre líneas, y cuando no puede lo DICE. El
  //     log a ciegas es lo único que va a resolver el incidente el día que dos
  //     conversaciones simultáneas contra el mismo negocio cruzen un mensaje.
  const correlacion = await leer('lib/pruebas/webhook.ts');
  check(
    'la correlación desambigua por channel_uuid cuando hay varias candidatas',
    /entrante\.canalUuid/.test(correlacion) && /porLinea\(/.test(correlacion),
  );
  check(
    'y deja escrito en el log cuando desambigua a ciegas',
    /desambiguaci[oó]n a ciegas/.test(correlacion),
  );
  check(
    'porLinea nunca devuelve vacío: perder el entrante cuelga la conversación',
    /if \(porCanal\.length > 0\) return/.test(correlacion) &&
      /return \{ coinciden: candidatas, aCiegas: true \}/.test(correlacion),
  );

  // (e) Un solo camino para crear una prueba a mano. Tener dos endpoints que
  //     hacían casi lo mismo con palabras distintas era la mitad del problema.
  let sobrevive = false;
  try {
    await leer('app/api/admin/pruebas/lotes/route.ts');
    sobrevive = true;
  } catch {
    sobrevive = false;
  }
  check('el POST de lotes ya no existe: hay un solo camino de creación', !sobrevive);
  const lanzar = await leer('lib/pruebas/lanzar.ts');
  check('y lanzarDesdeAdmin se fue de lanzar.ts', !/export async function lanzarDesdeAdmin/.test(lanzar));

  // (f) La llave se normaliza antes de salir. El panel de Callbell muestra el
  //     token ya escrito como cabecera (`Bearer xxx`), así se copia, y así entra
  //     a la variable. Con el prefijo pegado el header sale `Bearer Bearer …` y
  //     la API contesta 401 «not authorized», que es indistinguible de una llave
  //     vencida. Costó una tarde el 2026-08-23. Se verifica que el header NO lea
  //     `process.env` directo: es el único punto donde el bug puede volver.
  const callbell = await leer('lib/pruebas/callbell.ts');
  check(
    'llaveCallbell() le saca el prefijo Bearer a la variable',
    /export function llaveCallbell\(\)[\s\S]{0,400}?replace\(\/\^bearer/i.test(callbell),
  );
  check(
    'y el header usa llaveCallbell(), no process.env: es donde vuelve el 401',
    /authorization: `Bearer \$\{llaveCallbell\(\)\}`/.test(callbell) &&
      !/authorization: `Bearer \$\{process\.env/.test(callbell),
  );
  check(
    'faltaParaEnviar() mira la llave normalizada: una variable que solo dice «Bearer » falta',
    /if \(!llaveCallbell\(\)\) falta\.CALLBELL_API_KEY = true;/.test(callbell),
  );

  // (g) El camino del cliente manda `plantillas`, no `aMedida`. Es lo único que
  //     hace que el compilador lea el research: con `aMedida` la pantalla diría
  //     «como en el diagnóstico» y mandaría un guion escrito a mano, que es
  //     precisamente la cosa que no reproduce el escenario del cliente.
  const formulario = await leer('components/prueba-nueva.tsx');
  check(
    'cuerpoDelCliente manda plantillas y no aMedida',
    /function cuerpoDelCliente\(\)[\s\S]*?plantillas: bateria\.map/.test(formulario) &&
      !/function cuerpoDelCliente\(\)[\s\S]*?aMedida:/.test(
        formulario.slice(
          formulario.indexOf('function cuerpoDelCliente'),
          formulario.indexOf('function cuerpoAMano'),
        ),
      ),
  );
  // La lista de clientes NO se filtra por «tiene número». El research solo
  // registra los publicados, y filtrar por eso dejaba la pantalla vacía justo
  // para los clientes que sí tienen análisis.
  const pantalla = await leer('app/admin/pruebas/nueva/page.tsx');
  check(
    'la lista de clientes sale de organizations, no de smoke_targets',
    /\.from\('organizations'\)/.test(pantalla),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m9 · saludDeLineaWzap(): ¿va a VOLVER la respuesta?\x1b[0m');
{
  // En wzap el webhook se registra POR DEVICE. Una cuenta puede tener la llave
  // bien, el device bien y el mensaje saliendo perfecto, y no recibir una sola
  // respuesta — porque el webhook que reenvía los entrantes está atado a OTRA
  // línea de la misma cuenta. El mensaje sale, el negocio contesta, el evento
  // se dispara hacia una URL ajena, la conversación se cuelga, el watchdog la
  // cierra y el informe del cliente dice «no contestó».
  //
  // Eso no es un error: es una cifra falsa, y una acusación falsa contra el
  // negocio de alguien. Es el peor modo de fallo de todo el subsistema y el
  // único que no deja rastro en ningún log, así que se prueba.
  //
  // Los datos de abajo tienen la FORMA real de `GET /v1/devices` y
  // `/v1/webhooks`: una cuenta compartida, con la línea de pruebas que siembra
  // la migración 0018 y un webhook hacia una aplicación ajena.
  const { saludDeLineaWzap } = await import('@/lib/pruebas/wzap');

  const NUESTRO = '69e62a9b0b653ef3ef32e965';
  const AJENO = '67eaa49004ab7e30a7283ae3';
  const SECRETO = 'un-secreto-cualquiera';

  const devices = [
    { id: AJENO, phone: '+573136102235', alias: 'Otro negocio', status: 'operative', sesion: 'online' },
    { id: NUESTRO, phone: '+573332420353', alias: 'La de pruebas', status: 'operative', sesion: 'online' },
  ];
  const webhooks = [
    { id: 'a', nombre: 'ajeno', url: 'https://otra-app.example.com/hook', activo: true, deviceId: NUESTRO, eventos: ['message:in:new'] },
    { id: 'b', nombre: 'nuestro', url: `https://holaamigo.example.com/api/webhooks/wzap?k=${SECRETO}`, activo: true, deviceId: NUESTRO, eventos: ['message:in:new'] },
  ];
  const base = { devices, webhooks, nuestraRuta: '/api/webhooks/wzap', secreto: SECRETO };

  const nuestra = saludDeLineaWzap({ ...base, channelUuid: NUESTRO });
  check(
    'la línea bien configurada no levanta ninguna alarma',
    nuestra.problemas.length === 0 && nuestra.recibeRespuestas === true,
    nuestra.problemas.join(' · '),
  );
  check(
    'y confirma que el secreto de la URL es el vigente',
    nuestra.secretoEnLaUrlCoincide === true,
  );

  // EL CASO QUE JUSTIFICA TODO ESTO: manda perfecto y no recibe nada.
  const otraLinea = saludDeLineaWzap({ ...base, channelUuid: AJENO });
  check(
    'una línea sin webhook propio avisa que va a decir «no contestó»',
    otraLinea.recibeRespuestas === false &&
      otraLinea.problemas.some((p) => p.includes('no contestó')),
    otraLinea.problemas.join(' · '),
  );

  const inventado = saludDeLineaWzap({ ...base, channelUuid: 'f'.repeat(24) });
  check(
    'un device que no existe en la cuenta se dice antes de mandar nada',
    inventado.device === null && inventado.problemas.some((p) => p.includes('no existe')),
  );

  const rotado = saludDeLineaWzap({ ...base, channelUuid: NUESTRO, secreto: 'otro' });
  check(
    'un secreto rotado sin actualizar el webhook avisa del 401',
    rotado.secretoEnLaUrlCoincide === false && rotado.problemas.some((p) => p.includes('401')),
  );

  const caida = saludDeLineaWzap({
    ...base,
    channelUuid: NUESTRO,
    devices: devices.map((d) => (d.id === NUESTRO ? { ...d, sesion: 'offline' } : d)),
  });
  check(
    'una sesión caída manda a reconectar el QR',
    caida.problemas.some((p) => p.includes('QR')),
  );

  // `null` es «no se pudo preguntar» y NO es «no hay ninguno». Sin esa
  // distinción, una caída de wzap pintaría la pantalla de rojo diciendo que la
  // configuración está mal — y mandaría a alguien a romper lo que funciona.
  const aOscuras = saludDeLineaWzap({
    ...base,
    channelUuid: NUESTRO,
    devices: null,
    webhooks: null,
  });
  check(
    'sin poder consultar al proveedor no inventa alarmas',
    aOscuras.problemas.length === 0 && aOscuras.recibeRespuestas === false,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mEl smoke tester aplica limpio y respeta sus invariantes.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} chequeo(s) fallaron.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
