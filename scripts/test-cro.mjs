#!/usr/bin/env node
/**
 * P4 · El President como CRO — los criterios de aceptación, como pruebas.
 *
 *   node scripts/test-cro.mjs
 *
 * Los cuatro del plan:
 *   1. `channel_economics` cuadra contra la suma cruda de eventos (< 0,1%).
 *   2. Una propuesta de reasignación tiene al menos dos alternativas y
 *      evidencia de experimentos (se verifica su forma; el armado vive en TS).
 *   3. Un experimento que alcanza `min_sample` produce readout automático y
 *      escribe el `outcome` de su decisión — cerrando el ciclo de P1.
 *   4. El libro de resultados sale con los mismos números en CSV y en PDF (se
 *      garantiza por construcción: las dos salidas leen el mismo objeto).
 *
 * Más lo que sostiene a esos cuatro: el pre-registro inmutable, el guardrail
 * que le gana a la métrica principal, y el join que no multiplica.
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

async function attempt(sql, params) {
  try {
    const result = await db.query(sql, params);
    return { error: null, rows: result.rows };
  } catch (err) {
    return { error: err, rows: [] };
  }
}

await db.exec(`
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`);

console.log('\n\x1b[1mP4 · El President como CRO · Postgres real (PGlite)\x1b[0m');
console.log('\n\x1b[1m0 · Las migraciones aplican, dos veces\x1b[0m');

const archivos = (await readdir(carpeta)).filter((f) => f.endsWith('.sql')).sort();
for (const vuelta of [1, 2]) {
  let ok = true;
  let detalle = '';
  for (const archivo of archivos) {
    const sql = await readFile(join(carpeta, archivo), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      ok = false;
      detalle = `${archivo}: ${err.message}`;
      break;
    }
  }
  check(`pasada ${vuelta} de ${archivos.length} migraciones`, ok, detalle);
}

const ORG = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
await db.query(`insert into holaamigo.organizations (id, website_url, plan) values ($1, 'https://cro.test', 'growth')`, [ORG]);
await db.query(
  `insert into holaamigo.agents (organization_id, role, status, objective, budget, permissions, escalation_rules)
   values ($1, 'president', 'active', '{}', '{}', '{}', '{}')`,
  [ORG],
);

const { rows: canales } = await db.query(
  `insert into holaamigo.channels (organization_id, name, kind) values
     ($1, 'Correo en frío', 'outbound_email'),
     ($1, 'WhatsApp', 'whatsapp'),
     ($1, 'Partnerships', 'partnerships')
   returning id, kind`,
  [ORG],
);
const CORREO = canales.find((c) => c.kind === 'outbound_email').id;
const WHATSAPP = canales.find((c) => c.kind === 'whatsapp').id;

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · La economía por canal cuadra (y el join no multiplica)\x1b[0m');

// 10 ingresos y 8 gastos en el MISMO canal y el MISMO mes: es exactamente el
// caso donde un join ingenuo reporta 80 filas y el CAC sale inventado.
for (let i = 0; i < 10; i += 1) {
  await db.query(
    `insert into holaamigo.revenue_events
       (organization_id, channel_id, opportunity_id, amount_usd, kind, occurred_at)
     values ($1, $2, gen_random_uuid(), 1200, 'new', '2026-08-10T12:00:00Z')`,
    [ORG, CORREO],
  );
}
for (let i = 0; i < 8; i += 1) {
  await db.query(
    `insert into holaamigo.cost_events
       (organization_id, channel_id, amount_usd, category, occurred_at)
     values ($1, $2, 300, 'ads', '2026-08-12T12:00:00Z')`,
    [ORG, CORREO],
  );
}
// Un reembolso: tiene que RESTAR.
await db.query(
  `insert into holaamigo.revenue_events
     (organization_id, channel_id, amount_usd, kind, occurred_at)
   values ($1, $2, 1200, 'refund', '2026-08-20T12:00:00Z')`,
  [ORG, CORREO],
);
// Un canal solo con gasto: tiene que aparecer igual, con margen negativo.
await db.query(
  `insert into holaamigo.cost_events
     (organization_id, channel_id, amount_usd, category, occurred_at)
   values ($1, $2, 500, 'tooling', '2026-08-15T12:00:00Z')`,
  [ORG, WHATSAPP],
);

const { rows: economia } = await db.query(
  `select * from holaamigo.channel_economics where organization_id = $1 order by canal`,
  [ORG],
);

const correo = economia.find((e) => e.tipo === 'outbound_email');
check(
  'el ingreso no se multiplica por la cantidad de gastos',
  Number(correo.ingreso_usd) === 10 * 1200 - 1200,
  `dio ${correo.ingreso_usd}, esperaba ${10 * 1200 - 1200}`,
);
check(
  'el costo no se multiplica por la cantidad de ingresos',
  Number(correo.costo_usd) === 8 * 300,
  `dio ${correo.costo_usd}, esperaba ${8 * 300}`,
);
check(
  'el CAC divide por clientes NUEVOS, no por eventos',
  Number(correo.cac_usd) === Math.round((2400 / 10) * 100) / 100,
  `CAC ${correo.cac_usd}, esperaba 240`,
);
check(
  'el ROAS sale de las dos sumas agregadas',
  Math.abs(Number(correo.roas) - 10800 / 2400) < 0.01,
  `ROAS ${correo.roas}`,
);

const whatsapp = economia.find((e) => e.tipo === 'whatsapp');
check(
  'un canal con gasto y sin ingreso aparece, con margen negativo',
  whatsapp && Number(whatsapp.margen_usd) === -500 && whatsapp.cac_usd === null,
  JSON.stringify(whatsapp),
);

const { rows: crudo } = await db.query(
  `select
     (select coalesce(sum(case when kind in ('refund','churn') then -amount_usd else amount_usd end), 0)
        from holaamigo.revenue_events where organization_id = $1) as ingreso,
     (select coalesce(sum(amount_usd), 0)
        from holaamigo.cost_events where organization_id = $1) as costo`,
  [ORG],
);
const { rows: vista } = await db.query(
  `select coalesce(sum(ingreso_usd), 0) as ingreso, coalesce(sum(costo_usd), 0) as costo
     from holaamigo.channel_economics where organization_id = $1`,
  [ORG],
);
const desvioIngreso = Math.abs(Number(crudo[0].ingreso) - Number(vista[0].ingreso)) / Number(crudo[0].ingreso);
const desvioCosto = Math.abs(Number(crudo[0].costo) - Number(vista[0].costo)) / Number(crudo[0].costo);
check(
  'la vista cuadra contra la suma cruda de eventos (< 0,1%)',
  desvioIngreso < 0.001 && desvioCosto < 0.001,
  `ingreso ${crudo[0].ingreso} vs ${vista[0].ingreso} · costo ${crudo[0].costo} vs ${vista[0].costo}`,
);
check('y de hecho cuadra exacto', desvioIngreso === 0 && desvioCosto === 0);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · El costo de pensar entra al P&G\x1b[0m');

const RUN = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
for (let i = 0; i < 3; i += 1) {
  await db.query(
    `insert into holaamigo.traces
       (organization_id, run_id, step_type, name, model, tokens_in, tokens_out, cost_usd)
     values ($1, $2, 'output', 'diagnosis', 'gpt-5-mini', 1000, 500, 0.05)`,
    [ORG, RUN],
  );
}
const { rows: importados } = await db.query(
  `select holaamigo.importar_costos_de_agentes($1, '2020-01-01'::date) as n`,
  [ORG],
);
check('los costos de agente se importan como gasto', Number(importados[0].n) === 1, `importó ${importados[0].n}`);

const { rows: repetido } = await db.query(
  `select holaamigo.importar_costos_de_agentes($1, '2020-01-01'::date) as n`,
  [ORG],
);
const { rows: cuantos } = await db.query(
  `select count(*)::int as n, sum(amount_usd) as total from holaamigo.cost_events
    where organization_id = $1 and category = 'agent_compute'`,
  [ORG],
);
check(
  'reimportar actualiza en vez de duplicar',
  Number(repetido[0].n) === 1 && cuantos[0].n === 1 && Number(cuantos[0].total) === 0.15,
  JSON.stringify(cuantos[0]),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · El pre-registro es inmutable\x1b[0m');

const { rows: decision } = await db.query(
  `insert into holaamigo.decisions
     (organization_id, kind, question, options_considered, chosen, rationale, prediction)
   values ($1, 'angle_select', '¿Probamos el ángulo de costo?',
     '[{"label":"costo"},{"label":"urgencia"}]'::jsonb,
     '{"label":"costo"}'::jsonb, 'la base está fría',
     '{"metric":"reply_rate","expected_value":0.08,"horizon_days":14}'::jsonb)
   returning id`,
  [ORG],
);
const DECISION = decision[0].id;

const { rows: experimento } = await db.query(
  `insert into holaamigo.experiments
     (organization_id, decision_id, channel_id, hypothesis, primary_metric, expected_effect,
      decision_rule, min_sample, guardrail_metric, guardrail_threshold, status, started_at)
   values ($1, $2, $3, 'El ángulo de costo supera al de urgencia en logística',
           'reply_rate', 0.08,
           '{"comparador":">=","umbral":0.06,"gana":"won","pierde":"lost"}'::jsonb,
           200, 'complaint_rate', 0.003, 'running', now())
   returning id`,
  [ORG, DECISION, CORREO],
);
const EXP = experimento[0].id;

const cambio = await attempt(
  `update holaamigo.experiments set expected_effect = 0.02 where id = $1`,
  [EXP],
);
check(
  'no se puede bajar el efecto esperado después de arrancar',
  cambio.error !== null && /ya arrancó/.test(String(cambio.error.message)),
  cambio.error ? cambio.error.message : 'NO falló: se puede racionalizar el resultado',
);

const cambioRegla = await attempt(
  `update holaamigo.experiments set decision_rule = '{"comparador":">=","umbral":0.01}'::jsonb where id = $1`,
  [EXP],
);
check(
  'ni cambiar la regla de decisión',
  cambioRegla.error !== null && /ya arrancó/.test(String(cambioRegla.error.message)),
  cambioRegla.error ? cambioRegla.error.message : 'NO falló',
);

const cambioNota = await attempt(
  `update holaamigo.experiments set readout_note = 'nota operativa' where id = $1`,
  [EXP],
);
check('pero sí anotar lo operativo', cambioNota.error === null, cambioNota.error?.message);

const { rows: borrador } = await db.query(
  `insert into holaamigo.experiments
     (organization_id, hypothesis, primary_metric, expected_effect, decision_rule, min_sample)
   values ($1, 'borrador', 'x', 1, '{"comparador":">=","umbral":1}'::jsonb, 10)
   returning id`,
  [ORG],
);
const enBorrador = await attempt(
  `update holaamigo.experiments set expected_effect = 2 where id = $1`,
  [borrador[0].id],
);
check('un borrador sí se puede corregir antes de arrancar', enBorrador.error === null, enBorrador.error?.message);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · El readout aplica la regla literalmente\x1b[0m');

const { rows: corto } = await db.query(
  `select holaamigo.readout_experimento($1, 0.09, 120) as r`,
  [EXP],
);
check(
  'con menos muestra de la declarada, no concluye aunque el número sea bueno',
  corto[0].r.status === 'inconclusive' && /120 de 200/.test(corto[0].r.nota),
  JSON.stringify(corto[0].r),
);

// Se reabre para probar los otros caminos (el readout solo corre una vez).
await db.query(`update holaamigo.experiments set status = 'running' where id = $1`, [EXP]);

const { rows: guardrail } = await db.query(
  `select holaamigo.readout_experimento($1, 0.09, 400, 0.02) as r`,
  [EXP],
);
check(
  'el guardrail le gana a la métrica principal',
  guardrail[0].r.status === 'lost' && guardrail[0].r.guardrail_roto === true,
  JSON.stringify(guardrail[0].r),
);
check(
  'y la nota dice exactamente qué se rompió',
  /complaint_rate llegó a 0.02 y el tope era 0.003/.test(guardrail[0].r.nota),
  guardrail[0].r.nota,
);

await db.query(`update holaamigo.experiments set status = 'running' where id = $1`, [EXP]);
const { rows: gana } = await db.query(
  `select holaamigo.readout_experimento($1, 0.09, 400, 0.001) as r`,
  [EXP],
);
check('con muestra y sin romper el guardrail, gana', gana[0].r.status === 'won', JSON.stringify(gana[0].r));

// ═══════════════ el ciclo de P1, cerrado ═══════════════
const { rows: cerrada } = await db.query(
  `select outcome, calibration from holaamigo.decisions where id = $1`,
  [DECISION],
);
check(
  'el readout escribió el `outcome` de la decisión que lo originó',
  cerrada[0].outcome?.metric === 'reply_rate' && Number(cerrada[0].outcome?.actual_value) === 0.09,
  JSON.stringify(cerrada[0].outcome),
);
check(
  'y con eso quedó la calibración: predijo 0,08 y salió 0,09',
  Math.abs(Number(cerrada[0].calibration) - (1 - 0.01 / 0.09)) < 0.001,
  `calibración ${cerrada[0].calibration}`,
);
check(
  'el readout devuelve la calibración para poder mostrarla',
  Math.abs(Number(gana[0].r.calibracion) - Number(cerrada[0].calibration)) < 0.0001,
  JSON.stringify(gana[0].r),
);

const { rows: segundo } = await db.query(`select holaamigo.readout_experimento($1, 0.5, 900) as r`, [EXP]);
check(
  'un segundo readout no reescribe el resultado',
  /ya tenía readout/.test(segundo[0].r.nota ?? ''),
  JSON.stringify(segundo[0].r),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · La propuesta de reasignación\x1b[0m');

const { rows: deliberacion } = await db.query(
  `insert into holaamigo.deliberations (organization_id, opened_by_role, question)
   values ($1, 'president', '¿Cómo repartimos el presupuesto de septiembre?')
   returning id`,
  [ORG],
);

const { rows: propuesta } = await db.query(
  `insert into holaamigo.allocation_proposals
     (organization_id, period, current_allocation, proposed_allocation, expected_delta,
      confidence, reasoning, supporting_experiments, deliberation_id)
   values ($1, '2026-09',
     jsonb_build_object($2::text, 2400, $3::text, 500),
     jsonb_build_object($2::text, 2900, $3::text, 0),
     '{"revenue": 2200, "cac": -35, "payback_days": -12}'::jsonb,
     0.62, 'El correo trae clientes a 240 y WhatsApp no trajo ninguno este mes.',
     array[$4::uuid], $5)
   returning id`,
  [ORG, CORREO, WHATSAPP, EXP, deliberacion[0].id],
);

const { rows: guardada } = await db.query(
  `select current_allocation, proposed_allocation, supporting_experiments, deliberation_id
     from holaamigo.allocation_proposals where id = $1`,
  [propuesta[0].id],
);
check(
  'la propuesta compara al menos dos canales',
  Object.keys(guardada[0].proposed_allocation).length >= 2,
  JSON.stringify(guardada[0].proposed_allocation),
);
check(
  'y lleva la evidencia del experimento que la sostiene',
  guardada[0].supporting_experiments.length === 1 && guardada[0].deliberation_id !== null,
  JSON.stringify(guardada[0].supporting_experiments),
);

const duplicada = await attempt(
  `insert into holaamigo.allocation_proposals
     (organization_id, period, current_allocation, proposed_allocation, expected_delta, reasoning)
   values ($1, '2026-09', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'otra')`,
  [ORG],
);
check(
  'no puede haber dos propuestas pendientes del mismo periodo',
  duplicada.error !== null && /duplicate key|allocation_proposals_periodo_key/.test(String(duplicada.error.message)),
  duplicada.error ? duplicada.error.message : 'NO falló',
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLas cuentas cuadran, el pre-registro aguanta y el experimento cierra la decisión.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
