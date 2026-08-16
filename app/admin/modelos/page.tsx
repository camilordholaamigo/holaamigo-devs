import { Card, SectionTitle } from '@/components/ui';
import { ModelsForm, type StepView } from '@/components/models-form';
import { settingUpdatedAt } from '@/lib/settings';
import {
  DEFAULT_ROUTES,
  MODELS_SETTING_KEY,
  STEP_LABELS,
  STEP_NAMES,
  applyOverride,
  currentOverrides,
  estimateCost,
  priceOf,
} from '@/config/models';
import { db } from '@/lib/supabase/admin';
import { isoDaysAgo } from '@/lib/utils';

/**
 * §8.2 — qué modelo corre cada paso.
 *
 * Esta pantalla existe porque cambiar de modelo era un deploy. Con cinco
 * clientes fundadores y el producto todavía en prueba, la pregunta "¿cuánto nos
 * costaría subir el diagnóstico a gpt-5?" se responde probándolo diez minutos,
 * no esperando un despliegue. Ver docs/adr/0014-configuracion-en-caliente.md
 *
 * Lo que NO se toca desde acá: los prompts, los contratos de los agentes y el
 * cálculo de las cifras. El modelo aporta lenguaje; los números los pone el
 * código (ADR 0007). Por eso bajar de modelo abarata el texto sin poner en
 * riesgo una sola cifra de las que el cliente lee.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const overrides = await currentOverrides();
  const updated = await settingUpdatedAt(MODELS_SETTING_KEY).catch(() => null);

  const steps: StepView[] = STEP_NAMES.map((step) => {
    const route = applyOverride(DEFAULT_ROUTES[step], overrides[step]);
    return {
      step,
      title: STEP_LABELS[step].title,
      detail: STEP_LABELS[step].detail,
      models: route.models,
      maxOutputTokens: route.maxOutputTokens,
      reasoningEffort: route.reasoningEffort,
      webSearch: route.webSearch,
      overridden: Boolean(overrides[step]),
      price: priceOf(route.models[0] ?? ''),
    };
  });

  // Costo real de los últimos 30 días, por paso. Es el contrapeso honesto del
  // formulario: sin esto, "subir el modelo" es una decisión sin precio.
  const since = isoDaysAgo(30);
  const { data: runs } = await db()
    .from('agent_runs')
    .select('step, cost_usd, status')
    .gte('created_at', since)
    .limit(5000);

  const spendByStep = new Map<string, { usd: number; runs: number; failed: number }>();
  for (const run of runs ?? []) {
    const key = String(run.step ?? 'desconocido');
    const entry = spendByStep.get(key) ?? { usd: 0, runs: 0, failed: 0 };
    entry.usd += Number(run.cost_usd ?? 0);
    entry.runs += 1;
    if (run.status === 'failed') entry.failed += 1;
    spendByStep.set(key, entry);
  }

  const totalSpend = [...spendByStep.values()].reduce((sum, e) => sum + e.usd, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <SectionTitle
        eyebrow="§8.2"
        title="Modelos de IA"
        subtitle="Qué modelo corre cada paso del análisis. Se cambia acá y toma efecto en menos de 30 segundos, sin desplegar."
      />

      <Card className="space-y-3 p-5">
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Precedencia: <strong className="font-semibold text-ink">esta pantalla</strong> → variable
          de entorno → valor por defecto del código. Un paso marcado{' '}
          <em>valor por defecto</em> todavía no se ha tocado desde acá.
        </p>
        <p className="text-[13px] leading-relaxed text-ink-faint">
          Bajar de modelo abarata el texto, no las cifras: las fugas, la cuenta al revés y los
          costos de cada ruta los calcula el código, nunca el modelo (ADR 0007). Por eso se puede
          probar con la familia mini sin que el diagnóstico deje de ser defendible.
        </p>
        {updated ? (
          <p className="text-[12px] text-ink-faint">
            Última edición: {new Date(updated.at).toLocaleString('es-CO')} por {updated.by}.
          </p>
        ) : null}
      </Card>

      <ModelsForm steps={steps} />

      <section className="space-y-4">
        <SectionTitle
          eyebrow="Últimos 30 días"
          title="Qué costó de verdad"
          subtitle={`USD ${totalSpend.toFixed(2)} en total. Antes de subir un modelo, mira cuánto corre ese paso.`}
        />
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                <th className="px-5 py-3">Paso</th>
                <th className="px-5 py-3 text-right">Corridas</th>
                <th className="px-5 py-3 text-right">Fallidas</th>
                <th className="px-5 py-3 text-right">Costo</th>
                <th className="px-5 py-3 text-right">Promedio</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {STEP_NAMES.map((step) => {
                const entry = spendByStep.get(step) ?? { usd: 0, runs: 0, failed: 0 };
                return (
                  <tr key={step}>
                    <td className="px-5 py-3 text-[13.5px] text-ink">{STEP_LABELS[step].title}</td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink-soft">
                      {entry.runs}
                    </td>
                    <td
                      className={`tnum px-5 py-3 text-right text-[13px] ${
                        entry.failed > 0 ? 'font-semibold text-leak' : 'text-ink-faint'
                      }`}
                    >
                      {entry.failed}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink">
                      USD {entry.usd.toFixed(3)}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-[13px] text-ink-faint">
                      USD {(entry.runs > 0 ? entry.usd / entry.runs : 0).toFixed(4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <p className="text-[12.5px] text-ink-faint">
          Referencia con la configuración vigente: un diagnóstico completo (research + diagnóstico)
          con 40k tokens de entrada y 12k de salida cuesta cerca de USD{' '}
          {(
            estimateCost(steps[0].models[0] ?? '', 40_000, 12_000) +
            estimateCost(steps[3].models[0] ?? '', 40_000, 12_000)
          ).toFixed(2)}
          .
        </p>
      </section>
    </div>
  );
}
