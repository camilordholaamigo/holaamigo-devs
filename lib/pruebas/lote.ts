import { db, mustWrite, tryWrite, unwrap } from '@/lib/supabase/admin';
import { track } from '@/lib/events';
import { authorize } from '@/lib/governance/authorize';
import { canalActivo, canalesActivos } from '@/lib/pruebas/callbell';
import { faltaParaLineas } from '@/lib/pruebas/transporte';
import {
  compilarPrueba,
  contextoDelNegocio,
  plantilla,
  resolverRubrica,
} from '@/lib/pruebas/compilar';
import { moldeDelModo, planALaMedida, validarAMedida, type EntradaAMedida } from '@/lib/pruebas/guion';
import { arrancarPrueba, cancelarVivasContra } from '@/lib/pruebas/motor';
import { aE164 } from '@/lib/pruebas/numeros';
import type { CanalRow, HechoDeReferencia, PlanDePrueba, TargetRow } from '@/lib/pruebas/types';

/**
 * El lote — en pantalla, LA PRUEBA: un guion contra N números desde M líneas.
 *
 * ── QUÉ ES UNA PRUEBA ──────────────────────────────────────────────────────
 *
 * Un guion, una lista de números y una lista de NUESTRAS líneas. El producto
 * cartesiano son las conversaciones, y eso es todo el modelo (ADR 0027):
 *
 *     1 número × 1 línea   una conversación suelta
 *     1 número × 3 líneas  tres clientes distintos escribiéndole a la vez
 *    30 números × 1 línea  el barrido de prospección
 *    30 números × 3 líneas lo mismo, tres veces más rápido
 *
 * Hasta ADR 0026 esto se llamaba «tanda» y solo modelaba la tercera fila. El
 * nombre describía el diseño viejo y por eso nadie entendía qué hacía el botón.
 *
 * El guion viene de uno de dos lugares, y al motor le da exactamente igual:
 *
 *     `plantillas`  moldes compilados contra el research (`compilar.ts`)
 *     `aMedida`     un plan escrito a mano en /admin/pruebas/nueva (`guion.ts`)
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

/**
 * Una unidad de guion dentro de la prueba.
 *
 * `molde` compila contra el research; `a-medida` usa el plan que escribió el
 * operador. Se modelan como un tipo y no como dos caminos paralelos porque río
 * abajo son lo mismo: un `PlanDePrueba` por (objetivo × unidad).
 */
type Unidad = { tipo: 'molde'; templateId: string } | { tipo: 'a-medida' };

// ═══════════════════════════════════════════════════════════════════════════
// CREAR
// ═══════════════════════════════════════════════════════════════════════════

export interface ResultadoLote {
  loteId: string | null;
  pruebas: number;
  /**
   * Los ids de las conversaciones creadas, en orden de arranque.
   *
   * Con una sola, la pantalla siguiente es la transcripción y no el grupo. Es la
   * mitad de la decisión 6 de ADR 0027: una herramienta que no deja ver lo que
   * acaba de hacer no se vuelve a usar.
   */
  conversaciones: string[];
  omitidos: Array<{ telefono: string; motivo: string }>;
  error?: string;
}

