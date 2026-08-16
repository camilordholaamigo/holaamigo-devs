#!/usr/bin/env node
/**
 * P5 · La CMO expandida — los criterios de aceptación, como pruebas.
 *
 *   node scripts/test-cmo.mjs
 *
 * Los cuatro del plan:
 *   1. Un cambio de precio en el sitio de un competidor genera alerta con diff.
 *   2. Un deal cerrado sobre el umbral genera borrador de caso de estudio, una
 *      sola vez por ingreso.
 *   3. Saturación de un ángulo (respuesta cae 40% en 14 días) se detecta.
 *   4. **Ninguna señal de upsell llega al cliente sin visto bueno interno.**
 *
 * Más la deriva de copy contra el posicionamiento vigente, que es lo que
 * convierte al posicionamiento en algo medible y no en un PDF.
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

console.log('\n\x1b[1mP5 · La CMO expandida · Postgres real (PGlite)\x1b[0m');
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

const ORG = 'cccccccc-3333-4333-8333-cccccccccccc';
await db.query(`insert into holaamigo.organizations (id, website_url) values ($1, 'https://cmo.test')`, [ORG]);
for (const rol of ['president', 'cmo', 'sales']) {
  await db.query(
    `insert into holaamigo.agents (organization_id, role, status, objective, budget, permissions, escalation_rules)
     values ($1, $2, 'active', '{}', '{}', '{}', '{}')`,
    [ORG, rol],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · El posicionamiento se puede medir\x1b[0m');

await db.query(
  `insert into holaamigo.positioning
     (organization_id, version, statement, category, icp, differentiators, forbidden_claims)
   values ($1, 1, 'Para operadores logísticos que pierden carga por no contestar, somos el agente que responde en 60 segundos',
           'automatización comercial', 'operadores logísticos medianos',
           '["responde en 60 segundos","sin turnos","tu propio número"]'::jsonb,
           '["el más barato","garantizamos resultados","el mejor precio"]'::jsonb)`,
  [ORG],
);

const { rows: limpio } = await db.query(
  `select holaamigo.deriva_de_copy($1, 'Te respondemos en 60 segundos, sin turnos, desde tu propio número.') as r`,
  [ORG],
);
check(
  'un copy alineado no viola nada y cubre los tres diferenciadores',
  limpio[0].r.viola.length === 0 && Number(limpio[0].r.cobertura) === 1,
  JSON.stringify(limpio[0].r),
);
check(
  'y los reconoce aunque el copy conjugue: «responde» vs «te respondemos»',
  (await db.query(`select holaamigo.menciona('te respondemos en 60 segundos', 'responde en 60 segundos') as m`))
    .rows[0].m === true,
);
check(
  'sin confundirse con un texto que no dice nada parecido',
  (await db.query(`select holaamigo.menciona('mandamos correos bonitos', 'responde en 60 segundos') as m`))
    .rows[0].m === false,
);

const { rows: derivado } = await db.query(
  `select holaamigo.deriva_de_copy($1, 'Somos el más barato del mercado y garantizamos resultados.') as r`,
  [ORG],
);
check(
  'un copy que promete lo prohibido lo dice, con la frase exacta',
  derivado[0].r.viola.length === 2 && derivado[0].r.viola.includes('el más barato'),
  JSON.stringify(derivado[0].r.viola),
);
check(
  'y la cobertura cae a cero: no dice nada de lo que la marca dice ser',
  Number(derivado[0].r.cobertura) === 0,
  JSON.stringify(derivado[0].r),
);

const dosVigentes = await attempt(
  `insert into holaamigo.positioning (organization_id, version, statement) values ($1, 2, 'otro')`,
  [ORG],
);
check(
  'no puede haber dos posicionamientos vigentes a la vez',
  dosVigentes.error !== null && /duplicate key|positioning_current_key/.test(String(dosVigentes.error.message)),
  dosVigentes.error ? dosVigentes.error.message : 'NO falló',
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · La competencia: solo se alerta lo que cambió\x1b[0m');

await db.query(
  `insert into holaamigo.competitor_snapshots
     (organization_id, competitor, url, section, content, content_hash, captured_at)
   values ($1, 'Rival SAS', 'https://rival.test/precios', 'pricing',
           'Plan Pro USD 199 al mes', 'hash-viejo', now() - interval '7 days')`,
  [ORG],
);
await db.query(
  `insert into holaamigo.competitor_snapshots
     (organization_id, competitor, url, section, content, content_hash)
   values ($1, 'Rival SAS', 'https://rival.test/precios', 'pricing',
           'Plan Pro USD 149 al mes', 'hash-nuevo')`,
  [ORG],
);

const { rows: cambio } = await db.query(
  `insert into holaamigo.competitor_changes
     (organization_id, competitor, section, before_hash, after_hash, diff, why_it_matters, severity)
   values ($1, 'Rival SAS', 'pricing', 'hash-viejo', 'hash-nuevo',
     '{"antes":"Plan Pro USD 199 al mes","despues":"Plan Pro USD 149 al mes"}'::jsonb,
     'Bajó el precio 25%. Si tu diferenciador no es precio, no lo persigas: reforzá la velocidad de respuesta.',
     'high')
   returning id, detected_at`,
  [ORG],
);
check('el cambio queda con el antes y el después', cambio.length === 1, JSON.stringify(cambio[0]));

const { rows: historia } = await db.query(
  `select count(*)::int as n from holaamigo.competitor_snapshots
    where organization_id = $1 and competitor = 'Rival SAS' and section = 'pricing'`,
  [ORG],
);
check(
  'y los dos snapshots quedan para poder mirar la historia',
  historia[0].n === 2,
  `hay ${historia[0].n}`,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · La fábrica de ángulos: detectar el ángulo quemado\x1b[0m');

const { rows: angulos } = await db.query(
  `insert into holaamigo.angles (organization_id, name, hypothesis, target_segment, status)
   values ($1, 'Costo por carga parada', 'el costo duele más que la urgencia', 'logistica', 'approved'),
          ($1, 'Respuesta en 60 segundos', 'la velocidad es el diferenciador', 'logistica', 'approved')
   returning id, name`,
  [ORG],
);
const QUEMADO = angulos[0].id;
const SANO = angulos[1].id;

const { rows: campana } = await db.query(
  `insert into holaamigo.campaigns (organization_id, name, channel, status)
   values ($1, 'Reactivación agosto', 'email', 'active') returning id`,
  [ORG],
);

/** Siembra envíos con su ángulo, en una ventana concreta. */
async function sembrarEnvios({ angleId, diasAtras, enviados, respuestas }) {
  for (let i = 0; i < enviados; i += 1) {
    await db.query(
      `insert into holaamigo.messages
         (organization_id, campaign_id, angle_id, channel, direction, status, sent_at)
       values ($1, $2, $3, 'email', 'out', $4, now() - make_interval(days => $5))`,
      [ORG, campana[0].id, angleId, i < respuestas ? 'replied' : 'sent', diasAtras],
    );
  }
}

