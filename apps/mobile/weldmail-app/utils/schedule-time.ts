/**
 * Pure time logic for WeldMail's "Send later" / "Schedule send" flows.
 *
 * Kept out of the screen so the window rules are unit-testable — app-api
 * rejects anything outside them (`SCHEDULE_IN_PAST` / `SCHEDULE_TOO_FAR` in
 * apps/workers/app-api/src/services/mail/scheduled.ts), so enforcing the same bounds
 * here turns a 400 into a disabled button.
 */

/** Mirrors MAX_SCHEDULE_DAYS in apps/workers/app-api/src/services/mail/scheduled.ts. */
export const MAX_SCHEDULE_DAYS = 7;

export type SendTimeIcon = 'clock' | 'sun' | 'coffee' | 'calendar';

export interface SendTimePreset {
  key: string;
  label: string;
  /** Secondary line, e.g. "Tomorrow, 09:00". */
  description: string;
  icon: SendTimeIcon;
  date: Date;
}

export function formatClock(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export function scheduleWindowBounds(now: Date): { min: Date; max: Date } {
  return {
    min: now,
    max: new Date(now.getTime() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000),
  };
}

/** Server-side rule, client-side: strictly future, at most MAX_SCHEDULE_DAYS out. */
export function isWithinScheduleWindow(date: Date, now: Date): boolean {
  const { min, max } = scheduleWindowBounds(now);
  return date > min && date <= max;
}

function atTime(base: Date, dayOffset: number, hours: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, 0, 0, 0);
  return d;
}

/**
 * The quick options offered before the full date/time picker. Same four the
 * ActionSheet/Alert offered, plus descriptions for the themed sheet. Any preset
 * that falls outside the schedule window is dropped rather than shown and then
 * rejected by the server.
 */
export function buildSendTimePresets(now: Date): SendTimePreset[] {
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const tomorrowMorning = atTime(now, 1, 9);
  const tomorrowAfternoon = atTime(now, 1, 14);

  const presets: SendTimePreset[] = [
    { key: 'in-1h', label: 'In 1 hour', description: formatClock(inOneHour), icon: 'clock', date: inOneHour },
    { key: 'in-2h', label: 'In 2 hours', description: formatClock(inTwoHours), icon: 'clock', date: inTwoHours },
    {
      key: 'tomorrow-am',
      label: 'Tomorrow morning',
      description: `Tomorrow, ${formatClock(tomorrowMorning)}`,
      icon: 'coffee',
      date: tomorrowMorning,
    },
    {
      key: 'tomorrow-pm',
      label: 'Tomorrow afternoon',
      description: `Tomorrow, ${formatClock(tomorrowAfternoon)}`,
      icon: 'sun',
      date: tomorrowAfternoon,
    },
  ];

  return presets.filter((p) => isWithinScheduleWindow(p.date, now));
}

/**
 * Step the hour/minute of `date`, wrapping within the day. Wrapping (rather
 * than rolling the date) keeps the calendar selection above the time control
 * authoritative — changing the time never silently moves the chosen day.
 */
export function stepTime(
  date: Date,
  unit: 'hour' | 'minute',
  delta: number,
  minuteInterval = 5,
): Date {
  const next = new Date(date);
  if (unit === 'hour') {
    next.setHours((next.getHours() + delta + 24) % 24);
    return next;
  }
  const steps = Math.round(60 / minuteInterval);
  const current = Math.round(next.getMinutes() / minuteInterval);
  next.setMinutes((((current + delta) % steps) + steps) % steps * minuteInterval, 0, 0);
  return next;
}

/** Merge a day (from the calendar) with an hour/minute (from the time control). */
export function combineDateAndTime(day: Date, time: Date): Date {
  const out = new Date(day);
  out.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return out;
}
