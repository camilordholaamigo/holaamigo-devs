import { randomUUID } from 'node:crypto';
import { db, unwrap, mustWrite, tryWrite } from '@/lib/supabase/admin';
import { track } from '@/lib/events';
import { canalPorId, enviarMensaje } from '@/lib/pruebas/callbell';
import { siguienteTurno } from '@/lib/pruebas/comprador';
import { auditar } from '@/lib/pruebas/auditor';
import {
  ENTRE_PRUEBAS_MS,
  ESTANCADA_MS,
  SILENCIO_MS,
  SILENCIO_TOPE_MS,
  modoDelPlan,
  type CerroCon,
  type EstadoPrueba,
  type Mensaje,
  type PlanDePrueba,
  type PruebaRow,
} from '@/lib/pruebas/types';

/**
 * El motor por eventos.
 *
 * LA IDEA CENTRAL, Y TODO LO DEMÁS ES CONSECUENCIA: **nadie espera a nadie.**
 * El estado de la conversación vive en la base, no en la memoria de un proceso.
 * Cada mensaje entrante es un evento que despierta el sistema, hace un turno y
 * lo apaga.
 *
 *   arrancar()              manda el mensaje 1 y muere            (~2 s)
 *   webhook  ← respuesta
 *     ├── guarda, reserva el turno, devuelve 200
 *     └── en segundo plano: espera silencio, redacta, manda, muere (~40 s)
 *   webhook  ← … y así hasta el cierre
 *
 * Ninguna invocación dura más de un minuto y medio. Una conversación con una
 * PyME colombiana puede durar cuarenta minutos sin chocar con ningún límite de
 * plataforma, porque en ningún momento hay una función esperando.
 *
 * El diseño alternativo —una función viva haciendo polling— no es una variante
 * más simple: es un diseño que NO FUNCIONA. Vercel corta a los 300 s; esperar
 * una respuesta humana puede tomar 20 minutos. Dos mensajes agotan el
 * presupuesto, la función muere a la mitad, y la prueba queda en `running`
 * para siempre envenenando la correlación de todas las que vienen después.
 *
 * Ver docs/wiki/23-smoke-tester.md
 */

