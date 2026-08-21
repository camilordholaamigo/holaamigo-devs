#!/usr/bin/env node
/**
 * El agente de agendamiento — los criterios de aceptación, como pruebas.
 *
 *   node scripts/test-agente-agendamiento.mjs
 *
 * Lo que tiene que ser cierto para que el agente que sale del diagnóstico sea
 * defendible:
 *
 *   1. Un solo playbook vigente por organización, y compilar de nuevo retira el
 *      anterior en la misma transacción — nunca hay un instante sin guion.
 *   2. La versión la calcula la base. Dos compilaciones no producen la v2 dos
 *      veces.
 *   3. Un playbook activo sin escalamiento o sin calificación NO se puede
 *      guardar. La correa está en la base, no en el compilador.
 *   4. Una conversación no se cierra como agendada sin la cita que la cerró.
 *   5. Un lead no puede tener dos conversaciones abiertas.
 *   6. El embudo del setter cuenta el escalón MÁS ALTO alcanzado, no el actual,
 *      y excluye el simulador.
 *   7. Las capacidades nuevas están en el catálogo con su techo, y el motor de
 *      permisos las respeta.
 *   8. El embudo inicial tiene los dos escalones nuevos del agente.
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

/** Corre algo que DEBE fallar. Devuelve el mensaje, o null si no falló. */
async function debeFallar(db, sql) {
  try {
    await db.exec(sql);
    return null;
  } catch (err) {
    return err.message;
  }
}

const db = new PGlite();

await db.exec(`
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`);

console.log('\n\x1b[1mAgente de agendamiento · contra Postgres real (PGlite)\x1b[0m');
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
// Siembra
// ═══════════════════════════════════════════════════════════════════════════

const ORG = 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa';
const OTRA = 'bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb';
const LEAD = 'cccccccc-7777-4777-8777-cccccccccccc';

await db.exec(`
  -- domain es una columna generada desde website_url: no se inserta.
  insert into holaamigo.organizations (id, name, website_url)
  values ('${ORG}', 'Ejemplo', 'https://ejemplo.co'),
         ('${OTRA}', 'Otra', 'https://otra.co')
  on conflict (id) do nothing;

  insert into holaamigo.leads (id, organization_id, full_name, phone_e164)
  values ('${LEAD}', '${ORG}', 'Contacto', '+573001112233')
  on conflict (id) do nothing;
`);

const GUION_VALIDO = `
  '{"preguntas":[{"campo":"dolor","pregunta":"¿Qué te está costando?"}],"minimo_para_agendar":3}'::jsonb,
  '{"disparadores":["pregunta de precio fuera de rango"],"sla_minutos":30}'::jsonb
`;

