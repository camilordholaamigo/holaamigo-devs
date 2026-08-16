import { db } from '@/lib/supabase/admin';

/**
 * "Ajustar" nunca abre una caja de texto.
 *
 * Es la regla de UX que más se nota del feed. Cuando el cliente quiere aprobar
 * *pero no así*, la respuesta correcta no es pedirle que escriba un párrafo que
 * después alguien tiene que interpretar: es mostrarle los dos o tres números
 * reales de la propuesta y dejar que los mueva.
 *
 * El mecanismo es declarativo: cada propuesta trae en su payload qué se puede
 * ajustar (`ajustes_disponibles`), la pantalla lo pinta y esto lo aplica. Así,
 * cuando P4 y P5 propongan reasignaciones de presupuesto o listas de partners,
 * no hay que tocar ni el componente ni este archivo — solo declarar el ajuste.
 *
 * Ver docs/wiki/17-la-sala-el-feed-y-el-capitulo.md
 */

export type TipoDeAjuste = 'slider' | 'checkboxes';

export interface AjusteDisponible {
  key: string;
  label: string;
  tipo: TipoDeAjuste;
  /** slider */
  min?: number;
  max?: number;
  paso?: number;
  unidad?: string;
  /** checkboxes */
  opciones?: Array<{ value: string; label: string }>;
  /** El valor con el que llega la propuesta: lo que pasa si no se toca nada. */
  valor: number | string[];
  /** Qué cambia si lo mueve. Se muestra debajo del control. */
  efecto?: string;
}

export type Ajustes = Record<string, number | string[]>;

/**
 * Aplica lo que el cliente movió, antes de que la propuesta se ejecute.
 *
 * Devuelve una frase por ajuste aplicado. Esa frase va al efecto que ve el
 * cliente: aprobar con ajustes y que la pantalla diga solo "aprobado" es la
 * forma más rápida de que deje de confiar en los controles.
 *
 * Silencioso con lo que no reconoce: un ajuste declarado por una propuesta que
 * este archivo todavía no sabe aplicar queda registrado en la respuesta del
 * feed pero no inventa un efecto. Prometer un cambio que no ocurrió es peor que
 * no ofrecer el control.
 */
export async function aplicarAjustes(args: {
  campaignId: string | null;
  ajustes: Ajustes;
}): Promise<string[]> {
  const aplicados: string[] = [];
  if (!args.campaignId || Object.keys(args.ajustes).length === 0) return aplicados;

  const { data: campaign } = await db()
    .from('campaigns')
    .select('id, sequence, daily_cap')
    .eq('id', args.campaignId)
    .maybeSingle();

  if (!campaign) return aplicados;

  const patch: Record<string, unknown> = {};

  const tope = args.ajustes.send_today ?? args.ajustes.daily_cap;
  if (typeof tope === 'number' && tope > 0 && tope !== campaign.daily_cap) {
    patch.daily_cap = Math.round(tope);
    aplicados.push(`Tope bajado a ${Math.round(tope)} envíos por día.`);
  }

  const pasos = args.ajustes.pasos;
  if (Array.isArray(pasos) && Array.isArray(campaign.sequence)) {
    const indices = new Set(pasos.map((p) => Number(p)));
    const recortada = (campaign.sequence as unknown[]).filter((_, i) => indices.has(i));
    // Un solo paso es una secuencia válida; cero no lo es, y aceptarlo dejaría
    // una campaña aprobada que no puede enviar nada.
    if (recortada.length > 0 && recortada.length < (campaign.sequence as unknown[]).length) {
      patch.sequence = recortada;
      aplicados.push(
        `Secuencia recortada a ${recortada.length} de ${(campaign.sequence as unknown[]).length} toques.`,
      );
    }
  }

  if (Object.keys(patch).length > 0) {
    await db().from('campaigns').update(patch).eq('id', args.campaignId);
  }

  return aplicados;
}

/**
 * Los ajustes que ofrece una propuesta de envío.
 *
 * Vive acá y no en `lib/feed/president.ts` para que el catálogo de lo ajustable
 * esté en un solo archivo: cuando alguien pregunte "¿qué puede tocar el cliente
 * antes de aprobar?", la respuesta es este módulo y no una búsqueda por el repo.
 */
export function ajustesDeEnvio(args: {
  sendToday: number;
  pasos: Array<{ purpose: string }>;
}): AjusteDisponible[] {
  const ajustes: AjusteDisponible[] = [
    {
      key: 'send_today',
      label: '¿A cuántos le escribimos?',
      tipo: 'slider',
      min: Math.min(10, args.sendToday),
      max: args.sendToday,
      paso: 10,
      unidad: 'contactos',
      valor: args.sendToday,
      efecto: 'Baja el tope diario de la campaña. El resto de la lista espera al día siguiente.',
    },
  ];

  if (args.pasos.length > 1) {
    ajustes.push({
      key: 'pasos',
      label: '¿Qué toques incluimos?',
      tipo: 'checkboxes',
      opciones: args.pasos.map((paso, i) => ({
        value: String(i),
        label: `${i + 1}. ${paso.purpose}`,
      })),
      valor: args.pasos.map((_, i) => String(i)),
      efecto: 'Los que desmarques no se envían nunca, ni en los días siguientes.',
    });
  }

  return ajustes;
}
