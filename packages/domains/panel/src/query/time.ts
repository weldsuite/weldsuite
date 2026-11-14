/**
 * Date ranges: presets and custom days turned into a half-open UTC interval
 * `[from, to)`, clamped to the plan's retention (25 months at most), with the
 * timezone's offset for bucketing.
 *
 * Buckets are cut in the spec's timezone by shifting `ts` by one fixed offset
 * (the zone's offset at the end of the range). Across a daylight-saving change
 * inside a long range, buckets before the change are off by one hour.
 */

import type { PanelDateRange, PanelInterval } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { MAX_RETENTION_DAYS, type PanelQueryContext } from './context';
import { PanelQueryError } from './sql';

const DAY_MS = 86_400_000;

export interface TimeBounds {
  from: Date;
  to: Date;
}

export interface ResolvedRange extends TimeBounds {
  timezone: string;
  /** Minutes east of UTC at the end of the range. */
  offsetMinutes: number;
  clampedToRetention: boolean;
  /** The earliest instant any query may read (now minus retention). */
  floor: Date;
  now: Date;
}

export function queryNow(ctx: PanelQueryContext): Date {
  return ctx.now ?? new Date();
}

export function retentionFloor(ctx: PanelQueryContext): Date {
  const days = Math.min(Math.max(Math.floor(ctx.retentionDays), 1), MAX_RETENTION_DAYS);
  return new Date(queryNow(ctx).getTime() - days * DAY_MS);
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new PanelQueryError(`Unknown timezone: ${timezone.slice(0, 64)}`);
  }
}

/** Minutes east of UTC that `timezone` is at `at`. */
export function offsetMinutesAt(timezone: string, at: Date): number {
  if (timezone === 'UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a calendar day (`YYYY-MM-DD`) starts in `timezone`. */
export function dayStart(ymd: string, timezone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  let offset = offsetMinutesAt(timezone, new Date(utc));
  let result = utc - offset * 60_000;
  const second = offsetMinutesAt(timezone, new Date(result));
  if (second !== offset) {
    offset = second;
    result = utc - offset * 60_000;
  }
  return new Date(result);
}

/** `YYYY-MM-DD` of `at` in `timezone`. */
export function localDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const PRESET_DAYS: Record<string, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

/** Resolves a spec's range against the clock, the timezone and the retention floor. Always bounded. */
export function resolveRange(range: PanelDateRange, timezone: string, ctx: PanelQueryContext): ResolvedRange {
  assertTimezone(timezone);
  const now = queryNow(ctx);
  const floor = retentionFloor(ctx);
  const today = localDay(now, timezone);

  let from: Date;
  let to: Date;
  if ('preset' in range) {
    to = now;
    if (range.preset === '12m') {
      const [y, m, d] = today.split('-').map(Number) as [number, number, number];
      from = dayStart(new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10), timezone);
    } else {
      from = dayStart(addDays(today, 1 - (PRESET_DAYS[range.preset] ?? 30)), timezone);
    }
  } else {
    from = dayStart(range.from, timezone);
    to = new Date(Math.min(dayStart(addDays(range.to, 1), timezone).getTime(), now.getTime()));
  }

  let clamped = false;
  if (from.getTime() < floor.getTime()) {
    from = floor;
    clamped = true;
  }
  if (to.getTime() > now.getTime()) to = now;
  if (to.getTime() < from.getTime()) to = from;
  return { from, to, timezone, offsetMinutes: offsetMinutesAt(timezone, to), clampedToRetention: clamped, floor, now };
}

/** The same length ending where `current` starts (for "compare with the previous period"). */
export function previousBounds(current: TimeBounds, floor: Date): TimeBounds {
  const length = Math.max(current.to.getTime() - current.from.getTime(), 1);
  const to = current.from;
  const from = new Date(Math.max(to.getTime() - length, floor.getTime()));
  return { from, to };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/** SQL expression cutting `column` into `interval` buckets in the range's timezone. */
export function bucketSql(column: string, interval: PanelInterval, offsetMinutes: number): string {
  const shifted = offsetMinutes === 0 ? column : `${column} + INTERVAL '${Math.trunc(offsetMinutes)} minutes'`;
  return `date_trunc('${interval}', ${shifted})`;
}

/** Normalises a bucket value from Basin (`2026-11-01T00:00:00`, `2026-11-01 00:00:00`, a Date) to a label. */
export function bucketLabel(value: unknown, interval: PanelInterval): string {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  const day = text.slice(0, 10);
  if (interval === 'hour') return `${day}T${text.slice(11, 13) || '00'}:00`;
  return day;
}

/** Every bucket label from `bounds.from` to `bounds.to`, so empty buckets show as zero. */
export function bucketLabels(bounds: TimeBounds, interval: PanelInterval, offsetMinutes: number): string[] {
  const labels: string[] = [];
  const shift = offsetMinutes * 60_000;
  const start = new Date(bounds.from.getTime() + shift);
  const end = bounds.to.getTime() + shift;
  const cursor = new Date(start.getTime());
  if (interval === 'hour') cursor.setUTCMinutes(0, 0, 0);
  else {
    cursor.setUTCHours(0, 0, 0, 0);
    if (interval === 'week') cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
    if (interval === 'month') cursor.setUTCDate(1);
  }
  for (let guard = 0; cursor.getTime() < Math.max(end, start.getTime() + 1) && guard < 5000; guard += 1) {
    labels.push(bucketLabel(cursor.toISOString(), interval));
    if (interval === 'hour') cursor.setUTCHours(cursor.getUTCHours() + 1);
    else if (interval === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (interval === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return labels;
}
