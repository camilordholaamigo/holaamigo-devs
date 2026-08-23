import { db, mustWrite, tryWrite } from '@/lib/supabase/admin';
import { readSetting } from '@/lib/settings';
import { track } from '@/lib/events';
import { authorize } from '@/lib/governance/authorize';
import { canalActivo, hayTransporte } from '@/lib/pruebas/callbell';
import { compilarPrueba, plantilla } from '@/lib/pruebas/compilar';
import { arrancarPrueba, cancelarVivasContra, progreso } from '@/lib/pruebas/motor';
import { numerosDelResearch, registrarObjetivos, aE164 } from '@/lib/pruebas/numeros';
import type { PlanDePrueba, TargetRow } from '@/lib/pruebas/types';

/**
 * Quién arranca las pruebas, contra quién, y con qué frenos.
 *
 * Es la parte del smoke tester con más reglas y ninguna es arbitraria: cada
 * una es un mensaje de WhatsApp real, mandado desde nuestro número, a un
 * negocio que no nos escribió primero. Los frenos son, en orden de dureza:
 *
 *   1. `authorize()`. Escribirle a un tercero es `external_comms` y pasa por
 *      el catálogo o no pasa (ADR 0018).
 *   2. El número tiene que estar publicado EN EL SITIO DE ESA ORGANIZACIÓN.
 *      En el camino automático no hay forma de apuntarle a otro lado, y eso
 *      es lo que hace defendible el mensaje: le estamos escribiendo al dueño
 *      del número, no a un tercero.
 *   3. Enfriamiento. No se le vuelve a escribir al mismo número antes de las
 *      72 horas, aunque alguien recargue la landing cinco veces.
 *   4. Bloqueo. Un número que pidió no ser contactado no se desbloquea solo,
 *      ni volviendo a correr el diagnóstico.
 *
 * Ver docs/adr/0025-el-smoke-tester-como-evidencia.md
 */

export const CLAVE_CONFIG = 'pruebas.bateria';

interface Config {
  /** Qué pruebas se corren contra el número principal, en orden. */
  bateria: string[];
  /** Qué se corre contra los números secundarios. Menos, porque cuesta. */
  bateria_secundaria: string[];
  max_numeros: number;
  enfriamiento_horas: number;
  /** Apagado de emergencia sin desplegar. */
  activo: boolean;
}

const POR_DEFECTO: Config = {
  // Orden deliberado: `servicio` primero porque produce en dos minutos el dato
  // que el cliente va a leer —cuánto tardaron en contestar— y el cliente está
  // mirando la pantalla. `ventas` de última porque es la más larga.
  bateria: ['servicio', 'faq', 'ventas'],
  bateria_secundaria: ['servicio'],
  max_numeros: 3,
  enfriamiento_horas: 72,
  activo: true,
};

export async function configDePruebas(): Promise<Config> {
  const raw = await readSetting(CLAVE_CONFIG);
  return {
    bateria: arreglo(raw.bateria) ?? POR_DEFECTO.bateria,
    bateria_secundaria: arreglo(raw.bateria_secundaria) ?? POR_DEFECTO.bateria_secundaria,
    max_numeros: entero(raw.max_numeros, 1, 5) ?? POR_DEFECTO.max_numeros,
    enfriamiento_horas: entero(raw.enfriamiento_horas, 0, 720) ?? POR_DEFECTO.enfriamiento_horas,
    activo: typeof raw.activo === 'boolean' ? raw.activo : POR_DEFECTO.activo,
  };
}

const arreglo = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0
    ? (v as string[])
    : null;

const entero = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// EL CAMINO AUTOMÁTICO
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoLanzamiento {
  runId: string | null;
  pruebas: number;
  numeros: string[];
  /** Por qué no se lanzó nada. Se muestra en el admin, no al cliente. */
  motivo: string | null;
}

/**
 * Se llama al terminar el research, no al terminar el quiz.
 *
 * Es el primer instante en que existen las dos cosas que hacen falta: los
 * números publicados y el material para especializar las preguntas. Y es
 * cuatro o cinco minutos antes de que el cliente llegue al diagnóstico, que es
 * exactamente la ventaja que necesitamos — cuando llega, la primera prueba ya
 * tiene respuesta o ya sabemos que no la va a tener.
 *
 * NUNCA LANZA. Si algo sale mal, el diagnóstico del cliente sigue entero y el
 * motivo queda escrito.
 */
