/**
 * When alerts, scheduled reports and raw exports run, and the master
 * `panel_schedule_registry` that tells panel-api's cron which are due across
 * workspaces without opening every tenant database (the DATA-009 pattern).
 *
 * The tenant row stays the source of truth. Every create, update and delete of
 * an alert, subscription or export writes its registry row here
 * ({@link upsertSchedule} / {@link deleteSchedule}); the cron claims due rows
 * with a lock ({@link claimDue}), runs them, and writes the next run
 * ({@link releaseSchedule}).
 *
 * Times are computed in the object's timezone from Intl, so a daylight-saving
 * change moves a 09:00 report with the clock, not with UTC.
 */

import { and, asc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelScheduleKind, PanelScheduleRegistryRow } from '@weldsuite/db/schema/master';
import type { PanelCheckInterval, PanelExportFrequency, PanelSubscriptionSchedule } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';

const { panelScheduleRegistry } = masterSchema;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a claimed row stays locked: a run that dies leaves it to the next cron after this. */
export const LOCK_MS = 10 * MINUTE;
/** Most rows one cron invocation claims. */
export const MAX_CLAIM = 50;

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock time `at` shows in `timeZone`. */
export function localParts(at: Date, timeZone: string): LocalParts & { second: number } {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Minutes east of UTC that `timeZone` is at `at`. */
export function offsetMinutes(timeZone: string, at: Date): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE);
}

/**
 * The instant the wall clock in `timeZone` shows `hour`:00 on `date`. An hour
 * that does not exist (the spring-forward gap) lands just after the gap; an
 * hour that happens twice (fall back) is its first occurrence. `hour` may
 * overflow into the next day (24 → 00:00 the day after).
 */
