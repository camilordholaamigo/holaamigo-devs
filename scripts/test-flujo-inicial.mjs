#!/usr/bin/env node
/**
 * El flujo inicial y su medición — los criterios de aceptación, como pruebas.
 *
 *   node scripts/test-flujo-inicial.mjs
 *
 * Lo que tiene que ser cierto para que `/admin/embudo` sirva para decidir algo:
 *
 *   1. El embudo cuenta ORGANIZACIONES y no eventos: entrar dos veces no
 *      duplica la primera barra.
 *   2. La cohorte se ancla al primer `landing_submit`. Alguien que entró antes
 *      de la ventana no reaparece en la ventana por haber vuelto.
 *   3. `leads_uploaded` cuenta aunque no traiga `session_id` — se registra sin
 *      sesión, y un embudo que pierde la última etapa no mide activación.
 *   4. `abandonos` es la última respuesta de una sesión sin completar, no
 *      cualquier respuesta.
 *   5. Los supuestos discutidos solo cuentan cuando hay valor previo y
 *      posterior numéricos: una dirección inventada es peor que una fila menos.
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

console.log('\n\x1b[1mFlujo inicial · el embudo contra Postgres real (PGlite)\x1b[0m');
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

// ═══════════════════════════════════════════════════════════════════════════
// Siembra: cuatro organizaciones que recorren el embudo hasta distinta altura.
// ═══════════════════════════════════════════════════════════════════════════

const ORGS = {
  // Llega hasta el final. Entra dos veces a propósito.
  completa: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  // Se cae después de ver el diagnóstico.
  vio: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  // Abandona a mitad del quiz.
  aMitad: 'cccccccc-3333-4333-8333-cccccccccccc',
  // Entró hace 200 días y volvió ayer: NO es de esta cohorte.
  vieja: 'dddddddd-4444-4444-8444-dddddddddddd',
};

let sitio = 0;
for (const id of Object.values(ORGS)) {
  sitio += 1;
  await db.query(
    `insert into holaamigo.organizations (id, website_url) values ($1, $2)`,
    [id, `https://sitio-${sitio}.test`],
  );
}

/** Inserta un evento del embudo. `dias` es cuántos días atrás ocurrió. */
async function evento(org, sesion, nombre, dias, props = {}) {
  await db.query(
    `insert into holaamigo.plg_events (organization_id, session_id, event, props, created_at)
     values ($1, $2, $3, $4::jsonb, now() - ($5 || ' days')::interval)`,
    [org, sesion, nombre, JSON.stringify(props), String(dias)],
  );
}

async function sesion(id, org, dias, completada) {
  await db.query(
    `insert into holaamigo.intake_sessions (id, organization_id, created_at, completed_at, status)
     values ($1, $2, now() - ($3 || ' days')::interval,
             case when $4 then now() - ($3 || ' days')::interval + interval '7 minutes' else null end,
             case when $4 then 'diagnosed' else 'quiz' end)`,
    [id, org, String(dias), completada],
  );
}

const S = {
  completaA: '11111111-1111-4111-8111-111111111111',
  completaB: '11111111-1111-4111-8111-222222222222',
  vio: '22222222-2222-4222-8222-111111111111',
  aMitad: '33333333-3333-4333-8333-111111111111',
  vieja: '44444444-4444-4444-8444-111111111111',
};

await sesion(S.completaA, ORGS.completa, 10, true);
await sesion(S.completaB, ORGS.completa, 3, true);
await sesion(S.vio, ORGS.vio, 8, true);
await sesion(S.aMitad, ORGS.aMitad, 6, false);
await sesion(S.vieja, ORGS.vieja, 1, false);

