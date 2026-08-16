#!/usr/bin/env node
/**
 * P6 · Integraciones, CRM y habilidades — los criterios de aceptación.
 *
 *   node scripts/test-integraciones.mjs
 *
 * Los cinco del plan:
 *   1. Conectar una fuente con miles de contactos produce staging y cotización
 *      sin intervención.
 *   2. Aprobar un lote descuenta los créditos exactos.
 *   3. Un agente sin la habilidad genera `skill_request` con la decisión
 *      bloqueada enlazada.
 *   4. Habilitar la habilidad desde admin la hace disponible en la siguiente
 *      corrida, sin desplegar.
 *   5. La línea de tiempo de una oportunidad muestra actores humanos y de
 *      agente intercalados, con costo por paso.
 *
 * Más la regla dura: ninguna habilidad de clase `spend` o `irreversible` se
 * enciende sin operador y sin sobre.
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

console.log('\n\x1b[1mP6 · Integraciones, CRM y habilidades · Postgres real (PGlite)\x1b[0m');
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

const ORG = 'dddddddd-4444-4444-8444-dddddddddddd';
await db.query(
  `insert into holaamigo.organizations (id, website_url, plan) values ($1, 'https://crm.test', 'growth')`,
  [ORG],
);
for (const rol of ['president', 'cmo', 'sales']) {
  await db.query(
    `insert into holaamigo.agents (organization_id, role, status, objective, budget, permissions, escalation_rules, autonomy)
     values ($1, $2, 'active', '{}', '{}', '{}', '{}', 'auto_within_limits')`,
    [ORG, rol],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El tool list es una intersección, no una lista\x1b[0m');

const { rows: deSales } = await db.query(
  `select * from holaamigo.habilidades_activas($1, 'sales') order by skill_id`,
  [ORG],
);
check(
  'SALES ve LinkedIn y HubSpot lectura, que vienen encendidas del catálogo',
  deSales.some((s) => s.skill_id === 'linkedin.search_people') &&
    deSales.some((s) => s.skill_id === 'hubspot.read_contacts'),
  JSON.stringify(deSales.map((s) => s.skill_id)),
);
check(
  'y NO ve las que nadie le otorgó',
  !deSales.some((s) => s.skill_id === 'elevenlabs.voice'),
  JSON.stringify(deSales.map((s) => s.skill_id)),
);

// El plan como filtro: Apollo exige `growth`.
await db.query(
  `insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, granted_by, granted_by_type)
   values ($1, 'sales', 'apollo.build_list', 'prueba', 'operator')`,
  [ORG],
);
const { rows: conApollo } = await db.query(
  `select * from holaamigo.habilidades_activas($1, 'sales')`,
  [ORG],
);
check('con el grant, Apollo aparece', conApollo.some((s) => s.skill_id === 'apollo.build_list'));

await db.query(`update holaamigo.organizations set plan = 'starter' where id = $1`, [ORG]);
const { rows: enStarter } = await db.query(
  `select * from holaamigo.habilidades_activas($1, 'sales')`,
  [ORG],
);
check(
  'al bajar de plan, Apollo desaparece aunque el grant siga ahí',
  !enStarter.some((s) => s.skill_id === 'apollo.build_list'),
  JSON.stringify(enStarter.map((s) => s.skill_id)),
);
await db.query(`update holaamigo.organizations set plan = 'growth' where id = $1`, [ORG]);

// El nivel de capacidad como filtro: con la CMO en `propose`, las de
// comunicación externa no alcanzan el nivel mínimo.
await db.query(
  `insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, granted_by, granted_by_type)
   values ($1, 'cmo', 'elevenlabs.voice', 'prueba', 'operator')`,
  [ORG],
);
await db.query(
  `update holaamigo.agents set autonomy = 'propose' where organization_id = $1 and role = 'cmo'`,
  [ORG],
);
const { rows: cmoLimitada } = await db.query(
  `select * from holaamigo.habilidades_activas($1, 'cmo')`,
  [ORG],
);
check(
  'con la CMO en «solo proponer», la habilidad de voz no alcanza el nivel mínimo',
  !cmoLimitada.some((s) => s.skill_id === 'elevenlabs.voice'),
  JSON.stringify(cmoLimitada.map((s) => s.skill_id)),
);

await db.query(
  `update holaamigo.agents set autonomy = 'auto_within_limits' where organization_id = $1 and role = 'cmo'`,
  [ORG],
);
const { rows: cmoAbierta } = await db.query(
  `select * from holaamigo.habilidades_activas($1, 'cmo')`,
  [ORG],
);
check(
  'al subir su autonomía, la misma habilidad aparece — sin desplegar nada',
  cmoAbierta.some((s) => s.skill_id === 'elevenlabs.voice'),
  JSON.stringify(cmoAbierta.map((s) => s.skill_id)),
);

// Apagar para una organización lo que está encendido para todas.
await db.query(
  `insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, enabled, granted_by, granted_by_type)
   values ($1, 'sales', 'linkedin.search_people', false, 'prueba', 'operator')`,
  [ORG],
);
const { rows: sinLinkedin } = await db.query(
  `select * from holaamigo.habilidades_activas($1, 'sales')`,
  [ORG],
);
check(
  'la fila de la organización le gana a la global: se puede apagar para uno solo',
  !sinLinkedin.some((s) => s.skill_id === 'linkedin.search_people'),
  JSON.stringify(sinLinkedin.map((s) => s.skill_id)),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · La regla dura: gasto e irreversible no se encienden solos\x1b[0m');

const porSistema = await attempt(
  `insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, envelope, granted_by, granted_by_type)
   values ($1, 'sales', 'stripe.charge', '{"max_amount_usd": 100}'::jsonb, 'job', 'system')`,
  [ORG],
);
check(
  'el sistema no puede encender una habilidad de clase `spend`',
  porSistema.error !== null && /solo la enciende un operador/.test(String(porSistema.error.message)),
  porSistema.error ? porSistema.error.message : 'NO falló: un job podría darle poder de cobro a un agente',
);

const sinSobre = await attempt(
  `insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, granted_by, granted_by_type)
   values ($1, 'sales', 'n8n.trigger', 'camilo@rentmies.com', 'operator')`,
  [ORG],
);
check(
  'ni un operador puede encender una irreversible sin sobre',
  sinSobre.error !== null && /exige un sobre con límites/.test(String(sinSobre.error.message)),
  sinSobre.error ? sinSobre.error.message : 'NO falló: sería una firma en blanco',
);

const conSobre = await attempt(
  `insert into holaamigo.skill_grants (organization_id, agent_role, skill_id, envelope, granted_by, granted_by_type)
   values ($1, 'sales', 'n8n.trigger', '{"max_volume_per_day": 5}'::jsonb, 'camilo@rentmies.com', 'operator')`,
  [ORG],
);
check('con operador y sobre, sí', conSobre.error === null, conSobre.error?.message);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · El "intraer": el agente pide lo que le falta\x1b[0m');

const { rows: bloqueada } = await db.query(
  `insert into holaamigo.decisions
     (organization_id, kind, question, options_considered, chosen, rationale, prediction)
   values ($1, 'escalate', 'No puedo perfilar a los 40 candidatos sin LinkedIn',
     '[{"label":"pedir la habilidad"},{"label":"seguir a ciegas"}]'::jsonb,
     '{"label":"pedir la habilidad"}'::jsonb, 'sin datos de cargo no se puede segmentar', null)
   returning id`,
  [ORG],
);

const { rows: pedido } = await db.query(
  `insert into holaamigo.skill_requests
     (organization_id, agent_role, skill_id, justification, blocked_decision_id)
   values ($1, 'sales', 'linkedin.search_people',
     'Necesito buscar por cargo para segmentar los 40 candidatos que la CMO puntuó',
     $2)
   returning id, status`,
  [ORG, bloqueada[0].id],
);
check('el pedido queda pendiente y con su justificación', pedido[0].status === 'pending');

const { rows: enlace } = await db.query(
  `select r.justification, d.question
     from holaamigo.skill_requests r
     join holaamigo.decisions d on d.id = r.blocked_decision_id
    where r.id = $1`,
  [pedido[0].id],
);
check(
  'y enlaza la decisión que quedó bloqueada, que es lo que hace la tarjeta útil',
  /No puedo perfilar/.test(enlace[0].question),
  JSON.stringify(enlace[0]),
);

const repetido = await attempt(
  `insert into holaamigo.skill_requests (organization_id, agent_role, skill_id, justification)
   values ($1, 'sales', 'linkedin.search_people', 'otra vez lo mismo')`,
  [ORG],
);
check(
  'chocar contra el mismo muro no genera cien tarjetas',
  repetido.error !== null && /duplicate key|skill_requests_viva_key/.test(String(repetido.error.message)),
  repetido.error ? repetido.error.message : 'NO falló',
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · El lote: se cotiza, se aprueba, después se cobra\x1b[0m');

const { rows: integracion } = await db.query(
  `insert into holaamigo.integrations (organization_id, provider, status, connected_by)
   values ($1, 'hubspot', 'connected', 'cliente') returning id`,
  [ORG],
);

// 5.000 contactos en staging, como los traería el sync.
await db.query(
  `insert into holaamigo.staging_contacts (organization_id, integration_id, external_id, mapped)
   select $1, $2, 'hs-' || g, jsonb_build_object('email', 'c' || g || '@rival.test')
     from generate_series(1, 5000) g`,
  [ORG, integracion[0].id],
);

const { rows: staged } = await db.query(
  `select count(*)::int as n from holaamigo.staging_contacts where organization_id = $1 and status = 'staged'`,
  [ORG],
);
check('los 5.000 quedan en staging, fuera de operación', staged[0].n === 5000, `hay ${staged[0].n}`);

const { rows: enLeads } = await db.query(
  `select count(*)::int as n from holaamigo.leads where organization_id = $1`,
  [ORG],
);
check('y NO aparecen como leads trabajables todavía', enLeads[0].n === 0, `hay ${enLeads[0].n}`);

const { rows: tarifas } = await db.query(
  `select holaamigo.tarifa_de_lote('segment') as s,
          holaamigo.tarifa_de_lote('enrich') as e,
          holaamigo.tarifa_de_lote('reactivate') as r`,
);
check(
  'la tarifa es 1 / 3 / 5 según profundidad',
  tarifas[0].s === 1 && tarifas[0].e === 3 && tarifas[0].r === 5,
  JSON.stringify(tarifas[0]),
);

// El sistema propone empezar por 1.200, no por los 5.000.
const { rows: lote } = await db.query(
  `insert into holaamigo.analysis_batches
     (organization_id, integration_id, source, contact_count, depth, credits_quoted, quote_reason)
   values ($1, $2, 'hubspot', 1200, 'segment', 1200,
     'De tus 5.000 contactos, empezamos con los 1.200 que interactuaron en los últimos 18 meses.')
   returning id, status, credits_quoted`,
  [ORG, integracion[0].id],
);
check('el lote nace cotizado, no cobrado', lote[0].status === 'quoted' && lote[0].credits_quoted === 1200);

const sinAprobar = await db.query(`select holaamigo.cobrar_lote($1, 'camilo@rentmies.com') as r`, [
  lote[0].id,
]);
check(
  'cobrar un lote sin aprobar no pasa',
  sinAprobar.rows[0].r.ok === false && /no en approved/.test(sinAprobar.rows[0].r.motivo),
  JSON.stringify(sinAprobar.rows[0].r),
);

await db.query(`update holaamigo.analysis_batches set status = 'approved' where id = $1`, [lote[0].id]);

const sinSaldo = await db.query(`select holaamigo.cobrar_lote($1, 'camilo@rentmies.com') as r`, [
  lote[0].id,
]);
check(
  'sin saldo tampoco, y dice cuántos faltan',
  sinSaldo.rows[0].r.ok === false && sinSaldo.rows[0].r.faltan === 1200,
  JSON.stringify(sinSaldo.rows[0].r),
);

await db.query(
  `insert into holaamigo.credit_ledger (organization_id, delta, kind, note)
   values ($1, 2000, 'grant', 'prueba')`,
  [ORG],
);

const { rows: cobrado } = await db.query(
  `select holaamigo.cobrar_lote($1, 'camilo@rentmies.com') as r`,
  [lote[0].id],
);
check(
  'con saldo, cobra los créditos exactos y deja el lote corriendo',
  cobrado[0].r.ok === true && cobrado[0].r.cobrado === 1200 && cobrado[0].r.saldo_despues === 800,
  JSON.stringify(cobrado[0].r),
);

const { rows: dobleCobro } = await db.query(
  `select holaamigo.cobrar_lote($1, 'camilo@rentmies.com') as r`,
  [lote[0].id],
);
const { rows: saldoFinal } = await db.query(`select holaamigo.credit_balance($1) as s`, [ORG]);
check(
  'y no se puede cobrar dos veces',
  dobleCobro[0].r.ok === false && saldoFinal[0].s === 800,
  `saldo ${saldoFinal[0].s} · ${JSON.stringify(dobleCobro[0].r)}`,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · El CRM: la línea de tiempo con actor y costo\x1b[0m');

const { rows: lead } = await db.query(
  `insert into holaamigo.leads (organization_id, full_name, email, status)
   values ($1, 'Ana Restrepo', 'ana@transportes.test', 'contacted') returning id`,
  [ORG],
);

const { rows: decisionAngulo } = await db.query(
  `insert into holaamigo.decisions
     (organization_id, role, kind, question, options_considered, chosen, rationale, prediction, cost_usd)
   values ($1, 'cmo', 'angle_select', '¿Con qué ángulo le escribimos a logística?',
     '[{"label":"costo"},{"label":"urgencia"}]'::jsonb, '{"label":"costo"}'::jsonb,
     'la base está fría', '{"metric":"reply_rate","expected_value":0.08,"horizon_days":14}'::jsonb,
     0.042)
   returning id`,
  [ORG],
);

const { rows: oportunidad } = await db.query(
  `insert into holaamigo.opportunities
     (organization_id, lead_id, name, value_usd, stage, origin_decision_id, owner_type, owner_ref)
   values ($1, $2, 'Transportes del Norte · flota', 24000, 'reunion', $3, 'agent', 'sales')
   returning id`,
  [ORG, lead[0].id, decisionAngulo[0].id],
);

const toques = [
  ['agent', 'cmo', 'angle_proposed', decisionAngulo[0].id, null],
  ['agent', 'sales', 'email_sent', null, 0.001],
  ['human', 'ana@transportes.test', 'replied', null, null],
  ['agent', 'sales', 'qualified', null, 0.003],
  ['human', 'camilo@rentmies.com', 'note', null, null],
  ['agent', 'sales', 'booked', null, null],
];

for (const [tipo, actor, accion, decisionId, costo] of toques) {
  await db.query(
    `insert into holaamigo.touchpoints
       (organization_id, lead_id, opportunity_id, actor_type, actor_ref, action, decision_id, cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ORG, lead[0].id, oportunidad[0].id, tipo, actor, accion, decisionId, costo],
  );
}

const { rows: linea } = await db.query(
  `select * from holaamigo.lead_timeline where lead_id = $1 order by occurred_at, id`,
  [lead[0].id],
);

check('la línea de tiempo trae los seis toques', linea.length === 6, `hay ${linea.length}`);
check(
  'con actores de agente y humanos intercalados',
  linea.map((t) => t.actor_type).join(',') === 'agent,agent,human,agent,human,agent',
  linea.map((t) => `${t.actor_type}:${t.actor_ref}`).join(' → '),
);
check(
  'el toque que salió de una decisión hereda su costo',
  Number(linea[0].costo_usd) === 0.042 && /ángulo/.test(linea[0].decision_question ?? ''),
  JSON.stringify(linea[0]),
);
check(
  'y el que tiene costo propio lo conserva',
  Number(linea[1].costo_usd) === 0.001,
  JSON.stringify(linea[1]),
);
check(
  'los toques del humano no inventan costo',
  linea[2].costo_usd === null && linea[4].costo_usd === null,
  JSON.stringify([linea[2].costo_usd, linea[4].costo_usd]),
);

const cierreIncoherente = await attempt(
  `update holaamigo.opportunities set outcome = 'won' where id = $1`,
  [oportunidad[0].id],
);
check(
  'no se puede cerrar una oportunidad sin fecha de cierre',
  cierreIncoherente.error !== null && /opportunities_cierre_coherente/.test(String(cierreIncoherente.error.message)),
  cierreIncoherente.error ? cierreIncoherente.error.message : 'NO falló',
);

const cierre = await attempt(
  `update holaamigo.opportunities set outcome = 'won', closed_at = now(), stage = 'ganada' where id = $1`,
  [oportunidad[0].id],
);
check('con las dos cosas, sí', cierre.error === null, cierre.error?.message);

const { rows: origen } = await db.query(
  `select o.name, d.kind, d.question
     from holaamigo.opportunities o
     join holaamigo.decisions d on d.id = o.origin_decision_id
    where o.id = $1`,
  [oportunidad[0].id],
);
check(
  'y la oportunidad sabe qué decisión de agente la originó',
  origen[0]?.kind === 'angle_select',
  JSON.stringify(origen[0]),
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLas habilidades se intersecan, el lote se cobra una vez y el CRM sabe quién hizo qué.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
