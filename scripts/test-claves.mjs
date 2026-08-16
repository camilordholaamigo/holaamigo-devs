#!/usr/bin/env node
/**
 * Prueba de regresión de las claves de upsert, contra Postgres de verdad.
 *
 *   node scripts/test-claves.mjs
 *
 * Corre sobre PGlite —Postgres compilado a WASM, sin servidor ni Docker— así
 * que se puede correr en cualquier máquina y en CI sin provisionar nada.
 *
 * POR QUÉ EXISTE: el bug que dejó el quiz muerto era un error de Postgres
 * (`42P10`) provocado por un índice parcial usado como árbitro de un
 * `ON CONFLICT`. Ninguna prueba con la base simulada lo habría visto: hacía
 * falta un planificador de Postgres real diciendo que no.
 *
 * La primera prueba REPRODUCE el bug con el esquema viejo. Es deliberado: si
 * algún día deja de fallar, quiere decir que Postgres cambió esa regla y que
 * este archivo —y el ADR 0015— hay que revisarlos.
 *
 * Ver docs/adr/0015-claves-de-upsert-planas.md
 */

import { PGlite } from '@electric-sql/pglite';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      \x1b[31m${detail}\x1b[0m` : ''}`);
  }
}

/** Corre una sentencia y devuelve el error de Postgres, o null si pasó. */
async function attempt(db, sql, params) {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return err;
  }
}

const db = new PGlite();
await db.exec('create schema holaamigo');

