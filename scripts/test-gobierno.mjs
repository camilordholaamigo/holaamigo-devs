#!/usr/bin/env node
/**
 * P2 · Gobierno — los criterios de aceptación, como pruebas que corren.
 *
 *   node scripts/test-gobierno.mjs
 *
 * Los cuatro del plan:
 *   1. Intentar `partnership.commit` da `blocked` sin importar la configuración.
 *   2. Subir el techo del cliente por encima del de plataforma no tiene efecto.
 *   3. Una acción irreversible con grant L5 se ejecuta como L4 y queda `downgraded`.
 *   4. Un sobre violado (el 11º outreach de la semana) bloquea y genera tarjeta.
 *
 * Más lo que sostiene a esos cuatro: el techo de plan, el fallo cerrado ante una
 * capacidad desconocida, y el vencimiento fail-safe / fail-open de las tarjetas.
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

console.log('\n\x1b[1mP2 · Gobierno · Postgres real (PGlite)\x1b[0m');
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

const { rows: catalogo } = await db.query('select count(*)::int as n from holaamigo.capabilities');
check('el catálogo quedó sembrado', catalogo[0].n >= 25, `hay ${catalogo[0].n}`);

// ── Dos organizaciones: una enterprise y una starter ─────────────────────────
const ENTERPRISE = '77777777-7777-7777-7777-777777777777';
const STARTER = '88888888-8888-8888-8888-888888888888';

for (const [id, plan, dominio] of [
  [ENTERPRISE, 'enterprise', 'https://enterprise.test'],
  [STARTER, 'starter', 'https://starter.test'],
]) {
  await db.query(`insert into holaamigo.organizations (id, website_url, plan) values ($1, $2, $3)`, [
    id, dominio, plan,
  ]);
  for (const rol of ['president', 'cmo', 'sales']) {
    await db.query(
      `insert into holaamigo.agents (organization_id, role, status, objective, budget, permissions, escalation_rules, autonomy)
       values ($1, $2, 'active', '{}', '{}', '{}', '{}', 'auto_within_limits')`,
      [id, rol],
    );
  }
}

/** Llama al motor y devuelve el veredicto. */
async function autorizar(org, capability, payload = {}, opts = {}) {
  const { rows } = await db.query(
    'select holaamigo.autorizar($1, $2, $3::jsonb, null, $4, $5) as r',
    [org, capability, JSON.stringify(payload), opts.registrar ?? true, opts.titulo ?? null],
  );
  return rows[0].r;
}

