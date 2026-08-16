#!/usr/bin/env node
/**
 * Corre TODAS las migraciones en orden sobre un Postgres limpio, dos veces.
 *
 *   node scripts/test-migraciones.mjs
 *
 * Responde dos preguntas antes de tocar producción:
 *   1. ¿La migración nueva aplica sobre el esquema que ya existe?
 *   2. ¿Es idempotente de verdad, o solo dice serlo en el encabezado?
 *
 * La segunda importa más de lo que parece: las migraciones acá se corren a mano
 * en el SQL Editor de Supabase, sin tabla de control. Correr una dos veces por
 * accidente no es hipotético, es martes.
 *
 * Usa PGlite (Postgres en WASM), así que no hace falta Docker ni un servidor.
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

const archivos = (await readdir(carpeta)).filter((f) => f.endsWith('.sql')).sort();

const db = new PGlite();

// Supabase trae estos roles de fábrica; PGlite no. Los `grant` de 0001 fallarían
// sin ellos, y ese fallo sería un artefacto del entorno de prueba, no un bug.
await db.exec(`
  do $$ begin
    create role service_role;    exception when duplicate_object then null; end $$;
  do $$ begin
    create role anon;            exception when duplicate_object then null; end $$;
  do $$ begin
    create role authenticated;   exception when duplicate_object then null; end $$;
  do $$ begin
    create role authenticator;   exception when duplicate_object then null; end $$;
`);

console.log('\n\x1b[1mMigraciones · Postgres real (PGlite)\x1b[0m');

async function correrTodas(vuelta) {
  console.log(`\n\x1b[1m${vuelta}\x1b[0m`);
  for (const archivo of archivos) {
    const sql = await readFile(join(carpeta, archivo), 'utf8');
    try {
      await db.exec(sql);
      check(archivo, true);
    } catch (err) {
      check(archivo, false, err.message);
    }
  }
}

await correrTodas('1 · Primera pasada, base vacía');
await correrTodas('2 · Segunda pasada, misma base (idempotencia)');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · Lo que la 0005 tenía que dejar\x1b[0m');

const { rows: indices } = await db.query(`
  select indexname from pg_indexes
  where schemaname = 'holaamigo'
    and indexname in ('quiz_responses_key','products_sku_key',
                      'mailboxes_address_key','diagnostics_session_key')
`);
const nombres = indices.map((r) => r.indexname).sort();
check(
  'los cuatro índices nuevos existen',
  nombres.length === 4,
  `solo: ${nombres.join(', ') || 'ninguno'}`,
);

const { rows: viejos } = await db.query(`
  select indexname from pg_indexes
  where schemaname = 'holaamigo'
    and indexname in ('quiz_responses_fixed_key','quiz_responses_generated_key')
`);
check('los índices parciales viejos ya no están', viejos.length === 0, viejos.map((r) => r.indexname).join(', '));

const { rows: columna } = await db.query(`
  select is_generated, generation_expression from information_schema.columns
  where table_schema = 'holaamigo' and table_name = 'quiz_responses' and column_name = 'answer_key'
`);
check('answer_key existe y es generada', columna[0]?.is_generated === 'ALWAYS', JSON.stringify(columna[0]));

const { rows: settings } = await db.query(`
  select table_name from information_schema.tables
  where table_schema = 'holaamigo' and table_name = 'settings'
`);
check('la tabla settings existe', settings.length === 1);

// El seed del quiz: sin él, el quiz arranca vacío.
const { rows: preguntas } = await db.query(
  `select count(*)::int as n from holaamigo.quiz_questions where active`,
);
check('el seed dejó 7 preguntas activas', preguntas[0].n === 7, `hay ${preguntas[0].n}`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · El upsert real del quiz, contra el esquema real\x1b[0m');

const sesion = '44444444-4444-4444-4444-444444444444';
await db.query(
  `insert into holaamigo.organizations (id, website_url) values ($1, 'https://prueba.com')`,
  ['55555555-5555-5555-5555-555555555555'],
);
await db.query(
  `insert into holaamigo.intake_sessions (id, organization_id) values ($1, $2)`,
  [sesion, '55555555-5555-5555-5555-555555555555'],
);

async function guardar(key, answer, esGenerada) {
  try {
    await db.query(
      `insert into holaamigo.quiz_responses (session_id, question_id, slot, answer)
       values ($1, $2, $3, $4::jsonb)
       on conflict (session_id, answer_key) do update set answer = excluded.answer`,
      [sesion, esGenerada ? null : key, esGenerada ? key : null, JSON.stringify(answer)],
    );
    return null;
  } catch (err) {
    return err;
  }
}

// Las 6 fijas del banco, tal como las manda el quiz.
const fijas = ['main_offer', 'ticket_band', 'rev_band', 'sales_team', 'dormant_db', 'main_channel'];
let errores = 0;
for (const key of fijas) if (await guardar(key, 'x', false)) errores += 1;
check('las 6 preguntas fijas se guardan', errores === 0);

if (await guardar('goal_90d', 12, true)) check('la adaptativa se guarda', false);
else check('la adaptativa se guarda', true);

if (await guardar('goal_deadline', 'quarter', false)) check('la de cierre se guarda', false);
else check('la de cierre se guarda', true);

const { rows: cuenta } = await db.query(
  `select count(*)::int as n from holaamigo.quiz_responses where session_id = $1`,
  [sesion],
);
check('quedaron las 8 respuestas', cuenta[0].n === 8, `hay ${cuenta[0].n}`);

// Esta es la consulta exacta de getAnswers(): la clave que ve el código.
const { rows: leidas } = await db.query(
  `select coalesce(question_id, slot) as key from holaamigo.quiz_responses where session_id = $1`,
  [sesion],
);
check(
  'getAnswers() ve las 8 claves sin colisiones',
  new Set(leidas.map((r) => r.key)).size === 8,
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLas migraciones aplican limpias y son idempotentes.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
