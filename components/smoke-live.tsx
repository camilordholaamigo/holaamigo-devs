'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { PruebaResumida, ResumenDeCorrida } from '@/lib/pruebas/resumen';

/**
 * «Le escribimos a tu WhatsApp.»
 *
 * Es la sección del diagnóstico que no es una proyección. Todo lo demás son
 * cifras derivadas de supuestos que el cliente puede mover; esto es una
 * conversación que pasó, con la hora a la que pasó.
 *
 * ── LAS TRES REGLAS DE ESTA PANTALLA (ADR 0023) ────────────────────────────
 *
 * 1. **La barra no se mueve sola.** Cada tramo lo gana un hecho con hora en la
 *    base: el mensaje salió, contestaron, se completó un turno, se cerró.
 *    Entre dos hechos se queda quieta. Una barra que repta mientras no pasa
 *    nada es la mentira más común de las interfaces de espera, y acá lo único
 *    que vendemos es que los números son ciertos.
 *
 * 2. **Lo que sí corre es el cronómetro**, y es real: sale de restar
 *    `enviado_at` contra el reloj del navegador. Si tardan cuarenta minutos,
 *    dice cuarenta minutos.
 *
 * 3. **La conversación se ve.** Los globos que aparecen solos son la prueba de
 *    que hay alguien trabajando, y valen más que cualquier animación. Cuando
 *    el research se demora, el ticker del quiz se queda quieto y eso también
 *    es información honesta; acá igual.
 *
 * Nada que dependa del reloj se renderiza antes de montar. El porqué —y el bug
 * que lo enseñó— está en `useReloj`, acá abajo.
 */

const RECONEXION_MS = 4_000;
const POLL_MS = 6_000;

/**
 * El reloj de la pantalla, como sistema externo.
 *
 * Un `setInterval` que llama a `setState` es lo obvio y el compilador de React
 * lo rechaza con razón: es un render en cascada por segundo. `useSyncExternalStore`
 * es lo que corresponde —el reloj de la máquina ES un sistema externo al que
 * uno se suscribe— y resuelve gratis el problema de la hidratación: el
 * snapshot del servidor es 0, así que nada que dependa de la hora se renderiza
 * antes de montar.
 *
 * Ese cero importa más de lo que parece. Es el bug 7 del paquete que portamos:
 * el servidor calcula «hace 18 m», el cliente hidrata 200 ms después, en el
 * borde del minuto los dos difieren, React detecta el desajuste y cae a render
 * solo-cliente — y en ese fallback los manejadores de eventos no quedan
 * pegados. El síntoma no es «la fecha está mal», es «los botones no funcionan».
 *
 * El valor vive en el módulo y no en un ref porque `getSnapshot` tiene que
 * devolver el MISMO valor entre ticks: si devolviera `Date.now()` fresco en
 * cada llamada, React lo leería dos veces en un render, vería dos números
 * distintos y entraría en bucle.
 */
let relojCompartido = 0;

function useReloj(activo: boolean): number {
  const suscribir = useCallback(
    (avisar: () => void) => {
      if (!activo) return () => {};
      relojCompartido = Date.now();
      avisar();
      const t = setInterval(() => {
        relojCompartido = Date.now();
        avisar();
      }, 1_000);
      return () => clearInterval(t);
    },
    [activo],
  );

  return useSyncExternalStore(
    suscribir,
    () => relojCompartido,
    () => 0,
  );
}

