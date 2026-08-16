import { db, mustWrite } from '@/lib/supabase/admin';
import type { AgentRole } from '@/lib/agents/contracts';

/**
 * Lo que dice el humano, con peso.
 *
 * Es la palanca del titiritero (§P3): el cliente sabe cosas que el sistema no
 * puede observar —que un competidor quebró, que no quiere que los vean como los
 * baratos, que el cliente X es intocable— y el sistema tiene que obedecer y
 * dejar constancia de que obedeció.
 *
 * `weight > 1` significa que pesa MÁS que la evidencia del sistema. Es
 * deliberado y es la razón de que la columna exista: sin un peso explícito, el
 * agente "considera" el input del cliente y decide lo mismo de siempre, que es
 * la peor de las respuestas posibles porque parece que escuchó.
 */

export interface HumanInputRow {
  id: string;
  organization_id: string;
  author: string;
  author_type: 'client' | 'operator';
  body: string;
  scope: { agents?: AgentRole[]; kinds?: string[]; until?: string };
  weight: number;
  status: string;
  created_at: string;
}

export async function addHumanInput(args: {
  organizationId: string;
  author: string;
  authorType: 'client' | 'operator';
  body: string;
  scope?: { agents?: AgentRole[]; kinds?: string[]; until?: string };
  /** 1 = una fuente más. 2 = manda sobre los datos. */
  weight?: number;
  attachments?: unknown[];
}): Promise<string> {
  const { data, error } = await db()
    .from('human_inputs')
    .insert({
      organization_id: args.organizationId,
      author: args.author,
      author_type: args.authorType,
      body: args.body,
      scope: args.scope ?? {},
      weight: args.weight ?? 1.0,
      attachments: args.attachments ?? [],
    })
    .select('id')
    .single();

  // `mustWrite` equivalente, con mensaje propio: perder lo que el cliente
  // escribió es la forma más rápida de que deje de escribir.
  if (error || !data) {
    throw new Error(`[human_inputs] no se pudo guardar lo que escribió ${args.author}: ${error?.message}`);
  }
  return data.id as string;
}

/** Los inputs vigentes que aplican a este agente y a este tipo de decisión. */
export async function activeHumanInputs(args: {
  organizationId: string;
  role?: AgentRole | null;
  kind?: string | null;
}): Promise<HumanInputRow[]> {
  const { data } = await db()
    .from('human_inputs')
    .select('*')
    .eq('organization_id', args.organizationId)
    .eq('status', 'active')
    .order('weight', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50);

  const hoy = new Date().toISOString().slice(0, 10);

  return ((data ?? []) as HumanInputRow[]).filter((input) => {
    const scope = input.scope ?? {};
    if (scope.until && scope.until < hoy) return false;
    if (args.role && Array.isArray(scope.agents) && scope.agents.length > 0 && !scope.agents.includes(args.role)) {
      return false;
    }
    if (args.kind && Array.isArray(scope.kinds) && scope.kinds.length > 0 && !scope.kinds.includes(args.kind)) {
      return false;
    }
    return true;
  });
}

/**
 * El bloque de contexto. Los de peso > 1 van primero y marcados.
 *
 * El texto dice explícitamente "manda sobre los datos" porque la alternativa
 * —confiar en que el modelo infiera la jerarquía de un número— es exactamente
 * el tipo de cosa que funciona en la demo y falla en producción.
 */
export function humanInputBlock(inputs: HumanInputRow[]): string {
  if (inputs.length === 0) return '';
  const lineas = inputs.map((i) => {
    const marca = Number(i.weight) > 1 ? ' **(manda sobre los datos)**' : '';
    const quien = i.author_type === 'client' ? 'el cliente' : 'el operador';
    return `- ${quien} (${i.author}): ${i.body}${marca}`;
  });
  return ['## Lo que nos dijo el humano', '', ...lineas].join('\n');
}

export async function revokeHumanInput(id: string): Promise<void> {
  await mustWrite(
    db().from('human_inputs').update({ status: 'revoked' }).eq('id', id),
    'human_inputs.revoke',
  );
}
