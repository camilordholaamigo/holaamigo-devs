import { db, unwrap, mustWrite, tryWrite } from '@/lib/supabase/admin';
import { runConversation } from '@/lib/ai/client';
import { SetterTurnSchema, type SetterTurn } from '@/lib/ai/schemas';
import { SETTER_SYSTEM } from '@/config/prompts';
import { renderInstructions } from '@/lib/playbook/render';
import { playbookVigente } from '@/lib/playbook/store';
import { currentVectorStoreId } from '@/lib/playbook/knowledge';
import { agentIdFor } from '@/lib/agents/contracts';
import { authorize } from '@/lib/governance/authorize';
import { newRunId } from '@/lib/traces/record';
import { track } from '@/lib/events';
import {
  ejecutarHerramienta,
  toolsParaSetter,
  type ToolContext,
  type ToolOutcome,
} from '@/lib/whatsapp/tools';
import type { Playbook } from '@/lib/playbook/types';

/**
 * El agente de agendamiento, en ejecución.
 *
 * Un turno = un mensaje del contacto adentro, un mensaje del agente afuera. Lo
 * que pasa en el medio son, en orden: cargar el playbook vigente, autorizar,
 * armar la instrucción, dejar que el modelo use las herramientas que necesite,
 * validar la salida, aplicar los efectos y registrar el turno.
 *
 * DOS DECISIONES QUE VALE LA PENA DEFENDER:
 *
 * 1. **La continuidad es `previous_response_id`, no un historial reenviado.**
 *    El costo del turno 20 es el del turno 2. La contra es que el historial
 *    vive en OpenAI 30 días; por eso `conversation_turns` guarda nuestra copia
 *    de lo que se dijo. Si un día hay que reconstruir una conversación para una
 *    disputa, la fuente somos nosotros.
 *
 * 2. **El simulador corre por este MISMO camino.** Cambia `simulacion: true`,
 *    que apaga las escrituras hacia afuera (reservar, suprimir, escalar) y nada
 *    más. Un banco de pruebas con su propio código no prueba el agente: prueba
 *    el banco, y el día del estreno aparecen las diferencias.
 *
 * Ver docs/wiki/22-agente-de-agendamiento.md
 */

export interface ConversationRow {
  id: string;
  organization_id: string;
  lead_id: string | null;
  playbook_id: string | null;
  agent_id: string | null;
  channel: 'whatsapp' | 'email' | 'simulador';
  status: string;
  stage: string;
  qualification: Record<string, string>;
  last_response_id: string | null;
  turns: number;
  followups: number;
}

export interface TurnResult {
  conversationId: string;
  mensaje: string;
  stage: string;
  status: string;
  intencion: SetterTurn['intencion'];
  escalado: boolean;
  agendado: boolean;
  qualification: Record<string, string>;
  herramientas: Array<{ name: string; ok: boolean }>;
  costUsd: number;
  durationMs: number;
}

/** Abre una conversación, o devuelve la que ya estaba abierta con este lead. */
export async function abrirConversacion(args: {
  organizationId: string;
  leadId?: string | null;
  channel?: 'whatsapp' | 'simulador';
  campaignId?: string | null;
}): Promise<ConversationRow> {
  const channel = args.channel ?? 'whatsapp';

  if (args.leadId) {
    const { data: abierta } = await db()
      .from('conversations')
      .select('*')
      .eq('lead_id', args.leadId)
      .eq('status', 'open')
      .maybeSingle();
    if (abierta) return abierta as ConversationRow;
  }

  const playbook = await playbookVigente(args.organizationId);

  return unwrap(
    await db()
      .from('conversations')
      .insert({
        organization_id: args.organizationId,
        lead_id: args.leadId ?? null,
        playbook_id: playbook?.id ?? null,
        agent_id: await agentIdFor(args.organizationId, 'sales'),
        campaign_id: args.campaignId ?? null,
        channel,
        status: 'open',
        stage: 'apertura',
      })
      .select('*')
      .single(),
    'conversations.insert',
  ) as ConversationRow;
}

export async function conversacionPorId(id: string): Promise<ConversationRow | null> {
  const { data } = await db().from('conversations').select('*').eq('id', id).maybeSingle();
  return (data as ConversationRow | null) ?? null;
}