export function SmokeLive({
  runId,
  inicial,
}: {
  runId: string;
  inicial: ResumenDeCorrida | null;
}) {
  const [resumen, setResumen] = useState<ResumenDeCorrida | null>(inicial);
  const fuente = useRef<EventSource | null>(null);

  const vivas = resumen?.vivas ?? 0;

  // Un solo reloj para todos los cronómetros: N suscripciones para N tarjetas
  // sería N veces el trabajo por el mismo segundo.
  const ahora = useReloj(vivas > 0);

  const traer = useCallback(async () => {
    try {
      const res = await fetch(`/api/pruebas/estado/${runId}`, { cache: 'no-store' });
      if (res.ok) setResumen((await res.json()) as ResumenDeCorrida);
    } catch {
      /* el ciclo siguiente reintenta */
    }
  }, [runId]);

  // SSE con caída a polling, igual que el ticker del research (ADR 0002).
  // El polling no es solo un respaldo teórico: hay proxies corporativos que
  // buferean `text/event-stream` y dejan el flujo mudo sin cerrarlo.
  useEffect(() => {
    // No hace falta esperar a un flag de montaje: los efectos solo corren en el
    // cliente. El único que necesitaba esa guarda era el reloj, y lo resuelve
    // el snapshot de servidor de `useReloj`.
    if (vivas === 0) return;

    let cerrado = false;
    let respaldo: ReturnType<typeof setInterval> | null = null;

    const conectar = () => {
      if (cerrado) return;
      const es = new EventSource(`/api/pruebas/stream/${runId}`);
      fuente.current = es;

      es.addEventListener('estado', (e) => {
        try {
          setResumen(JSON.parse((e as MessageEvent).data) as ResumenDeCorrida);
        } catch {
          /* un evento mal formado no puede tumbar la vista */
        }
      });

      es.addEventListener('finished', () => {
        es.close();
        void traer();
      });

      es.onerror = () => {
        es.close();
        if (!cerrado) setTimeout(conectar, RECONEXION_MS);
      };
    };

    conectar();
    respaldo = setInterval(() => void traer(), POLL_MS);

    return () => {
      cerrado = true;
      fuente.current?.close();
      if (respaldo) clearInterval(respaldo);
    };
  }, [vivas, runId, traer]);

  if (!resumen || resumen.pruebas.length === 0) return null;

  return (
    <section className="reveal space-y-8" style={{ '--i': 3 } as React.CSSProperties}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Lo que pasó de verdad
          </p>
          {vivas > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-leak-soft px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-leak">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-leak" />
              en curso
            </span>
          ) : null}
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          Le escribimos a tu WhatsApp
        </h2>
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          {resumen.titular}
        </p>
      </div>

      <div className="space-y-5">
        {resumen.pruebas.map((p) => (
          <TarjetaDePrueba key={p.id} prueba={p} ahora={ahora} />
        ))}
      </div>

      <p className="text-[12.5px] leading-relaxed text-ink-faint">
        Escribimos desde un número nuestro, como escribiría un cliente. No le
        escribimos a tus clientes, y si alguien de tu equipo pide que paremos,
        paramos en ese mismo mensaje.
      </p>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

function TarjetaDePrueba({ prueba, ahora }: { prueba: PruebaResumida; ahora: number }) {
  const [abierta, setAbierta] = useState(false);

  const viva =
    prueba.estado === 'esperando' ||
    prueba.estado === 'conversando' ||
    prueba.estado === 'escribiendo';

  // El cronómetro solo aparece montado: `ahora` llega en 0 en el servidor.
  const esperandoSegundos =
    ahora > 0 && prueba.estado === 'esperando' && prueba.enviado_at
      ? Math.max(0, Math.round((ahora - Date.parse(prueba.enviado_at)) / 1000))
      : null;

  const mensajes = abierta ? prueba.conversation : prueba.conversation.slice(-6);
  const ocultos = prueba.conversation.length - mensajes.length;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-5 p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="space-y-1">
            <h3 className="text-[17px] font-semibold tracking-tight text-ink">{prueba.titulo}</h3>
            <p className="text-[13px] text-ink-faint">{prueba.que_mide}</p>
          </div>
          <p className="tnum shrink-0 text-[13px] text-ink-faint">{prueba.telefono}</p>
        </div>

        <Barra prueba={prueba} viva={viva} />

        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p
            className={cn(
              'text-[15px] font-medium leading-snug',
              prueba.cerro_con === 'sin_respuesta' ? 'text-leak' : 'text-ink',
            )}
          >
            {prueba.titular}
          </p>
          {esperandoSegundos !== null ? (
            <p className="tnum shrink-0 text-[13px] text-ink-faint">
              {reloj(esperandoSegundos)}
            </p>
          ) : null}
        </div>

        {prueba.conversation.length > 0 ? (
          <div className="space-y-2.5 rounded-xl bg-paper-sunken p-4">
            {ocultos > 0 ? (
              <button
                type="button"
                onClick={() => setAbierta(true)}
                className="text-[12.5px] font-medium text-ink-faint underline underline-offset-2 transition hover:text-ink"
              >
                Ver los {ocultos} mensajes anteriores
              </button>
            ) : null}

            {mensajes.map((m, i) => (
              <Globo
                key={`${m.timestamp}-${i}`}
                nuestro={m.role === 'comprador'}
                texto={m.text}
                // Solo el último entra animado. Animar todos en cada
                // actualización haría parpadear la conversación entera cada vez
                // que llega un mensaje.
                nuevo={i === mensajes.length - 1 && viva}
              />
            ))}
          </div>
        ) : null}

        {prueba.estado === 'cerrada' ? <Veredicto prueba={prueba} /> : null}
      </div>
    </Card>
  );
}

