import Link from 'next/link';
import { Card, Badge, Empty } from '@/components/ui';
import { db } from '@/lib/supabase/admin';
import { playbookVigente } from '@/lib/playbook/store';
import { renderInstructions } from '@/lib/playbook/render';

/**
 * El agente de agendamiento, dentro de la consola.
 *
 * Muestra tres cosas y la tercera es la que casi nadie muestra:
 *
 *   1. El embudo real del setter, por escalón alcanzado. Sale de SQL
 *      (`embudo_del_setter`), no del render.
 *   2. Qué falta por confirmar del guion, con enlace a la pantalla que lo
 *      resuelve en un tap.
 *   3. **La instrucción textual que el modelo lee en cada turno.** Completa, sin
 *      resumir. Es el mismo principio que las fuentes del diagnóstico (§13.4)
 *      aplicado al agente: si el cliente no puede leer lo que su agente tiene
 *      en la cabeza, lo que le estamos vendiendo es fe.
 */

export async function SetterPanel({ orgId }: { orgId: string }) {
  const playbook = await playbookVigente(orgId);

  if (!playbook) {
    return (
      <Empty
        title="Todavía no armaste tu agente de agendamiento"
        hint="Se compila solo con lo que ya sabemos de tu negocio. Toma menos de un minuto."
      />
    );
  }

  const [{ data: embudo }, { data: kb }] = await Promise.all([
    db().rpc('embudo_del_setter', { p_org: orgId }),
    db()
      .from('knowledge_bases')
      .select('status, file_count, built_at, error')
      .eq('organization_id', orgId)
      .eq('is_current', true)
      .maybeSingle(),
  ]);

  const etapas = (embudo ?? []) as Array<{
    etapa: string;
    orden: number;
    conversaciones: number;
    del_anterior: number | null;
  }>;

  const sinConversaciones = etapas.length === 0 || Number(etapas[0]?.conversaciones ?? 0) === 0;
  const porConfirmar = playbook.cobertura?.a_confirmar?.length ?? 0;

  return (
    <div className="space-y-4">
      <Card className="space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="money">Guion v{playbook.version}</Badge>
            <Badge tone="muted">{playbook.source === 'editado' ? 'Editado por ti' : 'Compilado'}</Badge>
            <Badge tone="muted">
              {kb?.status === 'ready'
                ? `${kb.file_count} documentos indexados`
                : kb?.status === 'failed'
                  ? 'Sin base de conocimiento'
                  : 'Base de conocimiento en construcción'}
            </Badge>
          </div>
          <Link
            href={`/agente/${orgId}`}
            className="text-[13px] font-semibold text-ink underline underline-offset-4"
          >
            Probarlo y ajustarlo
          </Link>
        </div>

        {porConfirmar > 0 ? (
          <p className="rounded-xl bg-paper-sunken px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
            Quedan <strong className="font-semibold text-ink">{porConfirmar}</strong>{' '}
            {porConfirmar === 1 ? 'cosa' : 'cosas'} que inferimos y que tu agente está usando sin
            confirmar. Cada una es un tap.
          </p>
        ) : null}

        {/* ── El embudo ────────────────────────────────────────────────── */}
        <div className="space-y-2.5">
          <p className="text-[13px] font-semibold tracking-tight text-ink">
            Dónde se caen las conversaciones
          </p>

          {sinConversaciones ? (
            <p className="text-[13px] leading-relaxed text-ink-faint">
              Todavía no hay conversaciones reales. Las pruebas del simulador no cuentan acá a
              propósito: un embudo que incluye tus propias pruebas no mide nada.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {etapas.map((etapa) => {
                const total = Number(etapas[0]?.conversaciones ?? 1) || 1;
                const ancho = Math.round((Number(etapa.conversaciones) / total) * 100);
                return (
                  <li key={etapa.orden} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="text-ink-soft">{etapa.etapa}</span>
                      <span className="shrink-0 tabular-nums text-ink-faint">
                        {etapa.conversaciones}
                        {etapa.del_anterior !== null ? ` · ${etapa.del_anterior}%` : ''}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-paper-sunken">
                      <div
                        className="h-full rounded-full bg-ink/70"
                        style={{ width: `${Math.max(ancho, 1)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      {/* ── La instrucción, sin resumir ──────────────────────────────────── */}
      <Card as="section" className="overflow-hidden">
        <details className="group">
          <summary className="cursor-pointer list-none px-6 py-4 text-[13px] font-semibold text-ink">
            <span className="flex items-center justify-between gap-3">
              Lo que tu agente lee antes de cada mensaje
              <span className="text-[12px] font-normal text-ink-faint group-open:hidden">
                Ver completo
              </span>
            </span>
          </summary>
          <div className="border-t border-line px-6 py-4">
            <p className="mb-3 text-[12.5px] leading-relaxed text-ink-faint">
              Esto es literal, no un resumen. Es exactamente el texto que recibe el modelo en cada
              turno, más lo que descubrió de la conversación en curso.
            </p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-paper-sunken p-4 text-[11.5px] leading-relaxed text-ink-soft">
              {renderInstructions(playbook)}
            </pre>
          </div>
        </details>
      </Card>
    </div>
  );
}