/**
 * Un turno.
 *
 * Devuelve el mensaje a enviar; NO lo envía. Enviar es del canal —el webhook de
 * WhatsApp, el simulador, el despachador— y separarlo es lo que permite que el
 * mismo runtime sirva a los tres. También es lo que hace que un fallo de envío
 * no se coma el turno: el turno ya está registrado cuando el canal lo intenta.
 */
export async function responder(args: {
  conversation: ConversationRow;
  mensajeDelContacto: string;
  contacto?: { nombre?: string | null; email?: string | null; telefono?: string | null };
}): Promise<TurnResult> {
  const conv = args.conversation;
  const simulacion = conv.channel === 'simulador';

  const playbook = conv.playbook_id
    ? await playbookPorIdOVigente(conv.playbook_id, conv.organization_id)
    : await playbookVigente(conv.organization_id);

  if (!playbook) {
    throw new Error(
      '[setter] esta organización no tiene playbook vigente. Compílalo antes de conversar.',
    );
  }

  // La autorización se pide por turno y no por conversación. Entre el turno 3 y
  // el 4 pueden pasar dos días, y en dos días el cliente puede haber pausado al
  // agente desde la consola. Una conversación autorizada una vez sería una
  // conversación que ignora esa pausa.
  const capacidad = simulacion ? 'setter.simulate' : 'outreach.reply';
  const agentId = conv.agent_id ?? (await agentIdFor(conv.organization_id, 'sales'));

  const permiso = await authorize({
    organizationId: conv.organization_id,
    capabilityId: capacidad,
    agentId,
    payload: { volume: 1 },
    title: simulacion ? 'Probar el agente' : 'Responder un WhatsApp entrante',
  });

  if (permiso.accion_permitida === 'nada') {
    throw new Error(`[setter] sin permiso para ${capacidad}: ${permiso.reason ?? 'bloqueado'}`);
  }

  const turno = conv.turns + 1;
  await guardarTurno({
    conversationId: conv.id,
    organizationId: conv.organization_id,
    turn: turno,
    role: 'contacto',
    body: args.mensajeDelContacto,
  });

  const efectos: ToolOutcome = { qualification: { ...(conv.qualification ?? {}) } };

  const ctx: ToolContext = {
    organizationId: conv.organization_id,
    agentId,
    conversationId: conv.id,
    playbook,
    leadId: conv.lead_id,
    simulacion,
    contacto: {
      nombre: args.contacto?.nombre ?? null,
      email: args.contacto?.email ?? null,
      telefono: args.contacto?.telefono ?? null,
    },
  };

  const [tools, vectorStoreId, empresa] = await Promise.all([
    toolsParaSetter(ctx),
    currentVectorStoreId(conv.organization_id),
    nombreDeEmpresa(conv.organization_id),
  ]);

  const instrucciones = [
    SETTER_SYSTEM,
    '',
    renderInstructions(playbook, { nombreEmpresa: empresa }),
    '',
    estadoDeLaConversacion(conv, efectos.qualification ?? {}, playbook),
  ].join('\n');

  const runId = newRunId();

  const resultado = await runConversation({
    step: 'setter',
    schemaName: 'setter_turn',
    schema: SetterTurnSchema,
    system: instrucciones,
    input: `Mensaje del contacto:\n"${args.mensajeDelContacto}"`,
    previousResponseId: conv.last_response_id,
    vectorStoreIds: vectorStoreId ? [vectorStoreId] : undefined,
    tools,
    onToolCall: (nombre, argumentos) => ejecutarHerramienta(ctx, nombre, argumentos, efectos),
    organizationId: conv.organization_id,
    agentId,
    role: 'sales',
    trigger: simulacion ? 'simulador' : 'inbound',
    runId,
  });

  const salida = resultado.data;

  // ── Los efectos, en orden de qué manda sobre qué ─────────────────────────
  //
  // La supresión gana sobre todo lo demás, incluido un agendamiento en el mismo
  // turno. Si alguien dice "agéndame y no me escribas más", lo segundo es lo
  // que hay que obedecer.
  let status = conv.status;
  let stage = salida.stage;

  if (efectos.efecto === 'suprimir' || salida.intencion === 'opt_out') {
    await cerrar(conv.id, 'opted_out', efectos.motivo ?? 'el contacto pidió no ser contactado');
    status = 'opted_out';
    stage = 'cerrado';
  } else if (efectos.efecto === 'agendado' && efectos.bookingId) {
    await cerrar(conv.id, 'booked', 'cita agendada por el agente', efectos.bookingId);
    status = 'booked';
    stage = 'confirmado';
  } else if (efectos.efecto === 'escalar' || salida.debe_escalar) {
    const motivo = efectos.motivo ?? salida.motivo_de_escalamiento ?? 'el agente pidió ayuda';
    await cerrar(conv.id, 'escalated', motivo);
    status = 'escalated';
    stage = 'cerrado';
  }

  // Lo que el modelo dice haber descubierto se funde con lo que las
  // herramientas anotaron. Las herramientas mandan: son una escritura
  // deliberada, y el campo del esquema es una lectura de sí mismo.
  const qualification = {
    ...limpiarDescubierto(salida.descubierto),
    ...(efectos.qualification ?? {}),
  };

  const mensaje = recortar(salida.mensaje);

  await guardarTurno({
    conversationId: conv.id,
    organizationId: conv.organization_id,
    turn: turno,
    role: 'agente',
    body: mensaje,
    toolCalls: resultado.toolCalls.map((t) => ({ name: t.name, ok: t.ok, args: t.args, result: t.result })),
    stage,
    model: resultado.model,
    tokensIn: resultado.tokensIn,
    tokensOut: resultado.tokensOut,
    costUsd: resultado.costUsd,
    durationMs: resultado.durationMs,
  });

  await tryWrite(
    db()
      .from('conversations')
      .update({
        turns: turno,
        stage,
        qualification,
        last_response_id: resultado.responseId,
        last_turn_at: new Date().toISOString(),
        // Contestar reinicia los seguimientos. Un contacto que respondió al
        // segundo seguimiento no lleva dos seguimientos gastados: lleva cero.
        followups: 0,
        ...(status !== conv.status ? {} : {}),
      })
      .eq('id', conv.id),
    'conversations.turn',
  );

  if (simulacion && turno === 1) {
    await track('agent_tested', {
      organizationId: conv.organization_id,
      props: { playbook_version: playbook.version, con_kb: Boolean(vectorStoreId) },
    });
  }

  return {
    conversationId: conv.id,
    mensaje,
    stage,
    status,
    intencion: salida.intencion,
    escalado: status === 'escalated',
    agendado: status === 'booked',
    qualification,
    herramientas: resultado.toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
    costUsd: resultado.costUsd,
    durationMs: resultado.durationMs,
  };
}

