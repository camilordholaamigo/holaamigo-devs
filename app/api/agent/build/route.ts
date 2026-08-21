import { z } from 'zod';
import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase/admin';
import { compilePlaybook } from '@/lib/playbook/compile';
import { buildKnowledgeBase } from '@/lib/playbook/knowledge';
import { playbookVigente } from '@/lib/playbook/store';
import { track } from '@/lib/events';
import { refreshScore } from '@/lib/scoring';

/**
 * POST /api/agent/build — arma el agente de agendamiento.
 *
 * DEVUELVE UN STREAM, y esa es la decisión de diseño de la ruta.
 *
 * Compilar tarda entre 20 y 50 segundos. Un spinner con tres pasos animados que
 * corren solos sería exactamente lo que prohíbe ADR 0023: fingir un progreso
 * que no está pasando. Acá cada línea que sale al navegador es una fase que
 * **terminó de verdad** en el servidor, con su nombre y su detalle.
 *
 * Se eligió NDJSON sobre la respuesta del POST y no un GET con SSE aparte —el
 * patrón del research (ADR 0002)— porque acá no hay una corrida persistida a la
 * que suscribirse: la construcción ES esta petición. Un SSE aparte obligaría a
 * inventar una tabla de progreso para un proceso que dura menos de un minuto.
 *
 * Idempotente por diseño: si ya hay un playbook vigente y no viene `force`,
 * devuelve el que hay. El botón se puede apretar dos veces.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const Body = z.object({
  organizationId: z.string().uuid(),
  sessionId: z.string().uuid().nullish(),
  force: z.boolean().nullish(),
});

interface Evento {
  fase: string;
  estado: 'corriendo' | 'listo' | 'falló';
  detalle: string;
  datos?: Record<string, unknown>;
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  const { organizationId, sessionId, force } = parsed.data;

  const { data: org } = await db()
    .from('organizations')
    .select('id, name, domain')
    .eq('id', organizationId)
    .maybeSingle();

  if (!org) return NextResponse.json({ error: 'Organización no encontrada' }, { status: 404 });

  const existente = await playbookVigente(organizationId);
  if (existente && !force) {
    return NextResponse.json({
      ok: true,
      reused: true,
      playbookId: existente.id,
      version: existente.version,
      cobertura: existente.cobertura,
      next: `/agente/${organizationId}`,
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let cerrado = false;
      const send = (evento: Evento) => {
        if (cerrado) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(evento)}\n`));
        } catch {
          cerrado = true;
        }
      };

      const companyName = org.name ?? org.domain;

      try {
        send({ fase: 'inicio', estado: 'listo', detalle: `Armando el agente de ${companyName}` });

        // ── 1. El playbook ────────────────────────────────────────────────
        const compilado = await compilePlaybook({
          organizationId,
          sessionId,
          onProgress: (p) =>
            send({ fase: p.fase, estado: 'corriendo', detalle: p.detalle }),
        });

        send({
          fase: 'playbook',
          estado: 'listo',
          detalle: `Guion listo · ${compilado.cobertura.porcentaje}% sale de tu sitio`,
          datos: {
            playbookId: compilado.playbookId,
            version: compilado.version,
            cobertura: compilado.cobertura,
            degraded: compilado.degraded,
          },
        });

        // ── 2. La base de conocimiento ────────────────────────────────────
        //
        // Si esto falla, el agente igual sirve: los hechos viven en el playbook
        // y el vector store solo aterriza las preguntas puntuales. Por eso se
        // reporta el fallo y se sigue, en vez de tumbar la construcción.
        const playbook = await playbookVigente(organizationId);
        if (playbook) {
          const kb = await buildKnowledgeBase({
            organizationId,
            playbook,
            companyName,
            onProgress: (p) => send({ fase: p.fase, estado: 'corriendo', detalle: p.detalle }),
          });

          send({
            fase: 'conocimiento',
            estado: kb.status === 'ready' ? 'listo' : 'falló',
            detalle:
              kb.status === 'ready'
                ? `${kb.fileCount} documentos indexados`
                : 'No pudimos indexar tu información. El agente funciona igual, con lo que ya tiene el guion.',
            datos: { fileCount: kb.fileCount, error: kb.error },
          });
        }

        await refreshScore(organizationId);

        await track('playbook_compiled', {
          organizationId,
          sessionId,
          props: { version: compilado.version, cobertura: compilado.cobertura.porcentaje },
        });

        send({
          fase: 'fin',
          estado: 'listo',
          detalle: 'Tu agente está listo. Pruébalo.',
          datos: {
            playbookId: compilado.playbookId,
            version: compilado.version,
            cobertura: compilado.cobertura,
            next: `/agente/${organizationId}`,
          },
        });
      } catch (err) {
        console.error('[agent/build] falló', err);
        send({
          fase: 'fin',
          estado: 'falló',
          detalle:
            err instanceof Error
              ? err.message
              : 'No pudimos armar el agente. Ya nos llegó el aviso y lo revisamos.',
        });
      } finally {
        cerrado = true;
        try {
          controller.close();
        } catch {
          /* el cliente ya se fue */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // Sin esto, el proxy de Vercel puede acumular el cuerpo y entregar las
      // seis fases juntas al final — que es visualmente idéntico a no tener
      // stream, y peor, porque nadie se entera de que se rompió.
      'x-accel-buffering': 'no',
    },
  });
}