export async function crearLote(args: {
  nombre: string;
  proposito: 'qa' | 'prospeccion';
  objetivos: ObjetivoDeLote[];
  /**
   * Desde qué líneas nuestras. Una conversación por (objetivo × línea).
   *
   * Vacío o nulo = la primera activa, que es el comportamiento de siempre y el
   * que usa el camino automático del diagnóstico.
   */
  canales?: string[] | null;
  /** Camino A · moldes compilados contra el research de cada objetivo. */
  plantillas?: string[] | null;
  /** Camino B · el plan que escribió una persona. Excluye `plantillas`. */
  aMedida?: EntradaAMedida | null;
  maxConcurrentes: number;
  ritmoSegundos: number;
  creadoPor: string;
  notas?: string | null;
}): Promise<ResultadoLote> {
  const vacio = (error: string, omitidos: ResultadoLote['omitidos'] = []): ResultadoLote => ({
    loteId: null,
    pruebas: 0,
    conversaciones: [],
    omitidos,
    error,
  });

  // ── 1 · desde qué líneas ───────────────────────────────────────────────
  const canales = await resolverCanales(args.canales);
  if (canales.length === 0) {
    return vacio(
      'No hay ninguna línea activa desde la que escribir. Configurá una en «Nuestras líneas».',
    );
  }

  // Qué falta se pregunta DESPUÉS de saber por dónde va a salir el lote: cada
  // proveedor tiene su propia llave, y abortar por la del otro sería mentir.
  const falta = Object.keys(faltaParaLineas(canales));
  if (falta.length > 0) {
    return vacio(`Falta ${falta.join(', ')} para las líneas elegidas.`);
  }

  // ── 2 · qué se manda ──────────────────────────────────────────────────
  //
  // Se valida ACÁ y no solo en el cliente. La petición del cliente es un dato de
  // entrada, y del otro lado del botón hay mensajes de WhatsApp reales.
  if (args.aMedida) {
    const problema = validarAMedida(args.aMedida);
    if (problema) return vacio(problema);
  }
  const unidades: Unidad[] = args.aMedida
    ? [{ tipo: 'a-medida' }]
    : (args.plantillas ?? []).map((templateId) => ({ tipo: 'molde' as const, templateId }));

  if (unidades.length === 0) {
    return vacio('Elegí al menos un tipo de prueba, o escribí un guion.');
  }

  // ── 3 · a quién ───────────────────────────────────────────────────────
  const omitidos: ResultadoLote['omitidos'] = [];
  const objetivos = await resolverObjetivos(args.objetivos, args.proposito, omitidos);

  if (objetivos.length === 0) {
    return vacio('Ningún número quedó disponible. Revisá los motivos.', omitidos);
  }

  const previsto = objetivos.length * unidades.length * canales.length;

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
          detail:
            `${objetivos.length} ${plural(objetivos.length, 'número', 'números')}` +
            ` x ${canales.length} ${plural(canales.length, 'línea', 'líneas')}` +
            ` x ${unidades.length} ${plural(unidades.length, 'guion', 'guiones')}` +
            ` = ${previsto} ${plural(previsto, 'conversación', 'conversaciones')}`,
        },
      ],
    })
    .select('id')
    .single();

  if (error || !lote) {
    return vacio(error?.message ?? 'no se pudo crear la prueba', omitidos);
  }

  // ── 4 · compilar ──────────────────────────────────────────────────────
  //
  // Un plan por (objetivo × unidad), NO por línea: las tres líneas mandan el
  // mismo guion, que es justamente lo que hace comparables las tres respuestas.
  // Van en paralelo porque son independientes, y si una falla se omite ese par
  // en vez de tumbar la prueba entera — treinta clientes que mueren en el cuarto
  // por un research incompleto no sirven para nada.
  const compilados = (
    await Promise.all(
      objetivos.flatMap((target) =>
        unidades.map(async (unidad) => {
          try {
            const plan = await compilarUnidad(unidad, target, args.aMedida ?? null);
            return { target, plan };
          } catch (err) {
            const que = unidad.tipo === 'molde' ? unidad.templateId : 'el guion a medida';
            console.error(`[lote] no se pudo compilar ${que} para ${target.phone_e164}`, err);
            omitidos.push({ telefono: target.phone_e164, motivo: `no se pudo compilar ${que}` });
            return null;
          }
        }),
      ),
    )
  ).filter((c): c is { target: TargetRow; plan: PlanDePrueba } => c !== null);

  if (compilados.length === 0) {
    await tryWrite(
      db()
        .from('smoke_batches')
        .update({ estado: 'cancelled', finished_at: new Date().toISOString() })
        .eq('id', lote.id),
      'smoke_batches.sin_pruebas',
    );
    return {
      loteId: lote.id,
      pruebas: 0,
      conversaciones: [],
      omitidos,
      error: 'No se pudo compilar ninguna prueba.',
    };
  }

  // Un solo run por organización: el `run` agrupa lo que el cliente ve en su
  // informe y el `batch` lo que nosotros vemos en la pantalla de operación. Son
  // dos preguntas distintas sobre las mismas filas.
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

  // ── 5 · el producto cartesiano ────────────────────────────────────────
  //
  // El orden importa y no es cosmético. `avanzarLote` arranca en orden de
  // creación, así que agrupando por OBJETIVO —y no por línea— un tope de
  // concurrencia de 3 abre las tres líneas contra el primer negocio antes de
  // pasar al segundo. Eso da dos cosas: es exactamente el escenario que se
  // quiere medir cuando hay varias líneas, y en un barrido de treinta hace que
  // el primer negocio esté completo y legible en minutos en vez de al final.
  const filas = compilados
    .filter(({ target }) => porOrg.has(target.organization_id))
    .flatMap(({ target, plan }) =>
      canales.map((canal) => ({
        run_id: porOrg.get(target.organization_id)!,
        batch_id: lote.id,
        target_id: target.id,
        template_id: plan.template_id,
        channel_id: canal.id,
        organization_id: target.organization_id,
        target_phone: target.phone_e164,
        plan,
        max_turnos: plan.max_turnos,
        estado: 'pending' as const,
      })),
    );

  // `mustWrite` devuelve el `data` pelado, no el sobre `{ data }`. Con
  // `.select('id')` eso es el arreglo de las filas insertadas, y es lo que
  // permite caer en la transcripción cuando hay una sola conversación.
  const creadas = await mustWrite(
    db().from('smoke_probes').insert(filas).select('id'),
    'smoke_probes.lote',
  );

  await progresoDeLote(
    lote.id,
    'compilado',
    `${filas.length} ${plural(filas.length, 'conversación lista', 'conversaciones listas')} para arrancar`,
  );

  await track('smoke_batch_started', {
    props: {
      proposito: args.proposito,
      modo: args.aMedida ? args.aMedida.modo : 'molde',
      pruebas: filas.length,
      lineas: canales.length,
      numeros: objetivos.length,
      max_concurrentes: args.maxConcurrentes,
    },
  });

  await avanzarLote(lote.id);

  return {
    loteId: lote.id,
    pruebas: filas.length,
    conversaciones: ((creadas ?? []) as Array<{ id: string }>).map((r) => r.id),
    omitidos,
  };
}

