import { consoleActor } from '@/lib/auth/console';
import { buildResultsBook, bookToCSV } from '@/lib/finance/book';
import { periodoActual } from '@/lib/finance/economics';

/**
 * GET /api/libro/[orgId]?periodo=2026-08&formato=csv — el libro de resultados.
 *
 * El CSV y la pantalla imprimible leen el MISMO objeto (`buildResultsBook`).
 * No hay dos caminos de cálculo, así que "el PDF y el CSV traen los mismos
 * números" no es algo que haya que verificar en cada cambio: es cierto por
 * construcción.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const url = new URL(request.url);
  const periodo = url.searchParams.get('periodo') ?? periodoActual();
  const formato = url.searchParams.get('formato') ?? 'csv';

  const actor = await consoleActor(orgId);
  if (!actor) return new Response('No autorizado', { status: 401 });

  if (!/^\d{4}-\d{2}$/.test(periodo)) {
    return new Response('El periodo va en formato AAAA-MM', { status: 400 });
  }

  const book = await buildResultsBook(orgId, periodo);

  if (formato === 'json') {
    return Response.json(book);
  }

  // El BOM es lo que hace que Excel en Windows abra las tildes bien. Sin él,
  // "Ángulo" se ve "Ãngulo" y el cliente asume que el archivo está roto.
  const csv = `﻿${bookToCSV(book)}`;

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="libro-de-resultados-${periodo}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