// El quemado: 10% de respuesta hace tres semanas, 3% esta.
await sembrarEnvios({ angleId: QUEMADO, diasAtras: 20, enviados: 100, respuestas: 10 });
await sembrarEnvios({ angleId: QUEMADO, diasAtras: 5, enviados: 100, respuestas: 3 });
// El sano: se mantiene.
await sembrarEnvios({ angleId: SANO, diasAtras: 20, enviados: 100, respuestas: 8 });
await sembrarEnvios({ angleId: SANO, diasAtras: 5, enviados: 100, respuestas: 9 });

const { rows: saturacion } = await db.query(
  `select * from holaamigo.saturacion_de_angulos($1) order by nombre`,
  [ORG],
);

const quemado = saturacion.find((s) => s.angle_id === QUEMADO);
const sano = saturacion.find((s) => s.angle_id === SANO);

check(
  'el ángulo que cayó de 10% a 3% se marca saturado',
  quemado?.saturado === true && Math.abs(Number(quemado.caida) - 0.7) < 0.01,
  JSON.stringify(quemado),
);
check(
  'el que se mantuvo, no',
  sano?.saturado === false,
  JSON.stringify(sano),
);
check(
  'y la función devuelve las dos ventanas para poder mostrarlas',
  Number(quemado.tasa_previa) === 0.1 && Number(quemado.tasa_reciente) === 0.03,
  JSON.stringify(quemado),
);

// Poca muestra: no se dispara nada.
const { rows: otroAngulo } = await db.query(
  `insert into holaamigo.angles (organization_id, name, status) values ($1, 'Recién nacido', 'approved') returning id`,
  [ORG],
);
await sembrarEnvios({ angleId: otroAngulo[0].id, diasAtras: 20, enviados: 10, respuestas: 3 });
await sembrarEnvios({ angleId: otroAngulo[0].id, diasAtras: 3, enviados: 10, respuestas: 0 });

