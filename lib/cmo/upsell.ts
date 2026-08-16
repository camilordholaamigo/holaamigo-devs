import { db, tryWrite } from '@/lib/supabase/admin';
import { pnl, periodoActual } from '@/lib/finance/economics';
import { evaluarSaturacion } from '@/lib/cmo/angles';
import { auditarCopyActivo } from '@/lib/cmo/positioning';

/**
 * La máquina de upsell.
 *
 * **La CMO no vende: detecta restricciones y genera propuestas con evidencia.**
 * La diferencia no es semántica — una señal es "tu tasa de cierre está 6 puntos
 * abajo del benchmark con una respuesta alta", y de ahí sale una conversación.
 * Una venta es "te ofrecemos nuestro servicio de marca", y de ahí sale un
 * cliente que deja de leer el feed.
 *
 * LA DISCIPLINA, que es la parte que importa:
 *
 *   detected → proposed_internal → proposed_client
 *
 * Toda señal aparece primero en NUESTRO admin. El salto al cliente exige firma
 * humana, y eso es un `check` constraint. Un agente que le vende servicios al
 * cliente sin filtro destruye la confianza que hace que el resto del producto
 * funcione — y esa confianza es lo único que no se reconstruye con una
 * migración.
 *
 * Ver docs/adr/0021-la-cmo-expandida.md
 */

export type ConstraintType =
  | 'volume'
  | 'conversion'
  | 'brand'
  | 'proof'
  | 'positioning'
  | 'capacity'
  | 'operation';

export type Service =
  | 'agency_brand'
  | 'agency_content'
  | 'agency_reposition'
  | 'media_play'
  | 'fdo'
  | 'credits';

export interface SenalDetectada {
  signal: string;
  evidence: Record<string, unknown>;
  constraint_type: ConstraintType;
  proposed_service: Service;
  estimated_value_usd: number;
  confidence: number;
}

/**
 * Las reglas de detección, tal cual la tabla del plan.
 *
 * Cada una compara contra un umbral explícito y guarda la evidencia que la
 * disparó. Nada de "el modelo cree que necesitan marca": si la señal no se
 * puede sostener con dos números, no es una señal.
 */
export async function detectarSenales(organizationId: string): Promise<SenalDetectada[]> {
  const senales: SenalDetectada[] = [];
  const periodo = periodoActual();
  const cuentas = await pnl(organizationId, periodo);

  // ── Respuesta alta + cierre bajo → falta prueba ────────────────────────
  const { data: metricas } = await db()
    .from('campaign_metrics')
    .select('sent, replied, positive, booked')
    .eq('organization_id', organizationId)
    .limit(500);

  const suma = (clave: 'sent' | 'replied' | 'positive' | 'booked') =>
    (metricas ?? []).reduce((total, fila) => total + Number(fila[clave] ?? 0), 0);

  const enviados = suma('sent');
  const respuestas = suma('replied');
  const citas = suma('booked');

  if (enviados >= 200 && respuestas > 0) {
    const tasaRespuesta = respuestas / enviados;
    const cierreDesdeRespuesta = citas / respuestas;

    if (tasaRespuesta >= 0.05 && cierreDesdeRespuesta < 0.15) {
      senales.push({
        signal: 'Contestan bien pero no llegan a la cita: falta credibilidad, no volumen',
        evidence: {
          enviados,
          tasa_respuesta: redondear(tasaRespuesta),
          citas_por_respuesta: redondear(cierreDesdeRespuesta),
          referencia: 0.15,
        },
        constraint_type: 'proof',
        proposed_service: 'media_play',
        estimated_value_usd: 4500,
        confidence: 0.65,
      });
    }
  }

  // ── Ángulos saturados en todos lados → posicionamiento ─────────────────
  const saturacion = await evaluarSaturacion(organizationId);
  const conDatos = saturacion.filter((s) => s.enviados_recientes >= 30);
  const quemados = conDatos.filter((s) => s.saturado);

  if (conDatos.length >= 2 && quemados.length === conDatos.length) {
    senales.push({
      signal: 'Todos los ángulos se están quemando a la vez: el problema no es el mensaje, es la posición',
      evidence: {
        angulos_evaluados: conDatos.length,
        angulos_quemados: quemados.length,
        detalle: quemados.map((q) => ({ nombre: q.nombre, caida: q.caida })),
      },
      constraint_type: 'positioning',
      proposed_service: 'agency_reposition',
      estimated_value_usd: 6000,
      confidence: 0.6,
    });
  }

  // ── El copy se alejó de la marca → marca ───────────────────────────────
  const deriva = await auditarCopyActivo(organizationId);
  if (deriva.length >= 2) {
    senales.push({
      signal: 'El copy que está saliendo ya no dice lo que la marca dice ser',
      evidence: {
        piezas_con_deriva: deriva.length,
        prohibidos_usados: [...new Set(deriva.flatMap((d) => d.viola))],
        ejemplo: deriva[0]?.extracto,
      },
      constraint_type: 'brand',
      proposed_service: 'agency_brand',
      estimated_value_usd: 3500,
      confidence: 0.55,
    });
  }

  // ── Tope de volumen con la meta lejos → capacidad ──────────────────────
  const { data: bandejas } = await db()
    .from('mailboxes')
    .select('daily_cap, status')
    .eq('organization_id', organizationId);

  const capacidad = (bandejas ?? [])
    .filter((b) => b.status !== 'blocked')
    .reduce((total, b) => total + Number(b.daily_cap ?? 0), 0);

  const { data: pendientes } = await db()
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'new');

  const porContactar = (pendientes as unknown as { count?: number })?.count ?? 0;

  if (capacidad > 0 && porContactar > capacidad * 30) {
    senales.push({
      signal: 'La base es más grande de lo que las bandejas alcanzan a trabajar en un mes',
      evidence: {
        contactos_sin_tocar: porContactar,
        capacidad_diaria: capacidad,
        dias_para_agotarla: Math.round(porContactar / capacidad),
      },
      constraint_type: 'capacity',
      proposed_service: 'credits',
      estimated_value_usd: 1200,
      confidence: 0.7,
    });
  }

  // ── Gasto sin retorno → operación ──────────────────────────────────────
  if (cuentas.costo_usd > 500 && cuentas.clientes_nuevos === 0) {
    senales.push({
      signal: 'Un mes de gasto sin un solo cliente nuevo: hace falta alguien mirando esto todos los días',
      evidence: {
        costo_usd: cuentas.costo_usd,
        clientes_nuevos: 0,
        periodo,
      },
      constraint_type: 'operation',
      proposed_service: 'fdo',
      estimated_value_usd: 2500,
      confidence: 0.75,
    });
  }

  return senales;
}