/** El primer mensaje: el agente abre, nadie escribió antes. */
export async function abrirConMensaje(args: {
  organizationId: string;
  conversation: ConversationRow;
  contacto?: { nombre?: string | null };
}): Promise<string> {
  const playbook = await playbookVigente(args.organizationId);
  if (!playbook) throw new Error('[setter] sin playbook vigente');

  // La apertura NO pasa por el modelo. Es texto del playbook, que el cliente
  // ya revisó, y es el único mensaje que sale sin que nadie haya escrito antes
  // — o sea, el de mayor riesgo. Que sea determinista significa que el cliente
  // puede leer exactamente lo que se va a enviar antes de que se envíe.
  const mensaje = playbook.guion.apertura.replace(
    /\{\{nombre\}\}/g,
    args.contacto?.nombre ?? '',
  );

  await guardarTurno({
    conversationId: args.conversation.id,
    organizationId: args.organizationId,
    turn: args.conversation.turns + 1,
    role: 'agente',
    body: mensaje,
    stage: 'apertura',
  });

  await tryWrite(
    db()
      .from('conversations')
      .update({
        turns: args.conversation.turns + 1,
        stage: 'apertura',
        last_turn_at: new Date().toISOString(),
      })
      .eq('id', args.conversation.id),
    'conversations.opener',
  );

  return recortar(mensaje);
}