// La que llega hasta el final, con dos entradas.
await evento(ORGS.completa, S.completaA, 'landing_submit', 10);
await evento(ORGS.completa, S.completaA, 'quiz_started', 10);
await evento(ORGS.completa, S.completaA, 'quiz_completed', 10);
await evento(ORGS.completa, S.completaA, 'diagnostic_viewed', 10);
await evento(ORGS.completa, S.completaA, 'assumption_edited', 10, {
  changed: 'close_rate',
  from: 0.18,
  to: 0.3,
  assumptions: {},
});
// Sin session_id, como lo registra de verdad la carga de base.
await evento(ORGS.completa, null, 'leads_uploaded', 9);
await evento(ORGS.completa, S.completaB, 'landing_submit', 3);
await evento(ORGS.completa, S.completaB, 'quiz_started', 3);

// La que se queda mirando el diagnóstico.
await evento(ORGS.vio, S.vio, 'landing_submit', 8);
await evento(ORGS.vio, S.vio, 'quiz_started', 8);
await evento(ORGS.vio, S.vio, 'quiz_completed', 8);
await evento(ORGS.vio, S.vio, 'diagnostic_viewed', 8);
await evento(ORGS.vio, S.vio, 'assumption_edited', 8, {
  changed: 'close_rate',
  from: 0.18,
  to: 0.09,
  assumptions: {},
});
// Edición vieja, sin dirección: no debe contar.
await evento(ORGS.vio, S.vio, 'assumption_edited', 8, { changed: 'avg_ticket_usd', assumptions: {} });

// La que abandona el quiz.
await evento(ORGS.aMitad, S.aMitad, 'landing_submit', 6);
await evento(ORGS.aMitad, S.aMitad, 'quiz_started', 6);

