/** Small formatting helpers shared by the WeldMerge pages. */

/** Fills `{name}` placeholders in a translated string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * "12 minutes ago" in the given locale; `justNow` under a minute. Dates in the
 * future (clock skew) also read as just now.
 */
export function relativeTime(iso: string, locale: string, justNow: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return justNow;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
  }
  return justNow;
}

/** `Nov 3 – Nov 16` for two `YYYY-MM-DD` dates. */
export function formatDateRange(startsAt: string, endsAt: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${format.format(new Date(`${startsAt}T00:00:00Z`))} – ${format.format(new Date(`${endsAt}T00:00:00Z`))}`;
}

export type CycleState = 'upcoming' | 'current' | 'past';

/** Where a cycle stands on `today` (all `YYYY-MM-DD`). */
export function cycleState(startsAt: string, endsAt: string, today: string): CycleState {
  if (today < startsAt) return 'upcoming';
  if (today > endsAt) return 'past';
  return 'current';
}

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Up to two initials of a name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}
