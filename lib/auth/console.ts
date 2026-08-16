import { db } from '@/lib/supabase/admin';
import { currentAdmin } from '@/lib/auth/admin';

/**
 * Acceso a la consola del cliente.
 *
 * ESTADO v1, dicho sin adornos: quien tenga el link de `/consola/[orgId]`
 * puede decidir por esa organización. Es el mismo nivel de confianza que ya
 * tenía `/panel/[orgId]`: un UUID v4 que no se adivina y que solo llega por
 * correo al dueño.
 *
 * Por qué así y no con Supabase Auth: los primeros clientes son cinco
 * fundadores con los que hablamos todos los días, y montar auth de verdad —
 * SMTP en el proyecto de Rentmies, magic links, invitaciones, roles— es una
 * semana que no mueve la aguja esta semana. La misma decisión, con las mismas
 * razones, que ADR 0005.
 *
 * LO QUE HAY QUE CAMBIAR ANTES DEL PRIMER CLIENTE QUE NO SEA FUNDADOR:
 * esto, por auth real con usuarios y roles. Está en el runbook y en el
 * CHANGELOG, no escondido en un comentario.
 *
 * Lo que sí está resuelto ya: toda ruta que muta verifica que la organización
 * exista y que el recurso PERTENEZCA a esa organización. Un link filtrado da
 * acceso a una organización, nunca a las demás.
 */

export type ConsoleActor = { kind: 'admin'; user: string } | { kind: 'link'; user: string };

export async function consoleActor(organizationId: string): Promise<ConsoleActor | null> {
  const admin = await currentAdmin();
  if (admin) return { kind: 'admin', user: admin.user };

  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) return null;

  const { data } = await db()
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle();

  return data ? { kind: 'link', user: 'cliente' } : null;
}

/** Verifica que un recurso sea de la organización que dice el llamador. Sin
 *  esto, tener un link válido permitiría decidir sobre recursos ajenos pasando
 *  otro id en el cuerpo. */
export async function belongsToOrg(
  table: 'campaigns' | 'feed_items' | 'mailboxes' | 'assets' | 'products' | 'orders' | 'bookings',
  id: string,
  organizationId: string,
): Promise<boolean> {
  const { data } = await db()
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return Boolean(data);
}
