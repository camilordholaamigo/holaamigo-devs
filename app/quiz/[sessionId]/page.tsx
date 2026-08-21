import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { QuizFlow } from '@/components/quiz-flow';
import { track } from '@/lib/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Tu diagnóstico · Hola Amigo', robots: { index: false } };

export default async function QuizPage({ params }: PageProps<'/quiz/[sessionId]'>) {
  const { sessionId } = await params;

  const { data: session } = await db()
    .from('intake_sessions')
    .select('id, organization_id, contact_name, status')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) notFound();

  const [{ data: org }, { data: run }] = await Promise.all([
    db()
      .from('organizations')
      .select('domain, name, currency')
      .eq('id', session.organization_id)
      .single(),
    db()
      .from('research_runs')
      .select('id')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  await track('quiz_started', { organizationId: session.organization_id, sessionId });

  // El usuario volvió a una sesión donde había abandonado: se reactiva.
  if (session.status === 'abandoned') {
    await db().from('intake_sessions').update({ status: 'quiz' }).eq('id', sessionId);
    await track('returned_48h', { organizationId: session.organization_id, sessionId });
  }

  return (
    <main className="flex-1">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-xl items-center gap-2.5 px-6 py-5">
          <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
          <span className="text-[13px] font-semibold tracking-tight text-ink">Hola Amigo</span>
          {session.contact_name ? (
            <span className="ml-auto text-[13px] text-ink-faint">
              Hola, {session.contact_name.split(' ')[0]}
            </span>
          ) : null}
        </div>
      </header>

      <QuizFlow
        sessionId={sessionId}
        domain={org?.domain ?? 'tu sitio'}
        // El research escribe la moneda en `organizations` al detectar el país
        // (ADR 0006). Si todavía no terminó, el adelanto sale en USD — que es
        // el fallback correcto, no una moneda inventada.
        currency={org?.currency ?? 'USD'}
        initialRunId={run?.id ?? null}
      />
    </main>
  );
}
