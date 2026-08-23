import { NextResponse, after } from 'next/server';
import { parsearEntrante, resumirPayload } from '@/lib/pruebas/callbell';
import { correlacionar } from '@/lib/pruebas/webhook';
import { avanzarTurno, leerPrueba } from '@/lib/pruebas/motor';
import { evaluarCerradasSinEvaluar } from '@/lib/pruebas/evaluador';

/**
 * La entrada de todo el smoke tester.
 *
 * Acá llegan las respuestas de los negocios a los que les escribimos. Dos
 * fuentes, y el parser aguanta las dos: el webhook nativo de Callbell
 * (`{event: "message_created", payload: {...}}`) y el reenvío desde otra
 * aplicación del equipo, que manda su propia forma.
 *
 * ── TRES REGLAS QUE NO SE NEGOCIAN ─────────────────────────────────────────
 *
 * 1. **SIEMPRE devuelve 200.** Aunque no matchee nada, aunque el JSON sea
 *    inválido, aunque el handler explote. Un 500 hace que el proveedor
 *    reintente o —peor— desactive el webhook, y se pierde la conversación
 *    entera por un error transitorio. Los errores van al log, no al status.
 *
 * 2. **Loguea la forma del payload ANTES de parsear.** Cuesta nada y es lo
 *    único que queda cuando el proveedor cambia el formato sin avisar. El día
 *    que un mensaje no aparezca en ninguna conversación, esta línea dice si
 *    llegó.
 *
 * 3. **El trabajo del turno va en `after()`, nunca suelto.** Una promesa
 *    huérfana en serverless muere en cuanto se devuelve la respuesta, y el
 *    modo de fallo es silencioso: la prueba queda esperando para siempre y en
 *    el log no aparece nada.
 *
 * ── AUTENTICACIÓN ──────────────────────────────────────────────────────────
 *
 * Callbell no firma sus webhooks, así que la única autenticación posible es un
 * secreto en la URL. Se configura como:
 *
 *   https://TU_DOMINIO/api/webhooks/callbell?k=CALLBELL_WEBHOOK_SECRET
 *
 * Sin `CALLBELL_WEBHOOK_SECRET` configurado, la ruta acepta en desarrollo y
 * rechaza en producción. Es el mismo criterio del Inbound Parse de SendGrid
 * (ver app/api/webhooks/sendgrid/inbound), y por la misma razón: un webhook
 * abierto deja inyectar respuestas falsas en las conversaciones, y una
 * respuesta falsa es un número falso en el diagnóstico de un cliente.
 */

export const runtime = 'nodejs';
// El acumulado de ráfagas espera hasta 90 s de silencio y después redacta el
// turno con el modelo. 300 s deja margen de sobra sin rozar el techo del plan.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function autorizado(request: Request): boolean {
  const esperado = process.env.CALLBELL_WEBHOOK_SECRET;
  if (!esperado) return process.env.NODE_ENV !== 'production';
  const k = new URL(request.url).searchParams.get('k');
  return k === esperado;
}

/** Ping para verificar desde el navegador que la ruta está viva y autorizada. */
export async function GET(request: Request) {
  if (!autorizado(request)) {
    return NextResponse.json({ ok: false, error: 'no autorizado' }, { status: 401 });
  }
  return NextResponse.json({ ok: true, servicio: 'smoke-tester', listo: true });
}

export async function POST(request: Request) {
  if (!autorizado(request)) {
    // Éste sí es 401 y no 200: un emisor no autorizado no es un evento que
    // perdimos, es uno que rechazamos a propósito, y el que configuró mal la
    // URL necesita enterarse.
    return NextResponse.json({ ok: false, error: 'no autorizado' }, { status: 401 });
  }

  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    console.warn('[callbell] cuerpo no era JSON');
    return NextResponse.json({ ok: true, ignorado: 'json inválido' });
  }

  console.info('[callbell] entrante', JSON.stringify(resumirPayload(raw)));

  try {
    const entrante = parsearEntrante(raw);
    if (!entrante) {
      return NextResponse.json({ ok: true, ignorado: 'sin texto o sin teléfono' });
    }

    const r = await correlacionar(entrante);

    if (r.tipo === 'sin_match') {
      console.warn('[callbell] ningún match', JSON.stringify(r.detalle));
      return NextResponse.json({ ok: true, ignorado: 'sin match' });
    }

    if (r.tipo === 'ignorado') {
      return NextResponse.json({ ok: true, ignorado: r.motivo });
    }

    const { pruebaId, token } = r;
    after(async () => {
      try {
        await avanzarTurno(pruebaId, token);
        // Si este turno fue el que cerró la conversación, la calificación con
        // modelo sale acá mismo. Va después del turno y no adentro del cierre
        // para que cerrar nunca espere a una llamada de modelo.
        const prueba = await leerPrueba(pruebaId);
        if (prueba.finished_at) await evaluarCerradasSinEvaluar(prueba.run_id);
      } catch (err) {
        console.error('[callbell] el turno de fondo murió', err);
      }
    });

    return NextResponse.json({ ok: true, prueba: pruebaId, camino: r.tipo });
  } catch (err) {
    console.error('[callbell] el handler explotó', err);
    return NextResponse.json({ ok: true, ignorado: 'error interno' });
  }
}
