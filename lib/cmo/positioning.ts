import { db, mustWrite, unwrap } from '@/lib/supabase/admin';

/**
 * Posicionamiento vivo.
 *
 * Un documento de posicionamiento normalmente es un PDF que se escribe una vez
 * y nadie vuelve a abrir. Acá es un objeto **versionado y medible**: el copy que
 * sale se compara contra él, y la deriva se detecta antes de que el cliente
 * note que su marca empezó a sonar como otra cosa.
 *
 * Dos decisiones que sostienen todo:
 *
 *  1. **Se versiona, no se edita.** La pregunta "¿qué decíamos ser en marzo?"
 *     es la que permite entender por qué el copy de marzo decía lo que decía.
 *  2. **La lista de lo que NO se dice es la mitad útil.** Un posicionamiento
 *     que solo enumera virtudes no sirve para detectar deriva, porque todo copy
 *     las cumple de alguna forma.
 *
 * Ver docs/wiki/19-la-cmo-expandida.md
 */

export interface Positioning {
  id: string;
  organization_id: string;
  version: number;
  statement: string;
  category: string | null;
  icp: string | null;
  differentiators: string[];
  forbidden_claims: string[];
  evidence: Array<{ type: string; ref: string; note?: string }>;
  created_by: string;
  reason: string | null;
  created_at: string;
}

export interface Deriva {
  sin_posicionamiento: boolean;
  version?: number;
  /** Frases prohibidas que aparecen literalmente en el texto. */
  viola: string[];
  /** Qué porción de los diferenciadores menciona el texto. `null` si no hay. */
  cobertura: number | null;
  diferenciadores?: number;
}

export async function currentPositioning(organizationId: string): Promise<Positioning | null> {
  const { data } = await db()
    .from('positioning')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_current', true)
    .maybeSingle();
  return (data as Positioning | null) ?? null;
}

/**
 * Escribe una versión nueva.
 *
 * El orden importa y es el mismo del Brief: primero se baja la vigente y
 * después se inserta la nueva, porque al revés el índice único parcial
 * rechazaría la inserción.
 */
export async function writePositioning(args: {
  organizationId: string;
  statement: string;
  category?: string | null;
  icp?: string | null;
  differentiators: string[];
  forbiddenClaims: string[];
  evidence?: Array<{ type: string; ref: string; note?: string }>;
  createdBy?: string;
  reason?: string | null;
}): Promise<{ id: string; version: number }> {
  const { data: previa } = await db()
    .from('positioning')
    .select('version')
    .eq('organization_id', args.organizationId)
    .order('version', { ascending: false })
    .limit(1);

  await mustWrite(
    db()
      .from('positioning')
      .update({ is_current: false })
      .eq('organization_id', args.organizationId)
      .eq('is_current', true),
    'positioning.retire',
  );

  const version = (previa?.[0]?.version ?? 0) + 1;

  const row = unwrap(
    await db()
      .from('positioning')
      .insert({
        organization_id: args.organizationId,
        version,
        statement: args.statement,
        category: args.category ?? null,
        icp: args.icp ?? null,
        differentiators: args.differentiators,
        forbidden_claims: args.forbiddenClaims,
        evidence: args.evidence ?? [],
        created_by: args.createdBy ?? 'cmo',
        reason: args.reason ?? null,
        is_current: true,
      })
      .select('id')
      .single(),
    'positioning.insert',
  ) as { id: string };

  return { id: row.id, version };
}

/**
 * ¿Este texto se aleja de lo que la marca dice ser?
 *
 * El cálculo vive en SQL (`holaamigo.deriva_de_copy`) porque la deriva es una
 * medición, no una opinión: el número se puede verificar con una consulta. El
 * modelo puede explicarla después; no la calcula.
 */
export async function checkDrift(organizationId: string, texto: string): Promise<Deriva> {
  const { data, error } = await db().rpc('deriva_de_copy', {
    p_org: organizationId,
    p_texto: texto,
  });

  if (error) {
    console.error(`[cmo:deriva] ${error.message}`);
    return { sin_posicionamiento: true, viola: [], cobertura: null };
  }

  const result = (data ?? {}) as Record<string, unknown>;
  return {
    sin_posicionamiento: Boolean(result.sin_posicionamiento),
    version: result.version as number | undefined,
    viola: (result.viola as string[]) ?? [],
    cobertura: result.cobertura === null || result.cobertura === undefined ? null : Number(result.cobertura),
    diferenciadores: result.diferenciadores as number | undefined,
  };
}

/**
 * Revisa el copy que se está enviando de verdad.
 *
 * Mira las secuencias de las campañas activas, no los borradores: lo que
 * importa no es lo que se escribió, es lo que está saliendo. Devuelve solo lo
 * que tiene problema — reportar las diez campañas alineadas es cómo una alerta
 * se convierte en ruido y deja de leerse.
 */
export interface HallazgoDeDeriva {
  campaign_id: string;
  campaign: string;
  paso: number;
  viola: string[];
  cobertura: number | null;
  extracto: string;
}

export async function auditarCopyActivo(
  organizationId: string,
  opts: { coberturaMinima?: number } = {},
): Promise<HallazgoDeDeriva[]> {
  const minima = opts.coberturaMinima ?? 0.25;

  const { data: campanas } = await db()
    .from('campaigns')
    .select('id, name, sequence, status')
    .eq('organization_id', organizationId)
    .in('status', ['active', 'scheduled'])
    .limit(20);

  const hallazgos: HallazgoDeDeriva[] = [];

  for (const campana of campanas ?? []) {
    const pasos = (campana.sequence ?? []) as Array<{ subject?: string; body?: string }>;
    for (const [i, paso] of pasos.entries()) {
      const texto = `${paso.subject ?? ''} ${paso.body ?? ''}`.trim();
      if (texto.length < 20) continue;

      const deriva = await checkDrift(organizationId, texto);
      if (deriva.sin_posicionamiento) return [];

      const problema =
        deriva.viola.length > 0 || (deriva.cobertura !== null && deriva.cobertura < minima);
      if (!problema) continue;

      hallazgos.push({
        campaign_id: campana.id,
        campaign: campana.name ?? 'campaña',
        paso: i + 1,
        viola: deriva.viola,
        cobertura: deriva.cobertura,
        extracto: texto.slice(0, 200),
      });
    }
  }

  return hallazgos;
}

export async function positioningHistory(organizationId: string, limit = 10): Promise<Positioning[]> {
  const { data } = await db()
    .from('positioning')
    .select('*')
    .eq('organization_id', organizationId)
    .order('version', { ascending: false })
    .limit(limit);
  return (data ?? []) as Positioning[];
}
