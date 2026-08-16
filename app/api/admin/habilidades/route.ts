import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { otorgarHabilidad, resolverPedido } from '@/lib/skills/registry';
import { db } from '@/lib/supabase/admin';

/**
 * POST /api/admin/habilidades — resolver un pedido del "intraer".
 *
 * Solo admin, y no hay versión para el cliente: qué herramientas existen es una
 * decisión de producto nuestra. El cliente decide **hasta dónde** las usa (P2);
 * nosotros decidimos **cuáles hay**.
 *
 * Otorgar enciende y resuelve en la misma petición. Si fueran dos pasos, la
 * mitad de los pedidos quedarían aprobados y sin efecto.
 */

export const runtime = 'nodejs';

const Body = z.object({
  requestId: z.string().uuid(),
  accion: z.enum(['otorgar', 'rechazar']),
  nota: z.string().max(1000).nullish(),
  skillId: z.string().nullish(),
  organizationId: z.string().uuid().nullish(),
  role: z.enum(['president', 'cmo', 'sales', 'todos']),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });

  const { requestId, accion, nota, skillId, organizationId, role } = parsed.data;

  if (accion === 'rechazar') {
    if (!nota?.trim()) {
      return NextResponse.json(
        { error: 'Rechazar exige una nota: el agente la va a leer la próxima vez que lo intente.' },
        { status: 400 },
      );
    }
    await resolverPedido({ requestId, status: 'rejected', by: admin.user, note: nota });
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  if (!skillId) {
    return NextResponse.json(
      { error: 'El agente pidió algo que no está en el catálogo. Primero hay que crearlo en una migración.' },
      { status: 400 },
    );
  }

  const { data: skill } = await db()
    .from('skills')
    .select('risk_class')
    .eq('id', skillId)
    .maybeSingle();

  if (!skill) {
    return NextResponse.json({ error: 'Esa habilidad no existe en el catálogo.' }, { status: 400 });
  }

  // Las de clase `spend` e `irreversible` exigen sobre, y el trigger de la base
  // lo hace cumplir. Se atrapa acá para dar un mensaje que diga qué hacer, en
  // vez de dejar salir el error crudo de Postgres.
  if (['spend', 'irreversible'].includes(skill.risk_class as string)) {
    return NextResponse.json(
      {
        error:
          `«${skillId}» es de clase ${skill.risk_class} y exige un sobre con límites. ` +
          'Se otorga a mano desde SQL, con el sobre escrito y revisado.',
      },
      { status: 400 },
    );
  }

  try {
    await otorgarHabilidad({
      organizationId: organizationId ?? null,
      role,
      skillId,
      by: admin.user,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }

  await resolverPedido({
    requestId,
    status: 'granted',
    by: admin.user,
    note: nota ?? `otorgada a ${role}`,
  });

  return NextResponse.json({ ok: true, status: 'granted' });
}
