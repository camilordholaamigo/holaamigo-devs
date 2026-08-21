import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase/admin';
import { playbookVigente } from '@/lib/playbook/store';
import { AgentBuilder } from '@/components/agent-builder';
import { SetterSandbox } from '@/components/setter-sandbox';
import { PlaybookReview } from '@/components/playbook-review';
import { WhatsappHandoff } from '@/components/whatsapp-handoff';
import { Card, SectionTitle, Badge } from '@/components/ui';

/**
 * `/agente/[orgId]` — donde el cliente conoce a su agente.
 *
 * El orden de la página es el orden de la confianza, y no es el orden obvio:
 *
 *   1. **Habla con él.** Antes de explicar nada. Un guion es un documento y
 *      nadie confía en un documento.
 *   2. **Confirma lo que inferimos.** Cuatro cosas, ya escritas, con un botón.
 *      Es lo que reemplaza dos semanas de correos.
 *   3. **Conecta WhatsApp.** Al final, cuando ya vio qué está conectando.
 *
 * Poner el formulario primero sería lo natural y sería un error: pedirle datos
 * a alguien que todavía no vio para qué son es cómo se pierde a la mitad de la
 * gente en un onboarding.
 *
 * Sin auth por `orgId`, igual que `/leads/[orgId]`: es el camino del embudo,
 * llega por su propio enlace y todavía no hay cuenta. Ver ADR 0005.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Tu agente de agendamiento · Hola Amigo',
  robots: { index: false },
};

export default async function AgentePage({ params }: PageProps<'/agente/[orgId]'>) {
  const { orgId } = await params;

  const { data: org } = await db()
    .from('organizations')
    .select('id, name, domain')
    .eq('id', orgId)
    .maybeSingle();

  if (!org) notFound();

  const [playbook, canal, kb, sesion] = await Promise.all([
    playbookVigente(orgId),
    canalDeWhatsapp(orgId),
    baseDeConocimiento(orgId),
    ultimaSesion(orgId),
  ]);

  const nombre = org.name ?? org.domain;

  // ── Todavía no hay agente ────────────────────────────────────────────────
  if (!playbook) {
    return (
      <Marco nombre={nombre}>
        <SectionTitle
          eyebrow="Tu agente"
          title="Todavía no armamos tu agente."
          subtitle="Lo armamos con lo que ya sabemos de tu negocio: lo que leímos de tu sitio y lo que nos contaste en el diagnóstico. No hay nada que llenar."
        />
        <AgentBuilder organizationId={orgId} sessionId={sesion} yaExiste={false} />
      </Marco>
    );
  }

  return (
    <Marco nombre={nombre}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge tone="money">Agente listo</Badge>
          <Badge tone="muted">Guion v{playbook.version}</Badge>
          {kb?.status === 'ready' ? (
            <Badge tone="muted">{kb.file_count} documentos indexados</Badge>
          ) : (
            <Badge tone="muted">Sin base de conocimiento</Badge>
          )}
        </div>

        <SectionTitle
          title={`El agente de ${nombre} ya sabe agendar.`}
          subtitle="Está armado con tu oferta, tus precios, tus objeciones y tu agenda. Háblale como si fueras un contacto tuyo: consulta tu agenda de verdad y propone horarios que existen."
        />
      </div>

      {/* ── 1 · Habla con él ─────────────────────────────────────────── */}
      <SetterSandbox organizationId={orgId} />

      {/* ── 2 · Confirma lo inferido ─────────────────────────────────── */}
      <PlaybookReview organizationId={orgId} cobertura={playbook.cobertura} />

      {/* ── 3 · Qué sabe, en concreto ────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <ResumenCard
          titulo="Lo que pregunta antes de agendar"
          items={playbook.calificacion.preguntas.map((p) => p.pregunta)}
          pie={`Necesita ${playbook.calificacion.minimo_para_agendar} de ${playbook.calificacion.preguntas.length} antes de proponer horario.`}
        />
        <ResumenCard
          titulo="Objeciones que ya tiene resueltas"
          items={playbook.objeciones.slice(0, 6).map((o) => o.objecion)}
          pie={
            playbook.objeciones.length > 6
              ? `Y ${playbook.objeciones.length - 6} más.`
              : 'Cada una con su respuesta escrita.'
          }
        />
        <ResumenCard
          titulo="La cita que agenda"
          items={[
            `${playbook.agendamiento.duracion_min} minutos por ${playbook.agendamiento.modalidad}`,
            playbook.agendamiento.quien_atiende
              ? `La atiende ${playbook.agendamiento.quien_atiende}`
              : 'Falta decir quién la atiende',
            `Horario: ${playbook.agendamiento.hora_inicio}:00 a ${playbook.agendamiento.hora_fin}:00 · ${playbook.agendamiento.zona_horaria}`,
          ]}
          pie={
            playbook.agendamiento.url
              ? 'Tu link de agenda ya existe y es el que reparte.'
              : 'Sin link de agenda todavía.'
          }
        />
        <ResumenCard
          titulo="Cuándo levanta la mano"
          items={playbook.escalamiento.disparadores.slice(0, 5)}
          pie="Cuando pasa algo de esto, para y te avisa. No improvisa."
        />
      </div>

      {/* ── 4 · Conectar WhatsApp ────────────────────────────────────── */}
      <WhatsappHandoff
        organizationId={orgId}
        sessionId={sesion}
        estado={canal?.status ?? null}
      />

      <p className="border-t border-line pt-8 text-[12px] leading-relaxed text-ink-faint">
        El guion completo, con la instrucción textual que lee el modelo en cada turno, está en tu
        consola:{' '}
        <Link
          href={`/consola/${orgId}/agentes`}
          className="underline underline-offset-4 hover:text-ink"
        >
          agentes
        </Link>
        .
      </p>
    </Marco>
  );
}

function Marco({ nombre, children }: { nombre: string; children: React.ReactNode }) {
  return (
    <main className="flex-1">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-5">
          <span className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight text-ink">
            <span className="h-2.5 w-2.5 rounded-full bg-money-bright" />
            Hola Amigo
          </span>
          <span className="truncate text-[13px] text-ink-faint">{nombre}</span>
        </div>
      </header>
      <div className="mx-auto max-w-3xl space-y-10 px-6 py-12">{children}</div>
    </main>
  );
}

function ResumenCard({
  titulo,
  items,
  pie,
}: {
  titulo: string;
  items: string[];
  pie: string;
}) {
  return (
    <Card className="space-y-3 p-5">
      <p className="text-[13px] font-semibold tracking-tight text-ink">{titulo}</p>
      <ul className="space-y-1.5">
        {items.filter(Boolean).map((item) => (
          <li key={item} className="flex gap-2 text-[13px] leading-relaxed text-ink-soft">
            <span className="mt-[3px] text-ink-faint">·</span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
      <p className="text-[12px] leading-relaxed text-ink-faint">{pie}</p>
    </Card>
  );
}

async function canalDeWhatsapp(orgId: string) {
  const { data } = await db()
    .from('channel_connections')
    .select('status, meta')
    .eq('organization_id', orgId)
    .eq('channel', 'whatsapp')
    .maybeSingle();
  return data;
}

async function baseDeConocimiento(orgId: string) {
  const { data } = await db()
    .from('knowledge_bases')
    .select('status, file_count, error')
    .eq('organization_id', orgId)
    .eq('is_current', true)
    .maybeSingle();
  return data;
}

async function ultimaSesion(orgId: string): Promise<string | null> {
  const { data } = await db()
    .from('intake_sessions')
    .select('id')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