export async function lanzarDesdeElDiagnostico(args: {
  organizationId: string;
  sessionId: string | null;
}): Promise<ResultadoLanzamiento> {
  const vacio = (motivo: string): ResultadoLanzamiento => ({
    runId: null,
    pruebas: 0,
    numeros: [],
    motivo,
  });

  try {
    const config = await configDePruebas();
    if (!config.activo) return vacio('las pruebas están apagadas en settings');
    if (!hayTransporte()) return vacio('falta CALLBELL_API_KEY');

    const canal = await canalActivo();
    if (!canal) return vacio('no hay ningún canal activo en /admin/pruebas');

    // La correa. Un `blocked` acá no es un error: es el sistema funcionando.
    const auth = await authorize({
      organizationId: args.organizationId,
      capabilityId: 'smoketest.probe',
      title: 'Probar la línea de WhatsApp del prospecto',
      payload: { canal: canal.phone_e164 },
    });
    if (auth.accion_permitida !== 'ejecutar') {
      return vacio(`gobierno: ${auth.verdict} — ${auth.reason}`);
    }

    const { numeros, negocio } = await numerosDelResearch(args.organizationId);
    if (numeros.length === 0) {
      // Que el sitio no publique ningún número es un HALLAZGO, no un fallo, y
      // se le cuenta al cliente tal cual. Se registra para poder medirlo.
      await track('smoke_sin_numeros', {
        organizationId: args.organizationId,
        sessionId: args.sessionId,
      });
      return vacio('el sitio no publica ningún número de WhatsApp');
    }

    await registrarObjetivos(args.organizationId, numeros.slice(0, config.max_numeros), negocio);

    const objetivos = await objetivosDisponibles(
      args.organizationId,
      numeros.slice(0, config.max_numeros).map((n) => n.phone_e164),
      config.enfriamiento_horas,
    );

    if (objetivos.length === 0) {
      return vacio('todos los números están bloqueados o en enfriamiento');
    }

    return await crearRun({
      organizationId: args.organizationId,
      sessionId: args.sessionId,
      origen: 'diagnostico',
      canalId: canal.id,
      objetivos: objetivos.map((t, i) => ({
        target: t,
        plantillas: i === 0 ? config.bateria : config.bateria_secundaria,
      })),
    });
  } catch (err) {
    console.error('[pruebas] el lanzamiento automático falló', err);
    return vacio(err instanceof Error ? err.message.slice(0, 200) : 'error desconocido');
  }
}

/**
 * Filtra por bloqueo y enfriamiento.
 *
 * El enfriamiento se mira sobre la tabla y no sobre la memoria del proceso
 * porque Vercel corre varias instancias: dos peticiones simultáneas de la misma
 * landing tienen que ver el mismo estado.
 */
