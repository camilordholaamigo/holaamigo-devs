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

/**
 * Un cliente o prospecto que ya pasó por la landing.
 *
 * `telefono` puede ser null y eso NO lo descalifica: el research solo registra
 * los números que encontró publicados en el sitio, y un negocio que no publica
 * WhatsApp igual se puede probar — el número lo escribe el operador y el
 * análisis sigue sirviendo para compilar las preguntas.
 */
export interface ClienteProbable {
  id: string;
  nombre: string;
  dominio: string | null;
  lifecycle: string;
  telefono: string | null;
  /** La URL donde el research leyó el número. Null = lo puso una persona. */
  fuenteTelefono: string | null;
  ultimaPruebaAt: string | null;
  bloqueado: boolean;
  /** Hay research en `done` o `partial`: el compilador tiene de dónde leer. */
  tieneAnalisis: boolean;
}

/** Un molde de la batería del diagnóstico, para poder nombrar qué va a correr. */
export interface MoldeDeBateria {
  id: string;
  nombre: string;
  que_mide: string;
  max_turnos: number;
}

type Camino = 'cliente' | 'numero';

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
  clientes,
  bateria,
}: {
  canales: CanalRow[];
  clientes: ClienteProbable[];
  bateria: MoldeDeBateria[];
}) {
  const router = useRouter();

  // Arranca en «cliente» cuando hay alguno: es el caso que más se pide y el que
  // estaba escondido. Con la base vacía no tiene sentido ofrecerlo.
  const [camino, setCamino] = useState<Camino>(clientes.length > 0 ? 'cliente' : 'numero');
  const [clienteId, setClienteId] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [telefonoCliente, setTelefonoCliente] = useState('');

  const [e, setE] = useState<EntradaAMedida>(ENTRADA_INICIAL);
  const [telefono, setTelefono] = useState('');
  const [varios, setVarios] = useState('');
  const [modoVarios, setModoVarios] = useState(false);
  const [elegidas, setElegidas] = useState<string[]>(canales[0] ? [canales[0].id] : []);
  const [conocido, setConocido] = useState<Conocido | null>(null);
  const [redactando, setRedactando] = useState(false);
  const [avisoBorrador, setAvisoBorrador] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [omitidos, setOmitidos] = useState<Array<{ telefono: string; motivo: string }>>([]);

  const set = <K extends keyof EntradaAMedida>(k: K, v: EntradaAMedida[K]) =>
    setE((prev) => ({ ...prev, [k]: v }));

  // ── el cliente elegido ──────────────────────────────────────────────────
  const cliente = useMemo(
    () => clientes.find((c) => c.id === clienteId) ?? null,
    [clientes, clienteId],
  );

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return clientes.slice(0, 12);
    return clientes
      .filter((c) => `${c.nombre} ${c.dominio ?? ''}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [clientes, busqueda]);

  /** El número al que se le va a escribir en el camino del cliente. */
  const telefonoDelCliente = cliente?.telefono ?? (esTelefono(telefonoCliente) ? telefonoCliente : null);

  // ── cuentas ─────────────────────────────────────────────────────────────
  const numeros = useMemo(
    () => (modoVarios ? lineasDeNumeros(varios) : [telefono].filter(esTelefono)),
    [modoVarios, varios, telefono],
  );
  const cuantosNumeros = camino === 'cliente' ? (telefonoDelCliente ? 1 : 0) : numeros.length;
  // En el camino del cliente corre la batería entera —el mismo guion que el
  // disparo automático—, así que cada línea abre una conversación por molde.
  const guiones = camino === 'cliente' ? bateria.length : 1;
  const conversaciones = cuantosNumeros * elegidas.length * guiones;

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
    camino === 'cliente'
      ? !cliente
        ? 'Elegí a qué cliente le vamos a escribir.'
        : cliente.bloqueado
          ? 'La línea de ese cliente pidió que no le escribiéramos. No se puede probar.'
          : !telefonoDelCliente
            ? 'No tenemos su número: escribilo para poder probarlo.'
            : elegidas.length === 0
              ? 'Elegí desde qué línea nuestra sale el mensaje.'
              : bateria.length === 0
                ? 'La batería del diagnóstico está vacía. Revisá los moldes en /admin/pruebas.'
                : null
      : cuantosNumeros === 0
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
        body: JSON.stringify(camino === 'cliente' ? cuerpoDelCliente() : cuerpoAMano()),
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

  /**
   * El camino del cliente: **no manda `aMedida`**.
   *
   * Manda `plantillas`, que es lo que hace que el compilador lea el research y
   * escriba las preguntas contra los hechos del sitio. Es literalmente el mismo
   * cuerpo que arma el disparo automático del diagnóstico, y por eso reproduce
   * el escenario que el cliente va a ver en vez de parecerse a él.
   *
   * El número va por `organizationIds` cuando lo conocemos —ahí el servidor lo
   * saca de `smoke_targets`, donde el research lo dejó con su fuente— y por
   * `numeros` con la organización pegada cuando lo escribió una persona. El
   * segundo caso no es degradado: la organización viaja igual, así que la ficha
   * de verdad entra y la prueba mide exactitud lo mismo.
   */
  function cuerpoDelCliente() {
    if (!cliente) return {};
    const conocemosSuNumero = Boolean(cliente.telefono);
    return {
      nombre: `${cliente.nombre} · como en el diagnóstico`,
      proposito: 'qa',
      numeros: conocemosSuNumero
        ? []
        : [{ telefono: telefonoCliente, nombre: cliente.nombre, organizationId: cliente.id }],
      organizationIds: conocemosSuNumero ? [cliente.id] : [],
      canales: elegidas,
      plantillas: bateria.map((m) => m.id),
      maxConcurrentes: Math.min(12, elegidas.length + 3),
      ritmoSegundos: 45,
      notas: `Reproducción manual del disparo automático para ${cliente.dominio ?? cliente.nombre}.`,
    };
  }

  function cuerpoAMano() {
    return {
      nombre: entradaFinal.negocio,
      proposito: 'prospeccion',
      // El nombre y la organización valen para el número que se miró, no para
      // treinta pegados: ponerle «Clínica Mirla» y su organización a toda una
      // lista asociaría números ajenos a un cliente nuestro, y eso después se
      // lee como si el research los hubiera encontrado ahí.
      numeros: numeros.map((n) => ({
        telefono: n,
        nombre: modoVarios ? null : entradaFinal.negocio || null,
        organizationId: modoVarios ? null : conocido?.organizationId ?? null,
      })),
      canales: elegidas,
      aMedida: {
        ...entradaFinal,
        contexto: entradaFinal.contexto || null,
        instrucciones: entradaFinal.instrucciones || null,
      },
      // Una conversación viva por línea, más tres. Con una línea da 4, que es el
      // default que ADR 0026 midió para un barrido; con tres da 6, que alcanza
      // para que las tres abran contra el mismo negocio antes de pasar al
      // siguiente. El techo de 12 es el de la columna.
      maxConcurrentes: Math.min(12, elegidas.length + 3),
      ritmoSegundos: 45,
    };
  }

  return (
    <form onSubmit={enviar} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
      {/* ══ la columna del formulario ══════════════════════════════════════ */}
      <div className="space-y-8">
        {/* ── 0 · qué querés probar ───────────────────────────────────── */}
        {clientes.length > 0 ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <TarjetaModo
              activa={camino === 'cliente'}
              onClick={() => setCamino('cliente')}
              titulo="Un cliente nuestro"
              insignia="un botón"
              texto="Las preguntas las compila el sistema leyendo su análisis. Es el mismo guion que corre solo durante el diagnóstico."
            />
            <TarjetaModo
              activa={camino === 'numero'}
              onClick={() => setCamino('numero')}
              titulo="Un número cualquiera"
              insignia="a medida"
              texto="El guion lo escribís vos. No hace falta que el negocio esté en nuestra base."
            />
          </div>
        ) : null}

        {camino === 'cliente' ? (
          <>
            {/* ── 1 · a quién ───────────────────────────────────────── */}
            <Paso n={1} titulo="Qué cliente">
              <Campo
                etiqueta="Buscar"
                valor={busqueda}
                onChange={setBusqueda}
                placeholder="conceptum"
              />

              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {filtrados.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-ink-faint">
                    Ninguno coincide con «{busqueda}».
                  </p>
                ) : (
                  filtrados.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setClienteId(c.id);
                        setTelefonoCliente('');
                      }}
                      className={cn(
                        'w-full rounded-xl border px-4 py-3 text-left transition',
                        clienteId === c.id
                          ? 'border-ink bg-ink text-paper'
                          : 'border-line bg-paper-raised hover:border-line-strong',
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                          {c.nombre}
                        </p>
                        <span
                          className={cn(
                            'tnum shrink-0 text-[12px]',
                            clienteId === c.id ? 'text-paper/70' : 'text-ink-faint',
                          )}
                        >
                          {c.telefono ?? 'sin número'}
                        </span>
                      </div>
                      <p
                        className={cn(
                          'mt-0.5 truncate text-[12px]',
                          clienteId === c.id ? 'text-paper/60' : 'text-ink-faint',
                        )}
                      >
                        {c.dominio ?? 'sin dominio'}
                        {c.tieneAnalisis ? ' · con análisis' : ' · sin análisis'}
                        {c.ultimaPruebaAt ? ` · probado ${hace(c.ultimaPruebaAt)}` : ''}
                      </p>
                    </button>
                  ))
                )}
              </div>

              {clientes.length > filtrados.length && !busqueda.trim() ? (
                <p className="text-[12.5px] text-ink-faint">
                  Los {filtrados.length} más recientes de {clientes.length}. Buscá por nombre o
                  dominio para ver el resto.
                </p>
              ) : null}

              {cliente ? (
                <FichaDelCliente
                  cliente={cliente}
                  telefonoEscrito={telefonoCliente}
                  onTelefono={setTelefonoCliente}
                />
              ) : null}
            </Paso>

            {/* ── 2 · qué le decimos ─────────────────────────────────── */}
            <Paso n={2} titulo="Qué le decimos">
              <BateriaDelDiagnostico bateria={bateria} cliente={cliente} />
            </Paso>
          </>
        ) : (
        <>
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
            {clientes.length > 0 ? (
              <button
                type="button"
                onClick={() => setCamino('cliente')}
                className="text-ink-faint underline decoration-line-strong underline-offset-2 transition hover:text-ink"
              >
                o elegí un cliente y usá su análisis
              </button>
            ) : null}
          </div>
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
        </>
        )}

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
          {camino === 'cliente' ? (
            <QueSeVaACompilar cliente={cliente} bateria={bateria} />
          ) : (
            <VistaPrevia entrada={entradaFinal} negocio={e.negocio} />
          )}

          <Card>
            <div className="space-y-3 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Lo que va a pasar
              </p>
              <p className="tnum text-[14px] leading-relaxed text-ink">
                {cuantosNumeros === 0 ? (
                  <span className="text-ink-faint">
                    {camino === 'cliente' ? 'Falta el cliente.' : 'Falta el número.'}
                  </span>
                ) : (
                  <>
                    <strong>{cuantosNumeros}</strong>{' '}
                    {cuantosNumeros === 1 ? 'número' : 'números'} ×{' '}
                    <strong>{elegidas.length}</strong>{' '}
                    {elegidas.length === 1 ? 'línea' : 'líneas'}
                    {guiones > 1 ? (
                      <>
                        {' '}
                        × <strong>{guiones}</strong> pruebas
                      </>
                    ) : null}{' '}
                    = <strong>{conversaciones}</strong>{' '}
                    {conversaciones === 1 ? 'conversación' : 'conversaciones'}
                  </>
                )}
              </p>
              <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-faint">
                {camino === 'cliente' ? (
                  <>
                    <li>
                      Hasta {bateria.reduce((n, m) => Math.max(n, m.max_turnos), 0)} mensajes
                      nuestros en la prueba más larga.
                    </li>
                    <li>Una llamada barata al modelo por turno, para redactar la respuesta.</li>
                    <li>
                      {cliente?.tieneAnalisis
                        ? 'Con su análisis detrás: además se mide si dicen lo mismo que su sitio.'
                        : 'Este cliente no tiene análisis terminado: se mide atención, no exactitud. No podemos acusar a nadie de inventar un dato que no podemos verificar.'}
                    </li>
                  </>
                ) : (
                  <>
                    <li>Hasta {turnosDe(entradaFinal)} mensajes nuestros por conversación.</li>
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
                  </>
                )}
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
              : camino === 'cliente'
                ? conversaciones > 0
                  ? `Probar como en el diagnóstico · ${conversaciones} ${conversaciones === 1 ? 'conversación' : 'conversaciones'}`
                  : 'Probar como en el diagnóstico'
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
// EL CAMINO DEL CLIENTE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que sabemos del cliente elegido, y el único campo que puede faltar.
 *
 * El número es el único dato que el análisis no siempre trae: el research solo
 * registra los que están publicados en el sitio, porque ése es el freno que hace
 * defendible el mensaje del camino automático (ADR 0025). Cuando no está, el
 * operador lo escribe —el camino manual lleva un solo freno, el bloqueo— y la
 * pantalla dice explícitamente qué freno se está saltando. Ocultarlo sería
 * convertir una decisión en un accidente.
 */
function FichaDelCliente({
  cliente,
  telefonoEscrito,
  onTelefono,
}: {
  cliente: ClienteProbable;
  telefonoEscrito: string;
  onTelefono: (v: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-paper-sunken/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-semibold text-ink">{cliente.nombre}</p>
        <Badge tone={cliente.tieneAnalisis ? 'money' : 'neutral'}>
          {cliente.tieneAnalisis ? 'con análisis' : 'sin análisis'}
        </Badge>
        <Badge tone="neutral">{cliente.lifecycle}</Badge>
      </div>

      {cliente.dominio ? (
        <p className="text-[12.5px] text-ink-faint">{cliente.dominio}</p>
      ) : null}

      {cliente.bloqueado ? (
        <Aviso tono="error">
          Su línea pidió que no le escribiéramos. No se puede probar, y no lo desbloquea nada
          automático.
        </Aviso>
      ) : cliente.telefono ? (
        <div className="space-y-1">
          <p className="tnum text-[13.5px] text-ink">{cliente.telefono}</p>
          <p className="text-[12px] leading-relaxed text-ink-faint">
            {cliente.fuenteTelefono ? (
              <>
                Lo publicaron en su sitio —{' '}
                <a
                  href={cliente.fuenteTelefono}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  la fuente
                </a>
                . Es el mismo número al que le escribe el disparo automático.
              </>
            ) : (
              'Lo escribió una persona: no está publicado en su sitio.'
            )}
            {cliente.ultimaPruebaAt ? ` Última prueba ${hace(cliente.ultimaPruebaAt)}.` : ''}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Campo
            etiqueta="Su número de WhatsApp"
            valor={telefonoEscrito}
            onChange={onTelefono}
            placeholder="+57 300 123 4567"
          />
          <p className="text-[12px] leading-relaxed text-ink-faint">
            Su sitio no publica WhatsApp, así que el research no dejó ningún número — y por eso el
            disparo automático no corrió contra ellos. Escribiéndolo acá la prueba sale igual, con
            su análisis detrás, y queda registrado como puesto a mano.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Qué se va a mandar, dicho sin fingir precisión.
 *
 * Acá NO van globos de WhatsApp. En el camino a medida el preview puede ser
 * literal porque el operador escribió las palabras; acá las escribe el
 * compilador leyendo el research en el momento del lanzamiento, y pintar un
 * globo con una pregunta inventada sería exactamente la clase de precisión falsa
 * que ADR 0023 prohíbe. Lo que sí se puede decir con certeza es qué pruebas
 * corren, en qué orden y qué mide cada una — y eso es lo que se dice.
 */
function BateriaDelDiagnostico({
  bateria,
  cliente,
}: {
  bateria: MoldeDeBateria[];
  cliente: ClienteProbable | null;
}) {
  if (bateria.length === 0) {
    return (
      <Aviso tono="error">
        La batería del diagnóstico está vacía: ninguno de los moldes configurados existe. Revisá los
        moldes en{' '}
        <Link href="/admin/pruebas#moldes" className="underline underline-offset-2">
          Pruebas de línea
        </Link>
        .
      </Aviso>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        No hay nada que escribir. Corre la <strong>misma batería</strong> que dispara el diagnóstico
        solo, en el mismo orden, y las preguntas las compila el sistema leyendo
        {cliente?.tieneAnalisis ? ' el análisis de este cliente' : ' lo que haya del cliente'}.
      </p>

      <ol className="space-y-2">
        {bateria.map((m, i) => (
          <li key={m.id} className="flex gap-3 rounded-xl border border-line bg-paper-raised p-3.5">
            <span className="tnum mt-0.5 shrink-0 text-[12px] font-semibold text-ink-faint">
              {i + 1}
            </span>
            <div className="min-w-0 space-y-0.5">
              <p className="text-[13.5px] font-medium text-ink">{m.nombre}</p>
              <p className="text-[12.5px] leading-relaxed text-ink-faint">{m.que_mide}</p>
            </div>
            <span className="tnum ml-auto shrink-0 self-start text-[12px] text-ink-faint">
              {m.max_turnos} turnos
            </span>
          </li>
        ))}
      </ol>

      {cliente && !cliente.tieneAnalisis ? (
        <Aviso tono="ojo">
          Este cliente no tiene research terminado, así que la ficha de verdad va vacía: la prueba
          mide si atienden, no si dicen la verdad. Sale igual y el informe lo dice.
        </Aviso>
      ) : null}
    </div>
  );
}

/** La versión de «lo que va a pasar» del camino del cliente. */
function QueSeVaACompilar({
  cliente,
  bateria,
}: {
  cliente: ClienteProbable | null;
  bateria: MoldeDeBateria[];
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line bg-paper-sunken px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-paper">
          {(cliente?.nombre ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">
            {cliente?.nombre ?? 'elegí un cliente'}
          </p>
          <p className="text-[11px] text-ink-faint">
            {cliente ? `${bateria.length} pruebas · nada se ha mandado` : 'nada se ha mandado'}
          </p>
        </div>
      </div>

      <div className="space-y-2.5 p-4">
        {!cliente ? (
          <p className="py-6 text-center text-[13px] text-ink-faint">
            Elegí un cliente de la lista y acá aparece qué se le va a mandar.
          </p>
        ) : (
          <>
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              La apertura y las preguntas se escriben en el momento del lanzamiento, contra los
              hechos que el research leyó en su sitio. No se muestran acá porque todavía no existen:
              quedan escritas, campo por campo, en la pantalla de la prueba.
            </p>
            <ul className="space-y-1">
              {bateria.map((m) => (
                <li key={m.id} className="text-[12.5px] text-ink-faint">
                  · {m.nombre}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
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