async function otorgar(org, capability, level, envelope = null) {
  await db.query(
    `insert into holaamigo.capability_grants
       (organization_id, capability_id, granted_level, envelope, granted_by, granted_by_type)
     values ($1, $2, $3, coalesce($4::jsonb, '{}'::jsonb), 'prueba', 'client')
     on conflict (organization_id, capability_id) do update
       set granted_level = excluded.granted_level, envelope = excluded.envelope`,
    [org, capability, level, envelope ? JSON.stringify(envelope) : null],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m1 · Lo prohibido es prohibido, se configure lo que se configure\x1b[0m');

await otorgar(ENTERPRISE, 'partnership.commit', 5);

const { rows: guardado } = await db.query(
  `select granted_level from holaamigo.capability_grants
   where organization_id = $1 and capability_id = 'partnership.commit'`,
  [ENTERPRISE],
);
check(
  'otorgar L5 sobre una capacidad prohibida se recorta a 0 al escribir',
  guardado[0].granted_level === 0,
  `quedó en ${guardado[0].granted_level}`,
);

const commit = await autorizar(ENTERPRISE, 'partnership.commit', { amount_usd: 0 });
check(
  'firmar una alianza da `blocked` en el plan más alto y con todo otorgado',
  commit.verdict === 'blocked' && commit.effective_level === 0,
  JSON.stringify(commit),
);
check(
  'y la acción permitida es «nada»: ni siquiera se prepara',
  commit.accion_permitida === 'nada' && commit.requires_approval === false,
  JSON.stringify(commit),
);

const desconocida = await autorizar(ENTERPRISE, 'partnership.firmar_todo');
check(
  'una capacidad que no existe falla CERRADA',
  desconocida.verdict === 'blocked' && /desconocida/.test(desconocida.reason ?? ''),
  JSON.stringify(desconocida),
);

const { rows: auditoria } = await db.query(
  `select count(*)::int as n from holaamigo.guard_events
   where organization_id = $1 and verdict = 'blocked'`,
  [ENTERPRISE],
);
check('los dos intentos bloqueados quedaron en la auditoría', auditoria[0].n === 2, `hay ${auditoria[0].n}`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m2 · El techo de plataforma le gana al del cliente\x1b[0m');

await otorgar(ENTERPRISE, 'partnership.send_outreach', 5);
const { rows: recortado } = await db.query(
  `select granted_level from holaamigo.capability_grants
   where organization_id = $1 and capability_id = 'partnership.send_outreach'`,
  [ENTERPRISE],
);
check(
  'pedir L5 sobre una capacidad con techo L4 se guarda como L4',
  recortado[0].granted_level === 4,
  `quedó en ${recortado[0].granted_level}`,
);

const outreach = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  volume: 1,
  discloses_agent: true,
  reversibility_hours: 0,
});
check(
  'y el nivel efectivo nunca pasa de 4',
  outreach.effective_level === 4 && outreach.ceilings.platform === 4,
  JSON.stringify(outreach),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m3 · El techo del plan\x1b[0m');

await otorgar(STARTER, 'partnership.send_outreach', 4);
const starter = await autorizar(STARTER, 'partnership.send_outreach', { discloses_agent: true });
check(
  'en plan starter, el mismo grant L4 se ejecuta como L3',
  starter.effective_level === 3 && starter.verdict === 'downgraded',
  JSON.stringify(starter),
);
check(
  'y pasa a exigir visto bueno ítem por ítem',
  starter.requires_approval === true && starter.accion_permitida === 'ejecutar_con_visto_bueno',
  JSON.stringify(starter),
);
check(
  'el motivo dice cuál techo mandó',
  /plan starter/.test(starter.reason ?? ''),
  starter.reason ?? 'sin motivo',
);

// El plan `diagnostico` ni siquiera alcanza el mínimo de la capacidad.
await db.query(`update holaamigo.organizations set plan = 'diagnostico' where id = $1`, [STARTER]);
const sinPlan = await autorizar(STARTER, 'partnership.send_outreach', { discloses_agent: true });
check(
  'por debajo del plan mínimo de la capacidad, queda en 0',
  sinPlan.effective_level === 0 && sinPlan.verdict === 'blocked',
  JSON.stringify(sinPlan),
);
await db.query(`update holaamigo.organizations set plan = 'starter' where id = $1`, [STARTER]);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m4 · La regla maestra de reversibilidad\x1b[0m');

// `outreach.reply` tiene techo de plataforma 5. Para llegar a L5 hace falta la
// autonomía `sampled`, que solo abre un operador.
await db.query(
  `update holaamigo.agents set autonomy = 'sampled' where organization_id = $1 and role = 'sales'`,
  [ENTERPRISE],
);
await otorgar(ENTERPRISE, 'outreach.reply', 5, { max_volume_per_day: 500 });

const reversible = await autorizar(ENTERPRISE, 'outreach.reply', {
  reversibility_hours: 2,
  discloses_agent: true,
});
check(
  'una acción reversible con grant L5 se ejecuta en L5, sin pedir permiso',
  reversible.effective_level === 5 && reversible.verdict === 'allowed' && reversible.requires_approval === false,
  JSON.stringify(reversible),
);

const irreversible = await autorizar(ENTERPRISE, 'outreach.reply', {
  reversibility_hours: 72,
  discloses_agent: true,
});
check(
  'la MISMA capacidad, con una acción que tarda 72 h en deshacerse, baja a L4',
  irreversible.effective_level === 4 && irreversible.verdict === 'downgraded',
  JSON.stringify(irreversible),
);
check(
  'y el motivo lo dice con el número',
  /72 h/.test(irreversible.reason ?? ''),
  irreversible.reason ?? 'sin motivo',
);
check(
  'pero sigue ejecutándose sola: L4 es "dentro del sobre", no "pide permiso"',
  irreversible.requires_approval === false && irreversible.accion_permitida === 'ejecutar',
  JSON.stringify(irreversible),
);

const { rows: degradado } = await db.query(
  `select verdict, requested_level, effective_level from holaamigo.guard_events
   where capability_id = 'outreach.reply' order by id desc limit 1`,
);
check(
  'la auditoría lo registra como `downgraded`, con nivel pedido y nivel real',
  degradado[0].verdict === 'downgraded' && degradado[0].requested_level === 5 && degradado[0].effective_level === 4,
  JSON.stringify(degradado[0]),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m5 · El sobre: 10 por semana, y el 11º pide permiso\x1b[0m');

// La CMO en `auto_within_limits` y plan enterprise: L4, ejecuta dentro del sobre.
await db.query(
  `delete from holaamigo.guard_events where organization_id = $1 and capability_id = 'partnership.send_outreach'`,
  [ENTERPRISE],
);

let permitidos = 0;
for (let i = 0; i < 10; i += 1) {
  const r = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
    volume: 1,
    discloses_agent: true,
    counterparty_tags: ['empresas_b2b_latam'],
    reversibility_hours: 0,
  });
  if (r.verdict === 'allowed') permitidos += 1;
}
check('los primeros 10 acercamientos de la semana salen solos', permitidos === 10, `salieron ${permitidos}`);

const onceavo = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  volume: 1,
  discloses_agent: true,
  counterparty_tags: ['empresas_b2b_latam'],
  reversibility_hours: 0,
});
check(
  'el 11º queda bloqueado por el sobre',
  onceavo.verdict === 'blocked' && onceavo.envelope_violations.some((v) => v.rule === 'max_volume_per_week'),
  JSON.stringify(onceavo),
);
check(
  'y genera una tarjeta de aprobación',
  onceavo.requires_approval === true && Boolean(onceavo.approval_id),
  JSON.stringify(onceavo),
);

const { rows: tarjeta } = await db.query(
  `select kind, title, rationale, severity, expires_at, capability_id, payload
     from holaamigo.approvals where id = $1`,
  [onceavo.approval_id],
);
check(
  'la tarjeta dice de qué capacidad viene y cuándo vence',
  tarjeta[0].kind === 'envelope_exceeded' &&
    tarjeta[0].capability_id === 'partnership.send_outreach' &&
    tarjeta[0].expires_at !== null,
  JSON.stringify(tarjeta[0]),
);
check(
  'y la tarjeta lleva adentro qué límite se pasó',
  /max_volume_per_week/.test(JSON.stringify(tarjeta[0].payload)),
  JSON.stringify(tarjeta[0].payload),
);

// Las otras reglas del sobre, una por una.
const sinAviso = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  discloses_agent: false,
  counterparty_tags: ['empresas_b2b_latam'],
});
check(
  'un mensaje que no dice que lo escribe un agente se bloquea',
  sinAviso.envelope_violations.some((v) => v.rule === 'requires_disclosure'),
  JSON.stringify(sinAviso.envelope_violations),
);

const conCompromiso = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  discloses_agent: true,
  commitments: ['exclusividad'],
});
check(
  'prometer exclusividad se bloquea aunque quede cupo',
  conCompromiso.envelope_violations.some((v) => v.rule === 'forbidden_commitments'),
  JSON.stringify(conCompromiso.envelope_violations),
);

