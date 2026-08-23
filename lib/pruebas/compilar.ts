import { db, unwrap } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import {
  PruebaLenguajeSchema,
  PruebaLenguajeMinimalSchema,
  inflarPruebaLenguaje,
} from '@/lib/ai/schemas';
import { PRUEBA_COMPILAR_SYSTEM } from '@/config/prompts';
import { blanquearCifras } from '@/lib/playbook/compile';
import type {
  ChequeoDeterministico,
  CriterioRubrica,
  HechoDeReferencia,
  PlanDePrueba,
  PlantillaRow,
  Persona,
  Sonda,
} from '@/lib/pruebas/types';

/**
 * De una plantilla genérica a una prueba concreta contra un negocio.
 *
 * El reparto es el mismo de ADR 0024 y por la misma razón:
 *
 *   EL CÓDIGO pone los hechos — qué precio publica el sitio, en qué ciudad
 *   atiende, cómo se llama el producto, qué prometió — y los chequeos
 *   determinísticos de la rúbrica, cada uno con su fuente.
 *
 *   EL MODELO pone el lenguaje — cómo se pregunta, con qué palabras, para que
 *   suene a una persona escribiendo por WhatsApp.
 *
 * Sin el research, la prueba corre igual: se usan la apertura y las sondas del
 * molde, `cobertura` queda en cero, y el admin ve que esa prueba midió atención
 * pero no pudo medir exactitud. Degradar honestamente en vez de fallar es lo
 * que mantiene el arnés vivo cuando un sitio bloquea el crawler.
 *
 * Ver docs/wiki/23-smoke-tester.md
 */

const MAX_SONDAS = 6;

