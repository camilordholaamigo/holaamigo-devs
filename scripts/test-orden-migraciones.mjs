#!/usr/bin/env node
/**
 * Correr una migración fuera de orden falla con un mensaje que dice qué hacer.
 *
 *   node scripts/test-orden-migraciones.mjs
 *
 * Existe por una tarde de producción: `0013` se corrió sin `0011` y reventó 500
 * líneas adentro con `42P01: relation "holaamigo.skills" does not exist`,
 * después de haber creado media docena de tablas. El error no decía qué correr
 * ni en qué archivo vivía esa tabla.
 *
 * Las migraciones de este proyecto se aplican **a mano** en el SQL Editor de
 * Supabase, sin tabla de control ni runner que imponga el orden. O sea que
 * correrlas mal no es hipotético: es el camino normal.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
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

const sql = async (archivo) => readFile(join(carpeta, archivo), 'utf8');

const db = new PGlite();
await db.exec(`
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`);

console.log('\n\x1b[1mOrden de migraciones · el fallo tiene que ser útil\x1b[0m');
console.log('\n\x1b[1m1 · 0013 sin 0011 falla temprano y dice qué correr\x1b[0m');

// Se aplica todo MENOS 0011, que es el que crea `skills`.
for (const archivo of [
  '0001_init.sql',
  '0002_seed_quiz.sql',
  '0003_motor_de_correo.sql',
  '0004_exponer_api.sql',
  '0005_claves_y_settings.sql',
  '0006_sustrato.sql',
  '0007_gobierno.sql',
  '0008_la_sala.sql',
  '0009_cro.sql',
  '0010_cmo.sql',
  '0012_flujo_inicial.sql',
]) {
  await db.exec(await sql(archivo));
}

let mensaje = null;
try {
  await db.exec(await sql('0013_agente_de_agendamiento.sql'));
} catch (err) {
  mensaje = err.message;
}

check('no se aplica', Boolean(mensaje), 'la aceptó sin 0011');
check(
  'nombra el archivo que falta, no la tabla',
  /0011_integraciones\.sql/.test(mensaje ?? ''),
  mensaje ?? '',
);
check(
  'y dice el orden completo',
  /0011.*0012.*0013/s.test(mensaje ?? ''),
  mensaje ?? '',
);
check(
  'no es el 42P01 crudo de "relation does not exist"',
  !/does not exist/.test(mensaje ?? ''),
  mensaje ?? '',
);

// Lo que importa de verdad: que no haya dejado la base a medio construir.
const { rows } = await db.query(
  `select count(*)::int as n from information_schema.tables
   where table_schema = 'holaamigo' and table_name in
     ('agent_playbooks','knowledge_bases','conversations','conversation_turns')`,
);
check(
  'y no dejó ninguna tabla de 0013 a medio crear',
  rows[0].n === 0,
  `quedaron ${rows[0].n} tablas`,
);

console.log('\n\x1b[1m2 · Con 0011 aplicada, 0013 entra sin quejarse\x1b[0m');

await db.exec(await sql('0011_integraciones.sql'));

let error2 = null;
try {
  await db.exec(await sql('0013_agente_de_agendamiento.sql'));
} catch (err) {
  error2 = err.message;
}
check('0013 aplica', !error2, error2 ?? '');

const { rows: creadas } = await db.query(
  `select count(*)::int as n from information_schema.tables
   where table_schema = 'holaamigo' and table_name in
     ('agent_playbooks','knowledge_bases','conversations','conversation_turns')`,
);
check('las cuatro tablas quedaron', creadas[0].n === 4, `fueron ${creadas[0].n}`);

const { rows: habilidades } = await db.query(
  `select count(*)::int as n from holaamigo.skills where id like 'agenda.%' or id = 'kb.buscar'`,
);
check('y las habilidades del setter se sembraron', habilidades[0].n === 3, `fueron ${habilidades[0].n}`);

console.log('');
if (failures > 0) {
  console.log(`\x1b[31m\x1b[1m${failures} comprobación(es) fallaron.\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32m\x1b[1mCorrer una migración fuera de orden avisa qué falta, y no rompe nada.\x1b[0m\n');
