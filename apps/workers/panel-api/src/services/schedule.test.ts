/**
 * Schedules: when scheduled reports, alerts and exports run (in the object's
 * timezone, across daylight-saving changes), and the master registry's claim
 * and release (a row is taken by one cron invocation at a time; a lock that
 * ran out is taken again; a run hands back only what it still holds).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import {
  LOCK_MS,
  claimDue,
  deleteSchedule,
  localParts,
  nextAlertCheck,
  nextExportRun,
  nextRunsOf,
  nextSubscriptionRun,
  releaseSchedule,
  upsertSchedule,
  zonedInstant,
} from './schedule';

const AMS = 'Europe/Amsterdam';
const NY = 'America/New_York';
const iso = (d: Date) => d.toISOString();

describe('zonedInstant', () => {
  it('turns a wall-clock hour into the instant, winter and summer', () => {
    expect(iso(zonedInstant({ year: 2026, month: 1, day: 15 }, 9, AMS))).toBe('2026-01-15T08:00:00.000Z');
    expect(iso(zonedInstant({ year: 2026, month: 7, day: 15 }, 9, AMS))).toBe('2026-07-15T07:00:00.000Z');
    expect(iso(zonedInstant({ year: 2026, month: 7, day: 15 }, 9, NY))).toBe('2026-07-15T13:00:00.000Z');
    expect(iso(zonedInstant({ year: 2026, month: 7, day: 15 }, 9, 'UTC'))).toBe('2026-07-15T09:00:00.000Z');
  });

  it('puts an hour lost to spring-forward just after the gap', () => {
    // Amsterdam, 29 March 2026: 02:00 → 03:00 CEST. 02:00 does not exist.
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 2, AMS))).toBe('2026-03-29T01:00:00.000Z');
    expect(localParts(new Date('2026-03-29T01:00:00Z'), AMS).hour).toBe(3);
  });

  it('takes the first of an hour that happens twice (fall back)', () => {
    // Amsterdam, 25 October 2026: 03:00 CEST → 02:00 CET. 02:00 happens at 00:00Z and 01:00Z.
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 25 }, 2, AMS))).toBe('2026-10-25T00:00:00.000Z');
  });

  it('lets the hour run over into the next day', () => {
    expect(iso(zonedInstant({ year: 2026, month: 11, day: 16 }, 24, 'UTC'))).toBe('2026-11-17T00:00:00.000Z');
  });
});

describe('nextSubscriptionRun', () => {
  it('daily: today at the hour if it is still ahead, else tomorrow', () => {
    const schedule = { frequency: 'daily' as const, hour: 9, timezone: AMS };
    expect(iso(nextSubscriptionRun(schedule, new Date('2026-11-16T07:00:00Z')))).toBe('2026-11-16T08:00:00.000Z');
    expect(iso(nextSubscriptionRun(schedule, new Date('2026-11-16T08:00:00Z')))).toBe('2026-11-17T08:00:00.000Z');
  });

  it('keeps 09:00 local across the spring and autumn changes', () => {
    const schedule = { frequency: 'daily' as const, hour: 9, timezone: AMS };
    expect(iso(nextSubscriptionRun(schedule, new Date('2026-03-28T09:00:00Z')))).toBe('2026-03-29T07:00:00.000Z');
    expect(iso(nextSubscriptionRun(schedule, new Date('2026-10-24T08:00:00Z')))).toBe('2026-10-25T08:00:00.000Z');
    const ny = { frequency: 'daily' as const, hour: 9, timezone: NY };
    expect(iso(nextSubscriptionRun(ny, new Date('2026-03-07T15:00:00Z')))).toBe('2026-03-08T13:00:00.000Z');
  });

  it('weekly: the next given weekday (0 = Sunday)', () => {
    // 2026-11-16 is a Monday.
    const friday = { frequency: 'weekly' as const, hour: 17, weekday: 5, timezone: 'UTC' };
    expect(iso(nextSubscriptionRun(friday, new Date('2026-11-16T12:00:00Z')))).toBe('2026-11-20T17:00:00.000Z');
    const monday = { frequency: 'weekly' as const, hour: 8, weekday: 1, timezone: 'UTC' };
    expect(iso(nextSubscriptionRun(monday, new Date('2026-11-16T09:00:00Z')))).toBe('2026-11-23T08:00:00.000Z');
  });

  it('monthly: the given day of this month or the next', () => {
    const first = { frequency: 'monthly' as const, hour: 6, monthDay: 1, timezone: AMS };
    expect(iso(nextSubscriptionRun(first, new Date('2026-11-16T12:00:00Z')))).toBe('2026-12-01T05:00:00.000Z');
    const twentyEighth = { frequency: 'monthly' as const, hour: 6, monthDay: 28, timezone: 'UTC' };
    expect(iso(nextSubscriptionRun(twentyEighth, new Date('2026-01-29T00:00:00Z')))).toBe('2026-02-28T06:00:00.000Z');
  });
});

describe('nextAlertCheck', () => {
  it('hourly: five minutes after the next hour', () => {
    expect(iso(nextAlertCheck('hourly', 'UTC', new Date('2026-11-16T10:07:00Z')))).toBe('2026-11-16T11:05:00.000Z');
    // Kolkata is UTC+5:30: its hours start at :30 UTC.
    expect(iso(nextAlertCheck('hourly', 'Asia/Kolkata', new Date('2026-11-16T10:07:00Z')))).toBe('2026-11-16T10:35:00.000Z');
  });

  it('daily: fifteen minutes after the next local midnight', () => {
    expect(iso(nextAlertCheck('daily', AMS, new Date('2026-11-16T10:00:00Z')))).toBe('2026-11-16T23:15:00.000Z');
  });

  it('weekly: fifteen minutes after the next local Monday', () => {
    // Wednesday 18 November → Monday 23 November 00:00 CET.
    expect(iso(nextAlertCheck('weekly', AMS, new Date('2026-11-18T10:00:00Z')))).toBe('2026-11-22T23:15:00.000Z');
    // On a Monday afternoon the next check is a week on.
    expect(iso(nextAlertCheck('weekly', 'UTC', new Date('2026-11-16T12:00:00Z')))).toBe('2026-11-23T00:15:00.000Z');
  });
});

describe('nextExportRun', () => {
  it('runs after the next hour or midnight (UTC) plus the Basin lag', () => {
    expect(iso(nextExportRun('hourly', new Date('2026-11-16T10:07:00Z')))).toBe('2026-11-16T11:20:00.000Z');
    expect(iso(nextExportRun('daily', new Date('2026-11-16T10:07:00Z')))).toBe('2026-11-17T00:20:00.000Z');
  });
});

describe('the registry', () => {
  let master: AnyMasterDatabase;
  const { panelScheduleRegistry } = masterSchema;
  const NOW = new Date('2026-11-16T10:00:00Z');

  beforeAll(async () => {
    master = (await createMasterPgliteDb()).db;
  }, 120_000);

  beforeEach(async () => {
    await master.delete(panelScheduleRegistry);
  });

  async function due(objectId: string, minutesAgo: number, workspaceId = 'ws_a', kind: 'alert' | 'subscription' | 'export' = 'alert') {
    await upsertSchedule(master, { workspaceId, kind, objectId, nextRunAt: new Date(NOW.getTime() - minutesAgo * 60_000) });
  }

  it('upserts one row per object, and removes it for a null next run', async () => {
    await due('pnal_1', 5);
    await upsertSchedule(master, { workspaceId: 'ws_a', kind: 'alert', objectId: 'pnal_1', nextRunAt: new Date('2026-11-17T00:00:00Z') });
    const rows = await master.select().from(panelScheduleRegistry);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nextRunAt.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect((await nextRunsOf(master, 'alert', ['pnal_1'])).get('pnal_1')?.toISOString()).toBe('2026-11-17T00:00:00.000Z');

    await upsertSchedule(master, { workspaceId: 'ws_a', kind: 'alert', objectId: 'pnal_1', nextRunAt: null });
    expect(await master.select().from(panelScheduleRegistry)).toHaveLength(0);
  });

  it('claims due rows oldest first, at most the limit, and only once', async () => {
    await due('pnal_1', 30);
    await due('pnal_2', 10);
    await due('pnal_3', 20);
    await upsertSchedule(master, { workspaceId: 'ws_a', kind: 'alert', objectId: 'pnal_future', nextRunAt: new Date(NOW.getTime() + 60_000) });

    const first = await claimDue(master, NOW, 2);
    expect(first.map((r) => r.objectId)).toEqual(expect.arrayContaining(['pnal_1', 'pnal_3']));
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.lockedUntil?.getTime() === NOW.getTime() + LOCK_MS)).toBe(true);

    const second = await claimDue(master, NOW, 50);
    expect(second.map((r) => r.objectId)).toEqual(['pnal_2']);
    expect(await claimDue(master, NOW, 50)).toEqual([]);
  });

  it('takes a row again once its lock ran out (a run that died)', async () => {
    await due('pnal_1', 5);
    expect(await claimDue(master, NOW, 50)).toHaveLength(1);
    expect(await claimDue(master, new Date(NOW.getTime() + LOCK_MS - 1), 50)).toHaveLength(0);
    expect(await claimDue(master, new Date(NOW.getTime() + LOCK_MS + 1), 50)).toHaveLength(1);
  });

  it('releases with the next run while the lock is held, and not after someone else took it', async () => {
    await due('pnal_1', 5);
    const [row] = await claimDue(master, NOW, 50);
    await releaseSchedule(master, row!, new Date('2026-11-16T11:05:00Z'));
    const [after] = await master.select().from(panelScheduleRegistry);
    expect(after).toMatchObject({ lockedUntil: null });
    expect(after!.nextRunAt.toISOString()).toBe('2026-11-16T11:05:00.000Z');

    // A run that overran its lock: the row was claimed again by a later run; the late release changes nothing.
    await due('pnal_2', 5);
    const [stale] = (await claimDue(master, NOW, 50)).filter((r) => r.objectId === 'pnal_2');
    const later = new Date(NOW.getTime() + LOCK_MS + 60_000);
    await claimDue(master, later, 50);
    await releaseSchedule(master, stale!, null);
    const rows = await master.select().from(panelScheduleRegistry);
    expect(rows.find((r) => r.objectId === 'pnal_2')).toBeDefined();
  });

  it('deletes a row', async () => {
    await due('pnsb_1', 5, 'ws_a', 'subscription');
    await deleteSchedule(master, { kind: 'subscription', objectId: 'pnsb_1' });
    expect(await master.select().from(panelScheduleRegistry)).toHaveLength(0);
  });
});
