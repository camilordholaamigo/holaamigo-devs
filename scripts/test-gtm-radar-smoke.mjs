#!/usr/bin/env node

import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = join(root, 'supabase', 'migrations');
let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
};

const database = new PGlite();
await database.exec(`
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator; exception when duplicate_object then null; end $$;
`);
for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
  await database.exec(await readFile(join(migrations, file), 'utf8'));
}

console.log('\n\x1b[1mGTM Radar → Smoke Tester\x1b[0m');
const tables = await database.query(`select table_name from information_schema.tables where table_schema='holaamigo' and table_name like 'radar_smoke_%'`);
check('crea request, targets y outbox', tables.rows.length === 3);

let invalidPhone = false;
try {
  await database.query(`insert into holaamigo.radar_smoke_requests
    (connection_id, radar_variant_id, idempotency_key, body_hash, callback_url)
    values ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','run:test',repeat('a',64),'https://radar.example/callback')`);
  const request = await database.query(`select id from holaamigo.radar_smoke_requests limit 1`);
  await database.query(`insert into holaamigo.radar_smoke_request_targets
    (request_id,external_brand_id,brand_name,role,candidate_id,phone_e164,whatsapp_url,source_page_url,source_evidence_hash)
    values ($1,'33333333-3333-4333-8333-333333333333','Marca','primary','44444444-4444-4444-8444-444444444444','3001234567','https://wa.me/573001234567','https://marca.example',repeat('b',64))`, [request.rows[0].id]);
} catch { invalidPhone = true; }
check('rechaza teléfonos fuera de E.164', invalidPhone);

const accepted = await database.query(`select holaamigo.accept_radar_smoke_request(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','run:atomic',repeat('c',64),
  'https://radar.example/callback',
  '[{"brand_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","brand_name":"Marca","role":"primary","candidate_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","confirmed_organization_id":null,"phone_e164":"+573001234568","whatsapp_url":"https://wa.me/573001234568","source_page_url":"https://marca.example","evidence_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}]'::jsonb
) as result`);
const replay = await database.query(`select holaamigo.accept_radar_smoke_request(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','run:atomic',repeat('c',64),
  'https://radar.example/callback',
  '[{"brand_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","brand_name":"Marca","role":"primary","candidate_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","confirmed_organization_id":null,"phone_e164":"+573001234568","whatsapp_url":"https://wa.me/573001234568","source_page_url":"https://marca.example","evidence_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}]'::jsonb
) as result`);
check('aceptar la misma solicitud es idempotente y no duplica targets', accepted.rows[0].result.id === replay.rows[0].result.id && Number((await database.query(`select count(*) as n from holaamigo.radar_smoke_request_targets where request_id=$1`, [accepted.rows[0].result.id])).rows[0].n) === 1);

const firstReservation = await database.query(`select holaamigo.reserve_radar_smoke_target('+573001234569',null,'Marca','https://marca.example') as result`);
const secondReservation = await database.query(`select holaamigo.reserve_radar_smoke_target('+573001234569',null,'Marca','https://marca.example') as result`);
check('la reserva atómica aplica el enfriamiento incluso entre corridas concurrentes', firstReservation.rows[0].result.ready === true && secondReservation.rows[0].result.reason === 'cooldown');

const source = await readFile(join(root, 'lib', 'integrations', 'gtm-radar-smoke.ts'), 'utf8');
check('la batería primaria conserva servicio, faq y ventas', /\['servicio', 'faq', 'ventas'\]/.test(source));
check('la batería competidora usa solo servicio', /\['servicio'\]/.test(source));
check('el callback aplica una barrera explícita de datos sensibles', /assertNoSensitiveCallback\(body\)/.test(source));
check('la autenticación firma el cuerpo crudo', /timestamp\}\.\$\{idempotencyKey\}\.\$\{raw\}/.test(source));

if (failures) process.exit(1);
console.log('\nTodo bien.');
