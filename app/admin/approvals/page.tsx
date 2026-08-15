import { db } from '@/lib/supabase/admin';
import { SectionTitle, Empty } from '@/components/ui';
import { ApprovalCard, type ApprovalItem } from '@/components/approval-card';

/**
 * §9.3 — la cola global, ordenada por severidad y antigüedad.
 *
 * "La cola de decisiones es el producto. Los gráficos son consulta; la cola es
 * el trabajo." (§13.6) Por eso esta pantalla no tiene gráficos.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEVERITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

export default async function ApprovalsPage() {
  const { data: approvals } = await db()
    .from('approvals')
    .select('id, organization_id, kind, title, rationale, if_approved, if_rejected, severity, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(120);

  const orgIds = [...new Set((approvals ?? []).map((a) => a.organization_id))];
  const { data: orgs } = orgIds.length
    ? await db().from('organizations').select('id, name, domain').in('id', orgIds)
    : { data: [] as never[] };

  const orgById = new Map((orgs ?? []).map((o) => [o.id, o.name ?? o.domain]));

  const items: ApprovalItem[] = (approvals ?? [])
    .map((a) => ({ ...a, org_label: orgById.get(a.organization_id) ?? undefined }))
    .sort((a, b) => {
      const severity = (SEVERITY_ORDER[a.severity] ?? 1) - (SEVERITY_ORDER[b.severity] ?? 1);
      if (severity !== 0) return severity;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
      <SectionTitle
        eyebrow="§9.3"
        title="Cola de decisiones"
        subtitle="Ordenada por severidad y antigüedad. Aprobar es un clic; rechazar exige nota."
      />

      {items.length === 0 ? (
        <Empty
          title="Cola vacía"
          hint="Cuando un agente proponga algo o escale, aparece acá."
        />
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <ApprovalCard key={item.id} approval={item} />
          ))}
        </div>
      )}
    </div>
  );
}
