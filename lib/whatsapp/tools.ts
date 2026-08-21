import { db, tryWrite } from '@/lib/supabase/admin';
import type { ToolSpec } from '@/lib/ai/client';
import { authorize } from '@/lib/governance/authorize';
import { habilidadesActivas } from '@/lib/skills/registry';
import { assetBySlug, publicUrlFor, type Asset } from '@/lib/assets/links';
import { slotsFor, createBooking } from '@/lib/scheduling/bookings';
import { formatSlotRange } from '@/lib/scheduling/slots';
import type { Playbook } from '@/lib/playbook/types';

/**
 * Las herramientas del agente de agendamiento.
 *
 * LA DECISIÓN QUE SOSTIENE EL ARCHIVO: los horarios y las citas NO son texto
 * que el modelo produce, son llamadas a funciones que tocan la base.
 *
 * La alternativa —meter los cupos disponibles en la instrucción de sistema— es
 * más simple y está mal: la lista se arma al empezar el turno y el contacto
 * puede tardar cuarenta minutos en contestar, así que el agente ofrece un cupo
 * que ya no existe. Un contacto que acepta un horario y después recibe "ay, se
 * ocupó" es una cita perdida y una marca dañada, y las dos por el mismo bug.
 *
 * Cada herramienta pasa por `authorize()` en el momento de usarse, no al armar
 * la lista: entre que empieza la conversación y que el agente decide reservar,
 * el cliente puede haber bajado el nivel de una capacidad desde la consola.
 *
 * Ver docs/wiki/22-agente-de-agendamiento.md
 */

export interface ToolContext {
  organizationId: string;
  agentId: string | null;
  conversationId: string;
  playbook: Playbook;
  /** `null` en el simulador: no hay nadie real del otro lado. */
  leadId: string | null;
  /** El simulador no reserva de verdad ni suprime a nadie. */
  simulacion: boolean;
  contacto: { nombre: string | null; email: string | null; telefono: string | null };
}

export interface ToolOutcome {
  /** Lo que el runtime tiene que hacer después del turno. */
  efecto?: 'agendado' | 'escalar' | 'suprimir' | null;
  bookingId?: string | null;
  motivo?: string | null;
  qualification?: Record<string, string>;
}

/**
 * El tool list es una INTERSECCIÓN calculada en runtime, no una constante.
 *
 * `habilidades_activas` en SQL cruza cuatro conjuntos: otorgadas al rol,
 * habilitadas para esta org, permitidas por el plan y alcanzables con el nivel
 * de capacidad actual. Si la agenda no está en esa intersección, el agente ni
 * siquiera ve la herramienta — que es distinto de verla y que le digan que no.
 * Un agente que sabe que existe una herramienta prohibida la va a mencionar.
 */
