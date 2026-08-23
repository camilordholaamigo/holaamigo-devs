'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  MAX_GUION,
  MAX_SONDAS,
  PERSONA_POR_DEFECTO,
  aperturaSugerida,
  objetivoSugerido,
  turnosDe,
  validarAMedida,
  type EntradaAMedida,
} from '@/lib/pruebas/guion';
import type { CanalRow, Persona } from '@/lib/pruebas/types';

/**
 * El formulario que arma una prueba desde cero.
 *
 * ── LA DECISIÓN DE DISEÑO ──────────────────────────────────────────────────
 *
 * Toda la pantalla existe alrededor de una idea: **el operador tiene que poder
 * leer, palabra por palabra, lo que le va a llegar al negocio, antes de mandarlo
 * y sin haberlo mandado.** De ahí la columna derecha, que no es decoración: son
 * los mismos globos de WhatsApp que va a ver el que contesta.
 *
 * El problema que arregla no era de campos que faltaban, era de que nadie sabía
 * qué hacía el botón. Un preview exacto contesta eso mejor que cualquier
 * explicación, y es la razón de que `lib/pruebas/guion.ts` sea puro: las
 * sugerencias que se ven acá salen de la MISMA función que después arma el plan
 * en el servidor. Si se calcularan por separado, el día que se desalineen la
 * pantalla estaría mintiendo.
 *
 * ── LA OTRA REGLA, HEREDADA ────────────────────────────────────────────────
 *
 * Si algo falla, el formulario se queda abierto con el error a la vista. Solo se
 * limpia en el camino feliz. En una herramienta de diagnóstico el error ES el
 * producto: cerrar el formulario cuando algo sale mal convierte un fallo de dos
 * segundos —«la llave venció»— en una investigación de veinte minutos.
 */

export interface OrgConLinea {
  id: string;
  nombre: string;
  telefono: string;
  ultima_prueba_at: string | null;
}

interface Conocido {
  conocido: boolean;
  nombre: string | null;
  organizationId: string | null;
  ultimaPruebaAt: string | null;
  bloqueado: boolean;
  bloqueadoMotivo: string | null;
}

const ENTRADA_INICIAL: EntradaAMedida = {
  modo: 'conversar',
  negocio: '',
  producto: '',
  apertura: '',
  objetivo: '',
  preguntas: ['', '', ''],
  guion: ['', '', ''],
  contexto: '',
  instrucciones: '',
  persona: {},
  maxTurnos: 10,
};

