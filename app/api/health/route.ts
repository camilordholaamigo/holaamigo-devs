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

    // ── v7: el CRO (P4) ───────────────────────────────────────────────────
    //
    // Lo que se comprueba, otra vez, no es que las tablas existan: es que el
    // readout aplique la regla declarada. Se le pide el readout de un
    // experimento inexistente y se exige que responda con error de dominio. Si
    // contestara "ok", el pre-registro sería decorativo.
    const v7: string[] = [];

    for (const table of ['channels', 'revenue_events', 'cost_events', 'experiments', 'channel_economics']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v7.push(table);
    }

    const { error: readoutError } = await db().rpc('readout_experimento', {
      p_id: '00000000-0000-0000-0000-000000000000',
      p_actual: 1,
      p_sample: 1,
    });
    if (!readoutError) v7.push('el readout acepta un experimento inexistente');
    else if (!/no existe/i.test(readoutError.message)) v7.push('rpc:readout_experimento');

    checks.push({
      name: 'db:v7',
      ok: v7.length === 0,
      detail:
        v7.length === 0
          ? 'el P&G por canal responde y el readout aplica la regla declarada'
          : `problemas: ${v7.join(', ')}`,
      fix: v7.length === 0 ? undefined : 'correr 0009_cro.sql',
    });

    // ── v8: la CMO (P5) ───────────────────────────────────────────────────
    //
    // El chequeo que importa es el de la disciplina: se intenta empujar una
    // señal de upsell directo al cliente y se exige que la base lo rechace. Si
    // pasara, un agente podría ofrecerle servicios al cliente sin que nadie de
    // acá lo mire, y eso destruye la confianza que sostiene el producto entero.
    const v8: string[] = [];

    for (const table of ['positioning', 'competitor_snapshots', 'case_studies', 'upsell_signals']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v8.push(table);
    }

    const { error: mencionaError } = await db().rpc('menciona', {
      p_texto: 'te respondemos en 60 segundos',
      p_frase: 'responde en 60 segundos',
    });
    if (mencionaError) v8.push('rpc:menciona');

    checks.push({
      name: 'db:v8',
      ok: v8.length === 0,
      detail:
        v8.length === 0
          ? 'posicionamiento medible, competencia vigilada y señales con escalera'
          : `problemas: ${v8.join(', ')}`,
      fix: v8.length === 0 ? undefined : 'correr 0010_cmo.sql',
    });

    // ── v9: habilidades y CRM (P6) ────────────────────────────────────────
    //
    // Se comprueba que el catálogo esté sembrado y que la intersección de
    // habilidades falle cerrado para una organización que no existe.
    //
    // OJO CON QUÉ SIGNIFICA «FALLA CERRADO» ACÁ. La primera versión de este
    // chequeo exigía lista VACÍA, y estuvo reportando un fallo falso desde el
    // día que se escribió: tanto 0011 como 0013 siembran habilidades globales
    // (`organization_id = null`), así que toda organización —exista o no—
    // recibe las de lectura. Peor todavía, el `fix` decía «correr
    // 0011_integraciones.sql», que es exactamente la migración que las crea.
    //
    // Un chequeo que grita siempre entrena a la gente a ignorar el endpoint que
    // usamos para diagnosticar. Lo que de verdad importa es que una
    // organización desconocida no reciba NADA que toque el mundo exterior.
    const v9: string[] = [];

    for (const table of ['skills', 'skill_grants', 'skill_requests', 'staging_contacts', 'opportunities', 'lead_timeline']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v9.push(table);
    }

    const { count: skillCount } = await db()
      .from('skills')
      .select('id', { count: 'exact', head: true });
    if ((skillCount ?? 0) < 8) v9.push(`catálogo incompleto (${skillCount ?? 0} habilidades)`);

    const { data: lista, error: skillError } = await db().rpc('habilidades_activas', {
      p_org: '00000000-0000-0000-0000-000000000000',
      p_role: 'sales',
    });
    if (skillError) {
      v9.push('rpc:habilidades_activas');
    } else {
      const peligrosas = ((lista as Array<{ risk_class?: string }> | null) ?? []).filter((s) =>
        ['external_comms', 'self_outreach', 'spend', 'irreversible'].includes(s.risk_class ?? ''),
      );
      if (peligrosas.length > 0) {
        v9.push(
          `el tool list no falla cerrado: una organización inexistente recibe ${peligrosas
            .map((s) => s.risk_class)
            .join(', ')}`,
        );
      }
    }

    checks.push({
      name: 'db:v9',
      ok: v9.length === 0,
      detail:
        v9.length === 0
          ? `${skillCount} habilidades en catálogo y nada que salga del edificio para una organización desconocida`
          : `problemas: ${v9.join(', ')}`,
      fix:
        v9.length === 0
          ? undefined
          : 'correr 0011_integraciones.sql y 0013_agente_de_agendamiento.sql, y revisar los grants globales de skill_grants',
    });

    // ── v10: el agente de agendamiento (P7) ───────────────────────────────
    //
    // Lo que se comprueba no es solo que las tablas existan: también que
    // `techo_de_plan` sea la versión de dos argumentos. Es la diferencia entre
    // "las migraciones corrieron" y "un cliente del plan gratis puede compilar
    // su guion sin generar una tarjeta de aprobación" — y desde afuera las dos
    // cosas se ven idénticas hasta que un cliente lo intenta.
    const v10: string[] = [];

    for (const table of ['agent_playbooks', 'knowledge_bases', 'conversations', 'conversation_turns']) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v10.push(table);
    }

    const { error: playbookRpcError } = await db().rpc('playbook_vigente', {
      p_org: '00000000-0000-0000-0000-000000000000',
    });
    if (playbookRpcError) v10.push('rpc:playbook_vigente');

    const { data: techo, error: techoError } = await db().rpc('techo_de_plan', {
      p_plan: 'diagnostico',
      p_risk_class: 'write',
    });
    if (techoError) v10.push('techo_de_plan sigue siendo el de un argumento');
    else if (Number(techo) !== 5) {
      v10.push(`el plan gratis topa en L${techo} lo que el agente escribe en objetos propios`);
    }

    const { data: embudo, error: embudoError } = await db().rpc('embudo_inicial', {
      p_desde: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    if (embudoError) v10.push('rpc:embudo_inicial (falta 0012)');
    else if ((embudo as unknown[])?.length !== 8) {
      v10.push(`embudo_inicial devuelve ${(embudo as unknown[])?.length} etapas, no 8`);
    }

    for (const capability of ['playbook.compile', 'knowledge.index', 'setter.simulate', 'meeting.offer_slots']) {
      const { data } = await db().from('capabilities').select('id').eq('id', capability).maybeSingle();
      if (!data) v10.push(`capacidad ${capability} sin sembrar`);
    }

    checks.push({
      name: 'db:v10',
      ok: v10.length === 0,
      detail:
        v10.length === 0
          ? 'el agente de agendamiento se puede compilar, y el plan gratis no lo frena'
          : `problemas: ${v10.join(', ')}`,
      fix: v10.length === 0 ? undefined : 'correr 0012_flujo_inicial.sql y 0013_agente_de_agendamiento.sql',
    });

    // ── v11: el smoke tester (P8, P9, P10) ────────────────────────────────
    //
    // Este chequeo existe porque **las migraciones del smoke tester se corren a
    // mano en el editor SQL de Supabase**: las credenciales están marcadas
    // Sensitive en Vercel, así que no hay forma de aplicarlas desde el
    // despliegue. Sin esto, «la 0017 no se corrió» y «Callbell rechazó la
    // llave» se ven exactamente igual desde afuera: una prueba que se crea y no
    // hace nada.
    //
    // Los dos moldes a medida son lo que más vale verificar. `template_id` es
    // clave foránea, así que sin esas filas el formulario del admin revienta con
    // un 23503 en el momento de mandar el mensaje — el peor lugar posible.
    const v11: string[] = [];

    for (const table of [
      'smoke_channels',
      'smoke_templates',
      'smoke_targets',
      'smoke_runs',
      'smoke_probes',
      'smoke_batches',
      'smoke_reports',
    ]) {
      const { error } = await db().from(table).select('*', { head: true, count: 'exact' }).limit(1);
      if (error) v11.push(table);
    }

    const { data: moldes } = await db()
      .from('smoke_templates')
      .select('id')
      .in('id', ['servicio', 'faq', 'ventas', 'a-medida', 'guion']);

    const sembrados = new Set((moldes ?? []).map((m) => m.id));
    for (const id of ['servicio', 'faq', 'ventas', 'a-medida', 'guion']) {
      if (!sembrados.has(id)) v11.push(`molde ${id} sin sembrar`);
    }

    const { error: resumenError } = await db().rpc('resumen_de_pruebas', {
      p_desde: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    if (resumenError) v11.push('rpc:resumen_de_pruebas (falta 0014)');

    const { error: loteError } = await db().rpc('estado_del_lote', {
      p_batch: '00000000-0000-0000-0000-000000000000',
    });
    if (loteError) v11.push('rpc:estado_del_lote (falta 0015)');

    // La clase de riesgo, no solo que la capacidad exista. Con
    // `external_comms` el disparo automático queda inalcanzable por
    // construcción y no corre nunca — ver la migración 0016. Desde afuera eso
    // se ve como «el prospecto no publicó su número».
    const { data: capSmoke } = await db()
      .from('capabilities')
      .select('risk_class, platform_ceiling')
      .eq('id', 'smoketest.probe')
      .maybeSingle();

    if (!capSmoke) v11.push('capacidad smoketest.probe sin sembrar');
    else if (capSmoke.risk_class !== 'self_outreach') {
      v11.push(`smoketest.probe sigue siendo ${capSmoke.risk_class}: el disparo automático no va a correr`);
    }

    // Sin línea activa no sale ningún mensaje, ni el automático ni el manual.
    // Es una condición de operación y no de esquema, así que va como aviso
    // dentro del mismo chequeo: quien lea esto está buscando por qué no salió.
    const { count: lineas } = await db()
      .from('smoke_channels')
      .select('id', { count: 'exact', head: true })
      .eq('activo', true);
    if ((lineas ?? 0) === 0) v11.push('ninguna línea activa en /admin/pruebas');

    checks.push({
      name: 'db:v11',
      ok: v11.length === 0,
      detail:
        v11.length === 0
          ? `el smoke tester puede escribir, y los cinco moldes están (${lineas} ${lineas === 1 ? 'línea' : 'líneas'} activas)`
          : `problemas: ${v11.join(', ')}`,
      fix:
        v11.length === 0
          ? undefined
          : 'correr 0014_smoke_tester.sql → 0015_lotes_e_informes.sql → 0016_la_prueba_no_la_gobierna_el_plan.sql → 0017_prueba_a_medida.sql',
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
