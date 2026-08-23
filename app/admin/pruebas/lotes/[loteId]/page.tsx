import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { Badge, Card, Empty } from '@/components/ui';
import { LoteEnVivo } from '@/components/lote-admin';
import { GenerarInformes } from '@/components/informe-admin';
import { estadoDelLote, leerLote } from '@/lib/pruebas/lote';
import { informesRecientes } from '@/lib/pruebas/informe';
import { env } from '@/lib/env';

/**
 * La pantalla de una prueba: sus conversaciones, en vivo.
 *
 * Tres bloques, en el orden en que se usan: las conversaciones creciendo, el
 * botón que las convierte en informes, y el registro de lo que fue pasando.
 *
 * El registro va último y completo. Un barrido de treinta clientes que corre
 * seis horas se mira tres veces, y las dos últimas la pregunta no es «cómo va»
 * sino «qué pasó mientras no estaba».
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Prueba de línea · admin', robots: { index: false } };

export default async function LotePage({ params }: PageProps<'/admin/pruebas/lotes/[loteId]'>) {
  const { loteId } = await params;

  const lote = await leerLote(loteId).catch(() => null);
  if (!lote) notFound();

  const [estado, { data: pruebas }, informes] = await Promise.all([
    estadoDelLote(loteId),
    db()
      .from('smoke_probes')
      .select(
        `id, template_id, target_phone, estado, cerro_con, turno, max_turnos,
         segundos_primera_respuesta, auditoria_score, evaluacion_score, error, conversation,
         smoke_targets ( nombre ),
         smoke_channels ( label, phone_e164 )`,
      )
      .eq('batch_id', loteId)
      .order('created_at', { ascending: true })
      .limit(200),
    informesRecientes(60),
  ]);

  const filas = (pruebas ?? []) as unknown as Array<{
    target_phone: string;
    smoke_channels: { phone_e164: string } | null;
  }>;
  // Los números y las líneas de la prueba no están en `smoke_batches`: se
  // derivan de las conversaciones, que son las que llevan el par. Guardarlos
  // duplicados en el lote dejaría dos verdades y una se desincronizaría.
  const numeros = new Set(filas.map((f) => f.target_phone)).size;
  const lineas = [
    ...new Set(filas.map((f) => f.smoke_channels?.phone_e164).filter(Boolean)),
  ] as string[];

  const delLote = informes.filter((i) => i.batch_id === loteId);

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-6 py-10">
      <div className="space-y-3">
        <Link href="/admin/pruebas" className="text-[13px] text-ink-faint transition hover:text-ink">
          ← Pruebas de línea
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{lote.nombre}</h1>
            <p className="tnum text-[13px] text-ink-faint">
              {estado.total} {estado.total === 1 ? 'conversación' : 'conversaciones'} ·{' '}
              {numeros} {numeros === 1 ? 'número' : 'números'} ·{' '}
              {lineas.length} {lineas.length === 1 ? 'línea nuestra' : 'líneas nuestras'} · máximo{' '}
              {lote.max_concurrentes} a la vez · {lote.ritmo_segundos} s entre arranques
            </p>
            {lineas.length > 0 ? (
              <p className="tnum text-[12.5px] text-ink-faint">
                Desde {lineas.join(' · ')}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={lote.proposito === 'qa' ? 'money' : 'neutral'}>
              {lote.proposito === 'qa' ? 'QA de clientes' : 'prospección'}
            </Badge>
            <Badge tone={lote.estado === 'running' ? 'neutral' : 'muted'}>{lote.estado}</Badge>
          </div>
        </div>
      </div>

      <LoteEnVivo
        loteId={loteId}
        inicial={{
          estado,
          pruebas: (pruebas ?? []) as never,
          corriendo: lote.estado === 'running',
        }}
      />

      {/* ── Los informes ────────────────────────────────────────────────
          Va acá y no en una pantalla aparte porque es la acción siguiente
          natural: la prueba terminó, ahora se convierte en algo que se manda. */}
      <section className="space-y-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Los informes</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
            Uno por organización, con enlace público. Publicado no es enviado:
            enviarlo es otra acción y la decide una persona.
          </p>
        </div>

        <GenerarInformes loteId={loteId} listos={delLote.length} />

        {delLote.length === 0 ? (
          <Empty
            title="Todavía no hay informes de esta prueba."
            hint="Se pueden generar cuando al menos una conversación haya cerrado."
          />
        ) : (
          <div className="space-y-2">
            {delLote.map((i) => (
              <Card key={i.id}>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-ink">
                      {i.organizations?.name ?? i.organizations?.domain ?? 'sin nombre'}
                    </p>
                    <p className="tnum text-[12px] text-ink-faint">
                      {i.resumen.conversaciones} conversaciones · {i.hallazgos.length} hallazgos
                      {i.vistas > 0 ? ` · abierto ${i.vistas} ${i.vistas === 1 ? 'vez' : 'veces'}` : ''}
                    </p>
                  </div>
                  {i.vistas > 0 ? <Badge tone="money">lo abrieron</Badge> : null}
                  <a
                    href={`${env.siteUrl}/informe/${i.share_token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[13px] font-medium text-ink underline underline-offset-2"
                  >
                    Ver
                  </a>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── El registro ─────────────────────────────────────────────────── */}
      {lote.progress_log.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Qué fue pasando</h2>
          <Card>
            <div className="divide-y divide-line/60">
              {[...lote.progress_log].reverse().map((l, i) => (
                <div key={`${l.t}-${i}`} className="flex gap-4 px-5 py-2.5">
                  <span className="tnum shrink-0 text-[12px] text-ink-faint">
                    {l.t.slice(11, 19)}
                  </span>
                  <span className="text-[13.5px] text-ink-soft">{l.detail}</span>
                </div>
              ))}
            </div>
          </Card>
        </section>
      ) : null}
    </main>
  );
}
