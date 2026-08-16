import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consoleActor } from '@/lib/auth/console';
import { connectInstantly, listLeadLists, importList } from '@/lib/integrations/instantly';
import { clientIp } from '@/lib/utils';
import { track } from '@/lib/events';

/**
 * Instantly: conectar, listar y traer.
 *
 * POST  → guarda la API key y la prueba contra el API.
 * GET   → lista las listas de leads disponibles.
 * PUT   → importa una lista a nuestra base.
 *
 * La importación EXIGE base legal, igual que el drag & drop de un CSV. Que los
 * contactos vengan por API no los hace más contactables: la obligación de
 * Habeas Data es sobre a quién le escribimos, no sobre cómo llegó el archivo.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const ConnectBody = z.object({
  organizationId: z.string().uuid(),
  apiKey: z.string().min(8).max(400),
});

export async function POST(request: Request) {
  const parsed = ConnectBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const result = await connectInstantly(parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { error: `No pudimos conectar con Instantly: ${result.error}` },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function GET(request: Request) {
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? '';
  const actor = await consoleActor(organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  return NextResponse.json({ lists: await listLeadLists(organizationId) });
}

const ImportBody = z.object({
  organizationId: z.string().uuid(),
  listId: z.string().min(1).max(120),
  listName: z.string().max(200),
  consentBasis: z.enum(['existing_relationship', 'opt_in', 'legitimate_interest']),
  country: z.string().length(2).nullish(),
});

export async function PUT(request: Request) {
  const parsed = ImportBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Falta la lista o la base legal del contacto.' },
      { status: 400 },
    );
  }

  const actor = await consoleActor(parsed.data.organizationId);
  if (!actor) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const result = await importList({
    organizationId: parsed.data.organizationId,
    listId: parsed.data.listId,
    listName: parsed.data.listName,
    consentBasis: parsed.data.consentBasis,
    consentIp: clientIp(request.headers),
    country: parsed.data.country ?? null,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await track('leads_uploaded', {
    organizationId: parsed.data.organizationId,
    props: { source: 'instantly', list: parsed.data.listName, imported: result.imported },
  });

  return NextResponse.json({ ok: true, imported: result.imported, batchId: result.batchId });
}