// La vieja: entró hace 200 días y volvió ayer.
await evento(ORGS.vieja, S.vieja, 'landing_submit', 200);
await evento(ORGS.vieja, S.vieja, 'quiz_started', 1);
await evento(ORGS.vieja, S.vieja, 'quiz_completed', 1);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El embudo\x1b[0m');

const { rows: embudo } = await db.query(
  `select * from holaamigo.embudo_inicial(now() - interval '30 days') order by orden`,
);
const porOrden = Object.fromEntries(embudo.map((r) => [r.orden, r]));

// Ocho desde 0013: se sumaron "Armó su agente" y "Habló con su agente", los dos
// escalones que P7 hizo posibles. La última sigue siendo la activación.
check('devuelve las ocho etapas, en orden', embudo.length === 8, JSON.stringify(embudo));

check(
  'entrar dos veces cuenta como una organización',
  Number(porOrden[1].organizaciones) === 3,
  `esperado 3, fue ${porOrden[1]?.organizaciones}`,
);

check(
  'la organización vieja no entra a la cohorte aunque haya vuelto ayer',
  !embudo.some((r) => Number(r.organizaciones) > 3),
  JSON.stringify(embudo),
);

check(
  'terminaron el quiz 2 de 3',
  Number(porOrden[3].organizaciones) === 2,
  `fue ${porOrden[3]?.organizaciones}`,
);

check(
  'la etapa final cuenta leads_uploaded aunque venga sin session_id',
  Number(porOrden[8].organizaciones) === 1,
  `fue ${porOrden[8]?.organizaciones}`,
);

check(
  'los escalones del agente están en cero mientras nadie lo arme',
  Number(porOrden[6].organizaciones) === 0 && Number(porOrden[7].organizaciones) === 0,
  `armó ${porOrden[6]?.organizaciones}, habló ${porOrden[7]?.organizaciones}`,
);

// Las tres abrieron el quiz y solo dos lo terminaron: 66,7%.
check(
  'del_anterior es null en la primera etapa y porcentaje después',
  porOrden[1].del_anterior === null && Math.abs(Number(porOrden[3].del_anterior) - 66.7) < 0.1,
  `${porOrden[1].del_anterior} · ${porOrden[3].del_anterior}`,
);

check(
  'la caída de "vio el diagnóstico" a "discutió" queda registrada',
  Number(porOrden[5].organizaciones) === 2 && Number(porOrden[5].del_anterior) === 100,
  JSON.stringify(porOrden[5]),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · La caída pregunta por pregunta\x1b[0m');

/** Respuesta del quiz, con `minutos` de separación respecto al inicio. */
async function respuesta(sesionId, clave, minutos) {
  await db.query(
    `insert into holaamigo.quiz_responses (session_id, question_id, answer, answered_at)
     select $1, $2, '"x"'::jsonb, s.created_at + ($3 || ' minutes')::interval
     from holaamigo.intake_sessions s where s.id = $1`,
    [sesionId, clave, String(minutos)],
  );
}

for (const [i, clave] of ['main_offer', 'ticket_band', 'rev_band'].entries()) {
  await respuesta(S.completaA, clave, i + 1);
  await respuesta(S.vio, clave, i + 1);
}
// La que abandona contesta dos y se cae en `ticket_band`.
await respuesta(S.aMitad, 'main_offer', 1);
await respuesta(S.aMitad, 'ticket_band', 2);

const { rows: caida } = await db.query(
  `select * from holaamigo.caida_por_pregunta(now() - interval '30 days')`,
);
const porClave = Object.fromEntries(caida.map((r) => [r.clave, r]));

check(
  'ordena por la posición promedio en que se responde',
  caida.map((r) => r.clave).join(',') === 'main_offer,ticket_band,rev_band',
  caida.map((r) => `${r.clave}:${r.orden}`).join(' '),
);

check(
  'cuenta cuántas sesiones llegaron a cada pregunta',
  Number(porClave.main_offer.sesiones) === 3 && Number(porClave.rev_band.sesiones) === 2,
  JSON.stringify(caida),
);

check(
  'el abandono se imputa a la ÚLTIMA respuesta de una sesión sin completar',
  Number(porClave.ticket_band.abandonos) === 1 &&
    Number(porClave.main_offer.abandonos) === 0 &&
    Number(porClave.rev_band.abandonos) === 0,
  JSON.stringify(caida.map((r) => `${r.clave}:${r.abandonos}`)),
);

check(
  'la mediana de segundos sale del hueco contra la respuesta anterior',
  Number(porClave.rev_band.mediana_segundos) === 60,
  `fue ${porClave.rev_band?.mediana_segundos}`,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · Qué supuestos no se creen\x1b[0m');

const { rows: supuestos } = await db.query(
  `select * from holaamigo.supuestos_discutidos(now() - interval '90 days')`,
);

check(
  'solo aparece el supuesto que trae valor previo y posterior',
  supuestos.length === 1 && supuestos[0].supuesto === 'close_rate',
  JSON.stringify(supuestos),
);

check(
  'separa quién lo subió de quién lo bajó',
  Number(supuestos[0].subieron) === 1 && Number(supuestos[0].bajaron) === 1,
  JSON.stringify(supuestos[0]),
);

check(
  'cuenta organizaciones distintas, no ediciones',
  Number(supuestos[0].ediciones) === 2 && Number(supuestos[0].organizaciones) === 2,
  JSON.stringify(supuestos[0]),
);

// +66,7% y −50%: la mediana de los dos es +8,35%.
check(
  'el cambio mediano es un porcentaje relativo al valor previo',
  Math.abs(Number(supuestos[0].cambio_mediano_pct) - 8.4) < 0.2,
  `fue ${supuestos[0].cambio_mediano_pct}`,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Ventanas vacías\x1b[0m');

const { rows: vacio } = await db.query(
  `select * from holaamigo.embudo_inicial(now() + interval '1 day')`,
);
check('una ventana sin nadie devuelve las ocho etapas en cero, no un error', vacio.length === 8);
check(
  'y no divide por cero al calcular del_anterior',
  vacio.every((r) => Number(r.organizaciones) === 0 && r.del_anterior === null),
  JSON.stringify(vacio),
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mEl flujo inicial se puede medir: dónde se cae, en qué pregunta y qué número no se cree.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