/**
 * La barra. `progress-fill` ya trae la transición de 450 ms del sistema, así
 * que un salto de 15 % a 45 % se ve como un avance y no como un corte — pero
 * el salto lo dispara un hecho, no un temporizador.
 */
function Barra({ prueba, viva }: { prueba: PruebaResumida; viva: boolean }) {
  const cerradaSinRespuesta = prueba.cerro_con === 'sin_respuesta';

  return (
    <div className="space-y-2">
      <div className="progress-track h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            'progress-fill h-full rounded-full',
            cerradaSinRespuesta && 'bg-leak',
            !cerradaSinRespuesta && prueba.estado === 'cerrada' && 'bg-money-bright',
          )}
          style={{ width: `${prueba.avance}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11.5px] text-ink-faint">
        <span>{etiquetaDeEstado(prueba)}</span>
        {viva && prueba.turno > 0 ? (
          <span className="tnum">
            Turno {prueba.turno} de {prueba.max_turnos}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Globo({
  nuestro,
  texto,
  nuevo,
}: {
  nuestro: boolean;
  texto: string;
  nuevo: boolean;
}) {
  return (
    <div className={cn('flex', nuestro ? 'justify-end' : 'justify-start')}>
      <p
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed',
          nuestro
            ? 'rounded-br-sm bg-ink text-paper'
            : 'rounded-bl-sm bg-paper-raised text-ink shadow-[0_1px_2px_rgb(18_16_14_/_0.06)]',
          nuevo && 'slide-in',
        )}
      >
        {texto}
      </p>
    </div>
  );
}

/**
 * El veredicto.
 *
 * Se muestra en el orden en que sirve leerlo, que no es el orden en que se
 * calcula: primero lo que el negocio dijo mal (verificable, con fuente),
 * después qué hacer, y la nota al final. Una nota aislada no significa nada;
 * «dijeron un precio distinto del que publican» significa todo.
 */
function Veredicto({ prueba }: { prueba: PruebaResumida }) {
  const { auditoria, evaluacion } = prueba;
  const fallidos = auditoria?.criterios.filter((c) => c.paso === false) ?? [];

  if (!auditoria && !evaluacion) return null;

  return (
    <div className="space-y-4 border-t border-line pt-5">
      {evaluacion?.alucinaciones.length ? (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-leak">
            Dijeron cosas que tu sitio no dice
          </p>
          <ul className="space-y-1.5">
            {evaluacion.alucinaciones.slice(0, 4).map((a) => (
              <li key={a} className="text-[13.5px] leading-relaxed text-ink-soft">
                <span className="text-ink-faint">«</span>
                {a}
                <span className="text-ink-faint">»</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {fallidos.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Lo que no pasó
          </p>
          <ul className="space-y-1.5">
            {fallidos.slice(0, 5).map((c) => (
              <li key={c.id} className="flex gap-2 text-[13.5px] leading-relaxed text-ink-soft">
                <span aria-hidden className="mt-[2px] shrink-0 text-leak">
                  ✕
                </span>
                <span>
                  {c.criterio}. <span className="text-ink-faint">{c.detalle}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {evaluacion?.sugerencias.length ? (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-money">
            Qué cambiaría el resultado
          </p>
          <ul className="space-y-1.5">
            {evaluacion.sugerencias.slice(0, 3).map((s) => (
              <li key={s} className="flex gap-2 text-[13.5px] leading-relaxed text-ink-soft">
                <span aria-hidden className="mt-[2px] shrink-0 text-money-bright">
                  →
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* La nota va al final y solo si se pudo verificar algo. Un cero que en
          realidad significa «no pudimos leer tu sitio» se lee como «lo hiciste
          pésimo», y esa confusión no se arregla con una nota al pie. */}
      {auditoria && auditoria.verificables > 0 ? (
        <p className="tnum text-[12.5px] text-ink-faint">
          {auditoria.score} de 100 en {auditoria.verificables} criterios verificables
          {evaluacion ? ` · ${evaluacion.score} de 100 en calidad de la respuesta` : ''}
        </p>
      ) : null}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

function etiquetaDeEstado(p: PruebaResumida): string {
  switch (p.estado) {
    case 'escribiendo':
      return 'En cola';
    case 'esperando':
      return 'Esperando respuesta';
    case 'conversando':
      return 'Conversando';
    case 'fallida':
      return 'No se pudo completar';
    default:
      return 'Cerrada';
  }
}

/** mm:ss hasta la hora, después h mm. Tabular para que no baile. */
function reloj(segundos: number): string {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
