/**
 * Routine schedules in words: "Weekdays at 07:00" instead of "0 7 * * 1-5".
 */

export interface ScheduleLabels {
  hourly: string;
  daily: string;
  weekdays: string;
  weekly: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Weekday name for cron day 0-6 (Sunday = 0) in the user's language. */
function dayName(day: number, locale?: string): string {
  // 2026-10-11 is a Sunday.
  const date = new Date(Date.UTC(2026, 9, 11 + day, 12));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date);
}

/**
 * Describe a five-field cron in words, or return it unchanged when it is not
 * one of the common shapes (hourly, daily, weekdays, one weekday).
 */
export function describeCron(cron: string | null | undefined, labels: ScheduleLabels, locale?: string): string {
  if (!cron) return '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*') return cron;
  if (/^\d+$/.test(minute) && hour === '*' && dow === '*') return labels.hourly;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return cron;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dow === '*') return labels.daily.replace('{time}', time);
  if (dow === '1-5') return labels.weekdays.replace('{time}', time);
  if (/^[0-6]$/.test(dow)) {
    return labels.weekly.replace('{day}', dayName(Number(dow), locale)).replace('{time}', time);
  }
  return cron;
}

/** "Thu 16 Oct, 07:00" in the routine's own timezone. */
export function formatNextRun(iso: string | null | undefined, timezone?: string | null, locale?: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone || undefined,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString(locale);
  }
}

/** The browser's IANA timezone, e.g. "Europe/Amsterdam". */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
