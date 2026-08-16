'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@/components/ui';

/**
 * Configuración de un agente.
 *
 * Lo que se puede cambiar está en el formulario. Lo que NO se puede cambiar —el
 * contrato— está impreso justo debajo, en gris, sin controles. Esa yuxtaposición
 * es deliberada: el cliente tiene que ver, en la misma pantalla, dónde termina
 * su capacidad de configurar y dónde empieza lo que le prometimos que el agente
 * nunca va a hacer.
 */

export interface AgentView {
  role: 'president' | 'cmo' | 'sales';
  status: string;
  autonomy: string;
  config: Record<string, unknown>;
  permissions: { can: string[]; cannot: string[] };
  objective: { metric: string; target: string; deadline: string };
}

const ROLE_COPY: Record<AgentView['role'], { title: string; subtitle: string }> = {
  president: {
    title: 'PRESIDENT',
    subtitle: 'El estratega. Te propone qué hacer y con qué plata. No ejecuta nunca.',
  },
  cmo: {
    title: 'CMO',
    subtitle: 'La marca y el mensaje. Escribe el copy y los ángulos. No publica ni envía.',
  },
  sales: {
    title: 'SALES',
    subtitle: 'La ejecución. Envía, responde y agenda dentro de lo que le aprobaste.',
  },
};

const AUTONOMY_COPY: { value: string; label: string; hint: string }[] = [
  {
    value: 'propose',
    label: 'Me propone todo',
    hint: 'No hace nada sin que apruebes. El más lento y el más seguro.',
  },
  {
    value: 'approve_each',
    label: 'Agenda solo, el resto me lo pasa',
    hint: 'Puede cerrar una cita sin preguntarte. Cualquier otra cosa te la pasa.',
  },
  {
    value: 'auto_within_limits',
    label: 'Responde y agenda solo',
    hint: 'Contesta lo que sabe contestar. Precio, quejas y dudas siguen escalando a ti.',
  },
];

