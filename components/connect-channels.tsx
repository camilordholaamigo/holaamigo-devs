'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { AgentBuilder } from '@/components/agent-builder';

/**
 * §4.5 Conectar canal.
 *
 * CAMBIÓ EL SIGNIFICADO DE "CONECTAR WHATSAPP" (P7).
 *
 * Antes esta pantalla registraba una intención y le avisaba a un humano por
 * Slack; todo lo que convertía esa intención en un agente que agenda pasaba
 * después, en semanas de correos. Ahora elegir WhatsApp **arma el agente ahí
 * mismo**, con lo que el diagnóstico ya sabe, y lo deja listo para hablarle.
 *
 * La provisión del número sigue siendo manual y sigue tardando 24-48 horas,
 * porque esa demora es de Meta. Pero deja de ser un bloqueo: el cliente ya vio
 * su agente funcionar antes de que exista el número.
 *
 * "El skip siempre es visible" (§13.5) sigue mandando: es un botón de tamaño
 * normal y lleva directo a cargar leads.
 *
 * Ver docs/adr/0024-el-agente-se-compila-del-diagnostico.md
 */

export function ConnectChannels({
  organizationId,
  sessionId,
  tienePlaybook,
}: {
  organizationId: string;
  sessionId: string;
  tienePlaybook: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [eligioWhatsapp, setEligioWhatsapp] = useState(false);
  const [done, setDone] = useState<{ channel: string; message: string } | null>(null);

  async function conectarCorreo() {
    setBusy('email_inbox');
    try {
      const response = await fetch('/api/channels/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          sessionId,
          channel: 'email_inbox',
          action: 'request',
        }),
      });
      const data = await response.json();
      if (response.ok) setDone({ channel: 'email_inbox', message: data.message });
    } finally {
      setBusy(null);
    }
  }

  async function skip() {
    setBusy('skip');
    await fetch('/api/channels/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, sessionId, channel: 'whatsapp', action: 'skip' }),
    }).catch(() => {});
    router.push(`/leads/${organizationId}`);
  }

  if (done) {
    return (
      <Card className="slide-in space-y-5 p-8">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-money-soft text-money">
          ✓
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold tracking-tight text-ink">Solicitud recibida.</h2>
          <p className="text-[14.5px] leading-relaxed text-ink-soft">{done.message}</p>
        </div>
        <button
          type="button"
          onClick={() => router.push(`/leads/${organizationId}`)}
          className="rounded-xl bg-ink px-6 py-3.5 text-[15px] font-semibold text-paper transition hover:bg-money-bright"
        >
          Ahora carga tu base
        </button>
      </Card>
    );
  }

  // Elegido WhatsApp: acá ya no se pide nada, se construye.
  if (eligioWhatsapp) {
    return (
      <div className="space-y-5">
        <Card className="space-y-2 p-6">
          <h3 className="text-[16px] font-semibold tracking-tight text-ink">
            No hay nada que llenar.
          </h3>
          <p className="text-[13.5px] leading-relaxed text-ink-soft">
            Tu agente se arma con lo que ya sabemos: lo que leímos de tu sitio, lo que nos
            contaste en el diagnóstico y tu agenda. Toma menos de un minuto, y al final vas a
            poder hablarle.
          </p>
        </Card>

        <AgentBuilder
          organizationId={organizationId}
          sessionId={sessionId}
          yaExiste={tienePlaybook}
        />

        <button
          type="button"
          onClick={() => setEligioWhatsapp(false)}
          className="text-[13px] text-ink-faint underline underline-offset-4 hover:text-ink"
        >
          Volver
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <ChannelCard
          title="WhatsApp"
          cta={tienePlaybook ? 'Ver mi agente' : 'Crear mi agente'}
          body="Armamos tu agente de agendamiento con lo que ya sabemos de tu negocio y lo pruebas en el navegador, ahora mismo."
          detail="El número lo verificamos después con Meta: esa parte tarda 24 a 48 horas y no depende de nosotros."
          destacado
          busy={false}
          onClick={() =>
            tienePlaybook ? router.push(`/agente/${organizationId}`) : setEligioWhatsapp(true)
          }
        />
        <ChannelCard
          title="Correo"
          cta="Conectar correo"
          body="Conectamos tu buzón de recepción para que el agente conteste inbound desde el día uno."
          detail="El envío en frío se configura aparte: exige dominios y calentamiento."
          busy={busy === 'email_inbox'}
          onClick={conectarCorreo}
        />
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-[14.5px] font-medium text-ink">
            ¿Prefieres arrancar sin conectar nada?
          </p>
          <p className="mt-0.5 text-[13px] text-ink-faint">
            Carga tu base y en 24 horas tienes el primer lead trabajado. Puedes conectar el canal
            después, cuando ya hayas visto resultados.
          </p>
        </div>
        <button
          type="button"
          onClick={skip}
          disabled={busy === 'skip'}
          className="shrink-0 rounded-xl border border-line-strong bg-paper-raised px-5 py-3 text-[14.5px] font-semibold text-ink transition hover:border-ink disabled:opacity-50"
        >
          Saltar este paso
        </button>
      </Card>
    </div>
  );
}

function ChannelCard({
  title,
  cta,
  body,
  detail,
  busy,
  destacado,
  onClick,
}: {
  title: string;
  cta: string;
  body: string;
  detail: string;
  busy: boolean;
  destacado?: boolean;
  onClick: () => void;
}) {
  return (
    <Card className={`flex flex-col gap-4 p-6 ${destacado ? 'border-ink/20' : ''}`}>
      <div className="space-y-2">
        <h3 className="text-[16px] font-semibold tracking-tight text-ink">{title}</h3>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">{body}</p>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">{detail}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={[
          'mt-auto rounded-xl px-5 py-3 text-[14.5px] font-semibold transition disabled:opacity-60',
          destacado
            ? 'bg-ink text-paper hover:bg-money-bright'
            : 'border border-line-strong text-ink hover:border-ink',
        ].join(' ')}
      >
        {busy ? 'Enviando…' : cta}
      </button>
    </Card>
  );
}
