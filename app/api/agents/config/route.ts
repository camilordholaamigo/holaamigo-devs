import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor } from '@/lib/auth/console';
import { updateAgentConfig, agentConfigFor } from '@/lib/agents/config';

/**
 * Configuración de los agentes.
 *
 * Solo toca `config`, `autonomy` y `status`. El CONTRATO —objetivo,
 * presupuesto, permisos, escalamiento— no es editable por nadie desde acá, ni
 * por el admin. Si "prohibido enviar sin aprobación" se pudiera apagar en un
 * formulario, dejaría de ser una prohibición.
 */

export const runtime = 'nodejs';

const Body = z.object({
  organizationId: z.string().uuid(),
  role: z.enum(['president', 'cmo', 'sales']),
  config: z.record(z.string(), z.unknown()),
  autonomy: z.enum(['propose', 'approve_each', 'auto_within_limits']).nullish(),
  status: z.enum(['active', 'paused', 'draft']).nullish(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const result = await updateAgentConfig({
    organizationId: parsed.data.organizationId,
    role: parsed.data.role,
    config: parsed.data.config,
    autonomy: parsed.data.autonomy,
    status: parsed.data.status ?? undefined,
  });

  if (!result.ok) return NextResponse.json({ error: 'No pudimos guardar.' }, { status: 500 });

  // Devolvemos lo que quedó guardado, no lo que llegó: los topes se acotan en
  // el servidor y el formulario tiene que reflejar el valor real.
  const saved = await agentConfigFor(parsed.data.organizationId, parsed.data.role);
  return NextResponse.json({ ok: true, ...saved });
}