export async function transcripcion(conversationId: string) {
  const { data } = await db()
    .from('conversation_turns')
    .select('turn, role, body, tool_calls, stage, created_at')
    .eq('conversation_id', conversationId)
    .order('turn', { ascending: true })
    .order('created_at', { ascending: true });
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * El estado, inyectado en cada turno.
 *
 * Va en la instrucción de sistema y no en el mensaje porque no es algo que el
 * contacto dijo: es lo que el agente sabe. Y se recalcula en cada turno porque
 * `previous_response_id` conserva la conversación, no el estado de la base — si
 * una herramienta anotó el `dolor` en el turno 3, el turno 4 tiene que saberlo
 * aunque el modelo lo haya olvidado.
 */
function estadoDeLaConversacion(
  conv: ConversationRow,
  qualification: Record<string, string>,
  playbook: Playbook,
): string {
  const descubierto = Object.entries(qualification).filter(([, v]) => v);
  const faltan = playbook.calificacion.preguntas
    .map((p) => p.campo)
    .filter((c) => !qualification[c]);

  return [
    '## DÓNDE VAS EN ESTA CONVERSACIÓN',
    `Turno ${conv.turns + 1}. Escalón actual: ${conv.stage}.`,
    descubierto.length > 0
      ? `Ya descubriste: ${descubierto.map(([k, v]) => `${k} = ${v}`).join(' · ')}`
      : 'Todavía no has descubierto nada. No repitas preguntas que ya hiciste.',
    faltan.length > 0 ? `Te falta: ${faltan.join(', ')}.` : 'Ya tienes todo lo que necesitas.',
    descubierto.length >= playbook.calificacion.minimo_para_agendar
      ? 'YA PUEDES PROPONER HORARIO. Consulta la agenda y ofrécelo en este turno o en el siguiente.'
      : 'Todavía no propongas horario: te falta descubrir.',
  ].join('\n');
}

async function playbookPorIdOVigente(id: string, organizationId: string): Promise<Playbook | null> {
  const { data } = await db().from('agent_playbooks').select('*').eq('id', id).maybeSingle();
  // Si el playbook con el que arrancó la conversación se retiró, se sigue con
  // ÉL y no con el nuevo: cambiar de guion a mitad de una conversación produce
  // un agente que se contradice, y el contacto lee las dos versiones.
  return (data as Playbook | null) ?? (await playbookVigente(organizationId));
}

async function nombreDeEmpresa(organizationId: string): Promise<string> {
  const { data } = await db()
    .from('organizations')
    .select('name, domain')
    .eq('id', organizationId)
    .maybeSingle();
  return data?.name ?? data?.domain ?? 'la empresa';
}

async function cerrar(
  conversationId: string,
  status: string,
  motivo: string,
  bookingId?: string | null,
): Promise<void> {
  const { error } = await db().rpc('cerrar_conversacion', {
    p_conversation: conversationId,
    p_status: status,
    p_motivo: motivo.slice(0, 500),
    p_booking: bookingId ?? null,
  });
  if (error) console.error(`[setter:cerrar] ${error.message}`);
}

async function guardarTurno(args: {
  conversationId: string;
  organizationId: string;
  turn: number;
  role: 'contacto' | 'agente' | 'sistema' | 'herramienta';
  body: string;
  toolCalls?: unknown[];
  stage?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
}): Promise<void> {
  // `mustWrite`: la transcripción es la única copia nuestra de lo que se le
  // dijo a un tercero. Perderla en silencio es perder la prueba.
  await mustWrite(
    db()
      .from('conversation_turns')
      .upsert(
        {
          conversation_id: args.conversationId,
          organization_id: args.organizationId,
          turn: args.turn,
          role: args.role,
          body: args.body,
          tool_calls: args.toolCalls ?? [],
          stage: args.stage ?? null,
          model: args.model ?? null,
          tokens_in: args.tokensIn ?? null,
          tokens_out: args.tokensOut ?? null,
          cost_usd: args.costUsd ?? null,
          duration_ms: args.durationMs ?? null,
        },
        { onConflict: 'conversation_id,turn,role' },
      ),
    'conversation_turns.upsert',
  );
}

function limpiarDescubierto(d: SetterTurn['descubierto']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 400);
  }
  return out;
}

/**
 * El tope de longitud, aplicado en código y no confiado al prompt.
 *
 * 45 palabras es la regla del oficio y el modelo la respeta casi siempre. "Casi
 * siempre" no alcanza: el mensaje de 200 palabras es el que hace que el
 * contacto deje de leer, y es gratis evitarlo. Se corta en la última frase
 * completa para no mandar algo truncado a la mitad.
 */
function recortar(mensaje: string, maxPalabras = 55): string {
  const texto = mensaje.trim();
  const palabras = texto.split(/\s+/);
  if (palabras.length <= maxPalabras) return texto;

  const cortado = palabras.slice(0, maxPalabras).join(' ');
  const ultimoPunto = Math.max(cortado.lastIndexOf('.'), cortado.lastIndexOf('?'), cortado.lastIndexOf('!'));
  return ultimoPunto > cortado.length * 0.5 ? cortado.slice(0, ultimoPunto + 1) : `${cortado}…`;
}