export function zonedInstant(date: LocalDate, hour: number, timeZone: string): Date {
  const utc = Date.UTC(date.year, date.month - 1, date.day, hour);
  let offset = offsetMinutes(timeZone, new Date(utc));
  let result = utc - offset * MINUTE;
  const second = offsetMinutes(timeZone, new Date(result));
  if (second !== offset) {
    offset = second;
    result = utc - offset * MINUTE;
  }
  // Fall back: the earlier of the two instants that show this wall time.
  const earlier = result - HOUR;
  const p = localParts(new Date(earlier), timeZone);
  const want = new Date(utc);
  if (p.hour === want.getUTCHours() && p.day === want.getUTCDate() && p.month === want.getUTCMonth() + 1) result = earlier;
  return new Date(result);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function formatLocalDate(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Next runs
// ---------------------------------------------------------------------------

/** The first time after `after` that the schedule says a report goes out. */
export function nextSubscriptionRun(schedule: PanelSubscriptionSchedule, after: Date): Date {
  const tz = schedule.timezone || 'UTC';
  const today = localParts(after, tz);
  for (let i = 0; i <= 62; i += 1) {
    const date = addDays(today, i);
    if (schedule.frequency === 'weekly' && weekdayOf(date) !== schedule.weekday) continue;
    if (schedule.frequency === 'monthly' && date.day !== schedule.monthDay) continue;
    const at = zonedInstant(date, schedule.hour, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  // Unreachable with a valid schedule (a monthly day 1–28 comes round within 62 days).
  return new Date(after.getTime() + DAY);
}

/** Wait after an interval ends before checking it: Basin is a minute or two behind, the query cache two more. */
export const ALERT_LAG_MS: Record<PanelCheckInterval, number> = { hourly: 5 * MINUTE, daily: 15 * MINUTE, weekly: 15 * MINUTE };

/** When an alert is next checked: shortly after the next local hour, day or week (Monday) starts. */
export function nextAlertCheck(interval: PanelCheckInterval, timeZone: string, after: Date): Date {
  const p = localParts(after, timeZone);
  let boundary: Date;
  if (interval === 'hourly') boundary = zonedInstant(p, p.hour + 1, timeZone);
  else if (interval === 'daily') boundary = zonedInstant(addDays(p, 1), 0, timeZone);
  else {
    const isoDow = (weekdayOf(p) + 6) % 7; // Monday 0
    boundary = zonedInstant(addDays(p, 7 - isoDow), 0, timeZone);
  }
  return new Date(boundary.getTime() + ALERT_LAG_MS[interval]);
}

/** Basin lag an export leaves behind it: rows received in the last 15 minutes wait for the next run. */
export const EXPORT_LAG_MS = 15 * MINUTE;

/** When an export next runs (UTC): after the next hour, or the next midnight, plus the Basin lag. */
export function nextExportRun(frequency: PanelExportFrequency, after: Date): Date {
  const t = after.getTime();
  const boundary = frequency === 'hourly' ? Math.floor(t / HOUR) * HOUR + HOUR : Math.floor(t / DAY) * DAY + DAY;
  return new Date(boundary + EXPORT_LAG_MS + 5 * MINUTE);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface ScheduleKey {
  kind: PanelScheduleKind;
  objectId: string;
}

/** Writes when `objectId` is next due; `nextRunAt: null` removes it (disabled, paused, deleted). */
export async function upsertSchedule(
  masterDb: AnyMasterDatabase,
  input: ScheduleKey & { workspaceId: string; nextRunAt: Date | null },
): Promise<void> {
  if (!input.nextRunAt) {
    await deleteSchedule(masterDb, input);
    return;
  }
  const now = new Date();
  await masterDb
    .insert(panelScheduleRegistry)
    .values({ id: generateId('pnsr'), workspaceId: input.workspaceId, kind: input.kind, objectId: input.objectId, nextRunAt: input.nextRunAt })
    .onConflictDoUpdate({
      target: [panelScheduleRegistry.kind, panelScheduleRegistry.objectId],
      set: { workspaceId: input.workspaceId, nextRunAt: input.nextRunAt, updatedAt: now },
    });
}

export async function deleteSchedule(masterDb: AnyMasterDatabase, key: ScheduleKey): Promise<void> {
  await masterDb
    .delete(panelScheduleRegistry)
    .where(and(eq(panelScheduleRegistry.kind, key.kind), eq(panelScheduleRegistry.objectId, key.objectId)));
}

/** When each object is next due, for the DTOs. */
export async function nextRunsOf(masterDb: AnyMasterDatabase, kind: PanelScheduleKind, objectIds: string[]): Promise<Map<string, Date>> {
  if (objectIds.length === 0) return new Map();
  const rows = await masterDb
    .select({ objectId: panelScheduleRegistry.objectId, nextRunAt: panelScheduleRegistry.nextRunAt })
    .from(panelScheduleRegistry)
    .where(and(eq(panelScheduleRegistry.kind, kind), inArray(panelScheduleRegistry.objectId, objectIds)));
  return new Map(rows.map((r) => [r.objectId, r.nextRunAt]));
}

/**
 * Claims up to `limit` due rows: `next_run_at <= now` and not locked (or the
 * lock ran out), oldest first, locking each until `now + LOCK_MS`. One
 * statement: the inner `SELECT … FOR UPDATE SKIP LOCKED` keeps two cron
 * invocations from taking the same row, and the outer condition is checked
 * again on the locked row.
 */
export async function claimDue(masterDb: AnyMasterDatabase, now: Date, limit = MAX_CLAIM): Promise<PanelScheduleRegistryRow[]> {
  const t = panelScheduleRegistry;
  const free = or(isNull(t.lockedUntil), lt(t.lockedUntil, now));
  const due = masterDb
    .select({ id: t.id })
    .from(t)
    .where(and(lte(t.nextRunAt, now), free))
    .orderBy(asc(t.nextRunAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  return masterDb
    .update(t)
    .set({ lockedUntil: new Date(now.getTime() + LOCK_MS), updatedAt: now })
    .where(and(inArray(t.id, due), lte(t.nextRunAt, now), free))
    .returning();
}

/**
 * Hands a claimed row back: the next run, or `null` to remove it (the object
 * is gone, disabled or paused). Only while this run still holds the lock, so a
 * run that overran it does not overwrite what a later one wrote.
 */
export async function releaseSchedule(masterDb: AnyMasterDatabase, row: PanelScheduleRegistryRow, nextRunAt: Date | null): Promise<void> {
  const t = panelScheduleRegistry;
  const held = row.lockedUntil ? eq(t.lockedUntil, row.lockedUntil) : isNull(t.lockedUntil);
  if (!nextRunAt) {
    await masterDb.delete(t).where(and(eq(t.id, row.id), held));
    return;
  }
  await masterDb.update(t).set({ nextRunAt, lockedUntil: null, updatedAt: new Date() }).where(and(eq(t.id, row.id), held));
}
