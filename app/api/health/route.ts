import { NextResponse } from 'next/server';
import { db, explainDbError } from '@/lib/supabase/admin';
import { env, hasOpenAI, hasSupabase } from '@/lib/env';
import { currentAdmin } from '@/lib/auth/admin';

/**
 * GET /api/health — ¿esto está bien configurado?
 *
 * Existe porque `Invalid schema: holaamigo` costó una tarde. Las tablas
 * existían, los permisos estaban bien, la key era correcta, y todo el producto
 * devolvía "algo se rompió de nuestro lado". Nada en la app decía qué revisar.
 *
 * Esta ruta contesta, en un solo GET: ¿hay credenciales? ¿la base responde?
 * ¿el schema está expuesto? ¿corrieron las migraciones? ¿v1 y v2?
 *
 * Público devuelve solo `{ ok }`. El detalle exige cookie de admin o
 * `?key=$CRON_SECRET`, porque los mensajes de error nombran infraestructura.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  const admin = await currentAdmin();
  const detailed = Boolean(admin) || (Boolean(env.cronSecret) && key === env.cronSecret);

  const checks: Check[] = [];

  // ── 1 · Credenciales ────────────────────────────────────────────────────
  checks.push({
    name: 'env:supabase',
    ok: hasSupabase(),
    detail: hasSupabase() ? 'SUPABASE_URL y SERVICE_ROLE_KEY presentes' : 'faltan variables',
    fix: hasSupabase() ? undefined : 'vercel env add SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY',
  });

  checks.push({
    name: 'env:openai',
    ok: hasOpenAI(),
    detail: hasOpenAI()
      ? 'OPENAI_API_KEY presente'
      : 'falta OPENAI_API_KEY — el research y el diagnóstico no van a correr',
    fix: hasOpenAI() ? undefined : 'vercel env add OPENAI_API_KEY production',
  });

  // ── 2 · La base responde y el schema está expuesto ──────────────────────
  // Estas dos preguntas son distintas y se confunden todo el tiempo: la base
  // puede estar perfecta y PostgREST rechazar igual el schema (ADR 0001).
  let schemaReachable = false;

  if (hasSupabase()) {
    try {
      const { error } = await db().from('organizations').select('id').limit(1);
      if (error) throw new Error(error.message);
      schemaReachable = true;
      checks.push({
        name: 'db:schema',
        ok: true,
        detail: 'el schema holaamigo responde',
      });
    } catch (err) {
      const explained = explainDbError(err);
      checks.push({
        name: 'db:schema',
        ok: false,
        detail: explained,
        fix: /Exposed schemas/.test(explained)
          ? 'Project Settings → API → Exposed schemas: agregar `holaamigo`'
          : 'correr supabase/migrations/*.sql en orden',
      });
    }
  }

  // ── 3 · ¿Qué migraciones corrieron? ─────────────────────────────────────
  if (schemaReachable) {
    const groups: { name: string; tables: string[]; migration: string }[] = [
      {
        name: 'db:v1',
        tables: ['organizations', 'intake_sessions', 'quiz_questions', 'diagnostics', 'agents'],
        migration: '0001_init.sql + 0002_seed_quiz.sql',
      },
      {
        name: 'db:v2',
        tables: ['mailboxes', 'campaign_metrics', 'assets', 'bookings', 'feed_items', 'credit_ledger'],
        migration: '0003_motor_de_correo.sql',
      },
    ];

    for (const group of groups) {
      const missing: string[] = [];
      for (const table of group.tables) {
        const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
        if (error) missing.push(table);
      }
      checks.push({
        name: group.name,
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `${group.tables.length} tablas presentes`
            : `faltan: ${missing.join(', ')}`,
        fix: missing.length === 0 ? undefined : `correr ${group.migration}`,
      });
    }

    // ── v3: las claves que hacen que el quiz pueda guardar ────────────────
    //
    // Este chequeo no mira una tabla, mira una COLUMNA. `answer_key` es la
    // columna generada que sostiene el índice único de `quiz_responses`. Sin
    // ella, cada respuesta del quiz falla con 42P10 y —antes de esta versión—
    // fallaba en silencio: la pantalla se quedaba en la misma pregunta y no
    // había nada en los logs. Un curl a /api/health lo dice ahora en un
    // segundo, que es lo que costó una semana descubrir a mano.
    const v3: string[] = [];

    const { error: keyError } = await db()
      .from('quiz_responses')
      .select('answer_key')
      .limit(1);
    if (keyError) v3.push('quiz_responses.answer_key');

    const { error: settingsError } = await db().from('settings').select('key').limit(1);
    if (settingsError) v3.push('settings');

    checks.push({
      name: 'db:v3',
      ok: v3.length === 0,
      detail:
        v3.length === 0
          ? 'clave del quiz y tabla de settings presentes'
          : `faltan: ${v3.join(', ')}`,
      fix: v3.length === 0 ? undefined : 'correr 0005_claves_y_settings.sql',
    });

    // ── v4: el sustrato (P1) ──────────────────────────────────────────────
    //
    // Aquí se mira una FUNCIÓN, no solo las tablas. `holaamigo.calibracion` es
    // la que convierte una predicción en aprendizaje, y se llama por RPC: si el
    // `grant execute` no corrió, las tablas existen, la migración "aparenta"
    // haber pasado, y el ciclo de aprendizaje se queda mudo sin un solo error
    // visible. Es el mismo modo de falla de `Invalid schema`, un nivel abajo.
    const v4: string[] = [];

    for (const table of ['traces', 'decisions', 'lessons', 'human_inputs', 'cost_rollup']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v4.push(table);
    }

    const { error: rpcError } = await db().rpc('calibracion', { p_esperado: 100, p_real: 80 });
    if (rpcError) v4.push('rpc:calibracion');

    checks.push({
      name: 'db:v4',
      ok: v4.length === 0,
      detail:
        v4.length === 0
          ? 'sustrato completo: trazas, decisiones, lecciones y funciones'
          : `faltan: ${v4.join(', ')}`,
      fix: v4.length === 0 ? undefined : 'correr 0006_sustrato.sql',
    });

    // ── v5: la correa (P2) ────────────────────────────────────────────────
    //
    // El chequeo que importa no es que las tablas existan: es que el motor diga
    // que NO. Se le pregunta por `partnership.commit`, que tiene techo de
    // plataforma L0, con una organización inexistente. Si contesta cualquier
    // cosa que no sea `blocked`, algo está mal en el catálogo o en la función y
    // hay que enterarse acá y no cuando un agente firme algo.
    const v5: string[] = [];

    for (const table of ['capabilities', 'capability_grants', 'guard_events', 'approval_kinds']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v5.push(table);
    }

    const { count: capCount } = await db()
      .from('capabilities')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');
    if ((capCount ?? 0) < 20) v5.push(`catálogo incompleto (${capCount ?? 0} capacidades)`);

    const { data: veredicto, error: guardError } = await db().rpc('autorizar', {
      p_org: '00000000-0000-0000-0000-000000000000',
      p_capability: 'partnership.commit',
      p_payload: {},
      p_agent: null,
      p_registrar: false,
    });
    if (guardError) v5.push('rpc:autorizar');
    else if ((veredicto as { verdict?: string } | null)?.verdict !== 'blocked') {
      v5.push('el motor NO bloquea partnership.commit');
    }

    checks.push({
      name: 'db:v5',
      ok: v5.length === 0,
      detail:
        v5.length === 0
          ? `correa activa: ${capCount} capacidades y el motor bloquea lo prohibido`
          : `problemas: ${v5.join(', ')}`,
      fix: v5.length === 0 ? undefined : 'correr 0007_gobierno.sql',
    });

    // ── v6: La Sala (P3) ──────────────────────────────────────────────────
    //
    // Igual que v5, lo que se comprueba no es que las tablas existan sino que
    // la regla se aplique: se intenta resolver una deliberación inexistente y
    // se exige que la función responda con un error de dominio. Si contestara
    // "ok", el campo obligatorio se podría saltar y el producto entero —una
    // recomendación que se puede discutir— se convertiría en un oráculo.
    const v6: string[] = [];

    for (const table of ['deliberations', 'deliberation_turns', 'chapters']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v6.push(table);
    }

    const { error: salaError } = await db().rpc('resolver_deliberacion', {
      p_id: '00000000-0000-0000-0000-000000000000',
      p_recommendation: {},
      p_confidence: 0.5,
      p_what_would_change: 'corto',
    });
    if (!salaError) v6.push('la función acepta resolver sin el campo obligatorio');
    else if (!/no existe|cambiar de opinión/i.test(salaError.message)) v6.push('rpc:resolver_deliberacion');

    checks.push({
      name: 'db:v6',
      ok: v6.length === 0,
      detail:
        v6.length === 0
          ? 'la sala responde y exige decir qué cambiaría de opinión'
          : `problemas: ${v6.join(', ')}`,
      fix: v6.length === 0 ? undefined : 'correr 0008_la_sala.sql',
    });

    // El seed del quiz: sin preguntas fijas el quiz arranca vacío y el
    // diagnóstico sale sin la cifra de fuga, que es el producto entero.
    const { count } = await db()
      .from('quiz_questions')
      .select('id', { count: 'exact', head: true })
      .eq('active', true);

    checks.push({
      name: 'db:seed_quiz',
      ok: (count ?? 0) >= 6,
      detail: `${count ?? 0} preguntas fijas activas`,
      fix: (count ?? 0) >= 6 ? undefined : 'correr 0002_seed_quiz.sql',
    });
  }

  // ── 4 · Correo (opcional: degrada, no rompe) ────────────────────────────
  checks.push({
    name: 'env:sendgrid',
    ok: Boolean(env.sendgridApiKey),
    detail: env.sendgridApiKey
      ? 'campañas habilitadas'
      : 'sin SENDGRID_API_KEY: los envíos se registran en el log y no salen',
  });

  // `db:v3` bloquea: sin la clave del quiz el producto no tiene camino feliz.
  const blocking = checks.filter(
    (check) =>
      !check.ok &&
      ['env:supabase', 'db:schema', 'db:v1', 'db:v3', 'db:seed_quiz'].includes(check.name),
  );

  const ok = blocking.length === 0;

  if (!detailed) {
    // Sin autenticar se ve QUÉ falla, no POR QUÉ. Los nombres de los chequeos
    // no dicen nada que un atacante no pueda deducir mirando el producto; los
    // mensajes de error sí nombran infraestructura, y esos quedan detrás del
    // admin. La diferencia importa: sin esta lista, el operador tiene que
    // loguearse para saber si vale la pena mirar.
    return NextResponse.json(
      { ok, checks: checks.map((check) => ({ name: check.name, ok: check.ok })) },
      { status: ok ? 200 : 503 },
    );
  }

  return NextResponse.json(
    {
      ok,
      blocking: blocking.map((check) => check.name),
      checks,
      site_url: env.siteUrl,
    },
    { status: ok ? 200 : 503 },
  );
}
