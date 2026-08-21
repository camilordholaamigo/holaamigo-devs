import { NextResponse } from 'next/server';
import { z } from 'zod';
import { corregirCampo, playbookVigente, historialDePlaybooks } from '@/lib/playbook/store';
import { renderInstructions } from '@/lib/playbook/render';
import { track } from '@/lib/events';

/**
 * GET / PATCH /api/agent/playbook — leer y corregir el guion.
 *
 * El PATCH es la mitad del producto que colapsa el onboarding. La otra mitad es
 * el compilador; esta es la que hace que el cliente no tenga que llenar nada:
 * en vez de un formulario de veinte campos, una lista de tres o cuatro cosas
 * que inferimos, cada una con su valor propuesto ya escrito y un botón.
 *
 * No versiona. Confirmar "sí, atiende Camila" no es un guion distinto — es el
 * mismo guion con un dato que dejó de ser una suposición. El razonamiento largo
 * está en `lib/playbook/store.ts`.
 */

export const runtime = 'nodejs';

const Patch = z.object({
  organizationId: z.string().uuid(),
  ruta: z.string().min(1).max(80),
  valor: z.union([z.string().max(2000), z.array(z.string().max(300)).max(20)]),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get('organizationId');
  if (!organizationId) return NextResponse.json({ error: 'Falta organizationId' }, { status: 400 });

  const playbook = await playbookVigente(organizationId);
  if (!playbook) return NextResponse.json({ ok: true, playbook: null });

  return NextResponse.json({
    ok: true,
    playbook,
    // La instrucción exacta que lee el modelo, tal cual. Un agente cuyo prompt
    // el cliente no puede leer es un agente en el que el cliente no puede
    // confiar — y este producto vende precisamente confianza.
    instrucciones: renderInstructions(playbook),
    historial: await historialDePlaybooks(organizationId, 5),
  });
}

export async function PATCH(request: Request) {
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }

  const { organizationId, ruta, valor } = parsed.data;

  const resultado = await corregirCampo({ organizationId, ruta, valor });
  if (!resultado.ok) {
    return NextResponse.json({ error: 'Ese campo no se puede editar.' }, { status: 400 });
  }

  await track('playbook_field_confirmed', {
    organizationId,
    props: { ruta, restantes: resultado.cobertura?.a_confirmar.length ?? 0 },
  });

  return NextResponse.json({ ok: true, cobertura: resultado.cobertura });
}
