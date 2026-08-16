#!/usr/bin/env node
/**
 * Prueba de humo del flujo completo, contra una instancia real.
 *
 *   node scripts/smoke.mjs                        # http://localhost:3000
 *   node scripts/smoke.mjs https://tu-deploy.app  # producción o preview
 *
 * Recorre exactamente lo que hace un cliente: landing → quiz → diagnóstico →
 * panel con los tres agentes. No usa mocks ni toca la base directamente; si
 * pasa, el producto funciona de punta a punta en esa URL.
 *
 * POR QUÉ EXISTE, y por qué es un script y no un test unitario: el bug que
 * dejó el quiz muerto (índice único parcial imposible de usar como árbitro de
 * un ON CONFLICT) era invisible para cualquier prueba con la base simulada. Se
 * necesitaba Postgres real contestando. La prueba que importa acá es
 * "¿avanzó la pregunta?", y solo se puede hacer end to end.
 *
 * El paso 3 es el corazón: exige que CADA respuesta cambie la pregunta. Si el
 * servidor devuelve dos veces la misma, el script falla — que es lo que el
 * producto debió hacer desde el principio en vez de quedarse quieto.
 */

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const HEALTH_KEY = process.env.CRON_SECRET ?? '';

let failures = 0;
const started = Date.now();

function ok(label, detail = '') {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[2m${detail}\x1b[0m` : ''}`);
}

function fail(label, detail = '') {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      \x1b[31m${detail}\x1b[0m` : ''}`);
}

function step(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function json(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* respuesta sin JSON */
  }
  return { status: response.status, ok: response.ok, body };
}

/** Una respuesta plausible para cualquier tipo de pregunta del quiz. */
function answerFor(question) {
  switch (question.input_type) {
    case 'single':
      return question.options?.[0]?.value ?? 'sin_opciones';
    case 'multi':
      return [question.options?.[0]?.value ?? 'sin_opciones'];
    case 'number':
      return 12;
    case 'scale':
      return 4;
    default:
      return 'Respuesta de prueba automatizada.';
  }
}

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n\x1b[1mHola Amigo · prueba de humo\x1b[0m  \x1b[2m${BASE}\x1b[0m`);

// ── 1 · Salud ──────────────────────────────────────────────────────────────
step('1 · Configuración');

const health = await json(`/api/health${HEALTH_KEY ? `?key=${HEALTH_KEY}` : ''}`);
if (health.body?.ok) {
  ok('/api/health responde ok');
} else {
  const blocking = health.body?.blocking ?? [];
  const detail = (health.body?.checks ?? [])
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: ${c.detail ?? 'falla'}${c.fix ? ` → ${c.fix}` : ''}`)
    .join('\n      ');
  fail(
    `/api/health devolvió ${health.status}`,
    detail || `bloqueantes: ${blocking.join(', ') || 'sin detalle (pasa CRON_SECRET para verlo)'}`,
  );
  console.log('\n  Sin configuración válida el resto de la prueba no significa nada.');
  process.exit(1);
}

const v3 = (health.body?.checks ?? []).find((c) => c.name === 'db:v3');
if (!v3 || v3.ok) ok('migración 0005 aplicada (clave del quiz + settings)');
else fail('falta la migración 0005', v3.detail);

// ── 2 · Intake ─────────────────────────────────────────────────────────────
step('2 · Landing → intake');

// Dominio distinto en cada corrida: el rate limit por dominio es de 3 por día
// y el caché de research es de 30 días. Con un dominio fijo, la segunda prueba
// del día mediría el caché en vez del producto.
const stamp = Date.now().toString(36);
const domain = `prueba-${stamp}.example.com`;

const intake = await json('/api/intake', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Prueba Automatizada',
    email: `smoke+${stamp}@holaamigo.co`,
    url: domain,
    utm: { utm_source: 'smoke' },
  }),
});

if (!intake.ok || !intake.body?.sessionId) {
  fail(`/api/intake devolvió ${intake.status}`, JSON.stringify(intake.body));
  process.exit(1);
}
ok('intake creado', `sesión ${intake.body.sessionId.slice(0, 8)}`);

const { sessionId, organizationId } = intake.body;

// ── 3 · El quiz avanza ─────────────────────────────────────────────────────
step('3 · El quiz guarda y avanza');

const first = await json('/api/quiz/next', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId }),
});