async function objetivosDisponibles(
  organizationId: string,
  telefonos: string[],
  enfriamientoHoras: number,
): Promise<TargetRow[]> {
  const { data } = await db()
    .from('smoke_targets')
    .select('*')
    .in('phone_e164', telefonos);

  const corte = Date.now() - enfriamientoHoras * 3_600_000;

  return ((data ?? []) as TargetRow[]).filter((t) => {
    if (t.bloqueado) return false;
    if (t.ultima_prueba_at && Date.parse(t.ultima_prueba_at) > corte) return false;
    // Doble llave sobre el camino automático: el número tiene que pertenecer a
    // la organización que acaba de pedir el diagnóstico. Si el research lo
    // encontró en otro sitio, no le escribimos.
    return t.organization_id === organizationId;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CAMINO MANUAL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Una prueba creada desde el admin, con o sin diagnóstico detrás.
 *
 * Acá NO hay filtro de propiedad del número: lo eligió una persona y esa
 * persona responde por él. Sí hay bloqueo —un número que pidió que no le
 * escribamos no se prueba ni a mano— porque eso no es una política nuestra,
 * es lo que pidió el que está del otro lado.
 */
export async function lanzarDesdeAdmin(args: {
  organizationId: string | null;
  telefono: string;
  nombre: string | null;
  plantillas: string[];
  canalId: string | null;
  contextoManual: string | null;
}): Promise<ResultadoLanzamiento & { error?: string }> {
  const e164 = aE164(args.telefono, 'CO');
  if (!e164) {
    return {
      runId: null,
      pruebas: 0,
      numeros: [],
      motivo: null,
      error: 'El número no se pudo interpretar. Escribilo con indicativo: +57 300 123 4567.',
    };
  }

  const canal = await canalActivo(args.canalId);
  if (!canal) {
    return {
      runId: null,
      pruebas: 0,
      numeros: [],
      motivo: null,
      error: 'No hay ningún canal activo. Configurá uno en la pestaña «Nuestra línea».',
    };
  }

  const { data: existente } = await db()
    .from('smoke_targets')
    .select('*')
    .eq('phone_e164', e164)
    .maybeSingle();

  if ((existente as TargetRow | null)?.bloqueado) {
    return {
      runId: null,
      pruebas: 0,
      numeros: [],
      motivo: null,
      error: `Ese número pidió que no le escribiéramos (${(existente as TargetRow).bloqueado_motivo ?? 'sin motivo'}). No se puede probar.`,
    };
  }

  const { data: target, error } = await db()
    .from('smoke_targets')
    .upsert(
      {
        // Si el admin no pasa organización, se conserva la que el número ya
        // tenía. Pisarla con null desasociaría un número del prospecto al que
        // pertenece solo porque alguien lo probó a mano.
        organization_id:
          args.organizationId ?? (existente as TargetRow | null)?.organization_id ?? null,
        nombre: args.nombre ?? (existente as TargetRow | null)?.nombre ?? null,
        phone_e164: e164,
        origen: 'manual' as const,
        source_url: (existente as TargetRow | null)?.source_url ?? null,
        confianza: 1,
      },
      { onConflict: 'phone_e164' },
    )
    .select('*')
    .single();

  if (error || !target) {
    return {
      runId: null,
      pruebas: 0,
      numeros: [],
      motivo: null,
      error: error?.message ?? 'no se pudo registrar el número',
    };
  }

  return await crearRun({
    organizationId: args.organizationId,
    sessionId: null,
    origen: 'manual',
    canalId: canal.id,
    contextoManual: args.contextoManual,
    objetivos: [{ target: target as TargetRow, plantillas: args.plantillas }],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CREAR
// ═══════════════════════════════════════════════════════════════════════════

async function crearRun(args: {
  organizationId: string | null;
  sessionId: string | null;
  origen: 'diagnostico' | 'manual';
  canalId: string;
  contextoManual?: string | null;
  objetivos: Array<{ target: TargetRow; plantillas: string[] }>;
}): Promise<ResultadoLanzamiento> {
  const { data: run, error } = await db()
    .from('smoke_runs')
    .insert({
      organization_id: args.organizationId,
      session_id: args.sessionId,
      origen: args.origen,
      estado: 'running',
      progress_log: [
        {
          t: new Date().toISOString(),
          step: 'inicio',
          detail:
            args.objetivos.length === 1
              ? `Vamos a escribirle a ${args.objetivos[0].target.phone_e164}`
              : `Vamos a escribirle a ${args.objetivos.length} números`,
        },
      ],
    })
    .select('id')
    .single();

  if (error || !run) throw new Error(error?.message ?? 'no se pudo crear la corrida');

  // Compilar es lo caro: una llamada al modelo por plantilla. Se hace de a
  // todas en paralelo porque son independientes y el cliente está esperando.
  const compilados = await Promise.all(
    args.objetivos.flatMap(({ target, plantillas }) =>
      plantillas.map(async (templateId) => {
        try {
          const molde = await plantilla(templateId);
          const plan = await compilarPrueba({
            plantilla: molde,
            organizationId: args.organizationId,
            contextoManual: args.contextoManual ?? null,
            nombreObjetivo: target.nombre,
          });
          return { target, templateId, plan };
        } catch (err) {
          console.error(`[pruebas] no se pudo compilar ${templateId}`, err);
          return null;
        }
      }),
    ),
  );

  const utiles = compilados.filter(
    (c): c is { target: TargetRow; templateId: string; plan: PlanDePrueba } => c !== null,
  );

  if (utiles.length === 0) {
    await tryWrite(
      db()
        .from('smoke_runs')
        .update({ estado: 'cancelled', finished_at: new Date().toISOString() })
        .eq('id', run.id),
      'smoke_runs.sin_pruebas',
    );
    return { runId: run.id, pruebas: 0, numeros: [], motivo: 'no se pudo compilar ninguna prueba' };
  }

  const filas = utiles.map(({ target, templateId, plan }) => ({
    run_id: run.id,
    target_id: target.id,
    template_id: templateId,
    channel_id: args.canalId,
    organization_id: args.organizationId,
    target_phone: target.phone_e164,
    plan,
    max_turnos: plan.max_turnos,
    estado: 'pending' as const,
  }));

  await mustWrite(db().from('smoke_probes').insert(filas), 'smoke_probes.insert');

  await progreso(
    run.id,
    'compilado',
    `${utiles.length} prueba${utiles.length === 1 ? '' : 's'} lista${utiles.length === 1 ? '' : 's'}`,
  );

  // Una conversación viva por número. En paralelo entre números —la
  // correlación del webhook es por número— y serial dentro de cada uno.
  const porNumero = new Map<string, string>();
  for (const { target } of utiles) {
    if (!porNumero.has(target.id)) porNumero.set(target.id, target.phone_e164);
  }

  for (const [targetId, telefono] of porNumero) {
    await cancelarVivasContra(telefono, run.id);
    const { data: primera } = await db()
      .from('smoke_probes')
      .select('id')
      .eq('run_id', run.id)
      .eq('target_id', targetId)
      .eq('estado', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (primera?.[0]) await arrancarPrueba(primera[0].id);
  }

  await track('smoke_run_started', {
    organizationId: args.organizationId,
    sessionId: args.sessionId,
    props: { origen: args.origen, pruebas: utiles.length, numeros: porNumero.size },
  });

  return {
    runId: run.id,
    pruebas: utiles.length,
    numeros: [...porNumero.values()],
    motivo: null,
  };
}
