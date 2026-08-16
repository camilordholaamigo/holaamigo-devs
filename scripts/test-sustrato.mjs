#!/usr/bin/env node
/**
 * P1 · El Sustrato — los criterios de aceptación, como pruebas que corren.
 *
 *   node scripts/test-sustrato.mjs
 *
 * Sobre PGlite (Postgres real en WASM), porque todo lo que se prueba acá vive
 * en la base: las invariantes de `decisions` son `check` constraints y el
 * destilador es una función SQL. Una prueba con la base simulada no vería
 * ninguno de los dos.
 *
 * Los cuatro criterios del plan, P1:
 *   1. Una decisión sin dos opciones o sin predicción no se puede escribir.
 *   2. El destilador produce al menos una lección `candidate` sobre 50 decisiones.
 *   3. Una lección de alcance amplio no queda activa sin firma humana.
 *   4. `cost_rollup` cuadra contra la suma cruda de trazas (< 0,5%).
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

/** Corre una sentencia y devuelve el error de Postgres, o null si pasó. */
async function attempt(sql, params) {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return err;
  }
}

/** Un archivo de migración entero. `exec` y no `query`: son varias sentencias. */
async function correr(sql) {
  try {
    await db.exec(sql);
    return null;
  } catch (err) {
    return err;
  }
}

const db = new PGlite();

await db.exec(`
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`);

console.log('\n\x1b[1mP1 · El Sustrato · Postgres real (PGlite)\x1b[0m');
console.log('\n\x1b[1m0 · Las migraciones aplican, dos veces\x1b[0m');

const archivos = (await readdir(carpeta)).filter((f) => f.endsWith('.sql')).sort();
for (const vuelta of [1, 2]) {
  let ok = true;
  let detalle = '';
  for (const archivo of archivos) {
    const sql = await readFile(join(carpeta, archivo), 'utf8');
    const err = await correr(sql);
    if (err) {
      ok = false;
      detalle = `${archivo}: ${err.message}`;
      break;
    }
  }
  check(`pasada ${vuelta} de ${archivos.length} migraciones`, ok, detalle);
}

