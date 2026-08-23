import Link from 'next/link';
import { db } from '@/lib/supabase/admin';
import { Card, Badge, SectionTitle, Stat, Empty } from '@/components/ui';
import { LineasDeCallbell } from '@/components/pruebas-admin';
import { EnviarInforme } from '@/components/informe-admin';
import { estadoDelLote, lotesRecientes } from '@/lib/pruebas/lote';
import { informesRecientes } from '@/lib/pruebas/informe';
import { faltaParaEnviar } from '@/lib/pruebas/callbell';
import { plantillasActivas } from '@/lib/pruebas/compilar';
import { formatoDuracion } from '@/lib/pruebas/motor';
import { isoDaysAgo } from '@/lib/utils';
import { env } from '@/lib/env';
import type { CanalRow, CerroCon, EstadoPrueba, Mensaje } from '@/lib/pruebas/types';

/**
 * /admin/pruebas — el otro lado del smoke tester.
 *
 * El orden de la pantalla es el orden en que se usa, y cada bloque tiene escrita
 * encima la decisión que cambia — que es el criterio de wiki/14: *una métrica
 * que no cambia una decisión es ruido*.
 *
 *   Nueva prueba      la acción. Va arriba porque es por lo que se entra acá.
 *   Las líneas vivas  ¿el canal sirve, o estamos hablando solos?
 *   Conversaciones    ¿a qué prospecto llamo ahora mismo?
 *   Las pruebas       ¿cómo va lo que lancé?
 *   Informes          ¿quién abrió el suyo? Es la señal de compra más barata.
 *   Configuración     desde qué números escribimos y con qué moldes
 *
 * La agregación del resumen sale de `holaamigo.resumen_de_pruebas()`, no de
 * contar filas acá: se puede probar contra Postgres real y deja la página tonta
 * (ADR 0023).
 *
 * El vocabulario es el de ADR 0027 y no es cosmético — era la mitad del problema
 * que esa decisión vino a arreglar: **una PRUEBA** es un guion contra N números
 * desde M de nuestras líneas; **una CONVERSACIÓN** es una transcripción con su
 * veredicto. La palabra «tanda» no se usa más en ningún lado.
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

interface FilaConversacion {
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
  conversation: Mensaje[] | null;
  smoke_targets: { nombre: string | null; organization_id: string | null } | null;
  smoke_channels: { phone_e164: string } | null;
}

export default async function PruebasPage() {
  // `isoDaysAgo` y no `Date.now()` acá: el compilador de React trata el reloj
  // como una función impura y falla el linter incluso en un Server Component.
  // La regla es correcta aunque el caso sea benigno — un render que depende del
  // reloj no es idempotente — y el ayudante ya existe.
  const desde = isoDaysAgo(30);

  const [{ data: resumen }, { data: crudas }, plantillas, { data: canales }, lotes, informes] =
    await Promise.all([
      db().rpc('resumen_de_pruebas', { p_desde: desde }),
      db()
        .from('smoke_probes')
        .select(
          `id, template_id, target_phone, estado, cerro_con, turno, max_turnos,
           segundos_primera_respuesta, auditoria_score, evaluacion_score, created_at, conversation,
           smoke_targets ( nombre, organization_id ),
           smoke_channels ( phone_e164 )`,
        )
        .order('created_at', { ascending: false })
        .limit(40),
      plantillasActivas(),
      db()
        .from('smoke_channels')
        .select('id, label, provider, phone_e164, channel_uuid, template_uuid, activo, notas')
        .order('created_at'),
      lotesRecientes(8),
      informesRecientes(12),
    ]);

  const filas = (resumen ?? []) as FilaResumen[];
  const conversaciones = (crudas ?? []) as unknown as FilaConversacion[];
  const falta = Object.keys(faltaParaEnviar());
  const lineas = (canales ?? []) as CanalRow[];
  const activas = lineas.filter((c) => c.activo);

  // El estado de cada prueba sale de la función de SQL, una por lote y en
  // paralelo. Contar filas acá se ve más barato y no lo es: son las mismas
  // consultas sin el plan que Postgres ya sabe hacer (ADR 0023).
  const estados = await Promise.all(lotes.map((l) => estadoDelLote(l.id).catch(() => null)));

  const enviadas = filas.reduce((s, f) => s + Number(f.enviadas), 0);
  const contestaron = filas.reduce((s, f) => s + Number(f.contestaron), 0);
  const medianas = filas
    .map((f) => f.mediana_segundos)
    .filter((n): n is number => typeof n === 'number');

  return (
    <main className="mx-auto max-w-7xl space-y-12 px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <SectionTitle
          eyebrow="Smoke tester"
          title="Pruebas de línea"
          subtitle="Le escribimos por WhatsApp a la línea de un negocio, como si fuéramos un cliente, y calificamos lo que pasa. Es la única parte del diagnóstico que no es una proyección."
          className="max-w-2xl"
        />
        <Link
          href="/admin/pruebas/nueva"
          className="shrink-0 rounded-xl bg-ink px-5 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-ink/90"
        >
          Nueva prueba
        </Link>
      </div>

      {falta.length > 0 ? (
        <Card className="border-leak/30 bg-leak-soft">
          <div className="space-y-1 p-5">
            <p className="text-[14px] font-semibold text-leak">
              Falta {falta.join(', ')} en el entorno.
            </p>
            <p className="text-[13px] leading-relaxed text-leak/80">
              Sin eso no sale ningún mensaje: ni el automático del diagnóstico ni el manual de esta
              pantalla. Se carga en Vercel → Settings → Environment Variables y se vuelve a
              desplegar.
            </p>
          </div>
        </Card>
      ) : activas.length === 0 ? (
        <Card className="border-leak/30 bg-leak-soft">
          <div className="space-y-1 p-5">
            <p className="text-[14px] font-semibold text-leak">
              No hay ninguna línea activa desde la que escribir.
            </p>
            <p className="text-[13px] leading-relaxed text-leak/80">
              Configurá una abajo, en <strong>Nuestras líneas</strong>, y probá el envío contra tu
              propio celular antes de apuntarle a un prospecto.
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
              value={
                enviadas > 0
                  ? `${Math.round(((enviadas - contestaron) / enviadas) * 100)}%`
                  : '—'
              }
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
                    <th className="px-5 py-3 font-semibold">Tipo de prueba</th>
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
                      <td className="px-5 py-3 font-medium text-ink">
                        {nombreDeMolde(f.template_id, plantillas)}
                      </td>
                      <td className="tnum px-5 py-3 text-ink-soft">{f.enviadas}</td>
                      <td className="tnum px-5 py-3 text-ink-soft">{f.sin_respuesta}</td>
                      <td className="tnum px-5 py-3 text-ink-soft">
                        {f.mediana_segundos !== null ? formatoDuracion(f.mediana_segundos) : '—'}
                      </td>
                      <td className="tnum px-5 py-3 text-ink-soft">
                        {f.p90_segundos !== null ? formatoDuracion(f.p90_segundos) : '—'}
                      </td>
                      <td className="tnum px-5 py-3 text-ink-soft">{f.auditoria_promedio ?? '—'}</td>
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

      {/* ── 2 · las conversaciones ───────────────────────────────────────── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">
            Las últimas 40 conversaciones
          </h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            Un prospecto cuya línea no contesta es el mejor gancho de llamada que tenemos. El
            último mensaje del negocio va en la fila: si con eso ya sabés, no hace falta abrir.
          </p>
        </div>

        {conversaciones.length === 0 ? (
          <Empty
            title="Todavía no hay ninguna conversación."
            hint="Se lanzan solas cuando termina el research de un diagnóstico, o a mano con «Nueva prueba»."
          />
        ) : (
          <div className="space-y-2.5">
            {conversaciones.map((p) => (
              <Card key={p.id} className="transition hover:border-line-strong">
                <Link href={`/admin/pruebas/${p.id}`} className="block px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-ink">
                        {p.smoke_targets?.nombre ?? p.target_phone}
                      </p>
                      <p className="tnum mt-0.5 text-[12.5px] text-ink-faint">
                        {p.target_phone}
                        {p.smoke_channels ? ` · desde ${p.smoke_channels.phone_e164}` : ''} ·{' '}
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

                  {ultimoDelNegocio(p.conversation) ? (
                    <p className="mt-2.5 line-clamp-2 border-l-2 border-line pl-2.5 text-[12.5px] leading-relaxed text-ink-faint">
                      {ultimoDelNegocio(p.conversation)}
                    </p>
                  ) : null}
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── 3 · las pruebas ──────────────────────────────────────────────── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Las pruebas</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
            Una prueba es un guion contra uno o varios números, desde una o varias de nuestras
            líneas. El mismo objeto sirve para las tres cosas: probar un prospecto, ver si el agente
            de un cliente aguanta tres conversaciones a la vez, y barrer treinta líneas de un
            sector.
          </p>
        </div>

        {lotes.length === 0 ? (
          <Empty
            title="Todavía no hay ninguna prueba."
            hint="La primera puede ser un número y una línea: sirve igual para ver cómo se comporta."
          />
        ) : (
          <div className="space-y-2.5">
            {lotes.map((l, i) => {
              const e = estados[i];
              return (
                <Card key={l.id} className="transition hover:border-line-strong">
                  <Link
                    href={`/admin/pruebas/lotes/${l.id}`}
                    className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-ink">{l.nombre}</p>
                      <p className="tnum text-[12px] text-ink-faint">
                        {e ? (
                          <>
                            {e.total} {e.total === 1 ? 'conversación' : 'conversaciones'}
                            {e.corriendo > 0 ? ` · ${e.corriendo} conversando` : ''}
                            {e.pendientes > 0 ? ` · ${e.pendientes} en cola` : ''}
                            {e.sin_respuesta > 0 ? ` · ${e.sin_respuesta} sin respuesta` : ''}
                          </>
                        ) : (
                          <>{l.proposito === 'qa' ? 'QA de clientes' : 'prospección'}</>
                        )}
                      </p>
                    </div>
                    <p className="tnum shrink-0 text-[12px] text-ink-faint">
                      {l.created_at.slice(0, 10)}
                    </p>
                    <Badge tone={l.estado === 'running' ? 'neutral' : 'muted'}>{l.estado}</Badge>
                  </Link>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 4 · los informes ─────────────────────────────────────────────── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Informes</h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            El enlace público que se le manda al cliente. <strong>Que lo hayan abierto</strong> es la
            señal de compra más barata que tenemos, y es la columna que decide a quién llamar.
          </p>
        </div>

        {informes.length === 0 ? (
          <Empty
            title="Todavía no hay informes."
            hint="Se generan desde la pantalla de una prueba, cuando ya hay conversaciones cerradas."
          />
        ) : (
          <div className="space-y-2.5">
            {informes.map((i) => (
              <Card key={i.id}>
                <div className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-ink">
                        {i.organizations?.name ?? i.organizations?.domain ?? 'sin nombre'}
                      </p>
                      <p className="tnum text-[12px] text-ink-faint">
                        {i.resumen.conversaciones} conversaciones ·{' '}
                        {i.resumen.sin_respuesta > 0
                          ? `${i.resumen.sin_respuesta} sin respuesta`
                          : 'todas contestaron'}{' '}
                        · {i.hallazgos.length} hallazgos
                      </p>
                    </div>
                    {i.vistas > 0 ? (
                      <Badge tone="money">
                        abierto {i.vistas} {i.vistas === 1 ? 'vez' : 'veces'}
                      </Badge>
                    ) : (
                      <Badge tone="muted">sin abrir</Badge>
                    )}
                    <a
                      href={`${env.siteUrl}/informe/${i.share_token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-[13px] font-medium text-ink underline underline-offset-2"
                    >
                      Ver
                    </a>
                  </div>

                  <EnviarInforme
                    informeId={i.id}
                    correoPorDefecto={null}
                    asunto={i.correo?.asunto ?? null}
                    cuerpo={i.correo?.cuerpo ?? null}
                    url={`${env.siteUrl}/informe/${i.share_token}`}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── 5 · configuración ────────────────────────────────────────────── */}
      <section id="lineas" className="space-y-5 scroll-mt-8">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Nuestras líneas</h2>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-faint">
            Los números desde los que escribimos, y su identificador en Callbell. Se cambian acá y
            toman efecto sin desplegar; la llave de la API va en Vercel porque eso es un secreto y
            esto es un dato de operación. <strong>Tener varias líneas es la unidad de escala:</strong>{' '}
            cada una abre su propio hilo de WhatsApp, así que tres líneas permiten ver si el agente
            de un negocio les contesta igual a tres clientes a la vez — y suben el techo diario sin
            acercarse al umbral de spam de Meta.
          </p>
        </div>

        <LineasDeCallbell canales={lineas} />

        <Card>
          <div className="space-y-4 p-6">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">Los moldes de prueba</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
                Definen lo que NO depende del cliente: qué se mide, con qué identidad se escribe y
                cómo se califica. Los usa el disparo automático del diagnóstico, que compila las
                preguntas leyendo el research de cada prospecto. Para una prueba escrita a mano no
                hacen falta: ahí el guion lo escribe una persona en{' '}
                <Link href="/admin/pruebas/nueva" className="underline underline-offset-2">
                  Nueva prueba
                </Link>
                .
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
                    {p.sondas.length} preguntas · {p.rubrica.length} criterios · {p.max_turnos}{' '}
                    turnos
                  </p>
                  <p className="w-full text-[13px] leading-relaxed text-ink-soft">
                    {p.descripcion}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-faint">
              Se editan con <code>POST /api/admin/pruebas/plantillas</code>. La migración los siembra
              con <code>on conflict do nothing</code>, así que volver a correrla no pisa lo que
              ajustes acá.
            </p>
          </div>
        </Card>

        <Card>
          <div className="space-y-1 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              El webhook
            </p>
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Callbell —o la aplicación que reenvía— tiene que mandar las respuestas a{' '}
              <code className="rounded bg-paper-sunken px-1.5 py-0.5 text-[12px] text-ink">
                {env.siteUrl}/api/webhooks/callbell
                {process.env.CALLBELL_WEBHOOK_SECRET ? '?k=…' : ''}
              </code>
              . El <code>GET</code> de esa misma URL devuelve <code>{'{ok: true}'}</code> si el
              secreto es correcto.
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

function ultimoDelNegocio(conversation: Mensaje[] | null): string | null {
  const ultimo = [...(conversation ?? [])].reverse().find((m) => m.role === 'negocio');
  return ultimo?.text ?? null;
}

function nombreDeMolde(id: string, plantillas: Array<{ id: string; nombre: string }>): string {
  return plantillas.find((p) => p.id === id)?.nombre ?? id;
}

function mediana(xs: number[]): number {
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 0 ? (o[m - 1] + o[m]) / 2 : o[m];
}
