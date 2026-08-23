import { db, mustWrite, tryWrite, unwrap } from '@/lib/supabase/admin';
import { track } from '@/lib/events';
import { authorize } from '@/lib/governance/authorize';
import { canalActivo, hayTransporte } from '@/lib/pruebas/callbell';
import { compilarPrueba, plantilla } from '@/lib/pruebas/compilar';
import { arrancarPrueba, cancelarVivasContra } from '@/lib/pruebas/motor';
import { aE164 } from '@/lib/pruebas/numeros';
import type { PlanDePrueba, TargetRow } from '@/lib/pruebas/types';

/**
 * El lote: la misma batería contra muchas líneas, con freno.
 *
 * ── POR QUÉ EL TOPE NO ES AFINACIÓN ────────────────────────────────────────
 *
 * Treinta clientes por tres pruebas son noventa conversaciones abiertas desde
 * UNA línea de WhatsApp en el mismo minuto. Para el clasificador de Meta eso
 * no se parece a un negocio: se parece a un emisor de spam. Lo que se pierde
 * cuando eso sale mal no es un lote — es el número, y un número quemado no se
 * recupera con un rollback.
 *
 * Por eso `max_concurrentes` (cuántas vivas a la vez) y `ritmo_segundos`
 * (cuánto entre dos arranques) son columnas de la tabla y no constantes: se
 * bajan en caliente el día que algo huela mal, sin desplegar.
 *
 * ── QUIÉN EMPUJA LA COLA ───────────────────────────────────────────────────
 *
 * `avanzarLote()` es idempotente y lo llaman tres cosas: la creación del lote,
 * el cierre de cada prueba, y la pantalla del admin mientras alguien la mira.
 * Es el mismo patrón que `avanzarCola()` en el motor, y por la misma razón:
 * en serverless nadie puede quedarse esperando a que la cola avance sola.
 *
 * La diferencia con `avanzarCola` es que acá SÍ se duerme entre arranques.
 * Está acotado por presupuesto de reloj (`PRESUPUESTO_MS`) y es el único
 * camino donde dormir es correcto: no estamos esperando un evento externo,
 * estamos espaciando a propósito nuestros propios envíos. Si se acaba el
 * presupuesto, la función se retira y el siguiente que pase sigue donde quedó.
 *
 * Ver docs/adr/0026-el-lote-y-el-informe.md
 */

/** Cuánto puede durar una invocación empujando la cola. El techo de la
 *  plataforma es 300 s; se deja margen para el arranque que quede a medias. */