async function insertarPlaybook(org, extra = '') {
  await db.exec(`
    insert into holaamigo.agent_playbooks
      (organization_id, calificacion, escalamiento ${extra ? ', ' + extra.split('=')[0] : ''})
    values ('${org}', ${GUION_VALIDO} ${extra ? ', ' + extra.split('=')[1] : ''});
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · Un solo playbook vigente, y la versión la pone la base\x1b[0m');

await insertarPlaybook(ORG);
await insertarPlaybook(ORG);
await insertarPlaybook(ORG);

const vigentes = await db.query(
  `select count(*)::int as n from holaamigo.agent_playbooks
   where organization_id = $1 and is_current`,
  [ORG],
);
check('queda exactamente uno vigente después de tres compilaciones', vigentes.rows[0].n === 1);

const versiones = await db.query(
  `select version, is_current, status from holaamigo.agent_playbooks
   where organization_id = $1 order by version`,
  [ORG],
);
check(
  'las versiones son 1, 2 y 3 sin repetirse',
  JSON.stringify(versiones.rows.map((r) => r.version)) === '[1,2,3]',
  JSON.stringify(versiones.rows.map((r) => r.version)),
);
check(
  'las anteriores quedaron `retired`, no `active` colgando',
  versiones.rows.slice(0, 2).every((r) => r.status === 'retired' && !r.is_current),
);

const otraOrg = await db.query(
  `select count(*)::int as n from holaamigo.agent_playbooks where organization_id = $1`,
  [OTRA],
);
check('retirar el de una organización no toca el de otra', otraOrg.rows[0].n === 0);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · La correa está en la base, no en el compilador\x1b[0m');

const sinEscalamiento = await debeFallar(
  db,
  `insert into holaamigo.agent_playbooks (organization_id, calificacion, escalamiento)
   values ('${OTRA}',
     '{"preguntas":[{"campo":"dolor","pregunta":"¿Qué te cuesta?"}]}'::jsonb,
     '{"disparadores":[]}'::jsonb);`,
);
check(
  'un playbook activo sin disparadores de escalamiento se rechaza',
  Boolean(sinEscalamiento) && /playbook_escala_algo/.test(sinEscalamiento),
  sinEscalamiento ?? 'lo aceptó',
);

const sinCalificacion = await debeFallar(
  db,
  `insert into holaamigo.agent_playbooks (organization_id, calificacion, escalamiento)
   values ('${OTRA}',
     '{"preguntas":[]}'::jsonb,
     '{"disparadores":["legal"]}'::jsonb);`,
);
check(
  'un playbook activo sin preguntas de calificación se rechaza',
  Boolean(sinCalificacion) && /playbook_califica/.test(sinCalificacion),
  sinCalificacion ?? 'lo aceptó',
);

// Un borrador sí puede estar incompleto: es lo que permite guardar a mitad.
await db.exec(`
  insert into holaamigo.agent_playbooks (organization_id, status, is_current, calificacion, escalamiento)
  values ('${OTRA}', 'draft', false, '{"preguntas":[]}'::jsonb, '{"disparadores":[]}'::jsonb);
`);
const borradores = await db.query(
  `select count(*)::int as n from holaamigo.agent_playbooks
   where organization_id = $1 and status = 'draft'`,
  [OTRA],
);
check('un borrador incompleto sí se puede guardar', borradores.rows[0].n === 1);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · playbook_vigente() es la única definición de "vigente"\x1b[0m');

const vigente = await db.query(`select * from holaamigo.playbook_vigente($1)`, [ORG]);
check('devuelve el de la versión más alta', vigente.rows[0]?.version === 3);
check('y solo uno', vigente.rows.length === 1);

const vacio = await db.query(`select * from holaamigo.playbook_vigente($1)`, [OTRA]);
check(
  'una organización con solo borradores no tiene playbook vigente',
  vacio.rows.length === 0 || !vacio.rows[0]?.id,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · Cerrar una conversación exige motivo, y la cita si agendó\x1b[0m');

const playbookId = vigente.rows[0].id;

await db.exec(`
  insert into holaamigo.conversations (id, organization_id, lead_id, playbook_id, stage, turns)
  values ('dddddddd-7777-4777-8777-dddddddddddd', '${ORG}', '${LEAD}', '${playbookId}', 'oferta_de_cita', 4);
`);

const sinCita = await debeFallar(
  db,
  `select holaamigo.cerrar_conversacion(
     'dddddddd-7777-4777-8777-dddddddddddd'::uuid, 'booked', 'agendó');`,
);
check(
  'no se cierra como agendada sin la cita que la cerró',
  Boolean(sinCita) && /sin la cita/.test(sinCita),
  sinCita ?? 'lo aceptó',
);

const estadoInvalido = await debeFallar(
  db,
  `select holaamigo.cerrar_conversacion(
     'dddddddd-7777-4777-8777-dddddddddddd'::uuid, 'inventado', 'x');`,
);
check('un estado de cierre inventado se rechaza', Boolean(estadoInvalido));

await db.exec(`
  select holaamigo.cerrar_conversacion(
    'dddddddd-7777-4777-8777-dddddddddddd'::uuid, 'escalated', 'preguntó por habeas data');
`);
const cerrada = await db.query(
  `select status, stage, escalation_reason, closed_at
   from holaamigo.conversations where id = 'dddddddd-7777-4777-8777-dddddddddddd'`,
);
check('escalar deja el motivo y la fecha de cierre', Boolean(cerrada.rows[0].closed_at));
check(
  'y el motivo queda en `escalation_reason`, no solo en `closed_reason`',
  cerrada.rows[0].escalation_reason === 'preguntó por habeas data',
);
check('el escalón pasa a `cerrado`', cerrada.rows[0].stage === 'cerrado');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · Dos agentes no le escriben a la misma persona\x1b[0m');

await db.exec(`
  insert into holaamigo.conversations (id, organization_id, lead_id, status)
  values ('eeeeeeee-7777-4777-8777-eeeeeeeeeeee', '${ORG}', '${LEAD}', 'open');
`);

const dobleAbierta = await debeFallar(
  db,
  `insert into holaamigo.conversations (organization_id, lead_id, status)
   values ('${ORG}', '${LEAD}', 'open');`,
);
check(
  'un lead no puede tener dos conversaciones abiertas',
  Boolean(dobleAbierta) && /conversations_lead_abierta_key/.test(dobleAbierta),
  dobleAbierta ?? 'lo aceptó',
);
check(
  'pero sí una abierta y varias cerradas',
  (
    await db.query(
      `select count(*)::int as n from holaamigo.conversations where lead_id = $1`,
      [LEAD],
    )
  ).rows[0].n === 2,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m6 · El embudo cuenta el escalón más alto alcanzado\x1b[0m');

await db.exec(`
  insert into holaamigo.conversations (organization_id, channel, status, stage, turns) values
    -- Agendó: pasó por todos los escalones aunque su stage diga confirmado.
    ('${ORG}', 'whatsapp', 'booked',   'confirmado',     8),
    -- Llegó a que le propusiéramos horario y se cayó ahí.
    ('${ORG}', 'whatsapp', 'no_reply', 'oferta_de_cita', 5),
    -- Se cayó calificando.
    ('${ORG}', 'whatsapp', 'closed',   'calificacion',   3),
    -- Nunca contestó.
    ('${ORG}', 'whatsapp', 'no_reply', 'apertura',       1),
    -- El simulador NO cuenta: es el cliente probando, no un contacto real.
    ('${ORG}', 'simulador','booked',   'confirmado',     6);
`);

const embudo = await db.query(`select * from holaamigo.embudo_del_setter($1) order by orden`, [
  ORG,
]);
const porEtapa = Object.fromEntries(embudo.rows.map((r) => [r.orden, Number(r.conversaciones)]));

// 6 reales: la escalada y la abierta de las secciones anteriores + las 4 de acá.
// El simulador es la séptima y no cuenta.
check('el simulador queda fuera del embudo', porEtapa[1] === 6, JSON.stringify(porEtapa));
check(
  'contestaron = las que tienen más de un turno',
  porEtapa[2] === 4,
  `esperaba 4, vino ${porEtapa[2]}`,
);
// Las cuatro que pasaron de calificación: la que agendó (confirmado), la que se
// cayó en oferta_de_cita, la que se cayó calificando, y —la que importa— la que
// escaló DESPUÉS de haber llegado a oferta_de_cita. Esa última es la que el
// embudo perdía cuando leía `stage` en vez de `stage_alcanzado`.
check(
  'la que escaló sigue contando por donde llegó, no por donde quedó',
  porEtapa[3] === 4,
  `esperaba 4, vino ${porEtapa[3]}`,
);
check(
  'y la que agendó cuenta en todos los escalones que atravesó',
  porEtapa[4] === 3,
  `esperaba 3 (confirmado + oferta_de_cita + la escalada), vino ${porEtapa[4]}`,
);
check('agendaron = 1', porEtapa[5] === 1, `vino ${porEtapa[5]}`);

const primera = embudo.rows.find((r) => r.orden === 1);
check('la primera etapa no tiene porcentaje del anterior', primera.del_anterior === null);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m7 · Las capacidades nuevas y sus techos\x1b[0m');

const caps = await db.query(
  `select id, agent_role, risk_class, platform_ceiling, default_level
   from holaamigo.capabilities
   where id in ('playbook.compile','knowledge.index','setter.simulate','meeting.offer_slots')
   order by id`,
);
check('las cuatro capacidades están en el catálogo', caps.rows.length === 4, JSON.stringify(caps.rows));

const porId = Object.fromEntries(caps.rows.map((r) => [r.id, r]));
check(
  'compilar e indexar son `write`: producen objetos propios, no salen del edificio',
  porId['playbook.compile']?.risk_class === 'write' && porId['knowledge.index']?.risk_class === 'write',
);
check(
  'proponer horarios es `read` y simular también: no tocan a un tercero',
  porId['meeting.offer_slots']?.risk_class === 'read' && porId['setter.simulate']?.risk_class === 'read',
);
check(
  'ninguna nace por encima de su techo de plataforma',
  caps.rows.every((r) => r.default_level <= r.platform_ceiling),
);

// El motor de permisos las respeta de verdad, no solo el catálogo.
const auth = await db.query(
  `select holaamigo.autorizar($1::uuid, 'playbook.compile', '{}'::jsonb) as v`,
  [ORG],
);
const veredicto = auth.rows[0].v;
// El techo del plan `diagnostico` es L2 y frenaba esto: compilar terminaba en
// una tarjeta de aprobación por cada build. Desde 0013 el plan solo gobierna lo
// que sale del edificio, así que una capacidad `write` sobre objetos propios
// corre libre. Ver el bloque 11 de la migración.
check(
  'un cliente del plan gratis puede compilar su guion sin pedir permiso',
  veredicto.accion_permitida === 'ejecutar' && !veredicto.requires_approval,
  JSON.stringify(veredicto),
);

const authFirma = await db.query(
  `select holaamigo.autorizar($1::uuid, 'partnership.commit', '{}'::jsonb) as v`,
  [ORG],
);
check(
  'y sigue sin dejar firmar nada, que es el control que no se puede encender',
  authFirma.rows[0].v.accion_permitida === 'nada',
);

// Lo que NO se aflojó: mandarle un WhatsApp a una persona real sigue topado por
// el plan. Si esta comprobación se cae, el cambio del techo se fue de rango.
const authEnviar = await db.query(
  `select holaamigo.autorizar($1::uuid, 'outreach.reply', '{}'::jsonb) as v`,
  [ORG],
);
check(
  'pero contestarle a una persona real sigue topado por el plan gratis',
  authEnviar.rows[0].v.accion_permitida !== 'ejecutar',
  JSON.stringify(authEnviar.rows[0].v),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m8 · Las habilidades del setter están encendidas para SALES\x1b[0m');

const habilidades = await db.query(`select * from holaamigo.habilidades_activas($1, 'sales')`, [ORG]);
const ids = habilidades.rows.map((r) => r.skill_id);
for (const esperada of ['agenda.consultar', 'kb.buscar', 'crm.registrar_calificacion']) {
  check(`${esperada} está disponible`, ids.includes(esperada), JSON.stringify(ids));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m9 · El embudo inicial mide los escalones nuevos\x1b[0m');

await db.exec(`
  insert into holaamigo.plg_events (organization_id, event) values
    ('${ORG}', 'landing_submit'),
    ('${ORG}', 'quiz_started'),
    ('${ORG}', 'quiz_completed'),
    ('${ORG}', 'diagnostic_viewed'),
    ('${ORG}', 'playbook_compiled'),
    ('${ORG}', 'agent_tested'),
    ('${OTRA}', 'landing_submit'),
    ('${OTRA}', 'quiz_started');
`);

const inicial = await db.query(`select * from holaamigo.embudo_inicial(now() - interval '1 day')`);
const etapas = inicial.rows.map((r) => r.etapa);
check(
  'aparecen "Armó su agente" y "Habló con su agente"',
  etapas.includes('Armó su agente') && etapas.includes('Habló con su agente'),
  JSON.stringify(etapas),
);

const armo = inicial.rows.find((r) => r.etapa === 'Armó su agente');
const hablo = inicial.rows.find((r) => r.etapa === 'Habló con su agente');
check('una de las dos organizaciones armó su agente', Number(armo.organizaciones) === 1);
check('y esa misma habló con él', Number(hablo.organizaciones) === 1);
check(
  'el orden no se rompió: "Conectó canal o cargó base" sigue al final',
  inicial.rows.at(-1).etapa === 'Conectó canal o cargó base',
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m10 · La base de conocimiento: una vigente por organización\x1b[0m');

await db.exec(`
  insert into holaamigo.knowledge_bases (organization_id, external_id, status)
  values ('${ORG}', 'vs_uno', 'ready'), ('${ORG}', 'vs_dos', 'ready');
`);
const kbs = await db.query(
  `select external_id, is_current from holaamigo.knowledge_bases
   where organization_id = $1 order by created_at`,
  [ORG],
);
check('la anterior se retira sola al indexar de nuevo', kbs.rows.filter((r) => r.is_current).length === 1);
check('y la vigente es la última', kbs.rows.find((r) => r.is_current).external_id === 'vs_dos');

// ═══════════════════════════════════════════════════════════════════════════

console.log('');
if (failures > 0) {
  console.log(`\x1b[31m\x1b[1m${failures} comprobación(es) fallaron.\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32m\x1b[1mEl agente de agendamiento se sostiene contra Postgres real.\x1b[0m\n');