export async function toolsParaSetter(ctx: ToolContext): Promise<ToolSpec[]> {
  const activas = new Set((await habilidadesActivas(ctx.organizationId, 'sales')).map((s) => s.skill_id));
  const specs: ToolSpec[] = [];

  if (activas.has('agenda.consultar')) specs.push(CONSULTAR_HORARIOS);
  if (activas.has('agenda.reservar')) specs.push(AGENDAR_CITA);
  if (activas.has('crm.registrar_calificacion')) specs.push(REGISTRAR_CALIFICACION);

  // Escalar y no-contactar NO se consultan contra el catálogo. Son las dos
  // cosas que un agente nunca puede perder: `escalate` y `suppression.add`
  // tienen techo de plataforma L5 y están siempre encendidas por diseño (ver
  // 0007_gobierno.sql). Condicionarlas a una lectura de base sería crear la
  // posibilidad de que un error de red deje a un agente sin poder pedir ayuda.
  specs.push(ESCALAR, NO_CONTACTAR);

  return specs;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAS DEFINICIONES
// ═══════════════════════════════════════════════════════════════════════════
//
// `strict: true` exige que todas las propiedades estén en `required` y que
// `additionalProperties` sea false. Lo que "puede faltar" se modela con un
// tipo que admita null, igual que en los esquemas Zod.

const CONSULTAR_HORARIOS: ToolSpec = {
  name: 'consultar_horarios',
  description:
    'Consulta los horarios REALES disponibles en la agenda. Úsala SIEMPRE antes de proponer un horario. Nunca inventes cupos.',
  parameters: {
    type: 'object',
    properties: {
      dias_adelante: {
        type: 'integer',
        description: 'Cuántos días hacia adelante mirar. Usa 7 salvo que el contacto pida otra cosa.',
      },
      zona_horaria_del_contacto: {
        type: ['string', 'null'],
        description: 'Zona IANA si el contacto dijo que está en otra ciudad. null si no lo dijo.',
      },
    },
    required: ['dias_adelante', 'zona_horaria_del_contacto'],
    additionalProperties: false,
  },
};

const AGENDAR_CITA: ToolSpec = {
  name: 'agendar_cita',
  description:
    'Reserva la cita en un horario que devolvió consultar_horarios. No confirmes la cita al contacto antes de que esta herramienta responda ok.',
  parameters: {
    type: 'object',
    properties: {
      inicio_iso: { type: 'string', description: 'El "start" exacto que devolvió consultar_horarios.' },
      nombre: { type: 'string', description: 'Nombre del contacto.' },
      email: { type: 'string', description: 'Correo del contacto. Pídelo antes si no lo tienes.' },
      telefono: { type: ['string', 'null'] },
      notas: { type: ['string', 'null'], description: 'Qué quiere resolver, en una frase. Lo lee quien atiende.' },
    },
    required: ['inicio_iso', 'nombre', 'email', 'telefono', 'notas'],
    additionalProperties: false,
  },
};

const REGISTRAR_CALIFICACION: ToolSpec = {
  name: 'registrar_calificacion',
  description:
    'Anota lo que descubriste de un eje de calificación. Úsala apenas lo sepas, no al final.',
  parameters: {
    type: 'object',
    properties: {
      campo: { type: 'string', enum: ['encaje', 'momento', 'decisor', 'dolor'] },
      valor: { type: 'string', description: 'Lo que dijo el contacto, resumido en una frase.' },
    },
    required: ['campo', 'valor'],
    additionalProperties: false,
  },
};

const ESCALAR: ToolSpec = {
  name: 'escalar_a_humano',
  description:
    'Pasa la conversación a una persona. Úsala cuando aplique un disparador de escalamiento del playbook.',
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Por qué escalas. Lo lee un humano en la cola.' },
      urgencia: { type: 'string', enum: ['normal', 'alta'] },
    },
    required: ['motivo', 'urgencia'],
    additionalProperties: false,
  },
};

