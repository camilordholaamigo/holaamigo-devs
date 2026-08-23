import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentAdmin } from '@/lib/auth/admin';
import { db, mustWrite } from '@/lib/supabase/admin';
import { slugify } from '@/lib/utils';

/**
 * POST /api/admin/pruebas/plantillas — editar y crear moldes de prueba.
 *
 * Las tres de fábrica —servicio, faq, ventas— se pueden editar como cualquier
 * otra: la migración las siembra con `on conflict do nothing` justamente para
 * que correrla otra vez no borre lo que el equipo ajustó.
 *
 * El molde define lo que NO depende del cliente: qué quiere medir, con qué
 * identidad se escribe, cuándo se da por terminada y cómo se califica. Lo que
 * sí depende del cliente lo agrega el compilador leyendo el research. Por eso
 * las preguntas de acá son genéricas y está bien que lo sean: si el sitio del
 * prospecto anuncia un evento, la pregunta por el evento la escribe el
 * compilador, no esta pantalla.
 */

export const runtime = 'nodejs';

const Sonda = z.object({
  id: z.string().trim().min(1).max(40),
  pregunta: z.string().trim().min(3).max(300),
  por_que: z.string().trim().max(300),
});

const Criterio = z.object({
  id: z.string().trim().min(1).max(40),
  dimension: z.string().trim().min(1).max(40),
  criterio: z.string().trim().min(3).max(200),
  peso: z.number().int().min(1).max(10),
  /** El mini-lenguaje. Se valida la forma, no el contenido: un chequeo que
   *  apunta a una clave inexistente se resuelve a null y pasa a la capa 3. */
  chequeo: z.string().trim().max(120).nullable(),
});

const Plantilla = z.object({
  id: z.string().trim().max(60).nullish(),
  nombre: z.string().trim().min(2).max(80),
  descripcion: z.string().trim().max(400),
  que_mide: z.string().trim().max(300),
  objetivo: z.string().trim().min(5).max(500),
  persona: z.object({
    nombre: z.string().trim().max(80),
    correo: z.string().trim().max(120),
    telefono: z.string().trim().max(30),
    ciudad: z.string().trim().max(60),
    presupuesto: z.string().trim().max(80).nullish(),
  }),
  apertura: z.string().trim().min(5).max(400),
  sondas: z.array(Sonda).min(1).max(8),
  rubrica: z.array(Criterio).min(1).max(12),
  criterios_cierre: z.array(z.string().trim().min(3).max(200)).min(1).max(8),
  max_turnos: z.number().int().min(2).max(40),
  activo: z.boolean(),
});

export async function POST(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const parsed = Plantilla.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Petición inválida', detalle: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  const d = parsed.data;
  const id = d.id?.trim() || slugify(d.nombre).slice(0, 60);
  if (!id) return NextResponse.json({ error: 'No se pudo derivar un id' }, { status: 400 });

  const fila = {
    id,
    nombre: d.nombre,
    descripcion: d.descripcion,
    que_mide: d.que_mide,
    objetivo: d.objetivo,
    persona: d.persona,
    apertura: d.apertura,
    sondas: d.sondas,
    rubrica: d.rubrica,
    criterios_cierre: d.criterios_cierre,
    max_turnos: d.max_turnos,
    activo: d.activo,
  };

  const { error } = await db().from('smoke_templates').upsert(fila, { onConflict: 'id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, id });
}

export async function DELETE(request: Request) {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'falta id' }, { status: 400 });

  // Se apaga, no se borra: `smoke_probes.template_id` la referencia, y borrarla
  // se llevaría el historial. Una plantilla apagada no aparece para crear
  // pruebas nuevas y las viejas se siguen leyendo.
  await mustWrite(
    db().from('smoke_templates').update({ activo: false }).eq('id', id),
    'smoke_templates.apagar',
  );
  return NextResponse.json({ ok: true, apagada: true });
}