const CAMPOS = `
  id, run_id, batch_id, target_id, template_id, channel_id, organization_id, target_phone, plan, conversation,
  estado, cerro_con, turno, max_turnos, turn_token, awaiting_reply,
  enviado_at, primera_respuesta_at, segundos_primera_respuesta, ultimo_entrante_at,
  auditoria, auditoria_score, evaluacion, evaluacion_score,
  motivo_cierre, error, provider_message_id, created_at, updated_at, finished_at
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function leerPrueba(pruebaId: string): Promise<PruebaRow> {
  return unwrap(
    await db().from('smoke_probes').select(CAMPOS).eq('id', pruebaId).single(),
    'smoke_probes.get',
  ) as unknown as PruebaRow;
}

async function escribir(pruebaId: string, patch: Record<string, unknown>): Promise<void> {
  await mustWrite(
    db().from('smoke_probes').update(patch).eq('id', pruebaId),
    'smoke_probes.update',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ARRANCAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manda el primer mensaje. **En primer plano, a propósito.**
 *
 * Es el único momento de todo el flujo donde alguien está mirando la pantalla,
 * y es donde falla el 90 % de los problemas de configuración: llave vencida,
 * canal mal escrito, número mal formado. Mandarlo en segundo plano convierte
 * un error de dos segundos en una investigación de veinte minutos.
 */
export async function arrancarPrueba(pruebaId: string): Promise<{ ok: boolean; error?: string }> {
  const prueba = await leerPrueba(pruebaId);

  if (prueba.estado !== 'pending') {
    return { ok: false, error: `la prueba ya está en ${prueba.estado}` };
  }

  const canal = await canalPorId(prueba.channel_id);
  const plan = prueba.plan as PlanDePrueba;
  const apertura = plan.apertura;
  const ahora = new Date().toISOString();

  const primerMensaje: Mensaje = { role: 'comprador', text: apertura, timestamp: ahora };

  // El receptor se arma ANTES de disparar el emisor. Si el negocio contesta
  // rapidísimo, el webhook tiene que encontrar la fila ya lista para
  // correlacionar. Al revés se pierde la respuesta y no hay reintento.
  //
  // `enviado_at` también va acá, y no después del envío, para que no exista
  // una ventana en la que llegue la respuesta antes de que exista el
  // timestamp contra el que se mide. Se sobreestima por milisegundos; la
  // alternativa era un tiempo de respuesta negativo.
  await escribir(pruebaId, {
    estado: 'running',
    conversation: [primerMensaje],
    turno: 1,
    awaiting_reply: true,
    enviado_at: ahora,
  });

  const envio = await enviarMensaje({
    canal,
    to: prueba.target_phone,
    texto: apertura,
    usarPlantilla: true,
  });

  if (!envio.ok) {
    await escribir(pruebaId, {
      estado: 'failed',
      awaiting_reply: false,
      enviado_at: null,
      error: [envio.error, envio.pista].filter(Boolean).join(' · ').slice(0, 900),
      finished_at: new Date().toISOString(),
    });
    await progreso(prueba.run_id, 'error', `No se pudo escribir a ${prueba.target_phone}`);
    // La cola no se muere por un envío fallido: se pasa a la siguiente.
    await avanzarCola(prueba.run_id, prueba.target_id, prueba.channel_id);
    return { ok: false, error: envio.error ?? 'no se pudo enviar' };
  }

  await escribir(pruebaId, { provider_message_id: envio.messageId });
  await progreso(
    prueba.run_id,
    'enviado',
    `Le escribimos a ${prueba.target_phone} · prueba de ${plan.template_id}`,
  );

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// UN MENSAJE ENTRANTE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Anexa la respuesta del negocio y reserva el turno siguiente.
 *
 * Devuelve el token del turno. El llamador —el webhook— tiene que programar
 * `avanzarTurno(id, token)` en segundo plano y devolver 200 de inmediato.
 *
 * La reserva del token es SÍNCRONA y pasa acá, antes de programar nada. Es lo
 * que hace que, de los tres o cuatro webhooks que dispara una ráfaga, gane el
 * último — que es justo el que vio la respuesta completa.
 */
export async function registrarEntrante(
  pruebaId: string,
  texto: string,
): Promise<string | null> {
  const prueba = await leerPrueba(pruebaId);
  if (prueba.estado !== 'running') return null;

  const ahora = new Date().toISOString();
  const conversation: Mensaje[] = [
    ...(prueba.conversation ?? []),
    { role: 'negocio', text: texto, timestamp: ahora },
  ];

  const patch: Record<string, unknown> = {
    conversation,
    awaiting_reply: false,
    ultimo_entrante_at: ahora,
  };

  // La cifra que el cliente lee. La calcula el código restando dos timestamps,
  // no un modelo (ADR 0007). Solo se escribe una vez: es «cuánto tardaron en
  // contestar», no «cuánto tardaron en el turno 4».
  if (!prueba.primera_respuesta_at) {
    patch.primera_respuesta_at = ahora;
    const base = prueba.enviado_at ?? prueba.created_at;
    patch.segundos_primera_respuesta = Math.max(
      0,
      Math.round((Date.parse(ahora) - Date.parse(base)) / 1000),
    );
    await progreso(
      prueba.run_id,
      'respondieron',
      `${prueba.target_phone} contestó en ${formatoDuracion(patch.segundos_primera_respuesta as number)}`,
    );
  }

  const token = randomUUID();
  patch.turn_token = token;

  await escribir(pruebaId, patch);
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL TURNO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El trabajo de fondo de un turno. Corre dentro de `after()`.
 *
 * Se retira en silencio si otro chunk más nuevo se llevó el turno. Es lo
 * normal, no un error: de una ráfaga de cuatro mensajes, tres de estas
 * invocaciones se retiran sin escribir nada.
 */
export async function avanzarTurno(pruebaId: string, token: string): Promise<void> {
  try {
    await acumularRafaga(pruebaId);

    // Releer. Entre el settle y acá pueden haber pasado noventa segundos: la
    // prueba pudo cancelarse, cerrarse o cambiar de manos. Confiar en lo que
    // se leyó al entrar es cómo se resucitan pruebas muertas.
    const prueba = await leerPrueba(pruebaId);
    if (prueba.estado !== 'running') return;
    if (prueba.turn_token !== token) return;

    const plan = prueba.plan as PlanDePrueba;
    const bloque = bloqueDelNegocio(prueba.conversation);

    if (pidioNoEscribir(bloque)) {
      await marcarObjetivoBloqueado(prueba.target_id, 'el negocio pidió no ser contactado');
      await cerrarPrueba(pruebaId, {
        estado: 'completed',
        cerroCon: 'bloqueado',
        motivo: 'El negocio pidió que no le escribiéramos más. Se respetó de inmediato.',
      });
      return;
    }

    // ── MODO GUION ──────────────────────────────────────────────────────
    //
    // Va ANTES de los detectores de cierre, y ése es todo el punto: si el
    // negocio agenda en el mensaje dos, las preguntas tres y cuatro se mandan
    // igual. Eso es lo que pidió el que armó el guion, y es lo que permite
    // hacerle la misma pregunta a veinte negocios y comparar las veinte
    // respuestas. El cierre se calcula UNA vez, al final, sobre todo lo que
    // dijo el negocio (ADR 0027, decisión 2).
    //
    // Lo único que sigue mandando por encima del guion es `pidioNoEscribir`,
    // arriba. Eso no lo revierte ninguna configuración.
    if (modoDelPlan(plan) === 'guion') {
      await avanzarGuion(prueba, plan, token);
      return;
    }

    const cierre = detectarCierreDeNegocio(bloque);
    if (cierre) {
      await cerrarPrueba(pruebaId, {
        estado: 'completed',
        cerroCon: cierre,
        motivo:
          cierre === 'agendado'
            ? 'El negocio propuso o confirmó una cita.'
            : 'El negocio ofreció enviar una cotización.',
      });
      return;
    }

    if (prueba.turno >= prueba.max_turnos) {
      await cerrarPrueba(pruebaId, {
        estado: 'completed',
        cerroCon: 'incompleto',
        motivo: `Se agotaron los ${prueba.max_turnos} turnos sin llegar a un cierre.`,
      });
      return;
    }

    const turno = await siguienteTurno({
      plan,
      conversation: prueba.conversation,
      turno: prueba.turno + 1,
      organizationId: prueba.organization_id,
    });

    if (turno.terminar) {
      await cerrarPrueba(pruebaId, {
        estado: 'completed',
        cerroCon: 'objetivo_cumplido',
        motivo: turno.motivo,
        // Se manda igual la despedida: dejar al negocio hablando solo después
        // de haberle hecho perder diez minutos es una grosería, y el que la
        // recibe es un prospecto nuestro.
        despedida: turno.mensaje,
      });
      return;
    }

    // Reclamar el token TAN TARDE COMO SE PUEDA. Redactar con el modelo tarda
    // entre dos y cinco segundos, y en esa ventana puede llegar otro chunk que
    // reprograma el turno. Reclamando al principio, contestaríamos con
    // información vieja.
    const reclamado = await reclamarTurno(pruebaId, token);
    if (!reclamado) return;

    const canal = await canalPorId(prueba.channel_id);
    const ahora = new Date().toISOString();

    // awaiting_reply en true ANTES de mandar, por lo mismo de siempre.
    await escribir(pruebaId, {
      conversation: [
        ...prueba.conversation,
        { role: 'comprador', text: turno.mensaje, timestamp: ahora },
      ],
      turno: prueba.turno + 1,
      awaiting_reply: true,
      motivo_cierre: turno.motivo.slice(0, 300),
    });

    const envio = await enviarMensaje({ canal, to: prueba.target_phone, texto: turno.mensaje });

    if (!envio.ok) {
      await cerrarPrueba(pruebaId, {
        estado: 'failed',
        cerroCon: null,
        motivo: `No se pudo enviar el turno ${prueba.turno + 1}: ${envio.error}`,
      });
    }
  } catch (err) {
    // Un rechazo sin manejar adentro del trabajo de fondo no aparece en ningún
    // lado y deja la prueba colgada para siempre. Se cierra como fallida:
    // toda condición tiene que escribir estado terminal.
    console.error('[pruebas] el turno explotó', err);
    await cerrarPrueba(pruebaId, {
      estado: 'failed',
      cerroCon: null,
      motivo: err instanceof Error ? err.message.slice(0, 300) : 'error desconocido',
    }).catch(() => {});
  }
}

/**
 * Un turno en modo guion: el mensaje siguiente ya está escrito.
 *
 * No llama a ningún modelo, no decide nada y no puede desviarse. Es la mitad
 * del valor de este modo: la misma prueba contra veinte negocios manda
 * exactamente las mismas palabras, así que las respuestas son comparables.
 *
 * `turno` es cuántos mensajes nuestros salieron, y `guion[0]` fue la apertura:
 * por eso el índice del que viene es `turno` y no `turno + 1`. Cuando se acaban,
 * la prueba cierra con el veredicto de negocio calculado sobre TODO lo que dijo
 * el negocio — no solo sobre el último bloque —, para que `cerro_con` siga
 * significando lo mismo que en modo conversar y el embudo siga sumando.
 */
async function avanzarGuion(
  prueba: PruebaRow,
  plan: PlanDePrueba,
  token: string,
): Promise<void> {
  const guion = plan.guion ?? [];
  const siguiente = guion[prueba.turno];

  if (!siguiente) {
    const cierre = detectarCierreDeNegocio(todoDelNegocio(prueba.conversation));
    await cerrarPrueba(prueba.id, {
      estado: 'completed',
      cerroCon: cierre ?? 'objetivo_cumplido',
      motivo: `Se mandaron los ${guion.length} mensajes del guion y se registró lo que contestaron.`,
    });
    return;
  }

  // Se reclama igual que en modo conversar aunque acá no haya nada que redactar:
  // la ráfaga del negocio dispara un webhook por mensaje, y sin el token los
  // cuatro mandarían la misma pregunta cuatro veces.
  const reclamado = await reclamarTurno(prueba.id, token);
  if (!reclamado) return;

  const canal = await canalPorId(prueba.channel_id);
  const ahora = new Date().toISOString();

  await escribir(prueba.id, {
    conversation: [
      ...prueba.conversation,
      { role: 'comprador', text: siguiente, timestamp: ahora },
    ],
    turno: prueba.turno + 1,
    awaiting_reply: true,
    motivo_cierre: `Mensaje ${prueba.turno + 1} de ${guion.length} del guion.`,
  });

  const envio = await enviarMensaje({ canal, to: prueba.target_phone, texto: siguiente });

  if (!envio.ok) {
    await cerrarPrueba(prueba.id, {
      estado: 'failed',
      cerroCon: null,
      motivo: `No se pudo enviar el mensaje ${prueba.turno + 1} del guion: ${envio.error}`,
    });
  }
}

/**
 * Espera a que el otro lado deje de escribir.
 *
 * Una persona que contesta por WhatsApp manda dos o tres mensajes seguidos con
 * quince segundos entre uno y otro. Sin esta espera, el comprador contesta al
 * primero, después al segundo, y la conversación se vuelve ilegible — y el
 * negocio del otro lado, que no sabe que es una prueba, empieza a contestarle
 * a un cliente que parece nervioso.
 *
 * La ventana se REINICIA con cada mensaje nuevo. Una ventana fija no sirve: si
 * el otro lado tarda veinticinco segundos entre el chunk 1 y el 2, una espera
 * fija de veinte los separa igual.
 */
async function acumularRafaga(pruebaId: string): Promise<void> {
  const tope = Date.now() + SILENCIO_TOPE_MS;
  let silencioHasta = Date.now() + SILENCIO_MS;
  let largo = -1;

  while (Date.now() < silencioHasta && Date.now() < tope) {
    await sleep(2_000);
    const { data } = await db()
      .from('smoke_probes')
      .select('conversation, estado')
      .eq('id', pruebaId)
      .maybeSingle();

    if (!data || data.estado !== 'running') return;

    const n = Array.isArray(data.conversation) ? data.conversation.length : 0;
    if (largo < 0) largo = n;
    else if (n > largo) {
      largo = n;
      silencioHasta = Date.now() + SILENCIO_MS;
    }
  }
}

/**
 * Reclama el turno con un UPDATE condicional, que es atómico.
 *
 * Devuelve false si otro chunk se lo llevó mientras redactábamos. La fila del
 * token es una columna propia justamente para poder hacer esto: con el token
 * adentro de un jsonb habría que leer-modificar-escribir, y dos webhooks
 * simultáneos se pisarían.
 */
async function reclamarTurno(pruebaId: string, token: string): Promise<boolean> {
  const { data } = await db()
    .from('smoke_probes')
    .update({ turn_token: null })
    .eq('id', pruebaId)
    .eq('turn_token', token)
    .select('id');
  return (data?.length ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// CERRAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El único camino de salida.
 *
 * TODA condición terminal pasa por acá y TODA condición escribe. No existe un
 * camino que deje una prueba abierta — y si existiera, esa prueba se
 * convertiría en un zombi, y un zombi se traga los mensajes de las que vienen
 * después.
 *
 * Al cerrar dispara la auditoría determinística (capa 2) en línea, porque es
 * gratis y no puede fallar, y deja la evaluación con modelo (capa 3) al
 * llamador. El paquete original tenía la capa 3 detrás de un botón y por eso
 * casi nunca se corría.
 */
export async function cerrarPrueba(
  pruebaId: string,
  args: {
    estado: EstadoPrueba;
    cerroCon: CerroCon | null;
    motivo: string;
    despedida?: string;
  },
): Promise<void> {
  const prueba = await leerPrueba(pruebaId);
  if (['completed', 'timeout', 'failed', 'cancelled'].includes(prueba.estado)) return;

  let conversation = prueba.conversation ?? [];

  if (args.despedida) {
    try {
      const canal = await canalPorId(prueba.channel_id);
      const envio = await enviarMensaje({
        canal,
        to: prueba.target_phone,
        texto: args.despedida,
      });
      if (envio.ok) {
        conversation = [
          ...conversation,
          { role: 'comprador', text: args.despedida, timestamp: new Date().toISOString() },
        ];
      }
    } catch (err) {
      // Que falle la despedida no puede impedir el cierre.
      console.error('[pruebas] no se pudo mandar la despedida', err);
    }
  }

  const auditoria = auditar({
    plan: prueba.plan as PlanDePrueba,
    conversation,
    segundosPrimeraRespuesta: prueba.segundos_primera_respuesta,
  });

  await escribir(pruebaId, {
    estado: args.estado,
    cerro_con: args.cerroCon,
    motivo_cierre: args.motivo.slice(0, 500),
    conversation,
    awaiting_reply: false,
    turn_token: null,
    auditoria,
    auditoria_score: auditoria.score,
    finished_at: new Date().toISOString(),
  });

  await progreso(
    prueba.run_id,
    'cerrada',
    `Prueba de ${(prueba.plan as PlanDePrueba).template_id} cerrada · ${args.cerroCon ?? args.estado}`,
  );

  await tryWrite(
    db()
      .from('smoke_targets')
      .update({ ultima_prueba_at: new Date().toISOString() })
      .eq('id', prueba.target_id),
    'smoke_targets.enfriamiento',
  );

  await track('smoke_probe_closed', {
    props: {
      template: prueba.template_id,
      estado: args.estado,
      cerro_con: args.cerroCon,
      segundos: prueba.segundos_primera_respuesta,
      auditoria: auditoria.score,
    },
  });

  await avanzarCola(prueba.run_id, prueba.target_id, prueba.channel_id);
}

// ═══════════════════════════════════════════════════════════════════════════
// LA COLA POR NÚMERO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arranca la prueba siguiente contra el MISMO número.
 *
 * Serial por número y paralelo entre números. La razón es física: dos
 * conversaciones simultáneas contra la misma línea caen en el mismo hilo de
 * WhatsApp y ninguna de las dos mide nada. Contra números distintos no hay
 * problema, porque la correlación del webhook es por número.
 *
 * EL ESPACIADO ES UNA GUARDA, NO UN `sleep`. La primera versión dormía 90 s
 * antes de arrancar la siguiente, y eso rompía tres cosas a la vez: el GET de
 * estado tiene un techo de 60 s y se moría a mitad de respuesta; el stream se
 * quedaba mudo un minuto y medio; y el cron, que puede tener cinco colas
 * pendientes, sumaba siete minutos y medio de siesta contra un techo de cinco.
 *
 * Ahora se pregunta «¿cerró hace poco?» y, si sí, no se hace nada. Quien vuelva
 * a pasar —el GET cada pocos segundos mientras el cliente mira, el cron cada
 * cinco minutos si no— la arranca. Nadie se queda esperando. Es la misma
 * lección que el motor entero: si el flujo dura más que tu función, el estado
 * va en la base.
 *
 * Idempotente por diseño: si ya hay una corriendo o no queda nada pendiente, se
 * retira. Se llama desde el cierre de cada prueba, desde el GET y desde el
 * watchdog, y las tres pueden pasar al mismo tiempo.
 */
export async function avanzarCola(
  runId: string,
  targetId: string,
  /**
   * Desde qué línea nuestra.
   *
   * La cola es por PAR (línea, número) y no por número desde ADR 0027: dos de
   * nuestras líneas escribiéndole al mismo negocio son dos hilos de WhatsApp
   * distintos y los dos tienen que poder avanzar. Sin este parámetro, la
   * conversación de la línea B veía «ya hay una corriendo» —la de la línea A—
   * y nunca arrancaba.
   */
  canalId: string,
): Promise<void> {
  const { data: viva } = await db()
    .from('smoke_probes')
    .select('id')
    .eq('run_id', runId)
    .eq('target_id', targetId)
    .eq('channel_id', canalId)
    .eq('estado', 'running')
    .limit(1);

  if ((viva?.length ?? 0) > 0) return;

  const { data: siguiente } = await db()
    .from('smoke_probes')
    .select('id')
    .eq('run_id', runId)
    .eq('target_id', targetId)
    .eq('channel_id', canalId)
    .eq('estado', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (!siguiente?.[0]) {
    await cerrarRunSiTerminó(runId);
    return;
  }

  // Sin esta pausa el negocio ve dos conversaciones distintas pegadas y
  // contesta la segunda con el contexto de la primera. También por par: lo que
  // confunde al que contesta es ver dos hilos seguidos del MISMO número, no que
  // le escriban dos personas distintas.
  const { data: ultima } = await db()
    .from('smoke_probes')
    .select('finished_at')
    .eq('target_id', targetId)
    .eq('channel_id', canalId)
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1);

  const cerroHace = ultima?.[0]?.finished_at
    ? Date.now() - Date.parse(ultima[0].finished_at)
    : Infinity;
  if (cerroHace < ENTRE_PRUEBAS_MS) return;

  await arrancarPrueba(siguiente[0].id);
}

export async function cerrarRunSiTerminó(runId: string): Promise<void> {
  const { data: pendientes } = await db()
    .from('smoke_probes')
    .select('id')
    .eq('run_id', runId)
    .in('estado', ['pending', 'running'])
    .limit(1);

  if ((pendientes?.length ?? 0) > 0) return;

  await tryWrite(
    db()
      .from('smoke_runs')
      .update({ estado: 'done', finished_at: new Date().toISOString() })
      .eq('id', runId)
      .eq('estado', 'running'),
    'smoke_runs.done',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LA RED DE SEGURIDAD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cierra una prueba que se quedó esperando.
 *
 * Si el negocio nunca contesta no hay webhook, y sin webhook no hay quien
 * cierre la prueba. Esta función se llama desde el GET que la interfaz ya
 * consulta cada tres segundos —gratis y frecuente— y desde el cron, que es la
 * red que recoge lo que el GET no vio porque nadie tenía la pestaña abierta.
 *
 * Devuelve true si cerró algo.
 */
export async function recogerSiEstancada(prueba: PruebaRow): Promise<boolean> {
  if (prueba.estado !== 'running') return false;

  const referencia = prueba.ultimo_entrante_at ?? prueba.enviado_at ?? prueba.created_at;
  if (Date.now() - Date.parse(referencia) < ESTANCADA_MS) return false;

  const nuncaContestó = !prueba.primera_respuesta_at;

  await cerrarPrueba(prueba.id, {
    estado: nuncaContestó ? 'timeout' : 'completed',
    cerroCon: nuncaContestó ? 'sin_respuesta' : 'incompleto',
    motivo: nuncaContestó
      ? `Nadie contestó en ${Math.round(ESTANCADA_MS / 60_000)} minutos.`
      : 'La conversación se quedó sin respuesta a mitad de camino.',
  });

  return true;
}

/**
 * Cancela lo que esté vivo contra un número antes de arrancar algo nuevo.
 *
 * Un sistema con estados de larga duración tiene que poder salir de un estado
 * malo sin intervención humana. La alternativa —bloquear el botón mientras hay
 * algo corriendo— suena prudente y es una trampa: el día que algo se cuelga,
 * la herramienta queda inutilizable. Preferimos reemplazar sobre bloquear.
 */
export async function cancelarVivasContra(
  targetPhone: string,
  /**
   * Desde qué línea nuestra. Solo se cancela lo que está vivo EN ESE HILO.
   *
   * Sin esto, arrancar la conversación de la línea B cancelaba la de la línea A
   * contra el mismo negocio — que es exactamente lo que ADR 0027 quiere
   * permitir. `null` cancela contra ese número desde todas las líneas, y es lo
   * que se usa cuando alguien cancela a mano desde el admin: ahí la intención es
   * «parale a todo lo que le estemos escribiendo a este señor».
   */
  canalId: string | null,
  /**
   * La corrida que se está armando ahora mismo.
   *
   * Sin esto, `crearRun` se cancelaba a sí mismo: inserta N pruebas en
   * `pending` con ese número y acto seguido llama a esta función, que cancela
   * todo lo `pending` contra ese número — incluidas las que acaba de crear.
   * El síntoma habría sido «la prueba se crea y muere en el acto», sin error.
   */
  exceptoRunId?: string | null,
): Promise<number> {
  let q = db()
    .from('smoke_probes')
    .update({
      estado: 'cancelled',
      awaiting_reply: false,
      turn_token: null,
      motivo_cierre: 'Cancelada: una prueba nueva la reemplazó.',
      finished_at: new Date().toISOString(),
    })
    .eq('target_phone', targetPhone)
    .in('estado', ['pending', 'running']);

  if (canalId) q = q.eq('channel_id', canalId);
  if (exceptoRunId) q = q.neq('run_id', exceptoRunId);

  const { data } = await q.select('id');
  return data?.length ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTORES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Todo lo que dijo el negocio desde el último mensaje nuestro, concatenado.
 *
 * Una ráfaga de cuatro mensajes es UN bloque lógico. Correr los detectores
 * sobre el último mensaje suelto pierde el cierre casi siempre: cuando alguien
 * agenda por WhatsApp, la fecha viene en el primer mensaje y el «te espero» en
 * el último.
 */
export function bloqueDelNegocio(conversation: Mensaje[]): string {
  const salida: string[] = [];
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i].role !== 'negocio') break;
    salida.unshift(conversation[i].text);
  }
  return salida.join('\n\n');
}

/**
 * Todo lo que dijo el negocio en la conversación entera.
 *
 * `bloqueDelNegocio` mira el último bloque, que es lo correcto para decidir el
 * turno siguiente. Esto mira todo, y es lo correcto para el veredicto final de
 * un guion: si agendaron en el mensaje dos, agendaron.
 */
export function todoDelNegocio(conversation: Mensaje[]): string {
  return conversation
    .filter((m) => m.role === 'negocio')
    .map((m) => m.text)
    .join('\n');
}

const NO_ESCRIBIR =
  /\b(no (me |nos )?(vuelvan? a |vuelva a )?escrib\w*|no (me |nos )?contact\w*|d(a|e)me? de baja|dar de baja|remover|quitar de la lista|no estoy interesad|deje de|dejen de|esto es spam|repórtel|report[eé] este)\b/i;

/** Pedir que no escriban se respeta de inmediato y sin excepción. */
export function pidioNoEscribir(texto: string): boolean {
  return NO_ESCRIBIR.test(texto);
}

const AGENDADO =
  /\b(#agendado|te (agend|esper)\w*|qued(a|ó) agendad|confirmad[ao] (la|tu) (cita|visita)|nos vemos el|te espero el|agendamos (para|el)|reserv(é|e|amos) (la|tu))\b/i;
const FECHA_HORA =
  /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|hoy|\d{1,2}\s?(de\s?\w+|\/\d{1,2}))\b[^.\n]{0,40}\b(\d{1,2}\s?(:|h)\s?\d{0,2}\s?(am|pm|a\.m|p\.m)?|\d{1,2}\s?(am|pm))\b/i;
const COTIZACION =
  /\b(#cotizacion|#cotizaci[oó]n|te (env[ií]|mand|paso) (la|una) cotizaci|cotizaci[oó]n (lista|adjunta|por correo)|te la (env[ií]o|mando) (al|por))\b/i;

/**
 * El veredicto de negocio, sacado de lo que el negocio escribió.
 *
 * Es intencionalmente conservador: prefiere no detectar un cierre a inventar
 * uno. Reportarle a un cliente «te agendaron una cita» cuando le dijeron «te
 * escribo luego» destruye la única cosa que este producto vende, que es que
 * los números son ciertos.
 */
export function detectarCierreDeNegocio(texto: string): CerroCon | null {
  if (COTIZACION.test(texto)) return 'cotizacion';
  if (AGENDADO.test(texto) && FECHA_HORA.test(texto)) return 'agendado';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUXILIARES
// ═══════════════════════════════════════════════════════════════════════════

async function marcarObjetivoBloqueado(targetId: string, motivo: string): Promise<void> {
  await mustWrite(
    db()
      .from('smoke_targets')
      .update({ bloqueado: true, bloqueado_motivo: motivo })
      .eq('id', targetId),
    'smoke_targets.bloquear',
  );
}

/** Una línea en el progreso del run. Lo lee el cliente en vivo. */
export async function progreso(runId: string, step: string, detail: string): Promise<void> {
  try {
    const { data } = await db()
      .from('smoke_runs')
      .select('progress_log')
      .eq('id', runId)
      .maybeSingle();

    const log = Array.isArray(data?.progress_log) ? data.progress_log : [];
    log.push({ t: new Date().toISOString(), step, detail });

    await tryWrite(
      db()
        .from('smoke_runs')
        .update({ progress_log: log.slice(-60) })
        .eq('id', runId),
      'smoke_runs.progreso',
    );
  } catch (err) {
    console.error('[pruebas] no se pudo escribir progreso', err);
  }
}

export function formatoDuracion(segundos: number): string {
  if (segundos < 60) return `${segundos} segundos`;
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto === 0
    ? `${horas} ${horas === 1 ? 'hora' : 'horas'}`
    : `${horas} h ${resto} min`;
}
