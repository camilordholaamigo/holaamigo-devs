#!/usr/bin/env node
/**
 * P3 · La Sala — los criterios de aceptación, como pruebas que corren.
 *
 *   node scripts/test-la-sala.mjs
 *
 * Los cuatro del plan:
 *   1. Una deliberación con desacuerdo real entre CMO y SALES muestra las dos
 *      posiciones.
 *   2. El cliente responde en La Sala → `human_input` con peso 2.0 → la
 *      deliberación vuelve a `open` → la nueva recomendación lo cita.
 *   3. Ninguna recomendación existe sin `what_would_change_my_mind`.
 *   4. Con 12 tarjetas pendientes, el feed muestra 7 y cada una dice por qué.
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

console.log('\n\x1b[1mP3 · La Sala · Postgres real (PGlite)\x1b[0m');
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

const ORG = '99999999-9999-9999-9999-999999999999';
await db.query(`insert into holaamigo.organizations (id, website_url) values ($1, 'https://sala.test')`, [ORG]);
for (const rol of ['president', 'cmo', 'sales']) {
  await db.query(
    `insert into holaamigo.agents (organization_id, role, status, objective, budget, permissions, escalation_rules)
     values ($1, $2, 'active', '{}', '{}', '{}', '{}')`,
    [ORG, rol],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El desacuerdo se muestra, no se resuelve en silencio\x1b[0m');

const { rows: deliberacion } = await db.query(
  `insert into holaamigo.deliberations
     (organization_id, opened_by_role, question, context, dissent)
   values ($1, 'president', '¿Subimos presupuesto de marca o compramos más buzones?',
           '{"segment":"logistica"}'::jsonb,
           $2::jsonb)
   returning id`,
  [
    ORG,
    JSON.stringify([
      { agent: 'cmo', position: 'subir marca', argument: 'los 3 ángulos saturaron el segmento' },
      { agent: 'sales', position: 'más buzones', argument: 'el cuello está en volumen, no en mensaje' },
    ]),
  ],
);
const DELIB = deliberacion[0].id;

for (const turno of [
  ['cmo', 'propose', 'Propongo mover 30% a marca: la tasa de respuesta cayó 40% en dos semanas.'],
  ['sales', 'object', 'No es el mensaje, es el volumen. Con 2 buzones más llegamos a la meta sin tocar el copy.'],
  ['president', 'decide', 'Escojo marca. El volumen sin mensaje nuevo repite el mismo resultado más caro.'],
]) {
  await db.query(
    `insert into holaamigo.deliberation_turns (deliberation_id, speaker, speaker_type, body, stance)
     values ($1, $2, 'agent', $4, $3)`,
    [DELIB, turno[0], turno[1], turno[2]],
  );
}

const { rows: hilo } = await db.query(
  `select speaker, stance from holaamigo.deliberation_turns where deliberation_id = $1 order by id`,
  [DELIB],
);
check(
  'el hilo guarda la objeción de SALES, no solo la decisión del President',
  hilo.length === 3 && hilo.some((t) => t.stance === 'object' && t.speaker === 'sales'),
  JSON.stringify(hilo),
);

const { rows: disenso } = await db.query(
  `select dissent from holaamigo.deliberations where id = $1`,
  [DELIB],
);
check(
  'y las dos posiciones quedan en `dissent` para poder renderizarlas juntas',
  disenso[0].dissent.length === 2 &&
    disenso[0].dissent.some((d) => d.agent === 'cmo') &&
    disenso[0].dissent.some((d) => d.agent === 'sales'),
  JSON.stringify(disenso[0].dissent),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · Nada se resuelve sin decir qué cambiaría de opinión\x1b[0m');

const REC = JSON.stringify({
  option: 'subir_marca',
  summary: 'Movemos 30% del presupuesto a marca durante 3 semanas.',
  evidence: [{ type: 'metric', ref: 'reply_rate_14d', note: 'cayó 40%' }],
});

const corta = await attempt('select holaamigo.resolver_deliberacion($1, $2::jsonb, 0.7, $3)', [
  DELIB, REC, 'más datos',
]);
check(
  'un «más datos» de tres palabras no alcanza para resolver',
  corta.error !== null && /qué te haría cambiar de opinión/.test(String(corta.error.message)),
  corta.error ? corta.error.message : 'NO falló',
);

const nula = await attempt('select holaamigo.resolver_deliberacion($1, $2::jsonb, 0.7, null)', [DELIB, REC]);
check('y sin el campo, tampoco', nula.error !== null, nula.error?.message);

const CAMBIO =
  'Si la respuesta del segmento logística sube por encima de 6% con los ángulos actuales en las próximas 2 semanas, el cuello no era el mensaje y esto se revierte.';

const resuelta = await attempt('select holaamigo.resolver_deliberacion($1, $2::jsonb, 0.7, $3)', [
  DELIB, REC, CAMBIO,
]);
check('con la frase completa, resuelve', resuelta.error === null, resuelta.error?.message);

const forzada = await attempt(
  `update holaamigo.deliberations set status = 'resolved', what_would_change_my_mind = null where id = $1`,
  [DELIB],
);
check(
  'y ni siquiera un UPDATE a mano puede dejarla resuelta sin ese campo',
  forzada.error !== null && /deliberations_resuelta_exige_cambio_de_opinion/.test(String(forzada.error.message)),
  forzada.error ? forzada.error.message : 'NO falló: la regla vive solo en el código',
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · El cliente entra a la sala\x1b[0m');

const { rows: interpuesto } = await db.query(
  `select holaamigo.interponer($1, 'camilo@rentmies.com', 'client',
     'El competidor grande acaba de bajar precios. No quiero que nos vean compitiendo por precio.') as r`,
  [DELIB],
);
check('la deliberación se reabre', interpuesto[0].r.reabierta === true, JSON.stringify(interpuesto[0].r));

const { rows: estado } = await db.query(
  `select status, reopened_count, resolved_at, recommendation from holaamigo.deliberations where id = $1`,
  [DELIB],
);
check(
  'vuelve a `open` y cuenta la reapertura',
  estado[0].status === 'open' && estado[0].reopened_count === 1 && estado[0].resolved_at === null,
  JSON.stringify(estado[0]),
);
check(
  'la recomendación anterior NO se borra: queda lo que el agente pensaba antes de escuchar',
  estado[0].recommendation?.option === 'subir_marca',
  JSON.stringify(estado[0].recommendation),
);

const { rows: input } = await db.query(
  `select weight, author_type, status, scope from holaamigo.human_inputs
    where organization_id = $1 order by created_at desc limit 1`,
  [ORG],
);
check(
  'lo que escribió pesa 2.0: manda sobre la evidencia del sistema',
  Number(input[0].weight) === 2 && input[0].author_type === 'client' && input[0].status === 'active',
  JSON.stringify(input[0]),
);
check(
  'y queda enganchado a la deliberación para la próxima corrida',
  input[0].scope?.deliberation_id === DELIB,
  JSON.stringify(input[0].scope),
);

const { rows: turnos } = await db.query(
  `select speaker_type, stance, human_input_id from holaamigo.deliberation_turns
    where deliberation_id = $1 order by id desc limit 1`,
  [DELIB],
);
check(
  'aparece en el hilo como un turno más, con su input enganchado',
  turnos[0].speaker_type === 'human' && turnos[0].human_input_id !== null,
  JSON.stringify(turnos[0]),
);

// La regla que importa: la nueva recomendación TIENE que citarlo.
const ignorando = await attempt('select holaamigo.resolver_deliberacion($1, $2::jsonb, 0.7, $3)', [
  DELIB, REC, CAMBIO,
]);
check(
  'resolver ignorando lo que el cliente escribió es imposible',
  ignorando.error !== null && /no cita lo que escribió el humano/.test(String(ignorando.error.message)),
  ignorando.error ? ignorando.error.message : 'NO falló: se puede ignorar al cliente en silencio',
);

const { rows: inputId } = await db.query(
  `select id from holaamigo.human_inputs where organization_id = $1 order by created_at desc limit 1`,
  [ORG],
);
const RECITADA = JSON.stringify({
  option: 'subir_marca',
  summary: 'Movemos 30% a marca, con el ángulo de servicio y no de precio.',
  evidence: [
    { type: 'metric', ref: 'reply_rate_14d', note: 'cayó 40%' },
    {
      type: 'human',
      ref: inputId[0].id,
      note: 'el cliente pide no competir por precio: cambia el ángulo, no la decisión',
    },
  ],
});

const citando = await attempt('select holaamigo.resolver_deliberacion($1, $2::jsonb, 0.75, $3)', [
  DELIB, RECITADA, CAMBIO,
]);
check('citándolo, sí resuelve', citando.error === null, citando.error?.message);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Doce pendientes, siete en pantalla\x1b[0m');

for (let i = 0; i < 12; i += 1) {
  const severidad = i < 2 ? 'high' : i < 8 ? 'normal' : 'low';
  const { rows: approval } = await db.query(
    `insert into holaamigo.approvals (organization_id, kind, title, status, expires_at)
     values ($1, 'campaign_launch', $2, 'pending', $3)
     returning id`,
    [
      ORG,
      `Propuesta ${i + 1}`,
      // La número 5 vence en 3 horas: tiene que subir por encima de su severidad.
      i === 5 ? new Date(Date.now() + 3 * 3600_000).toISOString() : new Date(Date.now() + 40 * 3600_000).toISOString(),
    ],
  );
  await db.query(
    `insert into holaamigo.feed_items
       (organization_id, kind, role, title, body, requires, severity, status, approval_id, created_at)
     values ($1, 'proposal', 'president', $2, 'cuerpo', 'approval', $3, 'open', $4, $5)`,
    [
      ORG,
      `Propuesta ${i + 1}`,
      severidad,
      approval[0].id,
      new Date(Date.now() - i * 3600_000).toISOString(),
    ],
  );
}

const { rows: cola } = await db.query('select * from holaamigo.priorizar_feed($1)', [ORG]);
const mostrados = cola.filter((c) => c.mostrado);

check('las 12 se priorizan', cola.length === 12, `hay ${cola.length}`);
check('y solo 7 se muestran', mostrados.length === 7, `se muestran ${mostrados.length}`);
check(
  'cada una dice por qué está ahí',
  mostrados.every((c) => typeof c.motivo === 'string' && c.motivo.length > 10),
  JSON.stringify(mostrados.map((c) => c.motivo)),
);
check(
  'la que vence en 3 horas sube por encima de su severidad',
  mostrados.some((c) => /se decide solo en menos de/.test(c.motivo)),
  JSON.stringify(mostrados.map((c) => c.motivo)),
);
check(
  'las de severidad alta están en la pantalla',
  mostrados.filter((c) => /costar caro/.test(c.motivo)).length === 2,
  JSON.stringify(mostrados.map((c) => c.motivo)),
);
check(
  'las postergadas dicen que entran cuando se despeje la cola',
  cola.filter((c) => !c.mostrado).length === 5,
  `postergadas ${cola.filter((c) => !c.mostrado).length}`,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · El Capítulo es una serie, no una notificación\x1b[0m');

await db.query(
  `insert into holaamigo.chapters (organization_id, dia, numero, titulo, body, stats)
   values ($1, current_date, 1, 'Día 1', 'Ayer la organización…', '{"enviados": 340}'::jsonb)`,
  [ORG],
);
const repetido = await attempt(
  `insert into holaamigo.chapters (organization_id, dia, numero, titulo, body)
   values ($1, current_date, 2, 'Día 1 otra vez', 'texto')`,
  [ORG],
);
check(
  'no se puede escribir dos capítulos del mismo día',
  repetido.error !== null && /duplicate key|chapters_dia_key/.test(String(repetido.error.message)),
  repetido.error ? repetido.error.message : 'NO falló',
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLa sala se ve: el desacuerdo, lo que cambiaría de opinión, y al cliente adentro.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
