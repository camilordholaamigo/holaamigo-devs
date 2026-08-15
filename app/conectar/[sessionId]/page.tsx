import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { ConnectChannels } from '@/components/connect-channels';
import { SectionTitle } from '@/components/ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Conectar canal · Hola Amigo', robots: { index: false } };

export default async function ConnectPage({ params }: PageProps<'/conectar/[sessionId]'>) {
  const { sessionId } = await params;

  const { data: session } = await db()
    .from('intake_sessions')
    .select('id, organization_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) notFound();

  const { data: diagnostic } = await db()
    .from('diagnostics')
    .select('share_token')
    .eq('session_id', sessionId)
    .maybeSingle();

  return (
    <main className="flex-1">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-5">
          <span className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight text-ink">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            Hola Amigo
          </span>
          {diagnostic ? (
            <Link
              href={`/diagnostico/${diagnostic.share_token}`}
              className="text-[13px] text-ink-faint underline underline-offset-4 hover:text-ink"
            >
              Volver al diagnóstico
            </Link>
          ) : null}
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-8 px-6 py-14">
        <SectionTitle
          eyebrow="Paso 1 de 2"
          title="Conecta el canal por donde vas a trabajar"
          subtitle="Puedes saltarte esto sin penalización. La carga de tu base es lo que sostiene la promesa de 24 horas, y no depende de tener un canal conectado."
        />

        <ConnectChannels organizationId={session.organization_id} sessionId={sessionId} />
      </div>
    </main>
  );
}
