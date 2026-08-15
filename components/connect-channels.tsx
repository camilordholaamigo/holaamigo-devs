'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

/**
 * §4.5 Conectar canal.
 *
 * "El skip siempre es visible" (Principio §13.5). No está escondido en letra
 * chica ni en un enlace gris al fondo: es un botón de tamaño normal, y lleva
 * directo a cargar leads — el camino de menor fricción y mayor valor
 * inmediato. La fricción escondida convierte peor y enseña desconfianza.
 */

export function ConnectChannels({
  organizationId,
  sessionId,
}: {
  organizationId: string;
  sessionId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ channel: string; message: string } | null>(null);

  async function connect(channel: 'whatsapp' | 'email_inbox') {
    setBusy(channel);
    try {
      const response = await fetch('/api/channels/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, sessionId, channel, action: 'request' }),
      });
      const data = await response.json();
      if (response.ok) setDone({ channel, message: data.message });
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

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <ChannelCard
          title="Conectar WhatsApp"
          body="Verificamos tu número con Meta y enviamos las plantillas a aprobación. Meta tarda entre 24 y 48 horas."
          detail="Necesitas un número que no esté ya usando la app de WhatsApp."
          busy={busy === 'whatsapp'}
          onClick={() => connect('whatsapp')}
        />
        <ChannelCard
          title="Conectar correo"
          body="Conectamos tu buzón de recepción para que el agente conteste inbound desde el día uno."
          detail="El envío en frío se configura aparte: exige dominios y calentamiento."
          busy={busy === 'email_inbox'}
          onClick={() => connect('email_inbox')}
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
  body,
  detail,
  busy,
  onClick,
}: {
  title: string;
  body: string;
  detail: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="space-y-2">
        <h3 className="text-[16px] font-semibold tracking-tight text-ink">{title}</h3>
        <p className="text-[13.5px] leading-relaxed text-ink-soft">{body}</p>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">{detail}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="mt-auto rounded-xl bg-ink px-5 py-3 text-[14.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-60"
      >
        {busy ? 'Enviando…' : title}
      </button>
    </Card>
  );
}