const PRESUPUESTO_MS = 200_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LoteRow {
  id: string;
  nombre: string;
  proposito: 'qa' | 'prospeccion';
  estado: 'running' | 'paused' | 'done' | 'cancelled';
  max_concurrentes: number;
  ritmo_segundos: number;
  creado_por: string | null;
  notas: string | null;
  progress_log: Array<{ t: string; step: string; detail: string }>;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface EstadoDelLote {
  total: number;
  pendientes: number;
  corriendo: number;
  cerradas: number;
  sin_respuesta: number;
  fallidas: number;
  organizaciones: number;
  ultimo_arranque: string | null;
}

export interface ObjetivoDeLote {
  organizationId: string | null;
  telefono: string;
  nombre: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CREAR
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoLote {
  loteId: string | null;
  pruebas: number;
  omitidos: Array<{ telefono: string; motivo: string }>;
  error?: string;
}

export async function crearLote(args: {
  nombre: string;
  proposito: 'qa' | 'prospeccion';
  objetivos: ObjetivoDeLote[];
  plantillas: string[];
  maxConcurrentes: number;
  ritmoSegundos: number;
  canalId: string | null;
  creadoPor: string;
  notas?: string | null;
}): Promise<ResultadoLote> {
  if (!hayTransporte()) {
    return { loteId: null, pruebas: 0, omitidos: [], error: 'Falta CALLBELL_API_KEY.' };
  }

  const canal = await canalActivo(args.canalId);
  if (!canal) {
    return { loteId: null, pruebas: 0, omitidos: [], error: 'No hay ningún canal activo.' };
  }

  const omitidos: ResultadoLote['omitidos'] = [];
  const objetivos = await resolverObjetivos(args.objetivos, args.proposito, omitidos);

  if (objetivos.length === 0) {
    return {
      loteId: null,
      pruebas: 0,
      omitidos,
      error: 'Ningún número quedó disponible. Revisá los motivos.',
    };
  }

  const { data: lote, error } = await db()
    .from('smoke_batches')
    .insert({
      nombre: args.nombre,
      proposito: args.proposito,
      estado: 'running',
      max_concurrentes: args.maxConcurrentes,
      ritmo_segundos: args.ritmoSegundos,
      creado_por: args.creadoPor,
      notas: args.notas ?? null,
      progress_log: [
        {
          t: new Date().toISOString(),
          step: 'inicio',
          detail: `${objetivos.length} línea${objetivos.length === 1 ? '' : 's'} · ${args.plantillas.length} prueba${args.plantillas.length === 1 ? '' : 's'} cada una`,
        },
      ],
    })
    .select('id')
    .single();

  if (error || !lote) {
    return { loteId: null, pruebas: 0, omitidos, error: error?.message ?? 'no se pudo crear el lote' };
  }

  // Compilar es lo caro: una llamada al modelo por (objetivo × plantilla). Van
  // en paralelo porque son independientes, y si una falla se omite ese par en
  // vez de tumbar el lote entero — un lote de treinta clientes que muere en el
  // cuarto por un research incompleto no sirve para nada.
  const compilados = (
    await Promise.all(
      objetivos.flatMap((target) =>
        args.plantillas.map(async (templateId) => {
          try {
            const molde = await plantilla(templateId);
            const plan = await compilarPrueba({
              plantilla: molde,
              organizationId: target.organization_id,
              nombreObjetivo: target.nombre,
            });
            return { target, templateId, plan };
          } catch (err) {
            console.error(`[lote] no se pudo compilar ${templateId} para ${target.phone_e164}`, err);
            omitidos.push({
              telefono: target.phone_e164,
              motivo: `no se pudo compilar ${templateId}`,
            });
            return null;
          }
        }),
      ),
    )
  ).filter((c): c is { target: TargetRow; templateId: string; plan: PlanDePrueba } => c !== null);

  if (compilados.length === 0) {
    await tryWrite(
      db()
        .from('smoke_batches')
        .update({ estado: 'cancelled', finished_at: new Date().toISOString() })
        .eq('id', lote.id),
      'smoke_batches.sin_pruebas',
    );
    return { loteId: lote.id, pruebas: 0, omitidos, error: 'No se pudo compilar ninguna prueba.' };
  }

  // Un solo run por lote: el `run` agrupa lo que el cliente ve en su informe y
  // el `batch` lo que nosotros vemos en la pantalla de operación. Son dos
  // preguntas distintas sobre las mismas filas.
  const porOrg = new Map<string | null, string>();
  for (const { target } of compilados) {
    if (porOrg.has(target.organization_id)) continue;
    const { data: run } = await db()
      .from('smoke_runs')
      .insert({
        organization_id: target.organization_id,
        origen: 'manual',
        estado: 'running',
      })
      .select('id')
      .single();
    if (run) porOrg.set(target.organization_id, run.id);
  }

  const filas = compilados
    .filter(({ target }) => porOrg.has(target.organization_id))
    .map(({ target, templateId, plan }) => ({
      run_id: porOrg.get(target.organization_id)!,
      batch_id: lote.id,
      target_id: target.id,
      template_id: templateId,
      channel_id: canal.id,
      organization_id: target.organization_id,
      target_phone: target.phone_e164,
      plan,
      max_turnos: plan.max_turnos,
      estado: 'pending' as const,
    }));

  await mustWrite(db().from('smoke_probes').insert(filas), 'smoke_probes.lote');

  await progresoDeLote(lote.id, 'compilado', `${filas.length} pruebas listas para arrancar`);

  await track('smoke_batch_started', {
    props: {
      proposito: args.proposito,
      pruebas: filas.length,
      lineas: objetivos.length,
      max_concurrentes: args.maxConcurrentes,
    },
  });

  await avanzarLote(lote.id);

  return { loteId: lote.id, pruebas: filas.length, omitidos };
}

/**
 * Filtra los objetivos y deja escrito por qué se cayó cada uno.
 *
 * Los motivos importan tanto como el resultado: un lote que arranca con 18 de
 * 30 sin decir qué pasó con los otros 12 es un lote que nadie va a volver a
 * usar. Se muestran en la pantalla, uno por uno.
 */
async function resolverObjetivos(
  entrada: ObjetivoDeLote[],
  proposito: 'qa' | 'prospeccion',
  omitidos: ResultadoLote['omitidos'],
): Promise<TargetRow[]> {
  const salida: TargetRow[] = [];
  const vistos = new Set<string>();

  for (const o of entrada) {
    const e164 = aE164(o.telefono, 'CO');
    if (!e164) {
      omitidos.push({ telefono: o.telefono, motivo: 'número ilegible' });
      continue;
    }
    if (vistos.has(e164)) continue;
    vistos.add(e164);

    // La correa, por organización. En `qa` el cliente nos contrató y el
    // catálogo lo refleja; en `prospeccion` puede bloquear, y ese bloqueo es
    // el sistema funcionando, no un error.
    if (o.organizationId) {
      const auth = await authorize({
        organizationId: o.organizationId,
        capabilityId: 'smoketest.probe',
        title: `Probar la línea (${proposito})`,
        payload: { proposito, telefono: e164 },
      });
      if (auth.accion_permitida !== 'ejecutar') {
        omitidos.push({ telefono: e164, motivo: `gobierno: ${auth.verdict}` });
        continue;
      }
    }

    const { data: existente } = await db()
      .from('smoke_targets')
      .select('*')
      .eq('phone_e164', e164)
      .maybeSingle();

    const previo = existente as TargetRow | null;

    // El bloqueo vale para los dos propósitos, y no lo levanta un lote. Es lo
    // que pidió el que está del otro lado, no una política nuestra.
    if (previo?.bloqueado) {
      omitidos.push({ telefono: e164, motivo: 'pidió que no le escribiéramos' });
      continue;
    }

    const { data: target, error } = await db()
      .from('smoke_targets')
      .upsert(
        {
          organization_id: o.organizationId ?? previo?.organization_id ?? null,
          nombre: o.nombre ?? previo?.nombre ?? null,
          phone_e164: e164,
          origen: previo?.origen ?? 'manual',
          source_url: previo?.source_url ?? null,
          confianza: previo?.confianza ?? 1,
        },
        { onConflict: 'phone_e164' },
      )
      .select('*')
      .single();

    if (error || !target) {
      omitidos.push({ telefono: e164, motivo: 'no se pudo registrar' });
      continue;
    }

    salida.push(target as TargetRow);
  }

  return salida;
}

// ═══════════════════════════════════════════════════════════════════════════
// AVANZAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arranca lo que quepa dentro del tope, respetando el ritmo.
 *
 * Idempotente y seguro de llamar en paralelo: si dos invocaciones se cruzan,
 * la segunda ve las conversaciones que abrió la primera y le queda menos cupo.
 * Se puede pasar de uno o dos por una carrera, y eso es aceptable: el daño de
 * abrir una conversación de más es una conversación de más.
 */
export async function avanzarLote(loteId: string): Promise<{ arrancadas: number }> {
  const lote = await leerLote(loteId);
  if (lote.estado !== 'running') return { arrancadas: 0 };

  const hasta = Date.now() + PRESUPUESTO_MS;
  let arrancadas = 0;

  while (Date.now() < hasta) {
    const estado = await estadoDelLote(loteId);

    if (estado.pendientes === 0) {
      if (estado.corriendo === 0) await cerrarLoteSiTerminó(loteId);
      break;
    }
    if (estado.corriendo >= lote.max_concurrentes) break;

    // El ritmo se mide contra el último arranque REAL del lote, no contra un
    // contador en memoria: dos invocaciones simultáneas tienen que ver el
    // mismo espaciado.
    if (estado.ultimo_arranque && lote.ritmo_segundos > 0) {
      const desde = Date.now() - Date.parse(estado.ultimo_arranque);
      const falta = lote.ritmo_segundos * 1000 - desde;
      if (falta > 0) {
        if (Date.now() + falta > hasta) break;
        await sleep(falta);
      }
    }

    const siguiente = await siguientePendiente(loteId);
    if (!siguiente) break;

    // Serial por número lo garantiza el motor; acá se garantiza que no
    // arranquemos una prueba contra una línea que ya tiene otra viva de otro
    // lote. Dos conversaciones en el mismo hilo de WhatsApp no miden nada.
    await cancelarVivasContra(siguiente.target_phone, siguiente.run_id);

    const r = await arrancarPrueba(siguiente.id);
    if (r.ok) {
      arrancadas += 1;
      await progresoDeLote(loteId, 'arranque', `Escribimos a ${siguiente.target_phone}`);
    }
  }

  return { arrancadas };
}

/**
 * La siguiente pendiente cuya línea esté libre.
 *
 * El filtro por línea ocupada se hace en la aplicación y no en SQL porque son
 * dos consultas chicas contra índices parciales, y la alternativa —un `not
 * exists` correlacionado sobre `smoke_probes`— no puede usar el índice parcial
 * de `estado in ('pending','running')` y termina barriendo la tabla entera
 * cuando haya historial.
 */
async function siguientePendiente(
  loteId: string,
): Promise<{ id: string; target_phone: string; run_id: string } | null> {
  const { data: ocupadas } = await db()
    .from('smoke_probes')
    .select('target_phone')
    .eq('estado', 'running');

  const bloqueadas = new Set((ocupadas ?? []).map((o) => o.target_phone));

  const { data: pendientes } = await db()
    .from('smoke_probes')
    .select('id, target_phone, run_id')
    .eq('batch_id', loteId)
    .eq('estado', 'pending')
    .order('created_at', { ascending: true })
    .limit(60);

  return (pendientes ?? []).find((p) => !bloqueadas.has(p.target_phone)) ?? null;
}

export async function cerrarLoteSiTerminó(loteId: string): Promise<void> {
  const estado = await estadoDelLote(loteId);
  if (estado.pendientes > 0 || estado.corriendo > 0) return;

  await tryWrite(
    db()
      .from('smoke_batches')
      .update({ estado: 'done', finished_at: new Date().toISOString() })
      .eq('id', loteId)
      .eq('estado', 'running'),
    'smoke_batches.done',
  );
  await progresoDeLote(loteId, 'fin', `${estado.cerradas} conversaciones cerradas`);
}

// ═══════════════════════════════════════════════════════════════════════════
// LEER
// ═══════════════════════════════════════════════════════════════════════════

export async function leerLote(loteId: string): Promise<LoteRow> {
  return unwrap(
    await db().from('smoke_batches').select('*').eq('id', loteId).single(),
    'smoke_batches.get',
  ) as LoteRow;
}

export async function estadoDelLote(loteId: string): Promise<EstadoDelLote> {
  const { data, error } = await db().rpc('estado_del_lote', { p_batch: loteId });
  if (error || !data?.[0]) {
    return {
      total: 0,
      pendientes: 0,
      corriendo: 0,
      cerradas: 0,
      sin_respuesta: 0,
      fallidas: 0,
      organizaciones: 0,
      ultimo_arranque: null,
    };
  }
  const f = data[0] as Record<string, unknown>;
  const n = (k: string) => Number(f[k] ?? 0);
  return {
    total: n('total'),
    pendientes: n('pendientes'),
    corriendo: n('corriendo'),
    cerradas: n('cerradas'),
    sin_respuesta: n('sin_respuesta'),
    fallidas: n('fallidas'),
    organizaciones: n('organizaciones'),
    ultimo_arranque: (f.ultimo_arranque as string | null) ?? null,
  };
}

export async function lotesRecientes(limite = 20): Promise<LoteRow[]> {
  const { data } = await db()
    .from('smoke_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limite);
  return (data ?? []) as LoteRow[];
}

/**
 * Los números que ya conocemos de un conjunto de organizaciones.
 *
 * Es lo que hace usable el lote de QA: en vez de pegar treinta teléfonos a
 * mano, se eligen las organizaciones y los números salen de `smoke_targets`,
 * que es donde el research los dejó con su fuente. No inventa ninguno.
 */
export async function objetivosDeOrganizaciones(
  orgIds: string[],
): Promise<ObjetivoDeLote[]> {
  if (orgIds.length === 0) return [];

  const { data } = await db()
    .from('smoke_targets')
    .select('organization_id, phone_e164, nombre, bloqueado, confianza')
    .in('organization_id', orgIds)
    .eq('bloqueado', false)
    .order('confianza', { ascending: false });

  // Uno por organización: el de mayor confianza. Probar las tres líneas de
  // cada uno de treinta clientes son noventa conversaciones, y el lote de QA
  // quiere cobertura amplia, no profundidad por cliente.
  const porOrg = new Map<string, ObjetivoDeLote>();
  for (const t of data ?? []) {
    if (!t.organization_id || porOrg.has(t.organization_id)) continue;
    porOrg.set(t.organization_id, {
      organizationId: t.organization_id,
      telefono: t.phone_e164,
      nombre: t.nombre,
    });
  }
  return [...porOrg.values()];
}

// ═══════════════════════════════════════════════════════════════════════════

export async function pausarLote(loteId: string, estado: 'paused' | 'running' | 'cancelled') {
  await mustWrite(
    db()
      .from('smoke_batches')
      .update({
        estado,
        finished_at: estado === 'cancelled' ? new Date().toISOString() : null,
      })
      .eq('id', loteId),
    'smoke_batches.estado',
  );

  // Cancelar el lote cancela lo que todavía no arrancó. Lo que ya está
  // conversando se deja terminar: cortar a mitad una conversación con un
  // negocio real es peor que gastar los tres mensajes que faltan.
  if (estado === 'cancelled') {
    await tryWrite(
      db()
        .from('smoke_probes')
        .update({
          estado: 'cancelled',
          motivo_cierre: 'El lote se canceló antes de que esta prueba arrancara.',
          finished_at: new Date().toISOString(),
        })
        .eq('batch_id', loteId)
        .eq('estado', 'pending'),
      'smoke_probes.lote_cancelado',
    );
  }
}

export async function progresoDeLote(
  loteId: string,
  step: string,
  detail: string,
): Promise<void> {
  try {
    const { data } = await db()
      .from('smoke_batches')
      .select('progress_log')
      .eq('id', loteId)
      .maybeSingle();

    const log = Array.isArray(data?.progress_log) ? data.progress_log : [];
    log.push({ t: new Date().toISOString(), step, detail });

    await tryWrite(
      db()
        .from('smoke_batches')
        .update({ progress_log: log.slice(-80) })
        .eq('id', loteId),
      'smoke_batches.progreso',
    );
  } catch (err) {
    console.error('[lote] no se pudo escribir progreso', err);
  }
}
