/**
 * Cron validation + next-run preview for the schedule trigger panel.
 *
 * The grammar is the one the schedule sweep's matcher understands: per field
 * a star, a star-slash-n step, or a comma list of numbers and a-b ranges. Keep it
 * in sync with `isValidCronExpression` in
 * apps/workers/connect-api/src/services/weldconnect-mvp.ts (the activation
 * gate) and the matcher in packages/core/workflow-integrations/src/cron.ts:
 * anything accepted here but not there would be saved and then never fire.
 */

const CRON_FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function isValidCronField(field: string, [min, max]: [number, number]): boolean {
  if (field === '*') return true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= max;
  }
  return field.split(',').every((token) => {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      return a >= min && b <= max && a <= b;
    }
    if (!/^\d+$/.test(token)) return false;
    const n = Number(token);
    return n >= min && n <= max;
  });
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => isValidCronField(field, CRON_FIELD_BOUNDS[i]));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MINUTE_MS = 60_000;
// A once-a-year expression still resolves inside this horizon.
const LOOKAHEAD_MINUTES = 366 * 24 * 60;

function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) return value % Number(field.slice(2)) === 0;
  return field.split(',').some((token) => {
    const [start, end] = token.split('-').map(Number);
    return end === undefined ? start === value : value >= start && value <= end;
  });
}

/**
 * The next minute strictly after `from` at which the expression fires in
 * `timezone`, or null when it is invalid or never fires within a year.
 */
export function nextCronRun(expression: string, timezone: string, from: Date): Date | null {
  if (!isValidCronExpression(expression)) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      minute: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
      hour12: false,
    });
  } catch {
    return null;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);

  // Local midnights and hour changes always fall on a UTC quarter hour (every
  // UTC offset is a multiple of 15 minutes), so a candidate whose date or hour
  // does not match can skip to the next quarter instead of stepping per minute.
  const QUARTER_MS = 15 * MINUTE_MS;
  let candidate = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const horizon = candidate + LOOKAHEAD_MINUTES * MINUTE_MS;
  while (candidate < horizon) {
    const parts = formatter.formatToParts(new Date(candidate));
    const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
    const dateAndHourMatch =
      matchField(hour, num('hour') % 24) &&
      matchField(dayOfMonth, num('day')) &&
      matchField(month, num('month')) &&
      matchField(dayOfWeek, weekday);
    if (!dateAndHourMatch) {
      candidate = Math.floor(candidate / QUARTER_MS) * QUARTER_MS + QUARTER_MS;
      continue;
    }
    if (matchField(minute, num('minute'))) return new Date(candidate);
    candidate += MINUTE_MS;
  }
  return null;
}