const competidor = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  discloses_agent: true,
  counterparty_tags: ['competidores_directos'],
});
check(
  'escribirle a un competidor directo se bloquea',
  competidor.envelope_violations.some((v) => v.rule === 'forbidden_counterparties'),
  JSON.stringify(competidor.envelope_violations),
);

const conPlata = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  discloses_agent: true,
  amount_usd: 500,
});
check(
  'comprometer USD 500 con un sobre de USD 0 se bloquea',
  conPlata.envelope_violations.some((v) => v.rule === 'max_amount_usd'),
  JSON.stringify(conPlata.envelope_violations),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m6 · Los niveles bajos producen trabajo, no silencio\x1b[0m');

const prepara = await autorizar(ENTERPRISE, 'partnership.negotiate', {});
check(
  'preparar un term sheet es L2: no envía, pero deja tarjeta',
  prepara.verdict === 'blocked' &&
    prepara.accion_permitida === 'preparar' &&
    prepara.requires_approval === true,
  JSON.stringify(prepara),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m6b · Una aprobación en la mano no pide otra\x1b[0m');

const { rows: aprobada } = await db.query(
  `insert into holaamigo.approvals (organization_id, kind, title, status, capability_id, decided_by, decided_at)
   values ($1, 'campaign_launch', 'Lanzar la campaña de reactivación', 'approved', 'campaign.launch', 'camilo@rentmies.com', now())
   returning id`,
  [STARTER],
);

const { rows: conAprobacion } = await db.query(
  'select holaamigo.autorizar($1, $2, $3::jsonb, null, true, null, null, $4) as r',
  [STARTER, 'campaign.launch', JSON.stringify({ volume: 400 }), aprobada[0].id],
);
check(
  'con la aprobación del cliente en la mano, la campaña se lanza sin pedir otra',
  conAprobacion[0].r.requires_approval === false && conAprobacion[0].r.accion_permitida === 'ejecutar',
  JSON.stringify(conAprobacion[0].r),
);

const { rows: cardsExtra } = await db.query(
  `select count(*)::int as n from holaamigo.approvals
    where organization_id = $1 and kind = 'campaign_launch' and status = 'pending'`,
  [STARTER],
);
check('y no se creó una segunda tarjeta', cardsExtra[0].n === 0, `hay ${cardsExtra[0].n}`);

const { rows: sinAprobacion } = await db.query(
  'select holaamigo.autorizar($1, $2, $3::jsonb) as r',
  [STARTER, 'campaign.launch', JSON.stringify({ volume: 400 })],
);
check(
  'sin ella, la misma campaña sí pide visto bueno',
  sinAprobacion[0].r.requires_approval === true && Boolean(sinAprobacion[0].r.approval_id),
  JSON.stringify(sinAprobacion[0].r),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m7 · Cuando el humano no contesta\x1b[0m');

await db.query(
  `insert into holaamigo.approvals (organization_id, kind, title, status, expires_at)
   values ($1, 'campaign_launch', 'Lanzar la campaña de agosto', 'pending', now() - interval '1 hour')`,
  [ENTERPRISE],
);
await db.query(
  `insert into holaamigo.approvals (organization_id, kind, title, status, expires_at)
   values ($1, 'pause_losing_campaign', 'Pausar la campaña que va perdiendo', 'pending', now() - interval '1 hour')`,
  [ENTERPRISE],
);

const { rows: vencidas } = await db.query('select holaamigo.expirar_aprobaciones() as r');
check(
  'lanzar una campaña sin respuesta NO se lanza (fail-safe)',
  vencidas[0].r.rechazadas >= 1,
  JSON.stringify(vencidas[0].r),
);
check(
  'pausar una campaña que pierde SÍ se ejecuta sin respuesta (fail-open)',
  vencidas[0].r.aprobadas === 1,
  JSON.stringify(vencidas[0].r),
);

const { rows: estados } = await db.query(
  `select kind, status, decided_by from holaamigo.approvals
    where decided_by = 'sistema:sla' order by kind`,
);
check(
  'y las dos quedan firmadas por el sistema, no por un humano fantasma',
  estados.every((e) => e.decided_by === 'sistema:sla'),
  JSON.stringify(estados),
);

const { rows: pendiente } = await db.query(
  `select count(*)::int as n from holaamigo.approvals
    where status = 'pending' and expires_at > now()`,
);
check('las tarjetas que aún no vencen siguen pendientes', pendiente[0].n >= 1, `hay ${pendiente[0].n}`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m8 · Investigar es libre\x1b[0m');

await db.query(
  `update holaamigo.agents set autonomy = 'propose' where organization_id = $1 and role = 'cmo'`,
  [ENTERPRISE],
);
const investigar = await autorizar(ENTERPRISE, 'partnership.research', {});
check(
  'con la CMO en «solo proponer», investigar sigue siendo L5',
  investigar.verdict === 'allowed' && investigar.effective_level === 5,
  JSON.stringify(investigar),
);

const enviarConPropose = await autorizar(ENTERPRISE, 'partnership.send_outreach', {
  discloses_agent: true,
});
check(
  'pero contactar a alguien cae a L1: propone y no ejecuta',
  enviarConPropose.effective_level === 1 && enviarConPropose.accion_permitida === 'proponer',
  JSON.stringify(enviarConPropose),
);

const brief = await autorizar(ENTERPRISE, 'brief.write', {});
check(
  'y escribir el Brief —trabajo interno— no lo toca el dial grueso',
  brief.verdict === 'allowed' && brief.effective_level === 5,
  JSON.stringify(brief),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m9 · Simular no ensucia la auditoría\x1b[0m');

const { rows: antes } = await db.query('select count(*)::int as n from holaamigo.guard_events');
await autorizar(ENTERPRISE, 'partnership.send_outreach', {}, { registrar: false });
const { rows: despues } = await db.query('select count(*)::int as n from holaamigo.guard_events');
check(
  'una autorización de simulacro no deja fila ni crea tarjetas',
  antes[0].n === despues[0].n,
  `${antes[0].n} → ${despues[0].n}`,
);

await db.close();

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mLa correa aguanta: lo prohibido no se abre, y lo abierto tiene límites.\x1b[0m\n'
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
