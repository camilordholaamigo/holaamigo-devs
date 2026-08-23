#!/usr/bin/env node
/**
 * El lote y el informe, contra Postgres real.
 *
 *   node scripts/test-lotes-e-informes.mjs
 *
 * Lo que se prueba acá no es «que las tablas existan»: es la ARITMÉTICA del
 * informe, que es lo único que el cliente lee y lo único que no puede estar
 * mal. Tres invariantes concretas:
 *
 *   1. Las canceladas NO cuentan. Las cancelamos nosotros; meterlas en la
 *      mediana sería reportarle al cliente un evento nuestro como si fuera
 *      suyo.
 *   2. Los criterios que no se pudieron verificar (`paso = null`) NO cuentan
 *      como fallo. Acusar a alguien porque no pudimos leer su sitio es la
 *      forma más rápida de que el informe pierda toda credibilidad.
 *   3. La frecuencia agrupa por `id` de criterio. Si algún día alguien la
 *      cambia a agrupar por texto, esta prueba se cae — y tiene que caerse,
 *      porque el texto lo escribe un modelo y nunca va a agrupar.
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

const roles = `
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`;

const db = new PGlite();
await db.exec(roles);
for (const archivo of (await readdir(carpeta)).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(join(carpeta, archivo), 'utf8'));
}

console.log('\n\x1b[1mLotes e informes · Postgres real (PGlite)\x1b[0m');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El orden: 0015 sin 0014 falla diciendo qué falta\x1b[0m');

{
  // Todo lo ANTERIOR al smoke tester. No se listan los archivos a mano —una
  // migración nueva entre medio dejaría esta prueba probando un esquema que ya
  // no existe— y tampoco se excluyen 0014 y 0015 por nombre: cualquier
  // migración posterior también depende de ellas y su guarda dispararía acá,
  // haciendo fallar la prueba por el motivo correcto en el lugar equivocado.
  // Se corta por número.
  const solo = new PGlite();
  await solo.exec(roles);
  const numero = (f) => Number.parseInt(f.slice(0, 4), 10);
  const sinSmoke = (await readdir(carpeta))
    .filter((f) => f.endsWith('.sql') && numero(f) < 14)
    .sort();
  for (const a of sinSmoke) {
    await solo.exec(await readFile(join(carpeta, a), 'utf8'));
  }

  let mensaje = null;
  try {
    await solo.exec(await readFile(join(carpeta, '0015_lotes_e_informes.sql'), 'utf8'));
  } catch (err) {
    mensaje = err.message;
  }

  check('no se aplica sin 0014', Boolean(mensaje));
  check('nombra el archivo que falta', /0014_smoke_tester\.sql/.test(mensaje ?? ''), mensaje ?? '');
  check(
    'no dejó tablas a medio crear',
    (
      await solo.query(`select count(*)::int as n from information_schema.tables
                        where table_schema='holaamigo' and table_name in ('smoke_batches','smoke_reports')`)
    ).rows[0].n === 0,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · Lo que 0015 tenía que dejar\x1b[0m');

{
  const { rows: tablas } = await db.query(`
    select table_name from information_schema.tables
    where table_schema='holaamigo' and table_name in ('smoke_batches','smoke_reports')
    order by 1`);
  check('las dos tablas', tablas.length === 2, tablas.map((r) => r.table_name).join(','));

  const { rows: batchCol } = await db.query(`
    select column_name from information_schema.columns
    where table_schema='holaamigo' and table_name='smoke_probes' and column_name='batch_id'`);
  check('smoke_probes.batch_id existe', batchCol.length === 1);

  const { rows: token } = await db.query(`
    select column_default from information_schema.columns
    where table_schema='holaamigo' and table_name='smoke_reports' and column_name='share_token'`);
  check(
    'share_token se genera solo y no es enumerable',
    /gen_random_uuid/.test(token[0]?.column_default ?? ''),
    token[0]?.column_default ?? '(sin default)',
  );

  // El tope de concurrencia tiene techo en la base, no solo en el formulario.
  // Es la última barrera contra que alguien mande 90 conversaciones juntas.
  let excedio = null;
  try {
    await db.query(
      `insert into holaamigo.smoke_batches (nombre, max_concurrentes) values ('x', 50)`,
    );
  } catch (err) {
    excedio = err.message;
  }
  check('la base rechaza un tope de concurrencia absurdo', Boolean(excedio));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · salud_de_linea(): la aritmética que el cliente lee\x1b[0m');

let orgId;
let canalId;
{
  const { rows: org } = await db.query(
    `insert into holaamigo.organizations (website_url) values ('https://informe-test.co') returning id`,
  );
  orgId = org[0].id;

  const { rows: run } = await db.query(
    `insert into holaamigo.smoke_runs (organization_id, origen) values ($1,'manual') returning id`,
    [orgId],
  );
  const { rows: target } = await db.query(
    `insert into holaamigo.smoke_targets (organization_id, phone_e164, origen)
     values ($1,'+573001110000','manual') returning id`,
    [orgId],
  );
  const { rows: canal } = await db.query(`select id from holaamigo.smoke_channels limit 1`);
  canalId = canal[0].id;

  const criterios = (props) =>
    JSON.stringify({
      score: 50,
      verificables: props.length,
      criterios: props,
      criticos: [],
      advertencias: [],
    });

  const insertar = (estado, cerroCon, segundos, auditoria, evaluacion) =>
    db.query(
      `insert into holaamigo.smoke_probes
         (run_id, target_id, template_id, channel_id, organization_id, target_phone, max_turnos,
          estado, cerro_con, segundos_primera_respuesta, enviado_at, primera_respuesta_at,
          auditoria, evaluacion)
       values ($1,$2,'ventas',$3,$4,'+573001110000',10,$5,$6,$7::int, now(), $8::timestamptz,
               $9::jsonb, $10::jsonb)`,
      [
        run[0].id,
        target[0].id,
        canalId,
        orgId,
        estado,
        cerroCon,
        segundos,
        segundos === null ? null : new Date().toISOString(),
        auditoria,
        evaluacion,
      ],
    );

  const conPropuso = (paso) => [
    { id: 'contesto', criterio: 'Contestaron algo', dimension: 'respuesta', peso: 3, paso: true },
    { id: 'propuso', criterio: 'Propuso el paso siguiente', dimension: 'iniciativa', peso: 3, paso },
    // Éste NO se pudo verificar. No tiene que contar como fallo en ningún lado.
    { id: 'sin_inventar', criterio: 'No inventó nada', dimension: 'exactitud', peso: 3, paso: null },
  ];

  await insertar('completed', 'objetivo_cumplido', 60, criterios(conPropuso(true)), null);
  await insertar('completed', 'incompleto', 240, criterios(conPropuso(false)), null);
  await insertar('timeout', 'sin_respuesta', null, criterios(conPropuso(false)), null);
  // Cancelada por nosotros: no tiene que aparecer en ninguna cifra.
  await insertar('cancelled', null, 9999, criterios(conPropuso(false)), null);

  const { rows } = await db.query(
    `select * from holaamigo.salud_de_linea($1, now() - interval '1 day')`,
    [orgId],
  );
  const s = rows[0];

  check('cuenta las conversaciones sin las canceladas', Number(s.conversaciones) === 3, JSON.stringify(s));
  check('cuenta las que contestaron', Number(s.contestadas) === 2);
  check('cuenta las que no contestaron', Number(s.sin_respuesta) === 1);
  check('la mediana ignora la cancelada', s.mediana_segundos === 150, `fue ${s.mediana_segundos}`);
  check('la más lenta ignora la cancelada', s.mas_lenta_segundos === 240, `fue ${s.mas_lenta_segundos}`);
  check(
    'propusieron_paso lee el criterio determinístico',
    Number(s.propusieron_paso) === 1,
    `fue ${s.propusieron_paso}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · hallazgos_por_frecuencia(): la cifra que decide qué arreglar\x1b[0m');

{
  const { rows } = await db.query(
    `select * from holaamigo.hallazgos_por_frecuencia($1, now() - interval '1 day')`,
    [orgId],
  );

  const propuso = rows.find((r) => r.id === 'propuso');
  check('encuentra el criterio que falló', Boolean(propuso), JSON.stringify(rows));
  check(
    'falló en 2 de 3, y la cancelada no entra',
    Number(propuso?.fallo_en) === 2 && Number(propuso?.de) === 3,
    JSON.stringify(propuso),
  );

  check(
    'el criterio que SÍ pasó no aparece como hallazgo',
    !rows.some((r) => r.id === 'contesto'),
  );

  // La invariante más importante del archivo: no se acusa a nadie por algo que
  // no pudimos verificar.
  check(
    'un criterio con paso=null NO aparece como fallo',
    !rows.some((r) => r.id === 'sin_inventar'),
    'apareció sin_inventar, que era imposible de verificar',
  );

  check('trae ejemplos para poder abrir la conversación', Array.isArray(propuso?.ejemplos) && propuso.ejemplos.length === 2);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · citas_del_periodo(): textuales, sin agrupar\x1b[0m');

{
  await db.query(
    `update holaamigo.smoke_probes
        set evaluacion = $2::jsonb
      where organization_id = $1 and estado = 'completed'`,
    [
      orgId,
      JSON.stringify({
        score: 40,
        alucinaciones: ['Dijeron que entregan en 2 días', 'Dijeron que cuesta 1.200.000'],
        errores: [],
        sugerencias: [],
      }),
    ],
  );

  const { rows } = await db.query(
    `select * from holaamigo.citas_del_periodo($1, now() - interval '1 day', 10)`,
    [orgId],
  );

  check('devuelve las citas textuales', rows.length === 4, `fueron ${rows.length}`);
  check(
    'la cita llega tal cual, sin comillas ni escapes de json',
    rows.some((r) => r.texto === 'Dijeron que entregan en 2 días'),
    JSON.stringify(rows.map((r) => r.texto)),
  );
  check('cada cita sabe de qué conversación salió', rows.every((r) => r.probe_id));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m6 · estado_del_lote(): los contadores del avanzador\x1b[0m');

{
  const { rows: lote } = await db.query(
    `insert into holaamigo.smoke_batches (nombre, max_concurrentes, ritmo_segundos)
     values ('tanda de prueba', 3, 30) returning id`,
  );
  await db.query(`update holaamigo.smoke_probes set batch_id = $1 where organization_id = $2`, [
    lote[0].id,
    orgId,
  ]);

  const { rows } = await db.query(`select * from holaamigo.estado_del_lote($1)`, [lote[0].id]);
  const e = rows[0];

  check('cuenta el total', Number(e.total) === 4, JSON.stringify(e));
  check('separa cerradas de fallidas', Number(e.cerradas) === 3 && Number(e.fallidas) === 1);
  check('cuenta organizaciones distintas', Number(e.organizaciones) === 1);
  check('sabe cuándo fue el último arranque', Boolean(e.ultimo_arranque));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m7 · Las invariantes del código\x1b[0m');

{
  const sinComentarios = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const leer = async (ruta) => sinComentarios(await readFile(join(raiz, ruta), 'utf8'));

  // El informe lo lee el cliente. Ninguna cifra suya puede salir de un modelo.
  const schemasCrudo = await readFile(join(raiz, 'lib/ai/schemas.ts'), 'utf8');
  const bloque = sinComentarios(
    schemasCrudo.slice(schemasCrudo.indexOf('export const InformeLenguajeSchema')),
  );
  check('InformeLenguajeSchema no pide ni una cifra', !/z\.number\(/.test(bloque));

  for (const ruta of ['lib/pruebas/lote.ts', 'lib/pruebas/informe.ts']) {
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

  // El tope de concurrencia tiene que seguir existiendo en el avanzador. Si
  // alguien lo saca «para que vaya más rápido», el número se quema.
  const lote = await leer('lib/pruebas/lote.ts');
  check(
    'avanzarLote respeta max_concurrentes',
    /estado\.corriendo >= lote\.max_concurrentes/.test(lote),
  );
  check('y respeta el ritmo entre arranques', /lote\.ritmo_segundos/.test(lote));
  check(
    'el avance está acotado por presupuesto de reloj',
    /PRESUPUESTO_MS/.test(lote) && /Date\.now\(\) < hasta/.test(lote),
  );

  // El impacto de una recomendación lo calcula el código, no el modelo.
  const informe = await leer('lib/pruebas/informe.ts');
  check('el impacto es una función pura del código', /function impactoDe\(/.test(informe));
  check(
    'el catálogo de recomendaciones vive en el repositorio',
    /const CATALOGO: Record</.test(informe),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mEl lote frena y el informe cuenta bien.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} chequeo(s) fallaron.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