export function PruebaNueva({
  canales,
  organizaciones,
}: {
  canales: CanalRow[];
  organizaciones: OrgConLinea[];
}) {
  const router = useRouter();

  const [e, setE] = useState<EntradaAMedida>(ENTRADA_INICIAL);
  const [telefono, setTelefono] = useState('');
  const [varios, setVarios] = useState('');
  const [modoVarios, setModoVarios] = useState(false);
  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [elegidas, setElegidas] = useState<string[]>(canales[0] ? [canales[0].id] : []);
  const [conocido, setConocido] = useState<Conocido | null>(null);
  const [redactando, setRedactando] = useState(false);
  const [avisoBorrador, setAvisoBorrador] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [omitidos, setOmitidos] = useState<Array<{ telefono: string; motivo: string }>>([]);

  const set = <K extends keyof EntradaAMedida>(k: K, v: EntradaAMedida[K]) =>
    setE((prev) => ({ ...prev, [k]: v }));

  // ── cuentas ─────────────────────────────────────────────────────────────
  const numeros = useMemo(
    () => (modoVarios ? lineasDeNumeros(varios) : [telefono].filter(esTelefono)),
    [modoVarios, varios, telefono],
  );
  const cuantosNumeros = numeros.length + orgIds.length;
  const conversaciones = cuantosNumeros * elegidas.length;

  // Las sugerencias se calculan pero no se escriben en el estado: el campo vacío
  // muestra el sugerido como placeholder y el servidor usa el mismo. Así el
  // operador ve qué va a salir sin tener que borrar texto que no escribió.
  const aperturaFinal = e.apertura.trim() || aperturaSugerida(e.negocio, e.producto);
  const objetivoFinal = e.objetivo.trim() || objetivoSugerido(e.producto);

  const entradaFinal: EntradaAMedida = {
    ...e,
    apertura: aperturaFinal,
    objetivo: objetivoFinal,
    preguntas: e.preguntas.map((p) => p.trim()).filter(Boolean),
    guion: e.guion.map((g) => g.trim()).filter(Boolean),
  };

  const problema =
    cuantosNumeros === 0
      ? 'Escribí a qué número le vamos a escribir.'
      : elegidas.length === 0
        ? 'Elegí desde qué línea nuestra sale el mensaje.'
        : conocido?.bloqueado
          ? 'Ese número pidió que no le escribiéramos. No se puede probar.'
          : validarAMedida(entradaFinal);

  // ── mirar el número antes de escribirle ─────────────────────────────────
  async function mirarNumero(valor: string) {
    if (!esTelefono(valor)) {
      setConocido(null);
      return;
    }
    try {
      const res = await fetch(`/api/admin/pruebas?telefono=${encodeURIComponent(valor)}`);
      const json = (await res.json()) as Conocido;
      setConocido(json);
      // El nombre que ya conocíamos se propone, no se impone: si el operador
      // escribió uno, gana el suyo.
      if (json.nombre && !e.negocio.trim()) set('negocio', json.nombre);
    } catch {
      setConocido(null);
    }
  }

  // ── el borrador con IA ──────────────────────────────────────────────────
  async function redactar() {
    setRedactando(true);
    setAvisoBorrador(null);
    try {
      const res = await fetch('/api/admin/pruebas/redactar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          negocio: e.negocio,
          producto: e.producto,
          brief: [e.contexto, ...e.preguntas.filter(Boolean)].filter(Boolean).join('\n'),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setAvisoBorrador(json.error ?? 'No se pudo redactar el borrador.');
        return;
      }
      setE((prev) => ({
        ...prev,
        apertura: json.apertura ?? prev.apertura,
        objetivo: json.objetivo ?? prev.objetivo,
        preguntas:
          Array.isArray(json.preguntas) && json.preguntas.length > 0
            ? json.preguntas.slice(0, MAX_SONDAS)
            : prev.preguntas,
      }));
      if (json.degradado) {
        setAvisoBorrador(
          json.motivo
            ? `Sin modelo (${json.motivo}). Quedaron las sugerencias de siempre — editalas.`
            : 'El modelo devolvió menos de lo pedido. Revisá las preguntas.',
        );
      }
    } catch (err) {
      setAvisoBorrador(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setRedactando(false);
    }
  }

  // ── mandar ──────────────────────────────────────────────────────────────
  async function enviar(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    setOmitidos([]);
    if (problema) {
      setError(problema);
      return;
    }
    setEnviando(true);
    try {
      const res = await fetch('/api/admin/pruebas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nombre: entradaFinal.negocio,
          proposito: orgIds.length > 0 ? 'qa' : 'prospeccion',
          // El nombre y la organización valen para el número que se miró, no
          // para treinta pegados: ponerle «Clínica Mirla» y su organización a
          // toda una lista asociaría números ajenos a un cliente nuestro, y eso
          // después se lee como si el research los hubiera encontrado ahí.
          numeros: numeros.map((n) => ({
            telefono: n,
            nombre: modoVarios ? null : entradaFinal.negocio || null,
            organizationId: modoVarios ? null : conocido?.organizationId ?? null,
          })),
          organizationIds: orgIds,
          canales: elegidas,
          aMedida: {
            ...entradaFinal,
            contexto: entradaFinal.contexto || null,
            instrucciones: entradaFinal.instrucciones || null,
          },
          // Una conversación viva por línea, más tres. Con una línea da 4, que
          // es el default que ADR 0026 midió para un barrido; con tres da 6, que
          // alcanza para que las tres abran contra el mismo negocio antes de
          // pasar al siguiente. El techo de 12 es el de la columna.
          maxConcurrentes: Math.min(12, elegidas.length + 3),
          ritmoSegundos: 45,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo crear la prueba.');
        setOmitidos(json.omitidos ?? []);
        return;
      }
      // Se cae en la conversación, o en la prueba si hay varias. Nunca de vuelta
      // al formulario: ver la decisión 6 de ADR 0027.
      router.push(json.destino);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falló la petición.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form onSubmit={enviar} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
      {/* ══ la columna del formulario ══════════════════════════════════════ */}
      <div className="space-y-8">
        {/* ── 1 · a quién ─────────────────────────────────────────────── */}
        <Paso n={1} titulo="A quién le escribimos">
          {modoVarios ? (
            <div className="space-y-2">
              <Area
                etiqueta="Números, uno por línea"
                valor={varios}
                onChange={setVarios}
                filas={5}
                placeholder={'+57 300 123 4567\n+57 310 987 6543'}
              />
              <p className="tnum text-[12.5px] text-ink-faint">
                {numeros.length} {numeros.length === 1 ? 'número' : 'números'} reconocidos
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo
                etiqueta="Número de WhatsApp"
                valor={telefono}
                onChange={setTelefono}
                onBlur={() => mirarNumero(telefono)}
                placeholder="+57 300 123 4567"
                autoFocus
              />
              <Campo
                etiqueta="Nombre del negocio"
                valor={e.negocio}
                onChange={(v) => set('negocio', v)}
                placeholder="Clínica Mirla"
              />
            </div>
          )}

          {conocido?.bloqueado ? (
            <Aviso tono="error">
              Este número pidió que no le escribiéramos
              {conocido.bloqueadoMotivo ? ` (${conocido.bloqueadoMotivo})` : ''}. No se puede
              probar, y no lo desbloquea nada automático.
            </Aviso>
          ) : conocido?.conocido ? (
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Ya lo conocemos
              {conocido.nombre ? <> como <strong>{conocido.nombre}</strong></> : null}
              {conocido.ultimaPruebaAt ? (
                <>
                  {' '}· última prueba <strong>{hace(conocido.ultimaPruebaAt)}</strong>
                </>
              ) : (
                ' · nunca le escribimos'
              )}
              {conocido.organizationId ? (
                <>
                  {' '}·{' '}
                  <span className="text-money">
                    tiene research, así que además medimos si dicen lo mismo que su sitio
                  </span>
                </>
              ) : null}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <button
              type="button"
              onClick={() => {
                // Lo que sabíamos era de UN número. Arrastrarlo al modo de
                // varios haría que la pantalla afirme cosas que no miró.
                setConocido(null);
                setModoVarios((v) => !v);
              }}
              className="font-medium text-ink underline decoration-line-strong underline-offset-2 transition hover:decoration-ink"
            >
              {modoVarios ? 'Volver a un solo número' : 'Probar varios números a la vez'}
            </button>
            {organizaciones.length > 0 ? (
              <span className="text-ink-faint">
                o elegí clientes de la lista, más abajo en «QA de clientes»
              </span>
            ) : null}
          </div>

          {organizaciones.length > 0 ? (
            <details className="group rounded-xl border border-line bg-paper-sunken/50 px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-medium text-ink-soft transition group-open:mb-3 hover:text-ink">
                QA de clientes · {orgIds.length > 0 ? `${orgIds.length} elegidos` : 'ninguno'}
              </summary>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {organizaciones.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition hover:bg-paper-raised"
                  >
                    <input
                      type="checkbox"
                      checked={orgIds.includes(o.id)}
                      onChange={() =>
                        setOrgIds((prev) =>
                          prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id],
                        )
                      }
                      className="h-4 w-4 rounded border-line-strong"
                    />
                    <span className="min-w-0 flex-1 truncate text-ink">{o.nombre}</span>
                    <span className="tnum shrink-0 text-[12px] text-ink-faint">{o.telefono}</span>
                  </label>
                ))}
              </div>
            </details>
          ) : null}
        </Paso>

        {/* ── 2 · qué le decimos ──────────────────────────────────────── */}
        <Paso n={2} titulo="Qué le decimos">
          <div className="grid gap-3 sm:grid-cols-2">
            <TarjetaModo
              activa={e.modo === 'conversar'}
              onClick={() => set('modo', 'conversar')}
              titulo="Conversar"
              insignia="con IA"
              texto="Un comprador sintético habla con ellos hasta llegar a un objetivo. Sirve para ver cómo venden."
            />
            <TarjetaModo
              activa={e.modo === 'guion'}
              onClick={() => set('modo', 'guion')}
              titulo="Preguntas fijas"
              insignia="sin IA"
              texto="Mandamos estos mensajes, uno tras otro, sin importar qué contesten. Sirve para comparar la misma pregunta entre negocios."
            />
          </div>

          <Campo
            etiqueta="Qué vende, en una línea"
            valor={e.producto}
            onChange={(v) => set('producto', v)}
            placeholder="tratamientos faciales y corporales"
          />

          {e.modo === 'conversar' ? (
            <>
              <Area
                etiqueta="Lo que sabemos de ellos"
                ayuda="Contexto para el comprador: qué venden, dónde, qué anuncian. No se cita como verdad —no tiene fuente— pero le sirve para preguntar bien."
                valor={e.contexto ?? ''}
                onChange={(v) => set('contexto', v)}
                filas={3}
                placeholder="Clínica estética en Bogotá, zona norte. Anuncian un paquete de 4 sesiones. No publican precios."
              />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={redactar}
                  disabled={redactando || (!e.negocio.trim() && !(e.contexto ?? '').trim())}
                  className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2 text-[13.5px] font-medium text-ink transition hover:bg-paper-sunken disabled:opacity-40"
                >
                  <Chispa />
                  {redactando ? 'Redactando…' : 'Redactar borrador con IA'}
                </button>
                <p className="text-[12.5px] leading-snug text-ink-faint">
                  Rellena los campos de abajo. Lo que se manda es lo que quede escrito ahí.
                </p>
              </div>
              {avisoBorrador ? <Aviso tono="ojo">{avisoBorrador}</Aviso> : null}

              <Area
                etiqueta="Primer mensaje"
                ayuda="Lo primero que les llega. Es el que decide si contestan."
                valor={e.apertura}
                onChange={(v) => set('apertura', v)}
                filas={2}
                placeholder={aperturaSugerida(e.negocio, e.producto)}
              />

              <Area
                etiqueta="Objetivo de la conversación"
                ayuda="A dónde tiene que llegar. Es la palanca principal: cambialo y cambia toda la prueba."
                valor={e.objetivo}
                onChange={(v) => set('objetivo', v)}
                filas={2}
                placeholder={objetivoSugerido(e.producto)}
              />

              <ListaEditable
                etiqueta="Lo que quiero que averigüe"
                ayuda="Una por línea, en el orden en que las haría una persona. El comprador las va metiendo cuando corresponde, no como un cuestionario."
                valores={e.preguntas}
                onChange={(v) => set('preguntas', v)}
                maximo={MAX_SONDAS}
                placeholders={[
                  '¿Están abiertos los lunes?',
                  '¿Cuánto cuesta el tratamiento de manchas?',
                  '¿Qué pasa si el tratamiento no me funciona?',
                ]}
              />
            </>
          ) : (
            <>
              <ListaEditable
                etiqueta="Los mensajes, en orden"
                ayuda="El primero es el saludo. Los demás salen uno tras otro, sin importar qué contesten."
                valores={e.guion}
                onChange={(v) => set('guion', v)}
                maximo={MAX_GUION}
                primeroEs="Saludo"
                placeholders={[
                  'Hola, buenas 🙂 tengo unas dudas',
                  '¿Están abiertos los lunes?',
                  '¿Cuánto cuesta el tratamiento de manchas?',
                  '¿Y qué pasa si no me funciona?',
                ]}
              />
              <Aviso tono="ojo">
                El mensaje siguiente se manda <strong>cuando el anterior tuvo respuesta</strong>. Si
                no contestan, no seguimos escribiendo: mandarle tres mensajes seguidos a un número
                que no contesta no agrega información y es la firma exacta de un emisor de spam.
              </Aviso>
            </>
          )}

          <AjustesFinos e={e} set={set} />
        </Paso>

        {/* ── 3 · desde qué líneas ────────────────────────────────────── */}
        <Paso n={3} titulo="Desde qué líneas nuestras">
          {canales.length === 0 ? (
            <Aviso tono="error">
              No hay ninguna línea activa. Configurá una en{' '}
              <Link href="/admin/pruebas#lineas" className="underline underline-offset-2">
                Nuestras líneas
              </Link>{' '}
              antes de probar.
            </Aviso>
          ) : (
            <>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {canales.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() =>
                      setElegidas((prev) =>
                        prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                      )
                    }
                    className={cn(
                      'rounded-xl border px-4 py-3 text-left transition',
                      elegidas.includes(c.id)
                        ? 'border-ink bg-ink text-paper'
                        : 'border-line bg-paper-raised text-ink hover:border-line-strong',
                    )}
                  >
                    <p className="text-[13.5px] font-medium">{c.label}</p>
                    <p
                      className={cn(
                        'tnum mt-0.5 text-[12.5px]',
                        elegidas.includes(c.id) ? 'text-paper/70' : 'text-ink-faint',
                      )}
                    >
                      {c.phone_e164}
                    </p>
                  </button>
                ))}
              </div>
              <p className="text-[13px] leading-relaxed text-ink-faint">
                {elegidas.length > 1 ? (
                  <>
                    Con {elegidas.length} líneas abrimos <strong>{elegidas.length} hilos de
                    WhatsApp distintos</strong> contra cada número. Es la forma de ver si su agente
                    les contesta igual a varios clientes a la vez.
                  </>
                ) : (
                  <>
                    Elegí más de una para que le escriban varias personas distintas al mismo tiempo.
                    Cada línea abre su propio hilo de WhatsApp.
                  </>
                )}
              </p>
            </>
          )}
        </Paso>
      </div>

      {/* ══ la columna de la vista previa ══════════════════════════════════ */}
      <div className="lg:sticky lg:top-8 lg:self-start">
        <div className="space-y-4">
          <VistaPrevia entrada={entradaFinal} negocio={e.negocio} />

          <Card>
            <div className="space-y-3 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Lo que va a pasar
              </p>
              <p className="tnum text-[14px] leading-relaxed text-ink">
                {cuantosNumeros === 0 ? (
                  <span className="text-ink-faint">Falta el número.</span>
                ) : (
                  <>
                    <strong>{cuantosNumeros}</strong>{' '}
                    {cuantosNumeros === 1 ? 'número' : 'números'} ×{' '}
                    <strong>{elegidas.length}</strong>{' '}
                    {elegidas.length === 1 ? 'línea' : 'líneas'} ={' '}
                    <strong>{conversaciones}</strong>{' '}
                    {conversaciones === 1 ? 'conversación' : 'conversaciones'}
                  </>
                )}
              </p>
              <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-faint">
                <li>
                  Hasta {turnosDe(entradaFinal)} mensajes nuestros por conversación.
                </li>
                <li>
                  {e.modo === 'guion'
                    ? 'Cero llamadas a modelo: los mensajes ya están escritos.'
                    : 'Una llamada barata al modelo por turno, para redactar la respuesta.'}
                </li>
                <li>
                  {conocido?.organizationId
                    ? 'Con research detrás: además se mide si dicen lo mismo que su sitio.'
                    : 'Sin research detrás: se mide atención, no exactitud. No podemos acusar a nadie de inventar un dato que no podemos verificar.'}
                </li>
              </ul>
            </div>
          </Card>

          {error ? <Aviso tono="error">{error}</Aviso> : null}
          {omitidos.length > 0 ? (
            <Card className="border-leak/30 bg-leak-soft">
              <div className="space-y-1.5 p-4">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-leak">
                  Números que se cayeron
                </p>
                {omitidos.map((o, i) => (
                  <p key={`${o.telefono}-${i}`} className="tnum text-[12.5px] text-leak/90">
                    {o.telefono} — {o.motivo}
                  </p>
                ))}
              </div>
            </Card>
          ) : null}

          <button
            type="submit"
            disabled={enviando || Boolean(problema)}
            title={problema ?? undefined}
            className="w-full rounded-xl bg-ink px-5 py-3.5 text-[14.5px] font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
          >
            {enviando
              ? 'Escribiendo…'
              : conversaciones > 0
                ? `Escribir ahora · ${conversaciones} ${conversaciones === 1 ? 'conversación' : 'conversaciones'}`
                : 'Escribir ahora'}
          </button>

          <p className="text-center text-[12px] leading-relaxed text-ink-faint">
            {problema ?? 'Son mensajes de WhatsApp reales, desde nuestro número, ahora mismo.'}
          </p>
        </div>
      </div>
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LA VISTA PREVIA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los mismos globos que va a ver el que contesta.
 *
 * En modo guion se pueden mostrar todos los mensajes porque ya están escritos.
 * En modo conversar solo el primero es literal: los demás los redacta el
 * comprador en vivo, así que se listan los temas y **se dice que se redactan en
 * vivo**. Pintar un globo con una pregunta que a lo mejor no sale con esas
 * palabras sería fingir precisión, que es lo único que este producto no se puede
 * permitir (ADR 0023).
 */
