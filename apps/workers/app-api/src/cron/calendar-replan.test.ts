/**
 * Nightly replan opt-out: a user with `uiPreferences.autoRescheduleTasks =
 * false` keeps their past auto-scheduled task slots, everyone else's are
 * moved forward.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { replanStaleAutoScheduledEvents } from '@weldsuite/db/lib/calendar-sync';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
}, 60_000);

afterAll(async () => {
  if (close) await close();
});

async function seedStaleTaskEvent(userId: string, suffix: string) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const taskId = `task_replan_${suffix}`;
  const eventId = `cev_replan_${suffix}`;

  await db.insert(schema.tasks).values({
    id: taskId,
    title: `Replan ${suffix}`,
    status: 'todo',
    priority: 'medium',
    calendarEventId: eventId,
  } as typeof schema.tasks.$inferInsert);

  await db.insert(schema.calendarEvents).values({
    id: eventId,
    title: `Replan ${suffix}`,
    type: 'task',
    startTime: yesterday,
    endTime: new Date(yesterday.getTime() + 30 * 60 * 1000),
    status: 'confirmed',
    calendarId: `cal_replan_${suffix}`,
    organizerId: userId,
    sourceType: 'task',
    sourceId: taskId,
    autoScheduled: true,
  } as typeof schema.calendarEvents.$inferInsert);

  return { taskId, eventId, startTime: yesterday };
}

describe('replanStaleAutoScheduledEvents', () => {
  it('skips users who turned off autoRescheduleTasks', async () => {
    await db.insert(schema.userPreferences).values({
      id: 'upref_replan_optout',
      userId: 'user_replan_optout',
      uiPreferences: { autoRescheduleTasks: false },
    } as typeof schema.userPreferences.$inferInsert);
    await db.insert(schema.userPreferences).values({
      id: 'upref_replan_optin',
      userId: 'user_replan_optin',
      uiPreferences: { autoRescheduleTasks: true },
    } as typeof schema.userPreferences.$inferInsert);

    const optedOut = await seedStaleTaskEvent('user_replan_optout', 'optout');
    const optedIn = await seedStaleTaskEvent('user_replan_optin', 'optin');
    const noPrefs = await seedStaleTaskEvent('user_replan_noprefs', 'noprefs');

    await replanStaleAutoScheduledEvents(db);

    // Opted-out: the original event is untouched and still linked to the task.
    const [keptEvent] = await db
      .select()
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, optedOut.eventId));
    expect(keptEvent.deletedAt).toBeNull();
    expect(new Date(keptEvent.startTime).getTime()).toBe(optedOut.startTime.getTime());
    const [keptTask] = await db
      .select({ calendarEventId: schema.tasks.calendarEventId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, optedOut.taskId));
    expect(keptTask.calendarEventId).toBe(optedOut.eventId);

    // Explicitly on, and no preference row at all (default on): moved forward.
    for (const moved of [optedIn, noPrefs]) {
      const [task] = await db
        .select({ calendarEventId: schema.tasks.calendarEventId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, moved.taskId));
      expect(task.calendarEventId).not.toBe(moved.eventId);
    }
  });
});
