import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { db, explainDbError } from '@/lib/supabase/admin';
import { normalizeUrl, domainOf, isValidEmail, clientIp } from '@/lib/utils';
import { checkRateLimit, LIMITS } from '@/lib/ratelimit';
import { executeResearch } from '@/lib/research/run';
import { track } from '@/lib/events';

/**
 * POST /api/intake — la única conversión de la landing (PRD §4.1).
 *
 * Contrato de latencia: responde en menos de 300 ms. Crea la organización, la
 * sesión y encola el research, y devuelve. NO espera a la investigación: el
 * usuario se va derecho al quiz mientras el research corre por detrás.
 *
 * El worker se dispara con `after()`, que en Vercel mantiene viva la función
 * después de enviar la respuesta. Por eso maxDuration = 300: el research puede
 * tardar hasta 3 minutos y necesita margen. Si la función igual se muere, el
 * cron de /api/cron/sweep lo recoge (§8.3.4).
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().max(254),
  url: z.string().trim().min(3).max(300),
  utm: z.record(z.string(), z.string()).optional(),
  referrer: z.string().max(500).nullish(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Cuerpo inválido.' }, { status: 400 });
  }

  if (!parsed.success) {
    return NextResponse.json({ error: 'Faltan datos o son inválidos.' }, { status: 400 });
  }

  const { name, email, url, utm, referrer } = parsed.data;

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Ese correo no parece válido.', field: 'email' }, { status: 400 });
  }

  const websiteUrl = normalizeUrl(url);
  if (!websiteUrl) {
    return NextResponse.json(
      { error: 'Escribe la dirección de tu sitio, por ejemplo acme.com', field: 'url' },
      { status: 400 },
    );
  }

  const domain = domainOf(websiteUrl);
  const ip = clientIp(request.headers);

  // Rate limit: el research cuesta plata real por visitante anónimo (§10).
  if (ip) {
    const byIp = await checkRateLimit(`intake:ip:${ip}`, LIMITS.intakePerIp.limit, LIMITS.intakePerIp.windowSeconds);
    if (!byIp.allowed) {
      return NextResponse.json(
        { error: 'Ya hiciste varios análisis. Intenta de nuevo en un rato.' },
        { status: 429, headers: { 'retry-after': String(byIp.retryAfterSeconds) } },
      );
    }
  }

  const byDomain = await checkRateLimit(
    `intake:domain:${domain}`,
    LIMITS.intakePerDomain.limit,
    LIMITS.intakePerDomain.windowSeconds,
  );
  if (!byDomain.allowed) {
    return NextResponse.json(
      { error: 'Ese dominio ya se analizó hoy. Revisa tu correo: te mandamos el enlace.' },
      { status: 429, headers: { 'retry-after': String(byDomain.retryAfterSeconds) } },
    );
  }

  try {
    // ── Organización: una por dominio (índice único) ──────────────────────
    const { data: existingOrg } = await db()
      .from('organizations')
      .select('id, name, lifecycle')
      .eq('domain', domain)
      .maybeSingle();

    let organizationId: string;

    if (existingOrg) {
      organizationId = existingOrg.id;
      await db()
        .from('organizations')
        .update({ owner_email: email.toLowerCase() })
        .eq('id', organizationId);
    } else {
      const { data: created, error } = await db()
        .from('organizations')
        .insert({
          website_url: websiteUrl,
          owner_email: email.toLowerCase(),
          lifecycle: 'diagnostic',
        })
        .select('id')
        .single();

      if (error || !created) {
        // Carrera: alguien creó el mismo dominio entre el select y el insert.
        const { data: retry } = await db()
          .from('organizations')
          .select('id')
          .eq('domain', domain)
          .maybeSingle();
        if (!retry) throw new Error(error?.message ?? 'no se pudo crear la organización');
        organizationId = retry.id;
      } else {
        organizationId = created.id;
      }
    }

    // ── Sesión de intake ──────────────────────────────────────────────────
    const { data: session, error: sessionError } = await db()
      .from('intake_sessions')
      .insert({
        organization_id: organizationId,
        contact_name: name,
        contact_email: email.toLowerCase(),
        status: 'started',
        utm: utm ?? {},
        referrer: referrer ?? request.headers.get('referer'),
        ip,
        user_agent: request.headers.get('user-agent')?.slice(0, 500),
      })
      .select('id')
      .single();

    if (sessionError || !session) {
      throw new Error(sessionError?.message ?? 'no se pudo crear la sesión');
    }

    // ── Research encolado ─────────────────────────────────────────────────
    const { data: run, error: runError } = await db()
      .from('research_runs')
      .insert({
        organization_id: organizationId,
        session_id: session.id,
        status: 'queued',
        progress_log: [
          { t: new Date().toISOString(), step: 'queued', detail: `Vamos a analizar ${domain}` },
        ],
      })
      .select('id')
      .single();

    if (runError || !run) throw new Error(runError?.message ?? 'no se pudo encolar el research');

    await track('landing_submit', {
      organizationId,
      sessionId: session.id,
      props: { domain, utm: utm ?? {}, returning: Boolean(existingOrg) },
    });

    // El worker arranca después de responder. El usuario ya está en el quiz.
    after(async () => {
      try {
        await executeResearch(run.id);
      } catch (err) {
        console.error('[intake] el worker de research murió', err);
      }
    });

    return NextResponse.json({
      sessionId: session.id,
      organizationId,
      runId: run.id,
      domain,
      next: `/quiz/${session.id}`,
    });
  } catch (err) {
    // `explainDbError` convierte los errores de configuración de Supabase en
    // instrucciones. El usuario sigue viendo el mensaje amable; quien lee los
    // logs ve qué hay que arreglar. Ver /api/health para el diagnóstico completo.
    console.error('[intake] fallo:', explainDbError(err));
    return NextResponse.json(
      { error: 'Algo se rompió de nuestro lado. Intenta de nuevo en un minuto.' },
      { status: 500 },
    );
  }
}
