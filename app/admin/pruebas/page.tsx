import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SectionTitle, Stat, Empty } from '@/components/ui';
import { CrearPrueba, EditarCanal } from '@/components/pruebas-admin';
import { canalActivo, faltaParaEnviar } from '@/lib/pruebas/callbell';
import { plantillasActivas } from '@/lib/pruebas/compilar';
import { formatoDuracion } from '@/lib/pruebas/motor';
import { isoDaysAgo } from '@/lib/utils';
import { env } from '@/lib/env';
import type { CanalRow, CerroCon, EstadoPrueba } from '@/lib/pruebas/types';

/**
 * /admin/pruebas — el otro lado del smoke tester.
 *
 * Tres bloques y cada uno tiene escrita encima la decisión que cambia, que es
 * el criterio de wiki/14: *una métrica que no cambia una decisión es ruido*.
 *
 *   El resumen        ¿el canal sirve, o estamos hablando solos?
 *   Las pruebas       ¿a qué prospecto vale la pena llamar ahora mismo?
 *   La configuración  desde qué número escribimos y con qué moldes
 *
 * La agregación del resumen sale de `holaamigo.resumen_de_pruebas()`, no de
 * contar filas acá: se puede probar contra Postgres real y deja la página
 * tonta (ADR 0023).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pruebas de línea · admin', robots: { index: false } };

interface FilaResumen {
  template_id: string;
  enviadas: number;
  contestaron: number;
  sin_respuesta: number;
  mediana_segundos: number | null;
  p90_segundos: number | null;
  auditoria_promedio: number | null;
  evaluacion_promedio: number | null;
}

interface FilaPrueba {
  id: string;
  template_id: string;
  target_phone: string;
  estado: EstadoPrueba;
  cerro_con: CerroCon | null;
  turno: number;
  max_turnos: number;
  segundos_primera_respuesta: number | null;
  auditoria_score: number | null;
  evaluacion_score: number | null;
  created_at: string;
  conversation: unknown[] | null;
  smoke_targets: { nombre: string | null; organization_id: string | null } | null;
}

export default async function PruebasPage() {
  // `isoDaysAgo` y no `Date.now()` acá: el compilador de React trata el reloj
  // como una función impura y falla el linter incluso en un Server Component.
  // La regla es correcta aunque el caso sea benigno — un render que depende
  // del reloj no es idempotente — y el ayudante ya existe.
  const desde = isoDaysAgo(30);

  const [{ data: resumen }, { data: pruebas }, canal, plantillas, { data: canales }] =
    await Promise.all([
      db().rpc('resumen_de_pruebas', { p_desde: desde }),
      db()
        .from('smoke_probes')
        .select(
          `id, template_id, target_phone, estado, cerro_con, turno, max_turnos,
           segundos_primera_respuesta, auditoria_score, evaluacion_score, created_at, conversation,
           smoke_targets ( nombre, organization_id )`,
        )
        .order('created_at', { ascending: false })
        .limit(40),
      canalActivo(),
      plantillasActivas(),
      db()
        .from('smoke_channels')
        .select('id, label, provider, phone_e164, channel_uuid, template_uuid, activo, notas')
        .order('created_at'),
    ]);

  const filas = (resumen ?? []) as FilaResumen[];
  const lista = (pruebas ?? []) as unknown as FilaPrueba[];
  const falta = Object.keys(faltaParaEnviar());

  const enviadas = filas.reduce((s, f) => s + Number(f.enviadas), 0);
  const contestaron = filas.reduce((s, f) => s + Number(f.contestaron), 0);
  const medianas = filas
    .map((f) => f.mediana_segundos)
    .filter((n): n is number => typeof n === 'number');

  return (
    <main className="mx-auto max-w-7xl space-y-12 px-6 py-10">
      <SectionTitle
        eyebrow="Smoke tester"
        title="Pruebas de línea"
        subtitle="Le escribimos por WhatsApp a la línea publicada de un prospecto, como si fuéramos un cliente, y calificamos lo que pasa. Es la única parte del diagnóstico que no es una proyección."
      />

      {falta.length > 0 ? (
        <Card className="border-leak/30 bg-leak-soft">
          <div className="space-y-1 p-5">
            <p className="text-[14px] font-semibold text-leak">
              Falta {falta.join(', ')} en el entorno.
            </p>
            <p className="text-[13px] leading-relaxed text-leak/80">
              Sin eso no sale ningún mensaje: ni el automático del diagnóstico ni el
              manual de esta pantalla. Se carga en Vercel → Settings → Environment
              Variables y se vuelve a desplegar.
            </p>
          </div>
        </Card>
      ) : null}

      {/* ── 1 · ¿el canal sirve? ─────────────────────────────────────────── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">
            Qué tan vivas están las líneas
          </h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            Últimos 30 días. Decide si vale la pena seguir mandando mensajes por acá.
          </p>
        </div>

        <Card>
          <div className="grid gap-6 p-6 sm:grid-cols-3">
            <Stat
              label="Mensajes enviados"
              value={String(enviadas)}
              hint={`${contestaron} tuvieron respuesta`}
            />
            <Stat
              label="Sin respuesta"
              value={enviadas > 0 ? `${Math.round(((enviadas - contestaron) / enviadas) * 100)}%` : '—'}
              tone="leak"
              hint="Prospectos cuya línea no contestó nunca"
            />
            <Stat
              label="Mediana de respuesta"
              value={medianas.length > 0 ? formatoDuracion(Math.round(mediana(medianas))) : '—'}
              tone="money"
              hint="De los que sí contestaron"
            />
          </div>
        </Card>

        {filas.length > 0 ? (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-faint">
                    <th className="px-5 py-3 font-semibold">Prueba</th>
                    <th className="px-5 py-3 font-semibold">Enviadas</th>
                    <th className="px-5 py-3 font-semibold">Sin respuesta</th>
                    <th className="px-5 py-3 font-semibold">Mediana</th>
                    <th className="px-5 py-3 font-semibold">p90</th>
                    <th className="px-5 py-3 font-semibold">Auditoría</th>
                    <th className="px-5 py-3 font-semibold">Calidad</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) => (
                    <tr key={f.template_id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3 font-medium text-ink">{f.template_id}</td>
                      <td className="tnum px-5 py-3 text-ink-soft">{f.enviadas}</td>
                      <td className="tnum px-5 py-3 text-ink-soft">{f.sin_respuesta}</td>
                      <td className="tnum px-5 py-3 text-ink-soft">
                        {f.mediana_segundos !== null ? formatoDuracion(f.mediana_segundos) : '—'}
                      </td>
                      <td className="tnum px-5 py-3 text-ink-soft">
                        {f.p90_segundos !== null ? formatoDuracion(f.p90_segundos) : '—'}
                      </td>
                      <td className="tnum px-5 py-3 text-ink-soft">
                        {f.auditoria_promedio ?? '—'}
                      </td>
                      <td className="tnum px-5 py-3 text-ink-soft">
                        {f.evaluacion_promedio ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </section>

      {/* ── 2 · las pruebas ──────────────────────────────────────────────── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">
            Las últimas 40 conversaciones
          </h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            Un prospecto cuya línea no contesta es el mejor gancho de llamada que
            tenemos. Abrí la conversación antes de marcar.
          </p>
        </div>

        {lista.length === 0 ? (
          <Empty
            title="Todavía no hay ninguna prueba."
            hint="Se lanzan solas cuando termina el research de un diagnóstico, o a mano acá abajo."
          />
        ) : (
          <div className="space-y-2.5">
            {lista.map((p) => (
              <Link key={p.id} href={`/admin/pruebas/${p.id}`} className="block">
                <Card className="transition hover:border-line-strong">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-ink">
                        {p.smoke_targets?.nombre ?? p.target_phone}
                      </p>
                      <p className="tnum mt-0.5 text-[12.5px] text-ink-faint">
                        {p.template_id} · {p.target_phone} ·{' '}
                        {(p.conversation ?? []).length} mensajes
                      </p>
                    </div>

                    <PastillaEstado estado={p.estado} cerroCon={p.cerro_con} />

                    <p className="tnum w-24 shrink-0 text-right text-[13px] text-ink-soft">
                      {p.segundos_primera_respuesta !== null
                        ? formatoDuracion(p.segundos_primera_respuesta)
                        : '—'}
                    </p>

                    <p className="tnum w-20 shrink-0 text-right text-[13px] text-ink-faint">
                      {p.auditoria_score ?? '—'} / {p.evaluacion_score ?? '—'}
                    </p>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── 3 · configuración ────────────────────────────────────────────── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Configuración</h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            El webhook al que Callbell —o la aplicación que reenvía— tiene que mandar
            las respuestas:{' '}
            <code className="rounded bg-paper-sunken px-1.5 py-0.5 text-[12px] text-ink">
              {env.siteUrl}/api/webhooks/callbell
              {process.env.CALLBELL_WEBHOOK_SECRET ? '?k=…' : ''}
            </code>
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <CrearPrueba
            plantillas={plantillas}
            canales={((canales ?? []) as CanalRow[]).filter((c) => c.activo)}
          />
          <EditarCanal canal={canal} />
        </div>

        <Card>
          <div className="space-y-4 p-6">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">Los moldes de prueba</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
                Definen lo que NO depende del cliente: qué se mide, con qué identidad
                se escribe y cómo se califica. Las preguntas concretas —el evento que
                están promocionando, el precio que publican— las agrega el compilador
                leyendo el research de cada prospecto.
              </p>
            </div>
            <div className="space-y-2.5">
              {plantillas.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line/60 pb-2.5 last:border-0 last:pb-0"
                >
                  <p className="text-[14px] font-medium text-ink">{p.nombre}</p>
                  {p.es_semilla ? <Badge tone="muted">de fábrica</Badge> : null}
                  <p className="tnum text-[12.5px] text-ink-faint">
                    {p.sondas.length} preguntas · {p.rubrica.length} criterios ·{' '}
                    {p.max_turnos} turnos
                  </p>
                  <p className="w-full text-[13px] leading-relaxed text-ink-soft">
                    {p.descripcion}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-faint">
              Se editan con <code>POST /api/admin/pruebas/plantillas</code>. La
              migración los siembra con <code>on conflict do nothing</code>, así que
              volver a correrla no pisa lo que ajustes acá.
            </p>
          </div>
        </Card>
      </section>
    </main>
  );
}

function PastillaEstado({
  estado,
  cerroCon,
}: {
  estado: EstadoPrueba;
  cerroCon: CerroCon | null;
}) {
  if (estado === 'running' || estado === 'pending') {
    return <Badge tone="neutral">en curso</Badge>;
  }
  if (estado === 'failed' || estado === 'cancelled') {
    return <Badge tone="muted">{estado === 'failed' ? 'falló' : 'cancelada'}</Badge>;
  }
  if (cerroCon === 'sin_respuesta') return <Badge tone="leak">sin respuesta</Badge>;
  if (cerroCon === 'bloqueado') return <Badge tone="leak">pidió parar</Badge>;
  if (cerroCon === 'agendado' || cerroCon === 'cotizacion') {
    return <Badge tone="money">{cerroCon}</Badge>;
  }
  return <Badge tone="muted">{cerroCon ?? 'cerrada'}</Badge>;
}

function mediana(xs: number[]): number {
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 0 ? (o[m - 1] + o[m]) / 2 : o[m];
}