function VistaPrevia({ entrada, negocio }: { entrada: EntradaAMedida; negocio: string }) {
  const esGuion = entrada.modo === 'guion';
  const mensajes = esGuion ? entrada.guion : [entrada.apertura];
  const temas = esGuion ? [] : entrada.preguntas;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line bg-paper-sunken px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-paper">
          {(negocio.trim() || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">
            {negocio.trim() || 'el negocio'}
          </p>
          <p className="text-[11px] text-ink-faint">vista previa · nada se ha mandado</p>
        </div>
      </div>

      <div className="space-y-2 p-4">
        {mensajes.filter(Boolean).length === 0 ? (
          <p className="py-6 text-center text-[13px] text-ink-faint">
            Escribí el primer mensaje y aparece acá.
          </p>
        ) : (
          mensajes.filter(Boolean).map((m, i) => (
            <div key={i} className="space-y-2">
              {i > 0 ? (
                <p className="py-0.5 text-center text-[11px] text-ink-faint">
                  ↓ cuando contesten
                </p>
              ) : null}
              <div className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ink px-3.5 py-2 text-[13px] leading-relaxed text-paper">
                  {m}
                </p>
              </div>
            </div>
          ))
        )}

        {temas.filter(Boolean).length > 0 ? (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Y va a averiguar, conversando
            </p>
            <ul className="space-y-1.5">
              {temas.filter(Boolean).map((t, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
                  <span className="tnum shrink-0 text-ink-faint">{i + 1}.</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              Estas las redacta el comprador en el momento, con las palabras que pidan las
              respuestas. No van textuales.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AJUSTES FINOS
// ═══════════════════════════════════════════════════════════════════════════

function AjustesFinos({
  e,
  set,
}: {
  e: EntradaAMedida;
  set: <K extends keyof EntradaAMedida>(k: K, v: EntradaAMedida[K]) => void;
}) {
  const p = e.persona;
  const setP = (k: keyof Persona, v: string) => set('persona', { ...p, [k]: v });

  return (
    <details className="group rounded-xl border border-line bg-paper-sunken/50 px-4 py-3">
      <summary className="cursor-pointer text-[13px] font-medium text-ink-soft transition group-open:mb-4 hover:text-ink">
        Ajustes finos · quién escribe, cómo se comporta, tope de turnos
      </summary>

      <div className="space-y-4">
        {e.modo === 'conversar' ? (
          <Area
            etiqueta="Cómo tiene que comportarse"
            ayuda="Ajusta el tono, nunca los hechos. «Que insista en el precio», «que se haga el desentendido»."
            valor={e.instrucciones ?? ''}
            onChange={(v) => set('instrucciones', v)}
            filas={2}
            placeholder="Que sea amable pero insista hasta que le den un precio concreto."
          />
        ) : null}

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Quién dice ser
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-faint">
            Se mantiene igual toda la conversación. No es realismo: es lo que hace verificable la
            prueba — terminada, se puede ir al CRM del negocio y confirmar que el lead llegó con ese
            correo exacto.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Campo
              etiqueta="Nombre"
              valor={p.nombre ?? ''}
              onChange={(v) => setP('nombre', v)}
              placeholder={PERSONA_POR_DEFECTO.nombre}
            />
            <Campo
              etiqueta="Correo"
              valor={p.correo ?? ''}
              onChange={(v) => setP('correo', v)}
              placeholder={PERSONA_POR_DEFECTO.correo}
            />
            <Campo
              etiqueta="Celular"
              valor={p.telefono ?? ''}
              onChange={(v) => setP('telefono', v)}
              placeholder={PERSONA_POR_DEFECTO.telefono}
            />
            <Campo
              etiqueta="Ciudad"
              valor={p.ciudad ?? ''}
              onChange={(v) => setP('ciudad', v)}
              placeholder={PERSONA_POR_DEFECTO.ciudad}
            />
            <Campo
              etiqueta="Presupuesto (opcional)"
              valor={p.presupuesto ?? ''}
              onChange={(v) => setP('presupuesto', v)}
              placeholder="hasta 2 millones"
            />
            {e.modo === 'conversar' ? (
              <div className="space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  Tope de turnos
                </label>
                <input
                  type="number"
                  min={2}
                  max={40}
                  value={e.maxTurnos}
                  onChange={(ev) => set('maxTurnos', Number(ev.target.value) || 10)}
                  className="tnum w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-line-strong"
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </details>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PIEZAS
// ═══════════════════════════════════════════════════════════════════════════

function Paso({ n, titulo, children }: { n: number; titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-paper">
          {n}
        </span>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">{titulo}</h2>
      </div>
      {/* 36px = el círculo (24) + el gap (12): el contenido cae exactamente
          debajo del título, no debajo del número. */}
      <div className="space-y-4 pl-9">{children}</div>
    </section>
  );
}

function TarjetaModo({
  activa,
  onClick,
  titulo,
  insignia,
  texto,
}: {
  activa: boolean;
  onClick: () => void;
  titulo: string;
  insignia: string;
  texto: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activa}
      className={cn(
        'rounded-xl border px-4 py-3.5 text-left transition',
        activa
          ? 'border-ink bg-paper-raised shadow-[0_0_0_1px_var(--color-ink)]'
          : 'border-line bg-paper-raised hover:border-line-strong',
      )}
    >
      <div className="flex items-center gap-2">
        <p className="text-[14px] font-semibold text-ink">{titulo}</p>
        <Badge tone={activa ? 'neutral' : 'muted'}>{insignia}</Badge>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-faint">{texto}</p>
    </button>
  );
}

function ListaEditable({
  etiqueta,
  ayuda,
  valores,
  onChange,
  maximo,
  primeroEs,
  placeholders = [],
}: {
  etiqueta: string;
  ayuda?: string;
  valores: string[];
  onChange: (v: string[]) => void;
  maximo: number;
  primeroEs?: string;
  placeholders?: string[];
}) {
  const set = (i: number, v: string) =>
    onChange(valores.map((x, j) => (j === i ? v : x)));

  return (
    <div className="space-y-2">
      <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {etiqueta}
      </label>
      {ayuda ? <p className="text-[12.5px] leading-relaxed text-ink-faint">{ayuda}</p> : null}

      <div className="space-y-2">
        {valores.map((v, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="tnum mt-2.5 w-14 shrink-0 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              {i === 0 && primeroEs ? primeroEs : `${i + 1}`}
            </span>
            <textarea
              value={v}
              onChange={(ev) => set(i, ev.target.value)}
              rows={1}
              placeholder={placeholders[i] ?? ''}
              className="min-h-[42px] flex-1 resize-y rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] leading-relaxed text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-line-strong"
            />
            {valores.length > 1 ? (
              <button
                type="button"
                onClick={() => onChange(valores.filter((_, j) => j !== i))}
                aria-label={`Quitar ${i + 1}`}
                className="mt-1.5 shrink-0 rounded-lg px-2 py-1.5 text-[16px] leading-none text-ink-faint transition hover:bg-paper-sunken hover:text-ink"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {valores.length < maximo ? (
        <button
          type="button"
          onClick={() => onChange([...valores, ''])}
          className="text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-2 transition hover:decoration-ink"
        >
          + agregar otra
        </button>
      ) : (
        <p className="text-[12px] text-ink-faint">
          Máximo {maximo}. Más que eso deja de ser una prueba y es un cuestionario.
        </p>
      )}
    </div>
  );
}

function Campo({
  etiqueta,
  valor,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
}: {
  etiqueta: string;
  valor: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {etiqueta}
      </label>
      <input
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        // El foco arranca acá porque es la primera cosa que se escribe en una
        // pantalla a la que se llega para escribir un número. Poner el cursor en
        // otro lado sería hacerse el difícil.
        autoFocus={autoFocus}
        className="w-full rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-line-strong"
      />
    </div>
  );
}

function Area({
  etiqueta,
  ayuda,
  valor,
  onChange,
  filas = 3,
  placeholder,
}: {
  etiqueta: string;
  ayuda?: string;
  valor: string;
  onChange: (v: string) => void;
  filas?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {etiqueta}
      </label>
      {ayuda ? <p className="text-[12.5px] leading-relaxed text-ink-faint">{ayuda}</p> : null}
      <textarea
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        rows={filas}
        placeholder={placeholder}
        className="w-full resize-y rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-[14px] leading-relaxed text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-line-strong"
      />
    </div>
  );
}

function Aviso({
  tono,
  children,
}: {
  tono: 'error' | 'ok' | 'ojo';
  children: React.ReactNode;
}) {
  const tonos = {
    error: 'bg-leak-soft text-leak',
    ok: 'bg-money-soft text-money',
    ojo: 'bg-paper-sunken text-ink-soft',
  } as const;
  return (
    <p className={cn('rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed', tonos[tono])}>
      {children}
    </p>
  );
}

function Chispa() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

/** Chequeo laxo a propósito: el servidor es el que manda con libphonenumber. */
function esTelefono(v: string): boolean {
  return v.replace(/\D/g, '').length >= 7;
}

function lineasDeNumeros(texto: string): string[] {
  return texto
    .split(/[\n,;]/)
    .map((l) => l.trim())
    .filter(esTelefono);
}

function hace(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}