console.log('\n\x1b[1mClaves de upsert · Postgres real (PGlite)\x1b[0m');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El esquema viejo: por qué el quiz no guardaba\x1b[0m');

await db.exec(`
  create table holaamigo.viejo (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null,
    question_id text,
    slot text,
    answer jsonb not null
  );
  create unique index viejo_fixed_key
    on holaamigo.viejo (session_id, question_id) where question_id is not null;
  create unique index viejo_generated_key
    on holaamigo.viejo (session_id, slot) where question_id is null and slot is not null;
`);

const sesion = '11111111-1111-1111-1111-111111111111';

const errorViejo = await attempt(
  db,
  `insert into holaamigo.viejo (session_id, question_id, answer)
   values ($1, 'main_offer', '"vendo software"'::jsonb)
   on conflict (session_id, question_id) do update set answer = excluded.answer`,
  [sesion],
);

check(
  'el upsert contra el índice PARCIAL falla, como en producción',
  errorViejo !== null && /42P10|no unique or exclusion constraint/i.test(String(errorViejo)),
  errorViejo ? `error inesperado: ${errorViejo.message}` : 'NO falló — revisar el ADR 0015',
);
if (errorViejo) console.log(`      \x1b[2m${errorViejo.message}\x1b[0m`);

// La misma trampa, versión índice de expresión: productos y bandejas.
await db.exec(`
  create table holaamigo.viejo_productos (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    sku text not null,
    name text not null
  );
  create unique index viejo_productos_key
    on holaamigo.viejo_productos (organization_id, lower(sku));
`);

const org = '22222222-2222-2222-2222-222222222222';
const errorExpresion = await attempt(
  db,
  `insert into holaamigo.viejo_productos (organization_id, sku, name)
   values ($1, 'entrada', 'Entrada general')
   on conflict (organization_id, sku) do update set name = excluded.name`,
  [org],
);

check(
  'el upsert contra el índice de EXPRESIÓN también falla',
  errorExpresion !== null && /42P10|no unique or exclusion constraint/i.test(String(errorExpresion)),
  errorExpresion ? `error inesperado: ${errorExpresion.message}` : 'NO falló',
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · El esquema nuevo: la clave generada\x1b[0m');

await db.exec(`
  create table holaamigo.quiz_responses (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null,
    question_id text,
    slot text,
    answer jsonb not null,
    answered_at timestamptz not null default now(),
    answer_key text generated always as (coalesce(question_id, slot)) stored
  );
  create unique index quiz_responses_key
    on holaamigo.quiz_responses (session_id, answer_key);
`);

/** Lo mismo que hace `saveAnswer()` en lib/quiz/service.ts. */
async function guardar(sessionId, key, answer, esGenerada) {
  return attempt(
    db,
    `insert into holaamigo.quiz_responses (session_id, question_id, slot, answer)
     values ($1, $2, $3, $4::jsonb)
     on conflict (session_id, answer_key) do update set answer = excluded.answer`,
    [sessionId, esGenerada ? null : key, esGenerada ? key : null, JSON.stringify(answer)],
  );
}

check('guarda una pregunta fija', (await guardar(sesion, 'main_offer', 'vendo software', false)) === null);
check('guarda una pregunta adaptativa', (await guardar(sesion, 'goal_90d', 12, true)) === null);
check('guarda una respuesta saltada (cadena vacía)', (await guardar(sesion, 'limits', '', true)) === null);

const reanswer = await guardar(sesion, 'main_offer', 'vendo servicios', false);
check('re-responder ACTUALIZA en vez de duplicar', reanswer === null);

const filas = await db.query('select answer_key, answer from holaamigo.quiz_responses order by answer_key');
check(
  'quedan 3 filas, una por clave',
  filas.rows.length === 3,
  `hay ${filas.rows.length}: ${filas.rows.map((r) => r.answer_key).join(', ')}`,
);

const oferta = filas.rows.find((r) => r.answer_key === 'main_offer');
check(
  'la respuesta re-escrita es la última',
  oferta?.answer === 'vendo servicios',
  `quedó "${oferta?.answer}"`,
);

// Dos sesiones distintas no se pisan: la clave es (session_id, answer_key).
const otraSesion = '33333333-3333-3333-3333-333333333333';
check(
  'otra sesión puede responder la misma pregunta',
  (await guardar(otraSesion, 'main_offer', 'vendo hardware', false)) === null,
);

const total = await db.query('select count(*)::int as n from holaamigo.quiz_responses');
check('ahora hay 4 filas en total', total.rows[0].n === 4, `hay ${total.rows[0].n}`);

// El NOT NULL de `answer` es lo que distingue "saltó" de "no respondió".
const nulo = await attempt(
  db,
  `insert into holaamigo.quiz_responses (session_id, question_id, answer)
   values ($1, 'otra', null)`,
  [sesion],
);
check('un answer NULL sigue siendo rechazado', nulo !== null && /not-null|23502/i.test(String(nulo)));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · Productos y bandejas con clave plana\x1b[0m');

await db.exec(`
  create table holaamigo.products (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    sku text not null,
    name text not null
  );
  create unique index products_sku_key on holaamigo.products (organization_id, sku);
`);

async function producto(sku, name) {
  return attempt(
    db,
    `insert into holaamigo.products (organization_id, sku, name) values ($1, $2, $3)
     on conflict (organization_id, sku) do update set name = excluded.name`,
    [org, sku.toLowerCase(), name],
  );
}

check('crea un producto', (await producto('Entrada', 'Entrada general')) === null);
check('el mismo SKU en otra caja actualiza', (await producto('ENTRADA', 'Entrada VIP')) === null);

const productos = await db.query('select sku, name from holaamigo.products');
check('quedó un solo producto', productos.rows.length === 1, `hay ${productos.rows.length}`);
check(
  'el SKU quedó normalizado y el nombre actualizado',
  productos.rows[0]?.sku === 'entrada' && productos.rows[0]?.name === 'Entrada VIP',
  JSON.stringify(productos.rows[0]),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Diagnósticos: el índice parcial que sí es correcto\x1b[0m');

await db.exec(`
  create table holaamigo.diagnostics (
    id uuid primary key default gen_random_uuid(),
    session_id uuid,
    created_at timestamptz not null default now()
  );
  create unique index diagnostics_session_key
    on holaamigo.diagnostics (session_id) where session_id is not null;
`);

const primero = await attempt(db, 'insert into holaamigo.diagnostics (session_id) values ($1)', [sesion]);
check('el primer diagnóstico entra', primero === null);

const segundo = await attempt(db, 'insert into holaamigo.diagnostics (session_id) values ($1)', [sesion]);
check(
  'el segundo concurrente es rechazado (23505), y el código relee el primero',
  segundo !== null && /23505|duplicate key/i.test(String(segundo)),
  segundo ? segundo.message : 'NO falló: se podrían duplicar diagnósticos',
);

const sinSesion = await attempt(db, 'insert into holaamigo.diagnostics (session_id) values (null)', []);
const sinSesion2 = await attempt(db, 'insert into holaamigo.diagnostics (session_id) values (null)', []);
check(
  'los diagnósticos sin sesión (regenerados a mano) no chocan entre sí',
  sinSesion === null && sinSesion2 === null,
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLas claves funcionan.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