const NO_CONTACTAR: ToolSpec = {
  name: 'no_contactar',
  description:
    'El contacto pidió que no le escriban más. Úsala inmediatamente, sin intentar retenerlo.',
  parameters: {
    type: 'object',
    properties: {
      textual: { type: 'string', description: 'Lo que dijo, textual. Queda como evidencia del pedido.' },
    },
    required: ['textual'],
    additionalProperties: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// LOS MANEJADORES
// ═══════════════════════════════════════════════════════════════════════════

export async function ejecutarHerramienta(
  ctx: ToolContext,
  nombre: string,
  args: Record<string, unknown>,
  efectos: ToolOutcome,
): Promise<unknown> {
  switch (nombre) {
    case 'consultar_horarios':
      return consultarHorarios(ctx, args);
    case 'agendar_cita':
      return agendarCita(ctx, args, efectos);
    case 'registrar_calificacion':
      return registrarCalificacion(ctx, args, efectos);
    case 'escalar_a_humano':
      return escalarAHumano(ctx, args, efectos);
    case 'no_contactar':
      return noContactar(ctx, args, efectos);
    default:
      return { ok: false, error: `no existe la herramienta ${nombre}` };
  }
}

async function consultarHorarios(ctx: ToolContext, args: Record<string, unknown>) {
  const permiso = await authorize({
    organizationId: ctx.organizationId,
    capabilityId: 'meeting.offer_slots',
    agentId: ctx.agentId,
  });
  if (permiso.accion_permitida === 'nada') {
    return { ok: false, error: 'no tengo acceso a la agenda ahora mismo' };
  }

  const asset = await agendaDe(ctx);
  if (!asset) return { ok: false, error: 'este cliente todavía no tiene agenda configurada' };

  const zona = typeof args.zona_horaria_del_contacto === 'string' ? args.zona_horaria_del_contacto : undefined;
  const dias = Math.min(Math.max(Number(args.dias_adelante) || 7, 1), 21);

  const { config, days } = await slotsFor(asset, zonaValida(zona) ? zona : undefined);

  // Se le devuelven POCOS: la lista completa de dos semanas son ochenta cupos y
  // un modelo con ochenta opciones escribe un menú. El playbook dice cuántos se
  // ofrecen por mensaje y acá se le entregan justo esos, ya formateados.
  const cupos = days
    .filter((d) => d.slots.length > 0)
    .slice(0, dias)
    .flatMap((d) => d.slots.slice(0, 2))
    .slice(0, Math.max(ctx.playbook.agendamiento.opciones_por_mensaje * 2, 4))
    .map((slot) => ({
      start: slot.start,
      etiqueta: slot.label,
    }));

  return {
    ok: true,
    zona_horaria: config.timezone,
    duracion_min: config.duration_min,
    // El texto ya armado para que el modelo no reformatee la fecha y se
    // equivoque de día. Es el error más caro y el más fácil de evitar.
    cupos,
    como_ofrecerlos: `Ofrece ${ctx.playbook.agendamiento.opciones_por_mensaje} de estos, con la etiqueta tal como viene.`,
  };
}

async function agendarCita(ctx: ToolContext, args: Record<string, unknown>, efectos: ToolOutcome) {
  const inicio = String(args.inicio_iso ?? '');
  const email = String(args.email ?? '').trim();
  const nombre = String(args.nombre ?? '').trim() || ctx.contacto.nombre || 'Sin nombre';

  if (!email.includes('@')) {
    return { ok: false, error: 'falta el correo del contacto: pídeselo antes de reservar' };
  }

  const permiso = await authorize({
    organizationId: ctx.organizationId,
    capabilityId: 'meeting.book',
    agentId: ctx.agentId,
    payload: { volume: 1 },
    title: 'Agendar una cita desde WhatsApp',
  });
  if (permiso.accion_permitida !== 'ejecutar') {
    return {
      ok: false,
      error: 'no puedo reservar automáticamente. Dile al contacto que le confirmas el horario en un momento y escala.',
      motivo: permiso.reason,
    };
  }

  const asset = await agendaDe(ctx);
  if (!asset) return { ok: false, error: 'no hay agenda configurada' };

  // El simulador NO reserva. Devuelve la forma exacta de una reserva real para
  // que el cliente vea el flujo completo, pero sin ocupar un cupo de su agenda
  // de verdad: probar el agente no puede costarle una hora del martes.
  if (ctx.simulacion) {
    return {
      ok: true,
      simulado: true,
      cita: `(simulación) ${inicio}`,
      link: publicUrlFor(asset),
      nota: 'En el simulador no se reserva de verdad. Con WhatsApp conectado, acá quedaría la cita.',
    };
  }

  const resultado = await createBooking({
    asset,
    start: inicio,
    contactName: nombre,
    contactEmail: email,
    contactPhone: (args.telefono as string | null) ?? ctx.contacto.telefono,
    notes: (args.notas as string | null) ?? null,
    source: 'whatsapp',
    leadId: ctx.leadId,
  });

  if (!resultado.ok || !resultado.booking) {
    return {
      ok: false,
      error: resultado.error ?? 'no se pudo reservar',
      // El motivo importa: "ese cupo se acaba de ocupar" tiene una salida
      // natural (volver a consultar), y "no hay agenda" no la tiene.
      siguiente_paso: 'Vuelve a consultar_horarios y ofrece otros dos.',
    };
  }

  efectos.efecto = 'agendado';
  efectos.bookingId = resultado.booking.id;

  return {
    ok: true,
    cita: resultado.booking.human_label,
    link: `${publicUrlFor(asset)}?g=${resultado.booking.manage_token}`,
    zona_horaria: resultado.booking.timezone,
  };
}

async function registrarCalificacion(
  ctx: ToolContext,
  args: Record<string, unknown>,
  efectos: ToolOutcome,
) {
  const campo = String(args.campo ?? '');
  const valor = String(args.valor ?? '').slice(0, 400);
  if (!['encaje', 'momento', 'decisor', 'dolor'].includes(campo)) {
    return { ok: false, error: `campo desconocido: ${campo}` };
  }

  efectos.qualification = { ...(efectos.qualification ?? {}), [campo]: valor };

  const faltan = ctx.playbook.calificacion.preguntas
    .map((p) => p.campo)
    .filter((c) => !(c in (efectos.qualification ?? {})));

  return {
    ok: true,
    anotado: campo,
    faltan_por_descubrir: faltan,
    puede_proponer_horario:
      Object.keys(efectos.qualification ?? {}).length >= ctx.playbook.calificacion.minimo_para_agendar,
  };
}

async function escalarAHumano(ctx: ToolContext, args: Record<string, unknown>, efectos: ToolOutcome) {
  const motivo = String(args.motivo ?? 'sin motivo').slice(0, 500);
  efectos.efecto = 'escalar';
  efectos.motivo = motivo;

  if (!ctx.simulacion) {
    await tryWrite(
      db().from('approvals').insert({
        organization_id: ctx.organizationId,
        agent_id: ctx.agentId,
        kind: 'escalation',
        title: 'El agente de agendamiento pidió ayuda',
        rationale: motivo,
        if_approved: 'Un humano toma la conversación desde el mismo chat.',
        if_rejected: 'La conversación queda marcada y sin respuesta automática.',
        payload: { conversation_id: ctx.conversationId, lead_id: ctx.leadId, motivo },
        severity: args.urgencia === 'alta' ? 'high' : 'normal',
      }),
      'approvals.setter_escalation',
    );
  }

  return {
    ok: true,
    escalado: true,
    que_decir: ctx.playbook.escalamiento.mensaje_al_contacto,
  };
}

async function noContactar(ctx: ToolContext, args: Record<string, unknown>, efectos: ToolOutcome) {
  efectos.efecto = 'suprimir';
  efectos.motivo = String(args.textual ?? '').slice(0, 300);

  // La supresión es lo único que se ejecuta sin consultar a nadie. `escalate` y
  // `suppression.add` tienen techo L5 justamente por esto: cuando alguien pide
  // que no le escriban, autorizar es una demora, no un control.
  if (!ctx.simulacion && ctx.contacto.telefono) {
    await tryWrite(
      db().from('suppressions').insert({
        organization_id: ctx.organizationId,
        phone_e164: ctx.contacto.telefono,
        reason: 'opt_out',
        source: 'whatsapp_setter',
      }),
      'suppressions.setter',
    );
    if (ctx.leadId) {
      await tryWrite(
        db().from('leads').update({ status: 'suppressed' }).eq('id', ctx.leadId),
        'leads.suppress',
      );
    }
  }

  return {
    ok: true,
    suprimido: true,
    que_decir: 'Confirma en una frase que no le vuelves a escribir. No preguntes por qué ni ofrezcas nada.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════

async function agendaDe(ctx: ToolContext): Promise<Asset | null> {
  if (ctx.playbook.agendamiento.asset_slug) {
    const asset = await assetBySlug(ctx.playbook.agendamiento.asset_slug);
    if (asset) return asset;
  }

  const { data } = await db()
    .from('assets')
    .select('*')
    .eq('organization_id', ctx.organizationId)
    .eq('kind', 'scheduler')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  return (data as Asset | null) ?? null;
}

/** `Intl` lanza ante una zona inventada, y eso mataría el turno entero. */
function zonaValida(zone: string | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export { formatSlotRange };