const ORG = '66666666-6666-6666-6666-666666666666';
await db.query(`insert into holaamigo.organizations (id, website_url) values ($1, 'https://sustrato.test')`, [ORG]);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · Las invariantes de la microdecisión\x1b[0m');

const DOS = JSON.stringify([{ label: 'a' }, { label: 'b' }]);
const PRED = JSON.stringify({ metric: 'reply_rate', expected_value: 10, horizon_days: 14 });

async function decidir({ kind = 'angle_select', opciones = DOS, prediccion = PRED, elegida = 'a', contexto = '{}' } = {}) {
  return attempt(
    `insert into holaamigo.decisions
       (organization_id, kind, question, context, options_considered, chosen, rationale, prediction)
     values ($1, $2, 'prueba', $3::jsonb, $4::jsonb, jsonb_build_object('label', $5::text), 'porque sí', $6::jsonb)`,
    [ORG, kind, contexto, opciones, elegida, prediccion],
  );
}

const unaOpcion = await decidir({ opciones: JSON.stringify([{ label: 'única' }]) });
check(
  'una decisión con UNA sola opción es rechazada',
  unaOpcion !== null && /decisions_dos_opciones/.test(String(unaOpcion.message)),
  unaOpcion ? unaOpcion.message : 'NO falló: se pueden escribir decisiones sin alternativas',
);

const sinPrediccion = await decidir({ prediccion: null });
check(
  'una decisión sin predicción es rechazada',
  sinPrediccion !== null && /decisions_prediccion\b/.test(String(sinPrediccion.message)),
  sinPrediccion ? sinPrediccion.message : 'NO falló: se puede decidir sin predecir nada',
);

const escalada = await decidir({ kind: 'escalate', prediccion: null });
check('un `escalate` sí puede ir sin predicción', escalada === null, escalada?.message);

const predMalformada = await decidir({ prediccion: JSON.stringify({ metric: 'reply_rate' }) });
check(
  'una predicción sin valor esperado ni horizonte es rechazada',
  predMalformada !== null && /decisions_prediccion_forma/.test(String(predMalformada.message)),
  predMalformada ? predMalformada.message : 'NO falló',
);

check('una decisión bien formada entra', (await decidir()) === null);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · Calibración y cierre del ciclo\x1b[0m');

const casos = [
  [100, 100, 1],
  [100, 80, 0.8],
  [100, 200, 0.5],
  [100, 0, 0],
  [0, 0, 1],
];
for (const [esperado, real, quiero] of casos) {
  const { rows } = await db.query('select holaamigo.calibracion($1, $2) as c', [esperado, real]);
  check(
    `calibracion(${esperado}, ${real}) = ${quiero}`,
    Math.abs(Number(rows[0].c) - quiero) < 0.0001,
    `dio ${rows[0].c}`,
  );
}

const { rows: creada } = await db.query(
  `insert into holaamigo.decisions
     (organization_id, kind, question, options_considered, chosen, rationale, prediction)
   values ($1, 'budget_shift', '¿movemos presupuesto?', $2::jsonb,
           jsonb_build_object('label','mover'), 'la evidencia lo pide', $3::jsonb)
   returning id`,
  [ORG, DOS, JSON.stringify({ metric: 'mrr', expected_value: 1000, horizon_days: 30 })],
);
const decisionId = creada[0].id;

const { rows: cerrada } = await db.query('select holaamigo.cerrar_decision($1, $2) as c', [decisionId, 900]);
check('cerrar_decision devuelve la calibración', Math.abs(Number(cerrada[0].c) - 0.9) < 0.0001, `dio ${cerrada[0].c}`);

const { rows: leida } = await db.query(
  'select outcome, calibration from holaamigo.decisions where id = $1',
  [decisionId],
);
check(
  'el outcome quedó escrito con métrica y valor',
  leida[0].outcome?.metric === 'mrr' && Number(leida[0].outcome?.actual_value) === 900,
  JSON.stringify(leida[0].outcome),
);
check('la calibración quedó guardada junto al outcome', Number(leida[0].calibration) === 0.9);

const sinPred = await attempt('select holaamigo.cerrar_decision($1, 5)', [
  (await db.query(`select id from holaamigo.decisions where kind = 'escalate' limit 1`)).rows[0].id,
]);
check(
  'no se puede cerrar una decisión que no predijo nada',
  sinPred !== null && /no tiene predicción medible/.test(String(sinPred.message)),
  sinPred ? sinPred.message : 'NO falló',
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · El destilador sobre 50 decisiones medidas\x1b[0m');

/** Siembra decisiones medidas: la opción `ganadora` rinde el triple. */
async function sembrar({ kind, segmento, canal, n, ganadora, perdedora, valorGanador, valorPerdedor }) {
  for (let i = 0; i < n; i += 1) {
    const gana = i % 2 === 0;
    const label = gana ? ganadora : perdedora;
    // Ruido determinista: sin variación, el promedio no significa nada; con
    // aleatoriedad, la prueba falla un martes cualquiera y nadie sabe por qué.
    const valor = (gana ? valorGanador : valorPerdedor) + (i % 5) * 0.1;
    await db.query(
      `insert into holaamigo.decisions
         (organization_id, kind, question, context, options_considered, chosen, rationale,
          prediction, outcome, calibration)
       values ($1, $2, 'prueba sembrada', $3::jsonb, $4::jsonb,
               jsonb_build_object('label', $5::text), 'semilla',
               $6::jsonb, $7::jsonb, 0.8)`,
      [
        ORG,
        kind,
        JSON.stringify({ segment: segmento, channel: canal }),
        JSON.stringify([{ label: ganadora }, { label: perdedora }]),
        label,
        JSON.stringify({ metric: 'reply_rate', expected_value: 8, horizon_days: 14 }),
        JSON.stringify({ metric: 'reply_rate', actual_value: valor, measured_at: '2026-08-01T00:00:00Z' }),
      ],
    );
  }
}

await sembrar({
  kind: 'angle_select', segmento: 'logistica', canal: 'email', n: 50,
  ganadora: 'costo', perdedora: 'urgencia', valorGanador: 12, valorPerdedor: 5,
});
// Grupo con evidencia insuficiente: tiene señal, pero solo 4 decisiones.
await sembrar({
  kind: 'angle_select', segmento: 'retail', canal: 'email', n: 4,
  ganadora: 'estatus', perdedora: 'precio', valorGanador: 20, valorPerdedor: 2,
});

const { rows: candidatas } = await db.query('select * from holaamigo.destilar_candidatas($1)', [ORG]);
check(
  'el grupo con 50 decisiones califica y el de 4 no',
  candidatas.length === 1 && candidatas[0].contexto === 'logistica·email',
  `salieron ${candidatas.length}: ${candidatas.map((c) => c.contexto).join(', ')}`,
);
check(
  'el lift refleja la ventaja real (≈2,4x)',
  Math.abs(Number(candidatas[0]?.lift) - 2.4) < 0.15,
  `lift ${candidatas[0]?.lift}`,
);
check(
  'la confianza sube con volumen y fuerza (n=50, lift 2,4 → ≈0,86)',
  Number(candidatas[0]?.confianza) > 0.8 && Number(candidatas[0]?.confianza) <= 0.95,
  `confianza ${candidatas[0]?.confianza}`,
);

const { rows: destilado } = await db.query('select holaamigo.destilar($1) as r', [ORG]);
check('el destilador crea la lección', destilado[0].r.creadas === 1, JSON.stringify(destilado[0].r));
check('y la activa sola por pasar el umbral de 0,7', destilado[0].r.activadas === 1, JSON.stringify(destilado[0].r));

const { rows: leccion } = await db.query(
  `select statement, status, n_support, confidence, best_option, version, scope
     from holaamigo.lessons where scope_ref = $1`,
  [ORG],
);
check(
  'el enunciado lleva los números que salieron del SQL, no del modelo',
  /logistica·email/.test(leccion[0].statement) && /«costo»/.test(leccion[0].statement) && /n=50/.test(leccion[0].statement),
  leccion[0].statement,
);

const { rows: repetido } = await db.query('select holaamigo.destilar($1) as r', [ORG]);
check(
  'volver a destilar actualiza en vez de duplicar',
  repetido[0].r.creadas === 0 && repetido[0].r.actualizadas === 1,
  JSON.stringify(repetido[0].r),
);

// Inversión de la evidencia: entran 60 decisiones donde gana la otra opción.
await sembrar({
  kind: 'angle_select', segmento: 'logistica', canal: 'email', n: 60,
  ganadora: 'urgencia', perdedora: 'costo', valorGanador: 40, valorPerdedor: 3,
});
const { rows: invertido } = await db.query('select holaamigo.destilar($1) as r', [ORG]);
const { rows: tras } = await db.query(
  `select status, version, best_option, retired_reason, contradicted_at
     from holaamigo.lessons where scope_ref = $1`,
  [ORG],
);
check(
  'cuando la evidencia se da vuelta, la lección deja de ser ley y sube de versión',
  tras[0].status === 'candidate' && tras[0].version === 2 && tras[0].best_option === 'urgencia',
  `${JSON.stringify(tras[0])} · destilado: ${JSON.stringify(invertido[0].r)}`,
);
check(
  'y NO se reactiva en la misma pasada que la contradijo',
  invertido[0].r.activadas === 0 && tras[0].contradicted_at !== null,
  JSON.stringify(invertido[0].r),
);

// Una noche después, con la evidencia nueva sosteniéndose, sí vuelve a ser ley.
await db.query(
  `update holaamigo.lessons set contradicted_at = now() - interval '2 days' where scope_ref = $1`,
  [ORG],
);
const { rows: manana } = await db.query('select holaamigo.destilar($1) as r', [ORG]);
const { rows: reactivada } = await db.query(
  `select status, version from holaamigo.lessons where scope_ref = $1`,
  [ORG],
);
check(
  'a la noche siguiente, si la evidencia aguanta, vuelve a activarse en v2',
  manana[0].r.activadas === 1 && reactivada[0].status === 'active' && reactivada[0].version === 2,
  `${JSON.stringify(reactivada[0])} · ${JSON.stringify(manana[0].r)}`,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Una lección de alcance amplio necesita firma humana\x1b[0m');

const globalSinFirma = await attempt(
  `insert into holaamigo.lessons (scope, statement, n_support, confidence, status, fingerprint)
   values ('global', 'el ángulo de costo gana siempre', 40, 0.9, 'active', 'global|prueba')`,
);
check(
  'una lección global no puede nacer activa sin `promoted_by`',
  globalSinFirma !== null && /lessons_alcance_amplio_requiere_humano/.test(String(globalSinFirma.message)),
  globalSinFirma ? globalSinFirma.message : 'NO falló: un cliente raro puede envenenar a los demás',
);

const globalFirmada = await attempt(
  `insert into holaamigo.lessons (scope, statement, n_support, confidence, status, promoted_by, promoted_at, fingerprint)
   values ('global', 'el ángulo de costo gana en logística', 40, 0.9, 'active', 'camilo@rentmies.com', now(), 'global|prueba2')`,
);
check('con firma sí entra', globalFirmada === null, globalFirmada?.message);

const candidataGlobal = await attempt(
  `insert into holaamigo.lessons (scope, statement, n_support, confidence, status, fingerprint)
   values ('industry', 'en logística el precio manda', 12, 0.8, 'candidate', 'industry|logistica|x')`,
);
check('una candidata de industria sí puede existir sin firma', candidataGlobal === null, candidataGlobal?.message);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · Costos: la vista cuadra contra las trazas\x1b[0m');

const CORRIDAS = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
for (const [i, runId] of CORRIDAS.entries()) {
  for (let paso = 0; paso < 3; paso += 1) {
    await db.query(
      `insert into holaamigo.traces
         (organization_id, run_id, step_type, name, model, tokens_in, tokens_out, cost_usd, duration_ms)
       values ($1, $2, 'output', $3, 'gpt-5-mini', 1000, 500, $4, 1200)`,
      [ORG, runId, `paso_${paso}`, 0.0123 + i * 0.01],
    );
  }
}

// La primera corrida produjo DOS decisiones: es el caso que rompe un join
// ingenuo entre trazas y decisiones.
for (const label of ['a', 'b']) {
  await db.query(
    `insert into holaamigo.decisions
       (organization_id, run_id, kind, question, options_considered, chosen, rationale, prediction)
     values ($1, $2, 'angle_select', 'con costo', $3::jsonb,
             jsonb_build_object('label', $4::text), 'x', $5::jsonb)`,
    [ORG, CORRIDAS[0], DOS, label, PRED],
  );
}

const { rows: crudo } = await db.query('select round(sum(cost_usd), 6) as total from holaamigo.traces');
const { rows: vista } = await db.query('select round(sum(costo_usd), 6) as total from holaamigo.cost_rollup');
const diff = Math.abs(Number(crudo[0].total) - Number(vista[0].total));
check(
  'cost_rollup cuadra contra la suma cruda de trazas (< 0,5%)',
  diff / Number(crudo[0].total) < 0.005,
  `crudo ${crudo[0].total} · vista ${vista[0].total}`,
);
check('y de hecho cuadra exacto', diff === 0, `diferencia ${diff}`);

const { rows: imputadas } = await db.query('select holaamigo.imputar_costos($1) as n', [ORG]);
check('imputar_costos toca las 2 decisiones con corrida', Number(imputadas[0].n) === 2, `tocó ${imputadas[0].n}`);

const { rows: reparto } = await db.query(
  `select round(sum(cost_usd), 6) as total from holaamigo.decisions where run_id = $1`,
  [CORRIDAS[0]],
);
const { rows: corrida } = await db.query(
  `select round(sum(cost_usd), 6) as total from holaamigo.traces where run_id = $1`,
  [CORRIDAS[0]],
);
check(
  'el costo de la corrida se repartió completo entre sus 2 decisiones',
  Number(reparto[0].total) === Number(corrida[0].total),
  `decisiones ${reparto[0].total} · trazas ${corrida[0].total}`,
);

const { rows: idempotente } = await db.query('select holaamigo.imputar_costos($1) as n', [ORG]);
check('correrlo otra vez no toca nada', Number(idempotente[0].n) === 0, `tocó ${idempotente[0].n}`);

const { rows: purgadas } = await db.query('select holaamigo.purgar_trazas(90) as n');
check('purgar_trazas no borra lo reciente', Number(purgadas[0].n) === 0, `borró ${purgadas[0].n}`);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mEl sustrato aguanta: se registra, se mide, se destila y cuadra.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
