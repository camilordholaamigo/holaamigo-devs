import { db, unwrap, tryWrite } from '@/lib/supabase/admin';
import { runStructured } from '@/lib/ai/client';
import {
  PlaybookLanguageSchema,
  PlaybookLanguageMinimalSchema,
  type PlaybookLanguage,
  type PlaybookLanguageMinimal,
} from '@/lib/ai/schemas';
import { PLAYBOOK_SYSTEM } from '@/config/prompts';
import { findingsForOrganization } from '@/lib/research/run';
import { getAnswers } from '@/lib/quiz/service';
import { agentIdFor } from '@/lib/agents/contracts';
import { agentConfigFor, type CmoConfig, type SalesConfig } from '@/lib/agents/config';
import { authorize } from '@/lib/governance/authorize';
import { ensureAsset, publicUrlFor } from '@/lib/assets/links';
import { schedulerConfigOf } from '@/lib/scheduling/bookings';
import { newRunId } from '@/lib/traces/record';
import { buildLearningContext } from '@/lib/learning/context';
import { recordDecision } from '@/lib/decisions/record';
import { track } from '@/lib/events';
import {
  medirCobertura,
  OBJECIONES_OBLIGATORIAS,
  type Agendamiento,
  type Calificacion,
  type Cobertura,
  type Escalamiento,
  type Guion,
  type Objecion,
  type Oferta,
  type PreguntaFrecuente,
  type Procedencia,
  type Producto,
  type Tono,
} from '@/lib/playbook/types';

/**
 * El compilador: del diagnóstico a un agente que puede conversar.
 *
 * Es el archivo que colapsa el onboarding. Antes, entre "el cliente vio su
 * diagnóstico" y "el cliente tiene un agente que agenda" había un correo, una
 * llamada, una plantilla de Google Docs y dos semanas. Todo lo que se
 * intercambiaba en esas dos semanas ya estaba en la base de datos cuando
 * terminó el quiz; nadie lo estaba leyendo.
 *
 * REPARTO DE TRABAJO, idéntico al del diagnóstico y por la misma razón:
 *
 *   El CÓDIGO pone los hechos y los números: qué productos, qué precio, qué
 *   duración de cita, qué franja horaria, qué link, qué prohibiciones, cuántas
 *   preguntas hacen falta antes de proponer horario.
 *
 *   El MODELO pone el lenguaje: cómo se pregunta, cómo se responde una
 *   objeción, cómo se abre.
 *
 * Y hay un tercer paso que no existe en el diagnóstico y que acá es
 * obligatorio: `blanquearCifras()` recorre TODO el texto del modelo y borra las
 * cifras de dinero que no estén autorizadas por el Brief. No alcanza con
 * pedirle al prompt que no escriba números — un guion que dice "desde $500.000"
 * se manda a un contacto real y nadie lo revisó.
 *
 * Ver docs/adr/0024-el-agente-se-compila-del-diagnostico.md
 */

export interface CompileResult {
  playbookId: string;
  version: number;
  cobertura: Cobertura;
  degraded: boolean;
  costUsd: number;
  durationMs: number;
}

export interface CompileProgress {
  fase: 'contexto' | 'lenguaje' | 'ensamblado' | 'agenda' | 'guardado';
  detalle: string;
}