if (!first.ok) {
  fail(`/api/quiz/next devolvió ${first.status}`, JSON.stringify(first.body));
  process.exit(1);
}

let state = first.body;
const seen = [];
let guard = 0;

while (!state.done && state.question && guard < 20) {
  guard += 1;
  const question = state.question;
  const key = question.slot ?? question.id;

  if (seen.includes(key)) {
    fail(
      `la pregunta "${key}" volvió a salir después de responderla`,
      'La respuesta no se guardó. Es exactamente el bug de la v2.0.1: revisa el índice ' +
        'quiz_responses_key y que la migración 0005 haya corrido.',
    );
    break;
  }
  seen.push(key);

  const answered = await json('/api/quiz/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, key, answer: answerFor(question) }),
  });

  if (!answered.ok) {
    fail(`respuesta a "${key}" devolvió ${answered.status}`, JSON.stringify(answered.body));
    break;
  }

  const before = state.answeredCount ?? 0;
  state = answered.body;

  if ((state.answeredCount ?? 0) <= before) {
    fail(
      `el contador no subió al responder "${key}"`,
      `iba en ${before} y sigue en ${state.answeredCount}`,
    );
    break;
  }
}

if (guard >= 20) fail('el quiz no terminó en 20 preguntas', 'el tope duro del PRD es 12');

if (state.done) {
  ok(`el quiz completó ${seen.length} preguntas`, seen.join(' → '));
  // 6 fijas + 4 o 5 adaptativas + 1 de cierre. Menos de 11 significa que
  // `ensureAdaptive` no completó con el respaldo; más de 12 rompe el tope duro
  // del PRD §4.2.
  if (seen.length >= 11 && seen.length <= 12) ok(`largo correcto (${seen.length})`);
  else fail(`el quiz tuvo ${seen.length} preguntas`, 'se esperaban 11 o 12');
} else if (failures === 0) {
  fail('el quiz nunca llegó a done');
}

// ── 4 · Diagnóstico ────────────────────────────────────────────────────────
step('4 · El President arma el diagnóstico');
console.log('  \x1b[2m(espera al research: puede tardar hasta 2 minutos)\x1b[0m');

const generated = await json('/api/diagnostic/generate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId }),
});

let shareToken = null;
if (!generated.ok || !generated.body?.shareToken) {
  fail(`/api/diagnostic/generate devolvió ${generated.status}`, JSON.stringify(generated.body));
} else {
  shareToken = generated.body.shareToken;
  ok('diagnóstico generado', `calidad del research: ${generated.body.researchQuality}`);
  if (generated.body.degraded) {
    console.log('  \x1b[33m!\x1b[0m salió en modo degradado: mira /admin/runs para ver por qué');
  }

  // Idempotencia: la segunda llamada tiene que devolver el MISMO diagnóstico,
  // no cobrar otra corrida del modelo.
  const again = await json('/api/diagnostic/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (again.body?.shareToken === shareToken) ok('la segunda llamada devuelve el mismo diagnóstico');
  else fail('la generación no es idempotente', `${shareToken} ≠ ${again.body?.shareToken}`);
}

// ── 5 · Las pantallas del cliente ──────────────────────────────────────────
step('5 · Lo que el cliente ve');

async function page(path, mustContain) {
  const response = await fetch(`${BASE}${path}`);
  const html = await response.text();
  if (!response.ok) {
    fail(`${path} devolvió ${response.status}`);
    return;
  }
  const missing = mustContain.filter((needle) => !html.includes(needle));
  if (missing.length > 0) fail(`${path} no muestra: ${missing.join(', ')}`);
  else ok(`${path} renderiza`);
}

if (shareToken) {
  await page(`/diagnostico/${shareToken}`, ['Quién eres', 'Tu posición', 'Las tres rutas']);
}
await page(`/panel/${organizationId}`, ['PRESIDENT', 'CMO', 'SALES']);

// ── Resumen ────────────────────────────────────────────────────────────────
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  failures === 0
    ? `\n\x1b[32m\x1b[1mTodo el flujo funciona.\x1b[0m ${seconds}s\n`
    : `\n\x1b[31m\x1b[1m${failures} problema(s).\x1b[0m ${seconds}s\n`,
);
process.exit(failures === 0 ? 0 : 1);
