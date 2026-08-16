/**
 * El agendador: cálculo de horarios disponibles.
 *
 * MISMA REGLA QUE lib/diagnostic/math.ts y lib/campaigns/math.ts: este archivo
 * no importa NADA de servidor. Corre en el navegador de quien está agendando,
 * que es lo que hace que cambiar de zona horaria en el selector reordene los
 * horarios sin ida y vuelta al servidor.
 *
 * Zonas horarias sin librería: usamos `Intl` para sacar el desfase real de la
 * zona en una fecha concreta. Es la única forma de que "9 de la mañana en
 * Bogotá" siga siendo 9 de la mañana cuando el que agenda está en Madrid, y de
 * que no se rompa en un cambio de horario de verano.
 */

export interface SchedulerConfig {
  duration_min: number;
  buffer_min: number;
  timezone: string;
  /** 0 = domingo … 6 = sábado. */
  working_days: number[];
  start_hour: number;
  end_hour: number;
  min_notice_hours: number;
  max_days_ahead: number;
}

export interface Busy {
  starts_at: string;
  ends_at: string;
}

export interface Slot {
  /** ISO en UTC. Es lo que se guarda. */
  start: string;
  end: string;
  /** Etiqueta ya formateada en la zona de quien mira. */
  label: string;
}

export interface DayWithSlots {
  /** YYYY-MM-DD en la zona del anfitrión. */
  date: string;
  label: string;
  slots: Slot[];
}

/** Desfase de una zona horaria en minutos, para una fecha concreta. */
function offsetMinutes(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Convierte una hora de pared en una zona ("el 3 de marzo a las 9:00 en
 * Bogotá") al instante UTC que le corresponde. Dos pasadas porque el desfase
 * depende del instante y el instante depende del desfase: la segunda corrige
 * el caso del cambio de horario.
 */
export function zonedTimeToUtc(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  let guess = new Date(naive - offsetMinutes(timeZone, new Date(naive)) * 60_000);
  guess = new Date(naive - offsetMinutes(timeZone, guess) * 60_000);
  return guess;
}

/** Partes de calendario de un instante, en una zona. */
function partsIn(timeZone: string, date: Date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) parts[part.type] = part.value;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: Math.max(0, weekdays.indexOf(parts.weekday)),
  };
}

export function availableSlots(args: {
  config: SchedulerConfig;
  busy: Busy[];
  now?: Date;
  /** Zona en la que se muestran las etiquetas. Por defecto, la del anfitrión. */
  viewerTimezone?: string;
}): DayWithSlots[] {
  const { config } = args;
  const now = args.now ?? new Date();
  const viewerTz = args.viewerTimezone || config.timezone;

  const earliest = new Date(now.getTime() + config.min_notice_hours * 3_600_000);
  const step = config.duration_min + config.buffer_min;
  if (step <= 0) return [];

  const busyRanges = args.busy.map((b) => ({
    start: new Date(b.starts_at).getTime(),
    end: new Date(b.ends_at).getTime(),
  }));

  const days: DayWithSlots[] = [];

  for (let offset = 0; offset <= config.max_days_ahead; offset += 1) {
    const probe = new Date(now.getTime() + offset * 86_400_000);
    const { year, month, day, weekday } = partsIn(config.timezone, probe);
    if (!config.working_days.includes(weekday)) continue;

    const slots: Slot[] = [];
    for (
      let minutes = config.start_hour * 60;
      minutes + config.duration_min <= config.end_hour * 60;
      minutes += step
    ) {
      const start = zonedTimeToUtc(
        config.timezone,
        year,
        month,
        day,
        Math.floor(minutes / 60),
        minutes % 60,
      );
      const end = new Date(start.getTime() + config.duration_min * 60_000);

      if (start.getTime() < earliest.getTime()) continue;

      const overlaps = busyRanges.some(
        (range) => start.getTime() < range.end && end.getTime() > range.start,
      );
      if (overlaps) continue;

      slots.push({
        start: start.toISOString(),
        end: end.toISOString(),
        label: new Intl.DateTimeFormat('es-CO', {
          timeZone: viewerTz,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(start),
      });
    }

    if (slots.length === 0) continue;

    days.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      label: new Intl.DateTimeFormat('es-CO', {
        timeZone: viewerTz,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date(slots[0].start)),
      slots,
    });

    // Diez días con cupo alcanzan y sobran. Mostrar tres semanas de horarios
    // vacíos hace que el agendador se sienta abandonado.
    if (days.length >= 10) break;
  }

  return days;
}

/** ¿El horario que mandó el que agenda sigue siendo válido? Se revalida en el
 *  servidor: la lista de horarios que él vio puede tener minutos de vieja y
 *  alguien más pudo tomar el cupo. */
export function isSlotValid(args: {
  config: SchedulerConfig;
  busy: Busy[];
  start: string;
  now?: Date;
}): { ok: boolean; reason?: string } {
  const start = new Date(args.start);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: 'Horario inválido.' };

  const days = availableSlots({ config: args.config, busy: args.busy, now: args.now });
  const exists = days.some((day) => day.slots.some((slot) => slot.start === start.toISOString()));

  return exists
    ? { ok: true }
    : { ok: false, reason: 'Ese horario ya no está disponible. Escoge otro.' };
}

export function formatSlotRange(startIso: string, endIso: string, timeZone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const date = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(start);
  const time = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatRange(start, end);
  return `${date}, ${time}`;
}