export async function compilePlaybook(args: {
  organizationId: string;
  /** La sesión de la que salen las respuestas del quiz. */
  sessionId?: string | null;
  onProgress?: (p: CompileProgress) => void;
}): Promise<CompileResult> {
  const started = Date.now();
  const say = args.onProgress ?? (() => {});

  // El compilador NO ejecuta hacia afuera, pero sí escribe un objeto que
  // gobierna lo que después se le dice a terceros. Pasa por el motor de
  // permisos igual que todo lo demás: lo que no está en el catálogo se bloquea.
  const permiso = await authorize({
    organizationId: args.organizationId,
    capabilityId: 'playbook.compile',
    agentId: await agentIdFor(args.organizationId, 'cmo'),
    title: 'Armar el guion del agente de agendamiento',
  });
  if (permiso.accion_permitida === 'nada') {
    throw new Error(`[playbook] sin permiso para compilar: ${permiso.reason ?? 'bloqueado'}`);
  }

  say({ fase: 'contexto', detalle: 'Leyendo tu diagnóstico y lo que encontramos de tu sitio' });

  const org = unwrap(
    await db()
      .from('organizations')
      .select('id, name, domain, website_url, country, currency, industry')
      .eq('id', args.organizationId)
      .single(),
    'organizations.get',
  );

  const companyName = org.name ?? org.domain;

  const sessionId = args.sessionId ?? (await ultimaSesion(args.organizationId));

  const [research, answers, brief, diagnostic] = await Promise.all([
    findingsForOrganization(args.organizationId),
    sessionId ? getAnswers(sessionId) : Promise.resolve({} as Record<string, unknown>),
    briefVigente(args.organizationId),
    diagnosticoVigente(args.organizationId),
  ]);

  const offer = research.sections.offer?.payload as
    | { summary?: string; products?: { name: string; description: string }[] }
    | undefined;
  const pricing = research.sections.pricing?.payload as
    | { is_public?: boolean; observed?: string[]; notes?: string }
    | undefined;
  const icp = research.sections.icp?.payload as
    | { description?: string; segments?: string[] }
    | undefined;
  const sitio = fuentePrincipal(research.sources, org.website_url);

  // ── La agenda real. Antes del modelo a propósito: los horarios que el guion
  //    va a mencionar tienen que existir antes de que se escriba el guion.
  say({ fase: 'agenda', detalle: 'Preparando tu agenda y el link de reserva' });

  const asset = await ensureAsset({
    organizationId: args.organizationId,
    kind: 'scheduler',
    companyName,
  });
  const scheduler = schedulerConfigOf(asset);

  const salesConfig = (await agentConfigFor(args.organizationId, 'sales')).config as SalesConfig;
  const cmoConfig = (await agentConfigFor(args.organizationId, 'cmo')).config as CmoConfig;

  // ── El modelo: solo lenguaje ──────────────────────────────────────────────
  say({ fase: 'lenguaje', detalle: 'Escribiendo el guion, las objeciones y las preguntas' });

  const runId = newRunId();
  const learning = await buildLearningContext({
    organizationId: args.organizationId,
    role: 'cmo',
    industry: org.industry,
    task: `Guion de agendamiento por WhatsApp para ${companyName}`,
    kind: 'playbook_compile',
    runId,
  });

  let language: PlaybookLanguage;
  let degraded = false;
  let costUsd = 0;

  try {
    const result = await runStructured({
      step: 'playbook',
      schemaName: 'playbook_language',
      schema: PlaybookLanguageSchema,
      system: PLAYBOOK_SYSTEM,
      input: [
        buildCompileInput({ org, companyName, answers, research, brief, diagnostic, scheduler }),
        learning.block,
      ]
        .filter(Boolean)
        .join('\n\n'),
      organizationId: args.organizationId,
      agentId: await agentIdFor(args.organizationId, 'cmo'),
      role: 'cmo',
      trigger: 'intake',
      runId,
      degradeTo: {
        schema: PlaybookLanguageMinimalSchema,
        schemaName: 'playbook_language_minimal',
        inflate: (min: PlaybookLanguageMinimal) => inflateLanguage(min, companyName),
      },
    });
    language = result.data;
    degraded = result.degraded;
    costUsd = result.costUsd;
  } catch (err) {
    // Mismo criterio que el diagnóstico: nunca dejamos al cliente sin salida.
    // Un guion de plantilla con SUS datos reales es defendible; una pantalla de
    // error después de tres minutos de quiz no lo es.
    console.error('[playbook] el modelo falló por completo, ensamblando de plantilla', err);
    language = plantillaDeRespaldo(companyName, offer?.summary ?? null);
    degraded = true;
  }

  say({ fase: 'ensamblado', detalle: 'Poniendo tus números, tus límites y tus horarios' });

  // ── Ensamblado determinista ───────────────────────────────────────────────
  const ticket = Number(brief?.precios?.ticket_promedio_usd ?? 0) || 0;
  const bandaDeclarada = (answers.ticket_band as string | undefined) ?? null;
  const preciosPublicos = (pricing?.observed ?? []).slice(0, 8).map((p) => String(p));

  const oferta: Oferta = {
    resumen: offer?.summary ?? (typeof answers.main_offer === 'string' ? answers.main_offer : `${companyName} vende sus servicios.`),
    productos: productosDe(offer?.products, answers.main_offer, sitio),
    lo_que_vendemos_aca: limpiar(language.lo_que_vendemos_aca, ticket, preciosPublicos),
    precio: {
      ticket_promedio_usd: ticket,
      banda_declarada: bandaDeclarada,
      publicos: preciosPublicos,
      // Si el cliente publica precios en su sitio, esconderlos por WhatsApp es
      // una pérdida de tiempo para los dos: el contacto los va a encontrar en
      // treinta segundos y va a pensar que le estamos escondiendo algo.
      politica: pricing?.is_public && preciosPublicos.length > 0 ? 'decir_rango' : 'derivar_a_la_cita',
    },
  };

  const calificacion: Calificacion = {
    preguntas: ordenarPreguntas(language.calificacion.preguntas, ticket, preciosPublicos),
    // Tres de cuatro y no cuatro de cuatro: exigir las cuatro convierte la
    // conversación en un interrogatorio y el `decisor` casi siempre se descubre
    // solo en la cita. Es un número, así que lo pone el código.
    minimo_para_agendar: 3,
    fuera_de_alcance: (language.calificacion.fuera_de_alcance ?? []).slice(0, 6).map((s) => String(s).slice(0, 160)),
  };

  const objeciones = completarObligatorias(
    language.objeciones.map((o) => ({
      objecion: String(o.objecion).slice(0, 160),
      respuesta: limpiar(o.respuesta, ticket, preciosPublicos),
      procedencia: procedenciaDe(o.source_url, o.inferred),
    })),
    { companyName, sitio, politica: oferta.precio.politica, banda: bandaDeclarada },
  );

  const faq: PreguntaFrecuente[] = language.faq.slice(0, 12).map((f) => ({
    pregunta: String(f.pregunta).slice(0, 200),
    respuesta: limpiar(f.respuesta, ticket, preciosPublicos),
    procedencia: procedenciaDe(f.source_url, f.inferred),
  }));

  const agendamiento: Agendamiento = {
    asset_slug: asset.slug,
    url: publicUrlFor(asset),
    duracion_min: scheduler.duration_min,
    zona_horaria: scheduler.timezone,
    dias_habiles: scheduler.working_days,
    hora_inicio: scheduler.start_hour,
    hora_fin: scheduler.end_hour,
    anticipacion_min_horas: scheduler.min_notice_hours,
    que_pasa_en_la_cita: limpiar(language.que_pasa_en_la_cita, ticket, preciosPublicos),
    quien_atiende: (typeof answers.quien_atiende === 'string' ? answers.quien_atiende : null) ?? null,
    modalidad: String((asset.config as { location?: string }).location ?? 'Google Meet'),
    // Dos y no tres: tres horarios son un menú, y un menú se contesta con
    // "déjame ver y te aviso".
    opciones_por_mensaje: 2,
  };

  const guion: Guion = {
    apertura: limpiar(language.guion.apertura, ticket, preciosPublicos),
    apertura_inbound: limpiar(language.guion.apertura_inbound, ticket, preciosPublicos),
    puente_a_la_cita: limpiar(language.guion.puente_a_la_cita, ticket, preciosPublicos),
    oferta_de_horarios: asegurarMarcador(
      limpiar(language.guion.oferta_de_horarios, ticket, preciosPublicos),
      '{{horarios}}',
      'Te puedo dejar {{horarios}}. ¿Cuál te sirve?',
    ),
    confirmacion: asegurarMarcador(
      limpiar(language.guion.confirmacion, ticket, preciosPublicos),
      '{{cita}}',
      'Listo, quedaste para {{cita}}. Si necesitas cambiarla: {{link}}',
    ),
    seguimientos: (language.guion.seguimientos ?? [])
      .slice(0, 3)
      .map((s) => limpiar(s, ticket, preciosPublicos)),
    cierre_cortes: limpiar(language.guion.cierre_cortes, ticket, preciosPublicos),
  };

  const escalamiento: Escalamiento = {
    // Los disparadores del contrato de SALES no son negociables por el modelo
    // ni por el cliente: son la promesa de que el agente levanta la mano. Se
    // unen a los que el modelo propuso, no los reemplazan.
    disparadores: unicos([
      ...DISPARADORES_DEL_CONTRATO,
      ...(salesConfig.always_escalate ?? []).map(etiquetaDeIntencion),
      ...(language.escalamiento.disparadores ?? []).map((d) => String(d).slice(0, 160)),
    ]).slice(0, 14),
    mensaje_al_contacto: limpiar(language.escalamiento.mensaje_al_contacto, ticket, preciosPublicos),
    sla_minutos: 30,
  };

  const tono: Tono = {
    descripcion: cmoConfig.tone || String(brief?.tono?.descripcion ?? 'directo, sin relleno corporativo'),
    prohibidas: unicos([...(cmoConfig.forbidden ?? []), ...(brief?.tono?.prohibidas ?? [])]).slice(0, 20),
    ejemplo_del_cliente: typeof answers.tone === 'string' ? answers.tone : null,
    // Colombia B2B tutea por WhatsApp salvo que el cliente diga lo contrario.
    // Es una decisión de mercado, no una preferencia: el usted por chat suena a
    // banco, y a un banco no le contestan.
    tratamiento: /usted|formal/i.test(cmoConfig.tone ?? '') ? 'usted' : 'tu',
    emojis: 'uno_maximo',
  };

  const prohibiciones = unicos([
    ...(Array.isArray(brief?.prohibiciones) ? (brief.prohibiciones as string[]) : []),
    'No agendar una cita sin haber confirmado un horario concreto con la herramienta de agenda.',
    'No decir que eres una persona.',
    'No insistir después de que alguien pida no ser contactado.',
  ]).slice(0, 20);

  const cobertura = medirCobertura(
    partesMedibles({ oferta, objeciones, faq, agendamiento, calificacion, icp, sitio }),
  );

  // ── Persistencia ──────────────────────────────────────────────────────────
  say({ fase: 'guardado', detalle: 'Guardando el guion y dejando el agente listo' });

  const salesAgentId = await agentIdFor(args.organizationId, 'sales');

  // Sin playbook no hay agente, y el cliente acaba de ver una pantalla que le
  // dijo que se lo estábamos armando. Acá no se acepta un fallo silencioso.
  const inserted = unwrap(
    await db()
      .from('agent_playbooks')
      .insert({
        organization_id: args.organizationId,
        agent_id: salesAgentId,
        vertical: 'appointment_setting',
        channel: 'whatsapp',
        status: 'active',
        source: 'compilado',
        oferta,
        calificacion,
        objeciones,
        faq,
        agendamiento,
        guion,
        escalamiento,
        prohibiciones,
        tono,
        cobertura,
        compiled_from: {
          diagnostic_id: diagnostic?.id ?? null,
          brief_version: brief?.__version ?? null,
          research_run_id: research.runId ?? null,
          research_quality: research.status,
          session_id: sessionId,
          run_id: runId,
          degraded,
        },
        compile_cost_usd: costUsd,
        compile_ms: Date.now() - started,
        is_current: true,
      })
      .select('id, version')
      .single(),
    'agent_playbooks.insert',
  );

  await sincronizarProductos(args.organizationId, oferta);

  // El agente SALES nace en `draft` (contracts.ts) porque ejecuta. Con playbook
  // pasa a `active`: ya tiene con qué trabajar. Lo que sale hacia un tercero
  // sigue gobernado por la escalera de capacidades — activar al agente no es
  // autorizarle nada, es dejar de decir "todavía no está listo" cuando sí lo
  // está.
  await tryWrite(
    db()
      .from('agents')
      .update({ status: 'active' })
      .eq('organization_id', args.organizationId)
      .eq('role', 'sales')
      .eq('status', 'draft'),
    'agents.activate_sales',
  );

  await registrarDecision({
    organizationId: args.organizationId,
    runId,
    agentId: salesAgentId,
    playbookId: inserted.id,
    oferta,
    calificacion,
    cobertura,
    degraded,
  });

  await track('playbook_compiled', {
    organizationId: args.organizationId,
    sessionId,
    props: {
      version: inserted.version,
      cobertura: cobertura.porcentaje,
      a_confirmar: cobertura.a_confirmar.length,
      objeciones: objeciones.length,
      faq: faq.length,
      degraded,
      cost_usd: costUsd,
    },
  });

  return {
    playbookId: inserted.id,
    version: inserted.version,
    cobertura,
    degraded,
    costUsd,
    durationMs: Date.now() - started,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LA RED QUE ATRAPA LAS CIFRAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Borra del texto del modelo cualquier cifra de dinero que no esté autorizada.
 *
 * Existe porque pedirlo en el prompt no basta. Un guion que dice "planes desde
 * $500.000" se envía a un contacto real por WhatsApp y nadie lo revisa en el
 * camino: no hay una pantalla intermedia donde el cliente lo lea. Es la única
 * cifra del producto que puede llegar a un tercero sin pasar por un humano, así
 * que es la única que se filtra por código.
 *
 * Qué se considera autorizado: los precios que el research LEYÓ TEXTUALMENTE en
 * el sitio del cliente, y el ticket promedio del Brief. Todo lo demás se
 * reemplaza por una frase que devuelve la conversación a la cita, que es
 * exactamente lo que un setter debería estar haciendo cuando aparece un precio.
 *
 * Los porcentajes y las duraciones NO se tocan: "en 15 minutos" o "el 40% de
 * nuestros clientes" no comprometen plata y borrarlos rompería el lenguaje.
 */
const CIFRA_DE_DINERO =
  /(?:\$|us\$|usd|cop|€|eur)\s?\d[\d.,]*(?:\s?(?:mil|millones|k|m))?|\d[\d.,]*\s?(?:dólares|dolares|pesos|usd|cop|euros)/gi;

/**
 * `reemplazo` existe porque el smoke tester reusa esta red con otra voz. Ahí
 * quien habla no es un vendedor sino un comprador sintético, y «lo hablamos en
 * la llamada» en su boca es un no-sequitur que delata la prueba. La red es la
 * misma —ninguna cifra que el modelo se invente sale por WhatsApp— y lo único
 * que cambia es con qué se tapa. Ver lib/pruebas/comprador.ts.
 */
export function blanquearCifras(
  texto: string,
  ticketUsd: number,
  autorizados: string[],
  reemplazo = 'lo hablamos en la llamada',
): string {
  if (!texto) return '';

  const permitidos = new Set(
    [...autorizados, ticketUsd > 0 ? `$${ticketUsd}` : '']
      .filter(Boolean)
      .map((p) => normalizarCifra(p)),
  );

  return texto.replace(CIFRA_DE_DINERO, (match) =>
    permitidos.has(normalizarCifra(match)) ? match : reemplazo,
  );
}

function normalizarCifra(raw: string): string {
  return raw.toLowerCase().replace(/[\s.,]/g, '');
}

function limpiar(texto: string, ticketUsd: number, autorizados: string[]): string {
  return blanquearCifras(String(texto ?? '').trim(), ticketUsd, autorizados).slice(0, 600);
}

// ═══════════════════════════════════════════════════════════════════════════

/** Los disparadores que vienen del contrato de SALES (§3.3). No se editan. */
const DISPARADORES_DEL_CONTRATO = [
  'Pregunta de precio que no está cubierta por el rango del Brief',
  'Queja hacia la marca o mención de spam',
  'Mención legal, de abogados o de habeas data',
  'Petición explícita de hablar con una persona',
  'Respuesta que no se entiende después de dos intentos',
];

const ETIQUETAS_DE_INTENCION: Record<string, string> = {
  ask_price: 'Pregunta de precio que no está cubierta por el rango del Brief',
  complaint: 'Queja hacia la marca o mención de spam',
  legal: 'Mención legal, de abogados o de habeas data',
};

function etiquetaDeIntencion(clave: string): string {
  return ETIQUETAS_DE_INTENCION[clave] ?? clave;
}

/**
 * Reordena las cuatro preguntas de calificación al orden del oficio.
 *
 * `dolor` va primero siempre, y esto no se le confía al modelo aunque el prompt
 * lo pida: es lo único que al contacto le interesa contestar en el primer
 * minuto. Las otras tres las contesta porque ya está conversando. Un setter que
 * abre preguntando quién decide recibe un "¿y tú quién eres?".
 */
const ORDEN_DE_EJES = ['dolor', 'encaje', 'momento', 'decisor'] as const;

function ordenarPreguntas(
  preguntas: PlaybookLanguage['calificacion']['preguntas'],
  ticket: number,
  autorizados: string[],
): Calificacion['preguntas'] {
  const porEje = new Map<string, PlaybookLanguage['calificacion']['preguntas'][number]>();
  for (const p of preguntas) if (!porEje.has(p.campo)) porEje.set(p.campo, p);

  return ORDEN_DE_EJES.filter((eje) => porEje.has(eje)).map((eje) => {
    const p = porEje.get(eje)!;
    return {
      campo: eje,
      pregunta: limpiar(p.pregunta, ticket, autorizados),
      por_que: String(p.por_que ?? '').slice(0, 240),
      descalifica_si: (p.descalifica_si ?? []).slice(0, 5).map((d) => String(d).slice(0, 160)),
    };
  });
}

/**
 * Las cinco objeciones obligatorias, con respuesta, existan o no en la salida
 * del modelo.
 *
 * La de "¿de dónde sacaste mi número?" no se deja al criterio de nadie: es una
 * respuesta sobre tratamiento de datos personales, y lo que no está escrito lo
 * improvisa el modelo en el momento. Eso es exactamente lo que no puede pasar.
 */
function completarObligatorias(
  objeciones: Objecion[],
  ctx: { companyName: string; sitio: string | null; politica: Oferta['precio']['politica']; banda: string | null },
): Objecion[] {
  const inferido: Procedencia = { fuente: null, inferido: true };

  // Cada obligatoria trae las palabras con las que se reconoce si el modelo ya
  // la escribió, y el respaldo por si no. Se recorre `OBJECIONES_OBLIGATORIAS`
  // para que agregar una a la lista de `types.ts` sin escribir su respaldo acá
  // sea un error de tipos y no un silencio.
  const respaldos: Record<
    (typeof OBJECIONES_OBLIGATORIAS)[number],
    { pistas: string[]; respuesta: string }
  > = {
    '¿De dónde sacaste mi número?': {
      pistas: ['número', 'numero', 'datos', 'contacto'],
      respuesta: `De una base de contactos de ${ctx.companyName}: en algún momento dejaste tus datos o consultaste por nuestros servicios. Si prefieres que no te escribamos más, me dices y listo.`,
    },
    '¿Esto es un bot?': {
      pistas: ['bot', 'robot', 'persona real', 'humano'],
      respuesta: `Soy el asistente de ${ctx.companyName}, sí. Coordino la agenda y contesto lo básico; lo de fondo lo ve una persona en la reunión.`,
    },
    'Mándame información por acá / no quiero reunión': {
      pistas: ['información', 'informacion', 'info', 'reunión', 'reunion'],
      respuesta:
        'Te puedo contar lo esencial por acá, pero lo que sirve de verdad es ver tu caso concreto. Son 15 minutos y sales sabiendo si te conviene o no.',
    },
    '¿Cuánto cuesta?': {
      pistas: ['cuesta', 'precio', 'vale', 'costo'],
      respuesta:
        ctx.politica === 'decir_rango'
          ? 'Depende del alcance, y por eso los precios están publicados en el sitio. En la llamada te decimos cuál te aplica.'
          : 'Depende del alcance, así que decirte un número ahora sería inventarlo. En la llamada te lo cotizan con tu caso en la mano.',
    },
    'Ahora no tengo tiempo': {
      pistas: ['tiempo', 'ocupad', 'después', 'despues'],
      respuesta:
        'Sin problema. ¿Te busco un horario para la próxima semana? Son 15 minutos y los agendamos cuando te sirva.',
    },
  };

  const faltantes: Objecion[] = [];
  for (const clave of OBJECIONES_OBLIGATORIAS) {
    const { pistas, respuesta } = respaldos[clave];
    const yaEsta = objeciones.some((o) =>
      pistas.some((pista) => o.objecion.toLowerCase().includes(pista)),
    );
    if (!yaEsta) faltantes.push({ objecion: clave, respuesta, procedencia: inferido });
  }

  return [...objeciones.slice(0, 14), ...faltantes];
}

function productosDe(
  fromResearch: { name: string; description: string }[] | undefined,
  mainOffer: unknown,
  sitio: string | null,
): Producto[] {
  const productos: Producto[] = (fromResearch ?? []).slice(0, 8).map((p) => ({
    nombre: String(p.name).slice(0, 120),
    descripcion: String(p.description ?? '').slice(0, 300),
    para_quien: '',
    procedencia: { fuente: sitio, inferido: !sitio },
  }));

  // Lo que el cliente escribió en el quiz manda sobre lo que leímos del sitio:
  // "si tuvieras que vender una sola cosa este trimestre" es una respuesta
  // suya, no una inferencia nuestra. Va primero.
  if (typeof mainOffer === 'string' && mainOffer.trim()) {
    productos.unshift({
      nombre: mainOffer.trim().slice(0, 120),
      descripcion: 'Lo que el cliente declaró como su foco del trimestre.',
      para_quien: '',
      procedencia: { fuente: null, inferido: false },
    });
  }

  return productos.slice(0, 8);
}

function procedenciaDe(url: string | null, inferido: boolean): Procedencia {
  const limpia = url && /^https?:\/\//i.test(url) ? url : null;
  return { fuente: limpia, inferido: inferido || !limpia };
}

function asegurarMarcador(texto: string, marcador: string, respaldo: string): string {
  return texto.includes(marcador) ? texto : respaldo;
}

function unicos(items: string[]): string[] {
  return [...new Set(items.map((i) => i.trim()).filter(Boolean))];
}

function fuentePrincipal(
  sources: { url: string }[] | undefined,
  websiteUrl: string,
): string | null {
  return sources?.[0]?.url ?? websiteUrl ?? null;
}

/**
 * Los campos que se cuentan para la cobertura.
 *
 * No son todos los campos del playbook: son los que el cliente puede confirmar
 * o corregir en treinta segundos y que cambian lo que el agente dice. Contar el
 * `sla_minutos` en la cobertura solo serviría para inflar el porcentaje.
 */
function partesMedibles(args: {
  oferta: Oferta;
  objeciones: Objecion[];
  faq: PreguntaFrecuente[];
  agendamiento: Agendamiento;
  calificacion: Calificacion;
  icp: { description?: string } | undefined;
  sitio: string | null;
}) {
  const partes: Parameters<typeof medirCobertura>[0] = [];

  partes.push({
    ruta: 'oferta.resumen',
    etiqueta: 'Qué vendes',
    valor: args.oferta.resumen,
    por_que: 'Va en el primer mensaje. Si está mal, el contacto se pierde en la primera línea.',
    procedencia: { fuente: args.sitio, inferido: !args.sitio },
  });

  for (const [i, producto] of args.oferta.productos.entries()) {
    partes.push({
      ruta: `oferta.productos.${i}`,
      etiqueta: `Producto · ${producto.nombre}`,
      valor: producto.nombre,
      por_que: 'El agente lo va a nombrar. Un producto que ya no vendes hace perder la conversación.',
      procedencia: producto.procedencia,
    });
  }

  partes.push({
    ruta: 'agendamiento.quien_atiende',
    etiqueta: 'Quién atiende la cita',
    valor: args.agendamiento.quien_atiende ?? '',
    por_que: 'Un nombre concreto agenda más que "un asesor". Es el dato que más rápido sube la tasa.',
    procedencia: { fuente: null, inferido: true },
  });

  partes.push({
    ruta: 'agendamiento.que_pasa_en_la_cita',
    etiqueta: 'Qué pasa en la cita',
    valor: args.agendamiento.que_pasa_en_la_cita,
    por_que: 'Lo preguntan siempre. Sin una respuesta concreta, la cita suena a que le van a vender.',
    procedencia: { fuente: null, inferido: true },
  });

  partes.push({
    ruta: 'calificacion.fuera_de_alcance',
    etiqueta: 'A quién NO le sirve',
    valor: args.calificacion.fuera_de_alcance.join(' · '),
    por_que: 'Es lo que evita que el agente agende citas que te hacen perder la mañana.',
    procedencia: { fuente: args.icp?.description ? args.sitio : null, inferido: !args.icp?.description },
  });

  for (const [i, o] of args.objeciones.entries()) {
    partes.push({
      ruta: `objeciones.${i}`,
      etiqueta: `Objeción · ${o.objecion}`,
      valor: o.respuesta,
      por_que: 'Es lo que el agente contesta textualmente cuando aparece.',
      procedencia: o.procedencia,
    });
  }

  for (const [i, f] of args.faq.entries()) {
    partes.push({
      ruta: `faq.${i}`,
      etiqueta: `Pregunta · ${f.pregunta}`,
      valor: f.respuesta,
      por_que: 'Sale de tu sitio. Si cambió, el agente contesta algo viejo.',
      procedencia: f.procedencia,
    });
  }

  return partes;
}

/**
 * Los productos del playbook también entran al catálogo, apagados.
 *
 * Apagados (`active = false`) a propósito: el catálogo alimenta el checkout, y
 * publicar a la venta algo que el cliente nunca aprobó sería exactamente el
 * tipo de sorpresa que este producto no puede darse. Quedan listos para que los
 * encienda con un clic el día que quiera cobrar por el link.
 *
 * Se hace con SELECT y después INSERT en vez de un upsert: el índice único de
 * `products` es `(organization_id, lower(sku))` — un índice de EXPRESIÓN, que
 * Postgres no puede usar como árbitro de `on conflict` (42P10). Ver ADR 0015.
 */
async function sincronizarProductos(organizationId: string, oferta: Oferta): Promise<void> {
  if (oferta.productos.length === 0) return;

  const { data: existentes } = await db()
    .from('products')
    .select('sku')
    .eq('organization_id', organizationId);

  const yaEstan = new Set((existentes ?? []).map((p) => String(p.sku).toLowerCase()));

  const nuevos = oferta.productos
    .map((p) => ({ producto: p, sku: skuDe(p.nombre) }))
    .filter(({ sku }) => sku && !yaEstan.has(sku))
    .map(({ producto, sku }) => ({
      organization_id: organizationId,
      sku,
      name: producto.nombre,
      description: producto.descripcion,
      kind: 'service' as const,
      price_usd: 0,
      active: false,
      metadata: { origen: 'playbook', procedencia: producto.procedencia },
    }));

  if (nuevos.length === 0) return;
  await tryWrite(db().from('products').insert(nuevos), 'products.from_playbook');
}

function skuDe(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Compilar el playbook ES una decisión: hay opciones con consecuencia (qué
 * política de precio, qué se pregunta y qué no) y en 30 días se va a poder
 * saber si esa elección agendó citas. Sin este registro, la primera versión del
 * guion sería la única que nadie puede evaluar.
 *
 * Nunca lanza: el guion del cliente no se cae porque no se pudo escribir el
 * registro de la decisión.
 */
async function registrarDecision(args: {
  organizationId: string;
  runId: string;
  agentId: string | null;
  playbookId: string;
  oferta: Oferta;
  calificacion: Calificacion;
  cobertura: Cobertura;
  degraded: boolean;
}): Promise<void> {
  try {
    await recordDecision({
      organizationId: args.organizationId,
      agentId: args.agentId,
      role: 'sales',
      runId: args.runId,
      kind: 'playbook_compile',
      question: '¿Con qué guion sale a agendar el agente?',
      context: { segment: 'onboarding', channel: 'whatsapp' },
      optionsConsidered: [
        {
          label: 'derivar_a_la_cita',
          pros: ['No compromete un precio por escrito', 'Deja la cotización para quien puede darla'],
          cons: ['Pierde a quien solo quería el precio'],
          est_cost_usd: 0,
          est_impact: 'Más citas, algunas con gente que se cae al ver el precio',
        },
        {
          label: 'decir_rango',
          pros: ['Filtra antes de la cita', 'El contacto lo va a encontrar igual en el sitio'],
          cons: ['Pierde a quien se asusta con el número sin contexto'],
          est_cost_usd: 0,
          est_impact: 'Menos citas, mejor calificadas',
        },
      ],
      chosen: {
        label: args.oferta.precio.politica,
        payload: {
          playbook_id: args.playbookId,
          preguntas: args.calificacion.preguntas.length,
          cobertura: args.cobertura.porcentaje,
        },
      },
      rationale:
        args.oferta.precio.politica === 'decir_rango'
          ? 'El cliente publica precios en su sitio: esconderlos por WhatsApp le enseña al contacto a desconfiar.'
          : 'El cliente no publica precios y el ticket depende del alcance: un número por WhatsApp sería inventado.',
      evidence: [
        {
          type: 'metric',
          ref: 'cobertura_playbook',
          note: `${args.cobertura.porcentaje}% del guion se sostiene con fuente; ${args.cobertura.a_confirmar.length} campos quedaron para confirmar`,
        },
      ],
      prediction: {
        // La predicción medible: de cada 100 conversaciones abiertas, cuántas
        // llegan a que propongamos un horario. Es el escalón que
        // `holaamigo.embudo_del_setter()` cuenta, así que a los 30 días se
        // puede cerrar con una consulta y no con una opinión.
        metric: 'share de conversaciones que llegan a oferta_de_cita',
        expected_value: 0.4,
        horizon_days: 30,
        confidence: args.degraded ? 0.3 : 0.5,
        direction: 'up',
      },
      reversible: true,
    });
  } catch (err) {
    console.error('[playbook] no se pudo registrar la decisión', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LECTURAS Y RESPALDOS
// ═══════════════════════════════════════════════════════════════════════════

interface BriefContent {
  __version?: number;
  precios?: { ticket_promedio_usd?: number };
  tono?: { descripcion?: string; prohibidas?: string[] };
  prohibiciones?: string[];
  icp?: string;
  identidad?: { empresa?: string; frases?: unknown[] };
  metas?: Record<string, unknown>;
  fugas?: Array<{ name?: string; usd_mes?: number }>;
}

async function briefVigente(organizationId: string): Promise<BriefContent | null> {
  const { data } = await db()
    .from('briefs')
    .select('content, version')
    .eq('organization_id', organizationId)
    .eq('is_current', true)
    .maybeSingle();
  if (!data) return null;
  return { ...(data.content as BriefContent), __version: data.version };
}

async function diagnosticoVigente(organizationId: string) {
  const { data } = await db()
    .from('diagnostics')
    .select('id, identity, brand, competitors, market_position, leaks, assumptions')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function ultimaSesion(organizationId: string): Promise<string | null> {
  const { data } = await db()
    .from('intake_sessions')
    .select('id')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

function buildCompileInput(args: {
  org: { name: string | null; domain: string; website_url: string; country: string | null; industry: string | null };
  companyName: string;
  answers: Record<string, unknown>;
  research: Awaited<ReturnType<typeof findingsForOrganization>>;
  brief: BriefContent | null;
  diagnostic: { identity?: unknown; competitors?: unknown; market_position?: unknown } | null;
  scheduler: ReturnType<typeof schedulerConfigOf>;
}): string {
  const { research } = args;
  const seccion = (nombre: string) => research.sections[nombre]?.payload ?? null;

  return [
    `EMPRESA: ${args.companyName} · ${args.org.website_url}`,
    args.org.industry ? `INDUSTRIA: ${args.org.industry}` : '',
    args.org.country ? `PAÍS: ${args.org.country}` : '',
    '',
    '── LO QUE LEÍMOS DE SU SITIO ──',
    json('oferta', seccion('offer')),
    json('precios', seccion('pricing')),
    json('a quién le vende', seccion('icp')),
    json('posicionamiento', seccion('positioning')),
    json('canales visibles', seccion('channels')),
    json('prueba social', seccion('social_proof')),
    json('competidores', seccion('competitors')),
    '',
    '── FUENTES DISPONIBLES (úsalas en source_url) ──',
    (research.sources ?? []).slice(0, 12).map((s) => `- ${s.url}`).join('\n') || '(ninguna)',
    '',
    '── LO QUE EL CLIENTE NOS DIJO EN EL QUIZ ──',
    json('respuestas', args.answers),
    '',
    '── EL BRIEF VIGENTE ──',
    json('identidad', args.brief?.identidad ?? null),
    json('icp', args.brief?.icp ?? null),
    json('tono', args.brief?.tono ?? null),
    json('prohibiciones (DURAS, no las contradigas)', args.brief?.prohibiciones ?? null),
    '',
    '── LA CITA QUE SE VA A AGENDAR ──',
    `Dura ${args.scheduler.duration_min} minutos, en ${args.scheduler.timezone}.`,
    'NO escribas esos números en el guion: usa los marcadores. El motor los inyecta.',
    '',
    '── DIAGNÓSTICO YA ENTREGADO AL CLIENTE ──',
    json('identidad', args.diagnostic?.identity ?? null),
    json('posición', args.diagnostic?.market_position ?? null),
  ]
    .filter(Boolean)
    .join('\n');
}

function json(label: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = JSON.stringify(value);
  return `${label}: ${text.length > 3000 ? `${text.slice(0, 3000)}…` : text}`;
}

/** El degradado del modelo: menos campos, misma forma. */
function inflateLanguage(min: PlaybookLanguageMinimal, companyName: string): PlaybookLanguage {
  const base = plantillaDeRespaldo(companyName, null);
  const ejes = ['dolor', 'encaje', 'momento', 'decisor'] as const;

  return {
    ...base,
    lo_que_vendemos_aca: min.lo_que_vendemos_aca || base.lo_que_vendemos_aca,
    calificacion: {
      preguntas: min.preguntas.slice(0, 4).map((pregunta, i) => ({
        campo: ejes[i] ?? 'dolor',
        pregunta,
        por_que: 'Generada en modo degradado. Vale la pena revisarla.',
        descalifica_si: [],
      })),
      fuera_de_alcance: base.calificacion.fuera_de_alcance,
    },
    guion: {
      ...base.guion,
      apertura: min.apertura || base.guion.apertura,
      puente_a_la_cita: min.puente_a_la_cita || base.guion.puente_a_la_cita,
    },
  };
}

/**
 * El guion de plantilla, con los datos reales del cliente.
 *
 * Se usa cuando el modelo falló por completo. No es un placeholder: es un guion
 * de setter que funciona, escrito a mano, al que le faltan los detalles del
 * negocio. Un cliente que llega acá tiene un agente peor, no un agente roto —
 * y la diferencia entre esas dos cosas es todo el producto.
 */
function plantillaDeRespaldo(companyName: string, resumen: string | null): PlaybookLanguage {
  const que = resumen ?? 'lo que hacemos';

  return {
    lo_que_vendemos_aca:
      'Una reunión corta para ver si esto le sirve. No se vende nada por acá.',
    calificacion: {
      preguntas: [
        {
          campo: 'dolor',
          pregunta: '¿Qué es lo que más te está costando resolver hoy con eso?',
          por_que: 'Es lo único que el contacto quiere contestar en el primer minuto.',
          descalifica_si: ['no tiene ningún problema', 'ya lo resolvió'],
        },
        {
          campo: 'encaje',
          pregunta: '¿A qué se dedica tu empresa?',
          por_que: 'Sin esto agendamos citas que hacen perder la mañana.',
          descalifica_si: [],
        },
        {
          campo: 'momento',
          pregunta: '¿Esto es algo que quieras resolver este mes o lo estás mirando para más adelante?',
          por_que: 'Separa la cita de esta semana de la de dentro de seis meses.',
          descalifica_si: ['el año que viene', 'solo estoy mirando'],
        },
        {
          campo: 'decisor',
          pregunta: '¿Lo decides tú o hay alguien más que debería estar en la llamada?',
          por_que: 'Una cita sin el que decide se repite completa.',
          descalifica_si: [],
        },
      ],
      fuera_de_alcance: [],
    },
    objeciones: [],
    faq: [],
    guion: {
      apertura: `Hola, te escribo de ${companyName}. Tengo tus datos porque en algún momento consultaste por ${que}. ¿Sigue en pie eso que estabas resolviendo?`,
      apertura_inbound: `Hola, soy el asistente de ${companyName}. Cuéntame qué estás buscando y te digo enseguida si te podemos ayudar.`,
      puente_a_la_cita:
        'Eso se ve mejor en concreto que por chat. ¿Te agendo 15 minutos y lo revisamos con tu caso?',
      oferta_de_horarios: 'Te puedo dejar {{horarios}}. ¿Cuál te sirve?',
      confirmacion: 'Listo, quedaste para {{cita}}. Si necesitas cambiarla: {{link}}',
      seguimientos: [
        '¿Alcanzaste a ver lo del horario?',
        'Te dejo esto por acá por si te sirve más adelante. ¿Lo vemos la próxima semana?',
        'No te escribo más por ahora. Si en algún momento lo quieres retomar, me escribes y lo agendamos.',
      ],
      cierre_cortes:
        'Entiendo, gracias por contestar. Si cambia la situación me escribes y lo vemos.',
    },
    escalamiento: {
      disparadores: DISPARADORES_DEL_CONTRATO,
      mensaje_al_contacto:
        'Déjame confirmarlo con el equipo y te escribo en un rato con la respuesta exacta.',
    },
    que_pasa_en_la_cita:
      'Una llamada corta para entender tu caso y decirte si esto te sirve. Sin presentación de ventas.',
  };
}
