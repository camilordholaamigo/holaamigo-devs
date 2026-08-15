import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { LeadsUpload } from '@/components/leads-upload';
import { SectionTitle, Card } from '@/components/ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cargar tu base · Hola Amigo', robots: { index: false } };

export default async function LeadsPage({ params }: PageProps<'/leads/[orgId]'>) {
  const { orgId } = await params;

  const { data: org } = await db()
    .from('organizations')
    .select('id, name, domain')
    .eq('id', orgId)
    .maybeSingle();

  if (!org) notFound();

  const { count } = await db()
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId);

  return (
    <main className="flex-1">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-5">
          <span className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight text-ink">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            Hola Amigo
          </span>
          <span className="text-[13px] text-ink-faint">{org.name ?? org.domain}</span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-8 px-6 py-14">
        <SectionTitle
          eyebrow="Paso 2 de 2"
          title="Carga tu base y en 24 horas tienes el primer lead trabajado"
          subtitle="Esta promesa es real para reactivar TU base, desde TU dominio o TU WhatsApp. El outbound en frío necesita 2 o 3 semanas de calentamiento — te lo decimos ahora y no cuando ya hayas pagado."
        />

        {count && count > 0 ? (
          <Card className="px-5 py-4">
            <p className="text-[13.5px] text-ink-soft">
              Ya tienes <strong className="tnum text-ink">{count}</strong> contactos cargados. Los
              repetidos se descartan solos: puedes subir otro archivo sin miedo.
            </p>
          </Card>
        ) : null}

        <LeadsUpload organizationId={orgId} />
      </div>
    </main>
  );
}
