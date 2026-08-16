import type { Benchmarks, Playbook } from '@/config/campaigns';
import { creditsForCampaign, creditsToUsd } from '@/config/credits';

/**
 * La aritmética de una campaña: qué esperamos, cuánto cuesta, cuándo lo
 * miramos y qué disparó una iteración.
 *
 * MISMA REGLA QUE lib/diagnostic/math.ts: este archivo NO importa nada de
 * servidor. Corre igual en el navegador, porque el cliente puede mover el
 * tamaño de la audiencia en la propuesta y ver el número recalcularse en vivo.
 * Un número que solo existe en el servidor es un número que el cliente no
 * puede interrogar.
 *
 * Y la regla de ADR 0007: ninguna de estas cifras sale de un modelo. El
 * President las lee y las redacta; este archivo las calcula.
 */

export interface FunnelStep {
  label: string;
  value: number;
  formula: string;
}

export interface CampaignProjection {
  audience: number;
  sends: number;
  delivered: number;
  opens: number;
  replies: number;
  positive: number;
  bookings: number;
  closes: number;
  revenue_usd: number;
  credits: number;
  credits_usd: number;
  /** Costo por cita agendada. La métrica que decide si esto escala. */
  cost_per_booking_credits: number;
  /** Retorno esperado: ingreso ÷ costo. <1 significa que no vale la pena. */
  roi: number;
  steps: FunnelStep[];
  /** Rango honesto alrededor del central. La banda baja es la que prometemos. */
  range: { low: number; high: number };
}

export function projectCampaign(args: {
  audience: number;
  steps: number;
  benchmarks: Benchmarks;
  avgTicketUsd: number;
}): CampaignProjection {
  const b = args.benchmarks;
  const audience = Math.max(0, Math.round(args.audience));

  // Los envíos totales no son audiencia × pasos: quien responde sale de la
  // secuencia. Se modela igual que en config/credits.ts para que la proyección
  // y el costo hablen del mismo envío.
  let alive = audience;
  let sends = 0;
  for (let i = 0; i < args.steps; i += 1) {
    sends += alive;
    alive = Math.round(alive * (1 - b.reply_rate));
  }

  const delivered = audience * b.deliverability;
  const opens = delivered * b.open_rate;
  const replies = delivered * b.reply_rate;
  const positive = replies * b.positive_share;
  const bookings = positive * b.booking_from_positive;
  const closes = bookings * b.close_from_booking;
  const revenue = closes * args.avgTicketUsd;

  const credits = creditsForCampaign({
    audience,
    steps: args.steps,
    expectedReplyRate: b.reply_rate,
  });

  const steps: FunnelStep[] = [
    {
      label: 'Correos a enviar',
      value: Math.round(sends),
      formula: `${fmt(audience)} contactos en ${args.steps} pasos, descontando a los que responden`,
    },
    {
      label: 'Entregados',
      value: Math.round(delivered),
      formula: `${fmt(audience)} × ${pct(b.deliverability)} de entregabilidad`,
    },
    {
      label: 'Aperturas',
      value: Math.round(opens),
      formula: `${fmt(delivered)} entregados × ${pct(b.open_rate)} de apertura`,
    },
    {
      label: 'Respuestas',
      value: Math.round(replies),
      formula: `${fmt(delivered)} entregados × ${pct(b.reply_rate)} de respuesta`,
    },
    {
      label: 'Respuestas útiles',
      value: Math.round(positive),
      formula: `${fmt(replies)} respuestas × ${pct(b.positive_share)} con intención real`,
    },
    {
      label: 'Citas agendadas',
      value: Math.round(bookings),
      formula: `${fmt(positive)} útiles × ${pct(b.booking_from_positive)} que agendan`,
    },
    {
      label: 'Cierres esperados',
      value: Math.round(closes),
      formula: `${fmt(bookings)} citas × ${pct(b.close_from_booking)} de cierre`,
    },
  ];

  const creditsUsd = creditsToUsd(credits);

  return {
    audience,
    sends: Math.round(sends),
    delivered: Math.round(delivered),
    opens: Math.round(opens),
    replies: Math.round(replies),
    positive: Math.round(positive),
    bookings: Math.round(bookings),
    closes: Math.round(closes),
    revenue_usd: Math.round(revenue),
    credits,
    credits_usd: creditsUsd,
    cost_per_booking_credits: bookings > 0 ? Math.round(credits / bookings) : 0,
    roi: creditsUsd > 0 ? Math.round((revenue / creditsUsd) * 10) / 10 : 0,
    steps,
    // ±40% sobre el central. No es estadística: es honestidad sobre que un
    // benchmark de industria aplicado a un negocio concreto tiene esa varianza.
    // Prometemos la banda baja y celebramos la alta.
    range: { low: Math.floor(closes * 0.6), high: Math.ceil(closes * 1.4) },
  };
}

