/**
 * Date helpers shared by WeldCalendar screens.
 *
 * app-api returns ISO timestamps. Everything here works in DEVICE-LOCAL time,
 * which is what the platform does too: the web event dialog builds an all-day
 * event as `new Date(\`${date}T00:00:00\`)` (local midnight) and the grid reads
 * it back with `getHours()`, so an event lands on the same calendar square on
 * both surfaces as long as neither side reaches for UTC components.
 *
 * Formatters tolerate empty/malformed values by returning an em dash so a bad
 * row never crashes a list.
 */

const DASH = '—';

/** Monday-first, matching the platform grid and European conventions. */
export const WEEK_STARTS_ON = 1;

export function parse(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Formatting ───────────────────────────────────────────────────────────

/** "5 Aug 2026" */
export function formatDate(value: string | Date | null | undefined, locale = 'en-GB'): string {
  const date = parse(value);
  if (!date) return DASH;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "5 Aug" — for dense rows where the year is implied. */
export function formatShortDate(value: string | Date | null | undefined, locale = 'en-GB'): string {
  const date = parse(value);
  if (!date) return DASH;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** "Wed 5 Aug" */
export function formatWeekdayDate(
  value: string | Date | null | undefined,
  locale = 'en-GB',
): string {
  const date = parse(value);
  if (!date) return DASH;
  return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "09:00" */
export function formatTime(value: string | Date | null | undefined, locale = 'en-GB'): string {
  const date = parse(value);
  if (!date) return DASH;
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** "August 2026" — month-grid header. */
export function formatMonthYear(value: Date, locale = 'en-GB'): string {
  return value.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

/**
 * The time line on an event row: "09:00 – 10:30", "09:00" when there is no
 * end, or the caller's all-day label. Multi-day ranges get the end date too.
 */
export function formatEventTimeRange(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
  options: { allDay?: boolean | null; allDayLabel: string; locale?: string },
): string {
  const locale = options.locale ?? 'en-GB';
  const startDate = parse(start);
  if (!startDate) return DASH;
  const endDate = parse(end);

  if (options.allDay) {
    if (endDate && !isSameDay(startDate, endDate)) {
      return `${options.allDayLabel} · ${formatShortDate(startDate, locale)} – ${formatShortDate(endDate, locale)}`;
    }
    return options.allDayLabel;
  }

  if (!endDate) return formatTime(startDate, locale);
  if (isSameDay(startDate, endDate)) {
    return `${formatTime(startDate, locale)} – ${formatTime(endDate, locale)}`;
  }
  return `${formatShortDate(startDate, locale)} ${formatTime(startDate, locale)} – ${formatShortDate(endDate, locale)} ${formatTime(endDate, locale)}`;
}

/** "1h 30m" / "45m" / "2h". Empty string when there is no measurable span. */
export function formatDuration(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
): string {
  const s = parse(start);
  const e = parse(end);
  if (!s || !e) return '';
  const minutes = Math.round((e.getTime() - s.getTime()) / 60000);
  if (minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

// ── Comparison & arithmetic ──────────────────────────────────────────────

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export function isToday(value: string | Date | null | undefined): boolean {
  const date = parse(value);
  return date ? isSameDay(date, new Date()) : false;
}

export function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function endOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Month arithmetic that never rolls over: adding a month to 31 Jan yields
 * 28/29 Feb, not 2/3 March. `setDate(1)` first, then clamp.
 */
export function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), lastDay));
  next.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return next;
}

/** Local `YYYY-MM-DD` — the key events are bucketed under. */
export function dayKey(value: string | Date | null | undefined): string {
  const date = parse(value);
  if (!date) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// ── Month grid ───────────────────────────────────────────────────────────

/**
 * Six Monday-first weeks covering `month`. Always 42 cells so the grid's
 * height never changes between months — a jumping grid under a fixed header
 * reads as a glitch on a phone.
 */
export function buildMonthMatrix(month: Date): Date[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // getDay() is Sunday-0; shift so Monday is 0.
  const leading = (first.getDay() - WEEK_STARTS_ON + 7) % 7;
  const gridStart = addDays(first, -leading);

  const weeks: Date[][] = [];
  for (let week = 0; week < 6; week++) {
    const days: Date[] = [];
    for (let day = 0; day < 7; day++) {
      days.push(startOfDay(addDays(gridStart, week * 7 + day)));
    }
    weeks.push(days);
  }
  return weeks;
}

/** Localised Mon…Sun initials for the grid header. */
export function weekdayInitials(locale = 'en-GB'): string[] {
  // 2024-01-01 was a Monday.
  const monday = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, i) =>
    addDays(monday, i).toLocaleDateString(locale, { weekday: 'narrow' }),
  );
}

// ── Relative labels ──────────────────────────────────────────────────────

export interface RelativeDayLabels {
  today: string;
  tomorrow: string;
  yesterday: string;
}

/**
 * "Today" / "Tomorrow" / "Yesterday", falling back to "Wed 5 Aug" (or the
 * full date once the year differs) so an agenda heading is never ambiguous.
 */
export function relativeDayLabel(
  value: string | Date | null | undefined,
  labels: RelativeDayLabels,
  locale = 'en-GB',
): string {
  const date = parse(value);
  if (!date) return DASH;
  const now = new Date();
  if (isSameDay(date, now)) return labels.today;
  if (isSameDay(date, addDays(now, 1))) return labels.tomorrow;
  if (isSameDay(date, addDays(now, -1))) return labels.yesterday;
  if (date.getFullYear() !== now.getFullYear()) {
    return date.toLocaleDateString(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  return formatWeekdayDate(date, locale);
}

/** True once an event's end (or start, when open-ended) is in the past. */
export function isPastEvent(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
): boolean {
  const reference = parse(end) ?? parse(start);
  if (!reference) return false;
  return reference.getTime() < Date.now();
}

/**
 * True while an event is running right now. Open-ended events count as live
 * for an hour after their start, matching how the platform grid draws them.
 */
export function isOngoing(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
): boolean {
  const s = parse(start);
  if (!s) return false;
  const e = parse(end) ?? new Date(s.getTime() + 60 * 60 * 1000);
  const now = Date.now();
  return s.getTime() <= now && now <= e.getTime();
}

// ── Grouping ─────────────────────────────────────────────────────────────

/**
 * The rows are called `data` rather than `items` so the result drops straight
 * into a React Native `SectionList`, which requires that exact key.
 */
export interface DaySection<T> {
  /** Local `YYYY-MM-DD`. */
  key: string;
  date: Date;
  data: T[];
}

/**
 * Bucket events into day sections, ordered by day and then by start time.
 * Multi-day events appear under their START day only — an agenda that
 * repeated a week-long event on seven headings would bury everything else.
 */
export function groupByDay<T>(items: T[], getStart: (item: T) => string | null): DaySection<T>[] {
  const buckets = new Map<string, DaySection<T>>();

  for (const item of items) {
    const start = parse(getStart(item));
    if (!start) continue;
    const key = dayKey(start);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.data.push(item);
    } else {
      buckets.set(key, { key, date: startOfDay(start), data: [item] });
    }
  }

  const sections = Array.from(buckets.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  for (const section of sections) {
    section.data.sort((a, b) => {
      const left = parse(getStart(a))?.getTime() ?? 0;
      const right = parse(getStart(b))?.getTime() ?? 0;
      return left - right;
    });
  }
  return sections;
}