/**
 * Guarda las señales nuevas en NUESTRO admin.
 *
 * El índice único parcial es el que impide que la misma restricción se apile:
 * si ya hay una señal viva de tipo `proof`, la de esta semana no entra. Sin eso,
 * el admin se vuelve ilegible en un mes y la disciplina se rompe sola — nadie
 * revisa una lista de doscientas señales repetidas.
 */
export async function registrarSenales(
  organizationId: string,
  senales: SenalDetectada[],
): Promise<number> {
  let guardadas = 0;

  for (const senal of senales) {
    const ok = await tryWrite(
      db().from('upsell_signals').insert({
        organization_id: organizationId,
        signal: senal.signal,
        evidence: senal.evidence,
        constraint_type: senal.constraint_type,
        proposed_service: senal.proposed_service,
        estimated_value_usd: senal.estimated_value_usd,
        confidence: senal.confidence,
      }),
      `upsell_signals.${senal.constraint_type}`,
    );
    if (ok) guardadas += 1;
  }

  return guardadas;
}

/**
 * Sube una señal un escalón. El único camino.
 *
 * `detected → proposed_internal` exige quién la aprobó;
 * `proposed_internal → proposed_client` la deja visible para el cliente.
 * La función rechaza cualquier otro salto con un mensaje que dice desde dónde
 * se puede promover.
 */
export async function promoverSenal(args: {
  signalId: string;
  por: string;
  nota?: string | null;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  const { data, error } = await db().rpc('promover_senal', {
    p_id: args.signalId,
    p_por: args.por,
    p_nota: args.nota ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, status: (data as { status?: string })?.status };
}

export async function descartarSenal(signalId: string, motivo: string): Promise<void> {
  await db()
    .from('upsell_signals')
    .update({ status: 'dismissed', internal_note: motivo })
    .eq('id', signalId);
}

/** Las señales de todas las organizaciones. Es la cola de trabajo del admin. */
export async function senalesParaAdmin(opts: { status?: string; limit?: number } = {}) {
  let query = db()
    .from('upsell_signals')
    .select('*, organizations(name, domain)')
    .order('detected_at', { ascending: false })
    .limit(opts.limit ?? 100);

  if (opts.status) query = query.eq('status', opts.status);

  const { data } = await query;
  return data ?? [];
}

export async function senalesDelCliente(organizationId: string) {
  const { data } = await db()
    .from('upsell_signals')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'proposed_client')
    .order('detected_at', { ascending: false });
  return data ?? [];
}

function redondear(valor: number): number {
  return Math.round(valor * 1000) / 1000;
}