/** Un plan, venga del molde o del formulario. Al motor le da igual. */
async function compilarUnidad(
  unidad: Unidad,
  target: TargetRow,
  aMedida: EntradaAMedida | null,
): Promise<PlanDePrueba> {
  if (unidad.tipo === 'molde') {
    const molde = await plantilla(unidad.templateId);
    return compilarPrueba({
      plantilla: molde,
      organizationId: target.organization_id,
      nombreObjetivo: target.nombre,
    });
  }

  if (!aMedida) throw new Error('falta el guion a medida');

  const molde = await plantilla(moldeDelModo(aMedida.modo));

  // Si el número está vinculado a una organización con research, la ficha entra
  // igual y la prueba a medida gana la capa de exactitud gratis. Sin research la
  // ficha queda vacía, `cobertura` lo dice, y la prueba mide atención pero no
  // invenciones. Degradar honestamente en vez de fallar es lo que mantiene el
  // arnés vivo (§13.4).
  let ficha: HechoDeReferencia[] = [];
  if (target.organization_id) {
    const ctx = await contextoDelNegocio(target.organization_id).catch(() => null);
    ficha = ctx?.ficha ?? [];
  }

  return planALaMedida({
    entrada: {
      ...aMedida,
      // El nombre del formulario manda. Solo si viene vacío se cae al que ya
      // conocíamos del número: es un lote de treinta y nadie escribió treinta
      // nombres a mano.
      negocio: aMedida.negocio.trim() || target.nombre || target.phone_e164,
    },
    rubrica: resolverRubrica(molde.rubrica, ficha),
    ficha,
  });
}