export function AgentConfigForm({ agent, orgId }: { agent: AgentView; orgId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [config, setConfig] = useState<Record<string, unknown>>(agent.config ?? {});
  const [autonomy, setAutonomy] = useState(agent.autonomy);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await fetch('/api/agents/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: orgId,
          role: agent.role,
          config,
          autonomy,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; config?: Record<string, unknown> };
      if (!res.ok) {
        setError(data.error ?? 'No pudimos guardar.');
        return;
      }
      // El servidor acota los topes: mostramos lo que quedó guardado, no lo que
      // se escribió.
      if (data.config) setConfig(data.config);
      setSaved(true);
      router.refresh();
    });
  }

  const copy = ROLE_COPY[agent.role];

  return (
    <Card className="space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold tracking-[0.02em] text-ink">{copy.title}</h3>
          <p className="mt-1 max-w-md text-[12.5px] leading-snug text-ink-faint">{copy.subtitle}</p>
        </div>
        <Badge tone={agent.status === 'active' ? 'money' : 'muted'}>
          {agent.status === 'active' ? 'Activo' : agent.status === 'draft' ? 'Esperando permiso' : 'En pausa'}
        </Badge>
      </div>

      {/* ── Autonomía: solo SALES ejecuta ─────────────────────────────────── */}
      {agent.role === 'sales' ? (
        <div className="space-y-2 border-t border-line pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Cuánto puede hacer solo
          </p>
          <div className="space-y-1.5">
            {AUTONOMY_COPY.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name={`autonomy-${agent.role}`}
                  checked={autonomy === option.value}
                  onChange={() => setAutonomy(option.value)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-[13.5px] font-medium text-ink">{option.label}</span>
                  <span className="block text-[12.5px] leading-snug text-ink-faint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <p className="border-t border-line pt-4 text-[12.5px] text-ink-faint">
          Este agente nunca ejecuta: razona y propone. No es configurable y es a propósito — el que
          piensa sobre dinero no toca dinero.
        </p>
      )}

      {/* ── Campos por rol ────────────────────────────────────────────────── */}
      <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
        {agent.role === 'president' ? (
          <>
            <NumberField
              label="Hora del resumen diario"
              value={Number(config.briefing_hour ?? 8)}
              onChange={(value) => setConfig({ ...config, briefing_hour: value })}
            />
            <NumberField
              label="Máximo de cosas abiertas antes de callarse"
              value={Number(config.max_open_items ?? 4)}
              onChange={(value) => setConfig({ ...config, max_open_items: value })}
            />
            <ToggleField
              label="Que me proponga envíos"
              checked={Boolean(config.propose_sends ?? true)}
              onChange={(value) => setConfig({ ...config, propose_sends: value })}
            />
          </>
        ) : null}

        {agent.role === 'cmo' ? (
          <>
            <TextField
              label="Cómo suena tu marca"
              value={String(config.tone ?? '')}
              onChange={(value) => setConfig({ ...config, tone: value })}
              placeholder="directo, sin relleno, tuteando"
            />
            <TextField
              label="Lo que nunca decimos (separado por comas)"
              value={(Array.isArray(config.forbidden) ? (config.forbidden as string[]) : []).join(', ')}
              onChange={(value) =>
                setConfig({
                  ...config,
                  forbidden: value.split(',').map((item) => item.trim()).filter(Boolean),
                })
              }
              placeholder="garantía de resultados, descuentos"
            />
          </>
        ) : null}

        {agent.role === 'sales' ? (
          <>
            <ToggleField
              label="Puede agendar solo"
              checked={Boolean(config.auto_book ?? true)}
              onChange={(value) => setConfig({ ...config, auto_book: value })}
            />
            <ToggleField
              label="Puede responder solo"
              checked={Boolean(config.auto_reply ?? false)}
              onChange={(value) => setConfig({ ...config, auto_reply: value })}
            />
            <NumberField
              label="Tope de correos al día"
              value={Number(config.daily_send_cap ?? 300)}
              onChange={(value) => setConfig({ ...config, daily_send_cap: value })}
            />
            <NumberField
              label="No enviar antes de las"
              value={Number((config.send_hours as { from?: number })?.from ?? 8)}
              onChange={(value) =>
                setConfig({
                  ...config,
                  send_hours: { ...(config.send_hours as object), from: value },
                })
              }
            />
            <NumberField
              label="No enviar después de las"
              value={Number((config.send_hours as { to?: number })?.to ?? 18)}
              onChange={(value) =>
                setConfig({ ...config, send_hours: { ...(config.send_hours as object), to: value } })
              }
            />
          </>
        ) : null}
      </div>

      {error ? <p className="text-[13px] text-leak">{error}</p> : null}
      {saved ? <p className="text-[13px] text-money">Guardado.</p> : null}

      <button
        type="button"
        disabled={pending}
        onClick={save}
        className="rounded-xl bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-paper transition hover:bg-money-bright disabled:opacity-40"
      >
        {pending ? 'Guardando…' : 'Guardar'}
      </button>

      {/* ── Lo que no se puede cambiar ────────────────────────────────────── */}
      <div className="space-y-1.5 border-t border-line pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-leak">
          Prohibido · no configurable
        </p>
        <ul className="space-y-1">
          {(agent.permissions?.cannot ?? []).map((rule) => (
            <li key={rule} className="flex gap-2 text-[12.5px] leading-snug text-ink-soft">
              <span className="text-leak">·</span>
              {rule}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

const INPUT =
  'w-full rounded-xl border border-line-strong bg-paper-raised px-3.5 py-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-ink';

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1 sm:col-span-2">
      <span className="text-[12px] text-ink-faint">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-ink-faint">{label}</span>
      <input
        value={value}
        inputMode="numeric"
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className={INPUT}
      />
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 sm:col-span-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="text-[13.5px] text-ink">{label}</span>
    </label>
  );
}