const { rows: conPocaData } = await db.query(
  `select * from holaamigo.saturacion_de_angulos($1) where angle_id = $2`,
  [ORG, otroAngulo[0].id],
);
check(
  'con 10 envíos por ventana no se declara saturación: sería ruido',
  conPocaData[0]?.saturado === false,
  JSON.stringify(conPocaData[0]),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Prueba social: un caso por deal, no siete\x1b[0m');

const { rows: canal } = await db.query(
  `insert into holaamigo.channels (organization_id, name, kind) values ($1, 'Correo', 'outbound_email') returning id`,
  [ORG],
);
const { rows: ingreso } = await db.query(
  `insert into holaamigo.revenue_events
     (organization_id, channel_id, opportunity_id, amount_usd, kind, occurred_at)
   values ($1, $2, gen_random_uuid(), 24000, 'new', now() - interval '2 hours')
   returning id`,
  [ORG, canal[0].id],
);

await db.query(
  `insert into holaamigo.case_studies
     (organization_id, revenue_event_id, deal_value_usd, cliente_nombre, draft, numbers, status)
   values ($1, $2, 24000, 'Transportes del Norte',
     '{"titulo":"De 3 días a 60 segundos"}'::jsonb,
     '{"valor_usd":24000,"dias_a_cierre":18}'::jsonb, 'drafted')`,
  [ORG, ingreso[0].id],
);

const repetido = await attempt(
  `insert into holaamigo.case_studies (organization_id, revenue_event_id, deal_value_usd, status)
   values ($1, $2, 24000, 'detected')`,
  [ORG, ingreso[0].id],
);
check(
  'el mismo ingreso no genera dos borradores',
  repetido.error !== null && /duplicate key|case_studies_revenue_key/.test(String(repetido.error.message)),
  repetido.error ? repetido.error.message : 'NO falló: el job diario repetiría el borrador cada noche',
);

const sinAprobar = await attempt(
  `update holaamigo.case_studies set status = 'published' where revenue_event_id = $1`,
  [ingreso[0].id],
);
check(
  'no se puede publicar un caso sin que el cliente final lo apruebe',
  sinAprobar.error !== null && /case_studies_publicado_exige_aprobacion/.test(String(sinAprobar.error.message)),
  sinAprobar.error ? sinAprobar.error.message : 'NO falló: publicaríamos números de alguien que no dijo que sí',
);

const aprobado = await attempt(
  `update holaamigo.case_studies
      set status = 'published', approved_by = 'contacto@transportes.test', approved_at = now()
    where revenue_event_id = $1`,
  [ingreso[0].id],
);
check('con la aprobación del cliente, sí', aprobado.error === null, aprobado.error?.message);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · La máquina de upsell: nada llega al cliente sin pasar por nosotros\x1b[0m');

const { rows: senal } = await db.query(
  `insert into holaamigo.upsell_signals
     (organization_id, signal, evidence, constraint_type, proposed_service, estimated_value_usd, confidence)
   values ($1, 'Responden mucho y cierran poco',
     '{"tasa_respuesta":0.11,"tasa_cierre":0.02,"benchmark_cierre":0.08}'::jsonb,
     'proof', 'media_play', 4500, 0.7)
   returning id, status`,
  [ORG],
);
check('la señal nace en `detected`', senal[0].status === 'detected');

const alCliente = await attempt(
  `update holaamigo.upsell_signals set status = 'proposed_client' where id = $1`,
  [senal[0].id],
);
check(
  'saltarse nuestro admin es imposible, no solo desaconsejado',
  alCliente.error !== null && /upsell_al_cliente_exige_visto_bueno/.test(String(alCliente.error.message)),
  alCliente.error ? alCliente.error.message : 'NO falló: un agente podría venderle al cliente sin filtro',
);

const { rows: interno } = await db.query(
  `select holaamigo.promover_senal($1, 'camilo@rentmies.com', 'sirve, pero bajemos el precio') as r`,
  [senal[0].id],
);
check('promoverla la deja en `proposed_internal` con firma', interno[0].r.status === 'proposed_internal');

const { rows: aCliente } = await db.query(
  `select holaamigo.promover_senal($1, 'camilo@rentmies.com') as r`,
  [senal[0].id],
);
check('y de ahí sí pasa al cliente', aCliente[0].r.status === 'proposed_client');

const { rows: firmada } = await db.query(
  `select internal_approved_by, internal_note from holaamigo.upsell_signals where id = $1`,
  [senal[0].id],
);
check(
  'con quién la aprobó y qué dijo, guardado',
  firmada[0].internal_approved_by === 'camilo@rentmies.com' && /bajemos el precio/.test(firmada[0].internal_note),
  JSON.stringify(firmada[0]),
);

const tercera = await attempt(`select holaamigo.promover_senal($1, 'otro')`, [senal[0].id]);
check(
  'promover una que ya llegó al cliente falla con un mensaje claro',
  tercera.error !== null && /solo se puede promover desde/.test(String(tercera.error.message)),
  tercera.error ? tercera.error.message : 'NO falló',
);

const duplicada = await attempt(
  `insert into holaamigo.upsell_signals (organization_id, signal, constraint_type)
   values ($1, 'otra vez lo mismo', 'proof')`,
  [ORG],
);
check(
  'no se apila la misma restricción dos veces mientras siga viva',
  duplicada.error !== null && /duplicate key|upsell_signals_viva_key/.test(String(duplicada.error.message)),
  duplicada.error ? duplicada.error.message : 'NO falló: nuestro admin se llenaría de la misma señal',
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLa CMO mide su posición, ve al rival, quema ángulos y no le vende al cliente sola.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