/**
 * Las líneas desde las que se va a escribir.
 *
 * Sin ids, la primera activa — que es el comportamiento de siempre. Con ids, se
 * filtran contra las activas: una línea desactivada no manda nada, y silenciar
 * eso dejaría una prueba entera en `pending` sin decir por qué.
 */
async function resolverCanales(ids?: string[] | null): Promise<CanalRow[]> {
  if (!ids || ids.length === 0) {
    const uno = await canalActivo();
    return uno ? [uno] : [];
  }
  const activas = await canalesActivos();
  const pedidas = new Set(ids);
  return activas.filter((c) => pedidas.has(c.id));
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

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

    // Serial por par (nuestra línea, su número) lo garantiza el motor; acá se
    // garantiza que no arranquemos en un hilo que ya tiene otra conversación
    // viva de otro lote. Se pasa el canal: cancelar por número solo cancelaría
    // la conversación de otra de nuestras líneas contra el mismo negocio, que es
    // exactamente lo que ADR 0027 quiere permitir.
    await cancelarVivasContra(
      siguiente.target_phone,
      siguiente.channel_id,
      siguiente.run_id,
    );

    const r = await arrancarPrueba(siguiente.id);
    if (r.ok) {
      arrancadas += 1;
      await progresoDeLote(
        loteId,
        'arranque',
        `Le escribimos a ${siguiente.target_phone} desde ${siguiente.desde}`,
      );
    }
  }

  return { arrancadas };
}

/**
 * La siguiente pendiente cuyo HILO esté libre.
 *
 * Un hilo es el par (nuestra línea, su número). Desde ADR 0027 la ocupación se
 * mira por par y no por número: tres de nuestras líneas escribiéndole al mismo
 * negocio son tres hilos distintos, y bloquear por número dejaría dos de las
 * tres esperando para siempre a una conversación que nunca las libera.
 *
 * El filtro se hace en la aplicación y no en SQL porque son dos consultas chicas
 * contra índices parciales, y la alternativa —un `not exists` correlacionado
 * sobre `smoke_probes`— no puede usar el índice parcial de
 * `estado in ('pending','running')` y termina barriendo la tabla entera cuando
 * haya historial.
 */
interface Pendiente {
  id: string;
  target_phone: string;
  run_id: string;
  channel_id: string;
  /** El número nuestro, para el registro. Sin esto el log dice tres veces lo
   *  mismo y no se puede saber qué línea abrió qué conversación. */
  desde: string;
}

async function siguientePendiente(loteId: string): Promise<Pendiente | null> {
  const { data: ocupadas } = await db()
    .from('smoke_probes')
    .select('target_phone, channel_id')
    .eq('estado', 'running');

  const hilo = (canalId: string, telefono: string) => `${canalId}:${telefono}`;
  const bloqueados = new Set(
    (ocupadas ?? []).map((o) => hilo(o.channel_id, o.target_phone)),
  );

  const { data: pendientes } = await db()
    .from('smoke_probes')
    .select('id, target_phone, run_id, channel_id, smoke_channels ( phone_e164 )')
    .eq('batch_id', loteId)
    .eq('estado', 'pending')
    .order('created_at', { ascending: true })
    .limit(120);

  const libre = ((pendientes ?? []) as unknown as Array<{
    id: string;
    target_phone: string;
    run_id: string;
    channel_id: string;
    smoke_channels: { phone_e164: string } | null;
  }>).find((p) => !bloqueados.has(hilo(p.channel_id, p.target_phone)));

  return libre
    ? {
        id: libre.id,
        target_phone: libre.target_phone,
        run_id: libre.run_id,
        channel_id: libre.channel_id,
        desde: libre.smoke_channels?.phone_e164 ?? 'nuestra línea',
      }
    : null;
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
