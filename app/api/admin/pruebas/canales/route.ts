import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { db, mustWrite } from '@/lib/supabase/admin';
import { aE164 } from '@/lib/pruebas/numeros';

/**
 * POST /api/admin/pruebas/canales — nuestras líneas, editables sin desplegar.
 *
 * El número desde el que escribimos, su proveedor y su identificador son datos
 * de operación, no secretos: los cambia alguien del equipo comercial cuando
 * rota la línea, y esperar un despliegue para eso es absurdo (ADR 0014). La
 * llave de la API sigue siendo una variable de entorno, que es donde va un
 * secreto.
 *
 * `channel_uuid` no se valida contra el proveedor acá. La validación de verdad
 * es mandar un mensaje, y eso lo hace el botón de prueba de la pantalla: un
 * chequeo de formato daría una falsa sensación de que está bien configurado.
 *
 * `prioridad` es editable por la misma razón que todo lo demás de esta tabla:
 * cuál es la línea preferida es una decisión de operación y cambia sin código
 * (ADR 0028). El menor gana.
 */

export const runtime = 'nodejs';

const Canal = z.object({
  id: z.string().uuid().nullish(),
  label: z.string().trim().min(2).max(80),
  // Sin default: una línea nueva sin proveedor explícito es un formulario mal
  // armado, y adivinar el proveedor es adivinar por qué API va a salir el
  // mensaje. El formulario manda el valor siempre.
  provider: z.enum(['wzap', 'callbell']),
  phone: z.string().trim().min(7).max(30),
  channelUuid: z.string().trim().min(8).max(80),
  templateUuid: z.string().trim().max(80).nullish(),
  prioridad: z.number().int().min(0).max(9999).nullish(),
  activo: z.boolean(),
  notas: z.string().max(500).nullish(),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Canal.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Petición inválida' }, { status: 400 });
  }

  const e164 = aE164(parsed.data.phone, 'CO');
  if (!e164) {
    return NextResponse.json(
      { error: 'El número no se pudo interpretar. Escribilo con indicativo: +57 305 418 2637.' },
      { status: 400 },
    );
  }

  const fila = {
    label: parsed.data.label,
    provider: parsed.data.provider,
    phone_e164: e164,
    channel_uuid: parsed.data.channelUuid,
    template_uuid: parsed.data.templateUuid?.trim() || null,
    prioridad: parsed.data.prioridad ?? 100,
    activo: parsed.data.activo,
    notas: parsed.data.notas ?? null,
  };

  if (parsed.data.id) {
    await mustWrite(
      db().from('smoke_channels').update(fila).eq('id', parsed.data.id),
      'smoke_channels.update',
    );
    return NextResponse.json({ ok: true, id: parsed.data.id });
  }

  const { data, error } = await db()
    .from('smoke_channels')
    // Clave plana `(provider, channel_uuid)`: el índice único no tiene `where`
    // ni funciones, así que Postgres lo puede usar de árbitro (ADR 0015).
    .upsert(fila, { onConflict: 'provider,channel_uuid' })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

export async function DELETE(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'falta id' }, { status: 400 });

  // No se borra: se apaga. Las pruebas viejas apuntan al canal con una clave
  // foránea, y borrarlo se llevaría por delante el historial que justamente
  // sirve para comparar contra las pruebas nuevas.
  await mustWrite(
    db().from('smoke_channels').update({ activo: false }).eq('id', id),
    'smoke_channels.apagar',
  );
  return NextResponse.json({ ok: true, apagado: true });
}