/** Los checkpoints con fecha real, no "día 4". Igual que los roadmaps de las
 *  rutas: una fecha se puede poner en el calendario, un "día 4" no. */
export function measurementSchedule(
  playbook: Playbook,
  startsAt: Date,
): { kpi: string; formula: string; date: string; iso: string }[] {
  return playbook.measurement.map((point) => {
    const date = new Date(startsAt);
    date.setDate(date.getDate() + point.checkpoint_days);
    return {
      kpi: point.kpi,
      formula: point.formula,
      date: date.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }),
      iso: date.toISOString(),
    };
  });
}

export interface Actuals {
  sent: number;
  delivered: number;
  bounced: number;
  opened: number;
  replied: number;
  positive: number;
  booked: number;
  complaints: number;
  days_running: number;
}

export interface IterationVerdict {
  rule: string;
  action: string;
  fired: boolean;
  auto_pause: boolean;
  /** El número concreto que hizo que disparara. Sin esto, "la campaña se pausó
   *  sola" es magia; con esto, es una decisión revisable. */
  observed: string;
}

/**
 * Evalúa las reglas de iteración contra lo que realmente pasó.
 *
 * Los `trigger` del playbook están escritos en español para que el cliente los
 * lea; la evaluación vive acá, emparejada por la clave del playbook. Si se
 * agrega una regla al playbook sin agregarla acá, se muestra pero no dispara:
 * por eso la función devuelve TODAS las reglas, disparadas o no, y la UI
 * muestra el estado de cada una.
 */
export function evaluateIteration(playbook: Playbook, a: Actuals): IterationVerdict[] {
  const bounceRate = a.sent > 0 ? a.bounced / a.sent : 0;
  const deliverability = a.sent > 0 ? a.delivered / a.sent : 1;
  const replyRate = a.delivered > 0 ? a.replied / a.delivered : 0;
  const openRate = a.delivered > 0 ? a.opened / a.delivered : 0;
  const positiveRate = a.delivered > 0 ? a.positive / a.delivered : 0;

  return playbook.iteration.map((rule) => {
    let fired = false;
    let observed = 'sin datos suficientes';

    if (rule.trigger.includes('rebote')) {
      fired = a.sent >= 200 && bounceRate > 0.03;
      observed = `rebote ${pct(bounceRate)} sobre ${fmt(a.sent)} envíos`;
    } else if (rule.trigger.includes('Entregabilidad') || rule.trigger.includes('entregabilidad')) {
      fired = a.sent >= 100 && deliverability < 0.9;
      observed = `entregabilidad ${pct(deliverability)}`;
    } else if (rule.trigger.includes('respuesta <')) {
      const threshold = rule.trigger.includes('1%') ? 0.01 : rule.trigger.includes('2%') ? 0.02 : 0.05;
      const minDays = rule.trigger.includes('día 3') ? 3 : rule.trigger.includes('día 4') ? 4 : 0;
      const minSends = rule.trigger.includes('300 envíos') ? 300 : 0;
      fired =
        a.days_running >= minDays && a.sent >= minSends && a.delivered > 0 && replyRate < threshold;
      observed = `respuesta ${pct(replyRate)} al día ${a.days_running}`;
    } else if (rule.trigger.includes('positivas >')) {
      fired = positiveRate > 0.08;
      observed = `positivas ${pct(positiveRate)}`;
    } else if (rule.trigger.includes('quejas')) {
      fired = a.complaints > 2;
      observed = `${a.complaints} quejas`;
    } else if (rule.trigger.includes('apertura <')) {
      fired = a.delivered >= 100 && openRate < 0.25;
      observed = `apertura ${pct(openRate)}`;
    } else if (rule.trigger.includes('clics >')) {
      // Los clics se miden por asset_events; se pasan en `positive` cuando la
      // campaña es de lanzamiento y el activo es el checkout.
      fired = positiveRate > 0.08;
      observed = `interacción ${pct(positiveRate)}`;
    }

    return { rule: rule.trigger, action: rule.action, fired, auto_pause: rule.auto_pause, observed };
  });
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function fmt(value: number): string {
  return new Intl.NumberFormat('es-CO').format(Math.round(value));
}
