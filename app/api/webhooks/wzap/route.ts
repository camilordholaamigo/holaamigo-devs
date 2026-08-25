import { NextResponse, after } from 'next/server';
import { parsearEntrante } from '@/lib/pruebas/callbell';
import { parsearEntranteWzap, resumirPayloadWzap } from '@/lib/pruebas/wzap';
import { correlacionar } from '@/lib/pruebas/webhook';
import { avanzarTurno, leerPrueba } from '@/lib/pruebas/motor';
import { evaluarCerradasSinEvaluar } from '@/lib/pruebas/evaluador';
import { avanzarLote } from '@/lib/pruebas/lote';

/**
 * La segunda entrada del smoke tester: las respuestas que llegan por wzap.
 *
 * Es una ruta aparte y no un `if` adentro de la de Callbell, y eso es lo más
 * importante de este archivo. La razón es operativa: el webhook de Callbell ya
 * está configurado, corriendo y recibiendo reenvíos de otra aplicación. Meter un
 * proveedor nuevo en esa misma URL habría puesto en riesgo un camino que hoy
 * funciona para ahorrar un archivo de sesenta líneas.
 *
 * Las TRES REGLAS son las mismas que en la ruta de Callbell, por las mismas
 * razones —siempre 200, loguear la forma antes de parsear, el trabajo del turno
 * dentro de `after()`— y el detalle de cada una está documentado allá.
 *
 * ── AUTENTICACIÓN ──────────────────────────────────────────────────────────
 *
 * wzap deja configurar una cabecera secreta por webhook, así que acá el secreto
 * va en `x-webhook-secret` y no en la URL. Es mejor que el `?k=` de Callbell por
 * una razón concreta: las URLs quedan escritas en los logs de todo lo que hay en
 * el camino, las cabeceras no. Se acepta `?k=` igual, para no bloquear la puesta
 * en marcha si el panel del proveedor no ofreciera el campo de cabecera.
 *
 * Sin `WZAP_WEBHOOK_SECRET` configurado, la ruta acepta en desarrollo y rechaza
 * en producción — mismo criterio que las otras dos entradas del sistema. Un
 * webhook abierto deja inyectar respuestas falsas en las conversaciones, y una
 * respuesta falsa es un número falso en el diagnóstico de un cliente.
 *
 * Configuración en wzap: Webhooks → nuevo webhook, evento `message:in:new`,
 * device de la línea de pruebas, URL `https://TU_DOMINIO/api/webhooks/wzap`.
 * Ver docs/adr/0028-dos-transportes.md
 */

export const runtime = 'nodejs';
// El acumulado de ráfagas espera hasta 90 s de silencio antes de redactar el
// turno con el modelo. Mismo techo que la ruta de Callbell.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function autorizado(request: Request): boolean {
  const esperado = process.env.WZAP_WEBHOOK_SECRET;
  if (!esperado) return process.env.NODE_ENV !== 'production';
  const cabecera = request.headers.get('x-webhook-secret');
  if (cabecera && cabecera === esperado) return true;
  return new URL(request.url).searchParams.get('k') === esperado;
}

/** Ping para verificar desde el navegador que la ruta está viva y autorizada. */
export async function GET(request: Request) {
  if (!autorizado(request)) {
    return NextResponse.json({ ok: false, error: 'no autorizado' }, { status: 401 });
  }
  return NextResponse.json({ ok: true, servicio: 'smoke-tester', proveedor: 'wzap', listo: true });
}

export async function POST(request: Request) {
  if (!autorizado(request)) {
    return NextResponse.json({ ok: false, error: 'no autorizado' }, { status: 401 });
  }

  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    console.warn('[wzap] cuerpo no era JSON');
    return NextResponse.json({ ok: true, ignorado: 'json inválido' });
  }

  console.info('[wzap] entrante', JSON.stringify(resumirPayloadWzap(raw)));

  try {
    // El parser propio primero; si no reconoce la forma, el genérico de
    // Callbell, que busca texto y teléfonos a cualquier profundidad. La forma
    // exacta del payload de wzap no está verificada contra un mensaje real
    // todavía, y perder un entrante deja la conversación colgada y al negocio
    // reportado como «no contestó» — una cifra falsa en el informe de alguien.
    let entrante = parsearEntranteWzap(raw);
    if (!entrante) {
      entrante = parsearEntrante(raw);
      if (entrante) {
        console.warn('[wzap] parseado con el parser genérico, no con el propio');
      }
    }

    if (!entrante) {
      // Acá sí se vuelca el cuerpo, y solo acá: es el único caso en que la forma
      // resumida ya demostró no alcanzar. Sin esto, «el mensaje no apareció en
      // ninguna conversación» no se puede diagnosticar sin esperar a que vuelva
      // a pasar.
      console.warn('[wzap] sin texto o sin teléfono', JSON.stringify(raw).slice(0, 1_500));
      return NextResponse.json({ ok: true, ignorado: 'sin texto o sin teléfono' });
    }

    const r = await correlacionar(entrante);

    if (r.tipo === 'sin_match') {
      console.warn('[wzap] ningún match', JSON.stringify(r.detalle));
      return NextResponse.json({ ok: true, ignorado: 'sin match' });
    }

    if (r.tipo === 'ignorado') {
      return NextResponse.json({ ok: true, ignorado: r.motivo });
    }

    const { pruebaId, token } = r;
    after(async () => {
      try {
        await avanzarTurno(pruebaId, token);
        const prueba = await leerPrueba(pruebaId);
        if (prueba.finished_at) {
          await evaluarCerradasSinEvaluar(prueba.run_id);
          if (prueba.batch_id) await avanzarLote(prueba.batch_id);
        }
      } catch (err) {
        console.error('[wzap] el turno de fondo murió', err);
      }
    });

    return NextResponse.json({ ok: true, prueba: pruebaId, camino: r.tipo });
  } catch (err) {
    console.error('[wzap] el handler explotó', err);
    return NextResponse.json({ ok: true, ignorado: 'error interno' });
  }
}