export interface ContextoDelNegocio {
  negocio: string;
  producto: string;
  ciudad: string | null;
  ficha: HechoDeReferencia[];
  /** El texto crudo que se le pasa al modelo. Nunca se muestra al cliente. */
  resumen: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · LOS HECHOS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arma la ficha de verdad desde el research.
 *
 * Todo lo que entra acá lleva `fuente`, y lo que no la tiene entra con
 * `fuente: null` para que se vea que es inferido (§13.4). El evaluador después
 * distingue: un dato con fuente que el negocio contradijo es una alucinación
 * demostrable; uno sin fuente no se puede usar para acusar a nadie.
 */
export async function contextoDelNegocio(
  organizationId: string,
): Promise<ContextoDelNegocio | null> {
  const { data: run } = await db()
    .from('research_runs')
    .select('id, reused_from_run_id')
    .eq('organization_id', organizationId)
    .in('status', ['done', 'partial'])
    .order('finished_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!run) return null;

  const { data: filas } = await db()
    .from('research_findings')
    .select('section, payload, sources')
    .eq('research_run_id', run.reused_from_run_id ?? run.id);

  if (!filas || filas.length === 0) return null;

  const de = (seccion: string) => filas.find((f) => f.section === seccion);
  const payload = (seccion: string) =>
    (de(seccion)?.payload ?? {}) as Record<string, unknown>;

  const meta = payload('meta');
  const offer = payload('offer');
  const pricing = payload('pricing');
  const channels = payload('channels');
  const positioning = payload('positioning');
  const paginas = (payload('pages').pages ?? []) as Array<{
    url?: string;
    title?: string;
    description?: string;
    text?: string;
  }>;

  const home = paginas[0]?.url ?? null;
  const fuenteDe = (parte: string): string | null => {
    // El crawler no guarda en qué página vio cada dato. Se busca la subpágina
    // cuyo texto lo contiene y, si no aparece, se cita la home. Inventar la
    // URL exacta sería peor que citar la portada.
    const aguja = parte.toLowerCase().slice(0, 40);
    if (!aguja) return home;
    const hit = paginas.find((p) => (p.text ?? '').toLowerCase().includes(aguja));
    return hit?.url ?? home;
  };

  const ficha: HechoDeReferencia[] = [];
  const empujar = (clave: string, valor: unknown) => {
    const texto = typeof valor === 'string' ? valor.trim() : '';
    if (!texto || texto.length < 2) return;
    ficha.push({ clave, valor: texto.slice(0, 400), fuente: fuenteDe(texto) });
  };

  empujar('oferta', offer.summary);
  empujar('posicionamiento', positioning.claim);

  const productos = (offer.products ?? []) as Array<{ name?: string; description?: string }>;
  for (const p of productos.slice(0, 5)) {
    if (p.name) {
      ficha.push({
        clave: 'producto',
        valor: [p.name, p.description].filter(Boolean).join(' — ').slice(0, 300),
        fuente: fuenteDe(p.name),
      });
    }
  }

  // El precio es el hecho que más se paga: es el que el negocio más improvisa
  // por WhatsApp y el único que el cliente puede verificar de un vistazo.
  const preciosObservados = (pricing.observed_prices ?? pricing.prices ?? []) as unknown[];
  for (const precio of preciosObservados.slice(0, 6)) {
    if (typeof precio === 'string') empujar('precio', precio);
    else if (precio && typeof precio === 'object') {
      const p = precio as Record<string, unknown>;
      const arm = [p.label ?? p.name, p.price ?? p.amount ?? p.value]
        .filter(Boolean)
        .join(': ');
      if (arm) empujar('precio', arm);
    }
  }
  if (preciosObservados.length === 0 && pricing.publishes_prices === false) {
    ficha.push({
      clave: 'precio',
      valor: 'El sitio NO publica precios.',
      fuente: home,
    });
  }
  empujar('precio_notas', pricing.notes);

  empujar('promesa_de_respuesta', channels.response_promise);
  empujar('canales', Array.isArray(channels.detected) ? channels.detected.join(', ') : '');

  // Cobertura y horario no tienen sección propia en el research: se buscan en
  // el texto de las páginas con las frases con que se escriben en español.
  const textoTodo = paginas
    .map((p) => p.text ?? '')
    .join('\n')
    .slice(0, 40_000);
  const horario = extraerFrase(textoTodo, /(?:horario|atendemos|abierto|lunes a \w+)[^.\n]{0,120}/i);
  if (horario) empujar('horario', horario);
  const cobertura = extraerFrase(
    textoTodo,
    /(?:cobertura|atendemos en|env[ií]os a|presencia en|sedes? en)[^.\n]{0,120}/i,
  );
  if (cobertura) empujar('cobertura', cobertura);

  const negocio =
    (typeof meta.company_name === 'string' && meta.company_name) ||
    paginas[0]?.title ||
    'el negocio';
  const producto =
    (typeof offer.summary === 'string' && offer.summary.slice(0, 120)) ||
    productos[0]?.name ||
    'lo que ofrecen';

  return {
    negocio,
    producto,
    ciudad: null,
    ficha: ficha.slice(0, 24),
    resumen: armarResumen(negocio, ficha, paginas),
  };
}

function extraerFrase(texto: string, patron: RegExp): string | null {
  const m = texto.match(patron);
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 200) : null;
}

function armarResumen(
  negocio: string,
  ficha: HechoDeReferencia[],
  paginas: Array<{ url?: string; title?: string; description?: string; text?: string }>,
): string {
  const hechos = ficha
    .map((h) => `- ${h.clave}: ${h.valor}${h.fuente ? ` [${h.fuente}]` : ' [inferido]'}`)
    .join('\n');

  // 3.000 caracteres del texto de la home: es lo que permite descubrir el
  // evento que están promocionando esta semana, que es justo la pregunta que
  // convierte una prueba genérica en una específica.
  const extracto = (paginas[0]?.text ?? '').slice(0, 3_000);

  return [
    `NEGOCIO: ${negocio}`,
    '',
    'LO QUE SABEMOS, CON FUENTE:',
    hechos || '(el research no dejó ningún hecho verificable)',
    '',
    'TEXTO DE SU PÁGINA PRINCIPAL:',
    extracto || '(no se pudo leer el sitio)',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · LA COMPILACIÓN
// ═══════════════════════════════════════════════════════════════════════════

export async function compilarPrueba(args: {
  plantilla: PlantillaRow;
  organizationId: string | null;
  /** Contexto escrito a mano por el admin cuando no hay diagnóstico detrás. */
  contextoManual?: string | null;
  nombreObjetivo?: string | null;
  runId?: string | null;
}): Promise<PlanDePrueba> {
  const { plantilla } = args;

  const ctx = args.organizationId ? await contextoDelNegocio(args.organizationId) : null;

  const negocio = ctx?.negocio ?? args.nombreObjetivo ?? 'el negocio';
  const producto = ctx?.producto ?? 'lo que ofrecen';
  const ficha = ctx?.ficha ?? [];

  const persona = normalizarPersona(plantilla.persona);

  // Las cifras que el comprador tiene permitido decir: su propio presupuesto y
  // los precios que el sitio publica. Cualquier otra que el modelo se invente
  // se tapa antes de que salga por WhatsApp.
  const cifrasPermitidas = [
    ...ficha.filter((h) => h.clave === 'precio').map((h) => h.valor),
    persona.presupuesto ?? '',
  ].filter(Boolean);

  let lenguaje = {
    apertura: rellenar(plantilla.apertura, { negocio, producto, ciudad: ctx?.ciudad ?? '' }),
    objetivo: plantilla.objetivo,
    sondas: plantilla.sondas.map((s) => ({ ...s, del_research: false })),
    criterios_cierre: plantilla.criterios_cierre,
  };
  let degradado = true;

  // Sin research no se llama al modelo: no tendría con qué especializar nada y
  // sería gastar una llamada para reescribir el molde con otras palabras.
  if (ctx) {
    try {
      const r = await runStructured({
        step: 'prueba',
        schemaName: 'prueba_lenguaje',
        schema: PruebaLenguajeSchema,
        system: PRUEBA_COMPILAR_SYSTEM,
        input: armarInput(plantilla, ctx, args.contextoManual ?? null),
        organizationId: args.organizationId,
        role: 'cmo',
        trigger: 'smoke_test',
        runId: args.runId ?? null,
        degradeTo: {
          schema: PruebaLenguajeMinimalSchema,
          schemaName: 'prueba_lenguaje_minimo',
          inflate: inflarPruebaLenguaje,
        },
      });
      lenguaje = r.data;
      degradado = r.degraded;
    } catch (err) {
      // Una prueba con el molde crudo sigue midiendo si contestan y en cuánto,
      // que es la mitad del valor. Caerse acá dejaría al cliente sin nada.
      console.error('[pruebas] el compilador falló, se usa el molde crudo', err);
    }
  }

  const sondas: Sonda[] = lenguaje.sondas.slice(0, MAX_SONDAS).map((s, i) => ({
    id: s.id || `sonda_${i + 1}`,
    pregunta: limpiarSalida(s.pregunta, cifrasPermitidas),
    por_que: String(s.por_que ?? '').slice(0, 240),
    origen: s.del_research ? 'research' : 'plantilla',
  }));

  const rubrica = resolverRubrica(plantilla.rubrica, ficha);

  // Cobertura: cuántos criterios de la rúbrica se pueden verificar contra algo
  // que salió del sitio. Es la cifra que dice si esta prueba mide exactitud o
  // solo mide atención, y se muestra en el admin sin adornos.
  const conFuente = rubrica.filter((c) => c.chequeo !== null).length;

  return {
    template_id: plantilla.id,
    negocio,
    producto,
    objetivo: limpiarSalida(lenguaje.objetivo, cifrasPermitidas) || plantilla.objetivo,
    persona,
    apertura:
      limpiarSalida(lenguaje.apertura, cifrasPermitidas) ||
      rellenar(plantilla.apertura, { negocio, producto, ciudad: ctx?.ciudad ?? '' }),
    sondas: sondas.length > 0 ? sondas : plantillaComoSondas(plantilla),
    ficha,
    rubrica,
    criterios_cierre:
      lenguaje.criterios_cierre?.length > 0
        ? lenguaje.criterios_cierre.slice(0, 8)
        : plantilla.criterios_cierre,
    max_turnos: plantilla.max_turnos,
    cobertura: {
      con_fuente: conFuente,
      total: rubrica.length,
      porcentaje: rubrica.length > 0 ? Math.round((conFuente / rubrica.length) * 100) : 0,
    },
    degradado,
  };
}

function armarInput(
  plantilla: PlantillaRow,
  ctx: ContextoDelNegocio,
  contextoManual: string | null,
): string {
  return [
    `MOLDE DE LA PRUEBA: ${plantilla.nombre}`,
    `Qué mide: ${plantilla.descripcion}`,
    `Objetivo del molde: ${plantilla.objetivo}`,
    '',
    'PREGUNTAS BASE DEL MOLDE (úsalas de guía, especialízalas o reemplázalas):',
    plantilla.sondas.map((s) => `- ${s.pregunta} (${s.por_que})`).join('\n'),
    '',
    'IDENTIDAD DEL COMPRADOR (no la cambies, solo escribe como ella):',
    JSON.stringify(plantilla.persona),
    '',
    ctx.resumen,
    contextoManual ? `\nNOTAS DEL EQUIPO:\n${contextoManual}` : '',
  ]
    .join('\n')
    .slice(0, 24_000);
}

function plantillaComoSondas(plantilla: PlantillaRow): Sonda[] {
  return plantilla.sondas.map((s) => ({ ...s, origen: 'plantilla' as const }));
}

function rellenar(texto: string, vars: Record<string, string>): string {
  return texto.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/** Recorta y le pasa la red de cifras. El comprador no inventa precios. */
function limpiarSalida(texto: string, permitidas: string[]): string {
  const limpio = String(texto ?? '').trim();
  if (!limpio) return '';
  return blanquearCifras(limpio, 0, permitidas, 'no me acuerdo bien').slice(0, 400);
}

function normalizarPersona(raw: Partial<Persona>): Persona {
  return {
    nombre: raw.nombre ?? 'Camila Restrepo',
    correo: raw.correo ?? 'camila.restrepo.pruebas@gmail.com',
    telefono: raw.telefono ?? '3054182637',
    ciudad: raw.ciudad ?? 'Bogotá',
    presupuesto: raw.presupuesto,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · LA RÚBRICA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resuelve el mini-lenguaje de `chequeo` contra la ficha.
 *
 * Un chequeo que apunte a una clave que la ficha no tiene se resuelve a `null`,
 * no a «no cumplió». La diferencia importa: el criterio pasa a la capa 3 y el
 * informe dice «no se pudo verificar automáticamente». Reprobar a un negocio
 * porque nosotros no pudimos leer su sitio sería inventar un resultado.
 */
export function resolverRubrica(
  raw: PlantillaRow['rubrica'],
  ficha: HechoDeReferencia[],
): CriterioRubrica[] {
  return raw.map((c) => {
    const spec = (c as { chequeo?: unknown }).chequeo;
    return {
      id: c.id,
      dimension: c.dimension,
      criterio: c.criterio,
      peso: Number.isFinite(c.peso) ? Math.max(1, Math.min(10, Math.round(c.peso))) : 1,
      chequeo: typeof spec === 'string' ? parsearChequeo(spec, ficha) : null,
    };
  });
}

function parsearChequeo(
  spec: string,
  ficha: HechoDeReferencia[],
): ChequeoDeterministico | null {
  const [tipo, arg] = spec.split(':', 2).map((s) => s.trim());

  switch (tipo) {
    case 'hubo_respuesta':
      return { tipo: 'hubo_respuesta' };

    case 'respondio_antes_de': {
      const segundos = Number(arg);
      return Number.isFinite(segundos) && segundos > 0
        ? { tipo: 'respondio_antes_de', segundos }
        : null;
    }

    case 'dio_precio':
      return { tipo: 'dio_precio' };

    case 'propuso_paso_siguiente':
      return { tipo: 'propuso_paso_siguiente' };

    case 'pregunto_al_menos': {
      const cantidad = Number(arg);
      return Number.isFinite(cantidad) && cantidad > 0
        ? { tipo: 'pregunto_al_menos', cantidad }
        : null;
    }

    case 'menciona': {
      const hechos = ficha.filter((h) => h.clave === arg);
      if (hechos.length === 0) return null;
      return {
        tipo: 'menciona',
        alguna_de: hechos.map((h) => h.valor),
        fuente: hechos.find((h) => h.fuente)?.fuente ?? null,
      };
    }

    case 'no_menciona': {
      const lista = (arg ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return lista.length > 0 ? { tipo: 'no_menciona', ninguna_de: lista, fuente: null } : null;
    }

    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · LEER LAS PLANTILLAS
// ═══════════════════════════════════════════════════════════════════════════

export async function plantilla(id: string): Promise<PlantillaRow> {
  return unwrap(
    await db().from('smoke_templates').select('*').eq('id', id).single(),
    'smoke_templates.get',
  ) as PlantillaRow;
}

export async function plantillasActivas(): Promise<PlantillaRow[]> {
  const { data } = await db()
    .from('smoke_templates')
    .select('*')
    .eq('activo', true)
    .order('es_semilla', { ascending: false })
    .order('id');
  return (data ?? []) as PlantillaRow[];
}
