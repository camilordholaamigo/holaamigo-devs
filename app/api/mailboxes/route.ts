import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { consoleActor, belongsToOrg } from '@/lib/auth/console';
import { createMailbox, listMailboxes } from '@/lib/email/mailboxes';
import { isValidEmail } from '@/lib/utils';

/**
 * Bandejas del cliente.
 *
 * POST  → registra una dirección de envío y le asigna su alias de recepción.
 * PATCH → cambia tope diario, firma, estado.
 *
 * La dirección NO queda activa al crearla: SendGrid manda un correo de
 * verificación al dueño de esa casilla. Es correcto que no podamos
 * autoverificar una dirección ajena y no lo vamos a evadir.
 */

export const runtime = 'nodejs';

const CreateBody = z.object({
  organizationId: z.string().uuid(),
  address: z.string().max(254),
  displayName: z.string().max(120),
  dailyCap: z.number().int().min(0).max(2000).nullish(),
  purpose: z.enum(['outbound', 'inbound', 'both']).nullish(),
  signatureHtml: z.string().max(4000).nullish(),
  startWarmup: z.boolean().nullish(),
});

export async function POST(request: Request) {
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!isValidEmail(parsed.data.address)) {
    return NextResponse.json({ error: 'Esa dirección no parece válida.' }, { status: 400 });
  }

  try {
    const mailbox = await createMailbox({
      organizationId: parsed.data.organizationId,
      address: parsed.data.address,
      displayName: parsed.data.displayName,
      dailyCap: parsed.data.dailyCap ?? 40,
      purpose: parsed.data.purpose ?? 'both',
      signatureHtml: parsed.data.signatureHtml ?? null,
      startWarmup: parsed.data.startWarmup ?? true,
    });

    return NextResponse.json({
      ok: true,
      mailbox: {
        id: mailbox.id,
        address: mailbox.address,
        status: mailbox.status,
        inbound_address: mailbox.inbound_address,
      },
      next_step:
        'Revisa el correo de verificación que SendGrid le mandó a esa dirección. Hasta que se confirme, la bandeja no envía.',
    });
  } catch (err) {
    console.error('[mailboxes] fallo al crear', err);
    return NextResponse.json({ error: 'No pudimos registrar la bandeja.' }, { status: 500 });
  }
}

const PatchBody = z.object({
  organizationId: z.string().uuid(),
  id: z.string().uuid(),
  dailyCap: z.number().int().min(0).max(2000).nullish(),
  status: z.enum(['pending', 'warming', 'active', 'paused', 'blocked']).nullish(),
  displayName: z.string().max(120).nullish(),
  signatureHtml: z.string().max(4000).nullish(),
});

export async function PATCH(request: Request) {
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!(await belongsToOrg('mailboxes', parsed.data.id, parsed.data.organizationId))) {
    return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.dailyCap !== null && parsed.data.dailyCap !== undefined) {
    patch.daily_cap = parsed.data.dailyCap;
  }
  if (parsed.data.status) patch.status = parsed.data.status;
  if (parsed.data.displayName) patch.display_name = parsed.data.displayName;
  if (parsed.data.signatureHtml !== undefined && parsed.data.signatureHtml !== null) {
    patch.signature_html = parsed.data.signatureHtml;
  }

  const { error } = await db().from('mailboxes').update(patch).eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: 'No pudimos guardar.' }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function GET(request: Request) {
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? '';
  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  return NextResponse.json({ mailboxes: await listMailboxes(organizationId) });
}
