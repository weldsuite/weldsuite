/**
 * Cron matching + next-run computation for WeldConnect workflow schedules.
 *
 * Standard 5-field cron: `minute hour day-of-month month day-of-week`.
 * Timezone-aware via `Intl.DateTimeFormat`. Pure — no I/O, no `Date.now()` reads
 * except the caller-supplied `from`/`at` — so it is unit-testable in isolation.
 *
 * Field syntax supported: `*`, `*​/n` step, `a,b,c` lists, `a-b` ranges (and
 * combinations via lists). This mirrors the matcher that previously lived inline
 * in `cron/schedule-sweep.ts`; the sweep now delegates here and additionally
 * uses `computeNextRunAt` to precompute the D1 schedule index's `next_run_at`.
 */

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// A cron that fires only once a year still resolves within this horizon; caps
// the minute-stepping loop so an unsatisfiable expression can't spin forever.
const LOOKAHEAD_LIMIT_MINUTES = 366 * 24 * 60;

const MINUTE_MS = 60_000;

interface CronParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hour12: false,
  });
}

function partsFrom(formatter: Intl.DateTimeFormat, date: Date): CronParts {
  const parts = formatter.formatToParts(date);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };
  const weekdayPart = parts.find((p) => p.type === 'weekday');
  return {
    minute: get('minute'),
    hour: get('hour') % 24,
    dayOfMonth: get('day'),
    month: get('month'),
    dayOfWeek: weekdayPart ? (WEEKDAY_MAP[weekdayPart.value] ?? 0) : 0,
  };
}

function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  for (const token of field.split(',')) {
    if (token.includes('-')) {
      const [start, end] = token.split('-').map(Number);
      if (Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end) return true;
    } else if (parseInt(token, 10) === value) {
      return true;
    }
  }
  return false;
}

function matchesWithFormatter(fields: string[], formatter: Intl.DateTimeFormat, at: Date): boolean {
  const p = partsFrom(formatter, at);
  return (
    matchField(fields[0], p.minute) &&
    matchField(fields[1], p.hour) &&
    matchField(fields[2], p.dayOfMonth) &&
    matchField(fields[3], p.month) &&
    matchField(fields[4], p.dayOfWeek)
  );
}

/**
 * Does `cronExpression` fire at the exact minute of `at`, in `timezone`?
 * Returns false on a malformed expression or invalid timezone (never throws).
 */
export function cronMatchesAt(cronExpression: string, timezone: string, at: Date): boolean {
  try {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length < 5) return false;
    return matchesWithFormatter(fields, makeFormatter(timezone || 'UTC'), at);
  } catch {
    return false;
  }
}

/** Back-compat helper: does the cron fire at the current minute? */
export function cronMatchesNow(cronExpression: string, timezone: string, now: Date = new Date()): boolean {
  return cronMatchesAt(cronExpression, timezone, now);
}

/**
 * The next instant strictly after `from` at which this cron fires, clamped to
 * `[startDate, endDate]`. Steps minute-by-minute (cron granularity is one
 * minute) up to a ~1-year horizon, reusing a single formatter so even a
 * once-a-year expression resolves cheaply.
 *
 * Returns `null` when the expression is malformed, the timezone is invalid, the
 * schedule's `endDate` has already passed, or no occurrence exists within the
 * horizon — the caller treats `null` as "no future run" and disables the row.
 */
export function computeNextRunAt(
  cronExpression: string,
  timezone: string,
  from: Date,
  bounds?: { startDate?: Date | null; endDate?: Date | null },
): Date | null {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length < 5) return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = makeFormatter(timezone || 'UTC');
  } catch {
    return null;
  }

  const end = bounds?.endDate ?? null;
  const start = bounds?.startDate ?? null;

  // Begin at the whole minute following the later of `from` and `startDate`,
  // guaranteeing the result is strictly in the future (never re-fires `from`'s
  // own minute).
  const floorBase = Math.max(from.getTime(), start ? start.getTime() : 0);
  let candidate = new Date(Math.floor(floorBase / MINUTE_MS) * MINUTE_MS + MINUTE_MS);

  for (let i = 0; i < LOOKAHEAD_LIMIT_MINUTES; i++) {
    if (end && candidate.getTime() > end.getTime()) return null;
    if (matchesWithFormatter(fields, formatter, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + MINUTE_MS);
  }
  return null;
}
