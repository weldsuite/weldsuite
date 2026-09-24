/**
 * Schedule-trigger sync against a real (pglite) tenant DB plus a recording
 * fake of the D1 schedule index, driven through the workflows service the way
 * the routes call it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import type { ScheduleIndexSync } from '../lib/schedule-index';
import { createWorkflow, deleteWorkflow, updateWorkflow, updateWorkflowStatus } from './workflows';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

/** Records every statement sent to the D1 index. */
function fakeIndex() {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          statements.push({ sql, args });
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
  const sync: ScheduleIndexSync = { d1, workspaceId: 'org_sched' };
  return {
    sync,
    upserts: () => statements.filter((s) => s.sql.includes('INSERT INTO schedule_index')),
    deletes: () => statements.filter((s) => s.sql.includes('DELETE FROM schedule_index')),
  };
}

const scheduleTrigger = (overrides: Record<string, unknown> = {}) => ({
  id: 'trigger-sched',
  type: 'schedule',
  scheduleType: 'recurring',
  cronExpression: '0 9 * * *',
  timezone: 'Europe/Amsterdam',
  isEnabled: true,
  ...overrides,
});

async function liveSchedules(workflowId: string) {
  return db
    .select()
    .from(schema.workflowSchedules)
    .where(and(eq(schema.workflowSchedules.workflowId, workflowId), isNull(schema.workflowSchedules.deletedAt)));
}

describe('workflow schedule-trigger sync', () => {
  it('does not materialize a schedule for a draft', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(db, { name: 'draft', triggers: [scheduleTrigger()] }, 'user_1', index.sync);
    expect(await liveSchedules(id)).toHaveLength(0);
    expect(index.upserts()).toHaveLength(0);
  });

  it('creates an enabled schedule + index row when the workflow is activated', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(db, { name: 'daily', triggers: [scheduleTrigger()] }, 'user_1', index.sync);
    await updateWorkflowStatus(db, id, 'active', index.sync);

    const [row] = await liveSchedules(id);
    expect(row).toMatchObject({
      triggerId: 'trigger-sched',
      cronExpression: '0 9 * * *',
      timezone: 'Europe/Amsterdam',
      isEnabled: true,
    });
    const [upsert] = index.upserts();
    expect(upsert.args.slice(0, 6)).toEqual([row.id, 'org_sched', id, 'trigger-sched', '0 9 * * *', 'Europe/Amsterdam']);
    expect(upsert.args[9]).toBe(1); // is_enabled
  });

  it('re-indexes on a cron change, disables on pause, and keeps the same row', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(
      db,
      { name: 'weekly', status: 'active', triggers: [scheduleTrigger()] },
      'user_1',
      index.sync,
    );
    const [created] = await liveSchedules(id);

    await updateWorkflow(db, id, { triggers: [scheduleTrigger({ cronExpression: '0 9 * * 1' })] }, index.sync);
    await updateWorkflowStatus(db, id, 'paused', index.sync);

    const rows = await liveSchedules(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, cronExpression: '0 9 * * 1', isEnabled: false });
    // create, cron change, pause → three upserts, the last one disabled.
    expect(index.upserts()).toHaveLength(3);
    expect(index.upserts()[2].args[9]).toBe(0);
  });

  it('does not touch the index for a rename-only save', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(
      db,
      { name: 'stable', status: 'active', triggers: [scheduleTrigger()] },
      'user_1',
      index.sync,
    );
    await updateWorkflow(db, id, { name: 'stable (renamed)' }, index.sync);
    expect(index.upserts()).toHaveLength(1);
  });

  it('retires the schedule when the trigger is swapped for an entity event', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(
      db,
      { name: 'swap', status: 'active', triggers: [scheduleTrigger()] },
      'user_1',
      index.sync,
    );
    const [row] = await liveSchedules(id);

    await updateWorkflow(
      db,
      id,
      { triggers: [{ id: 'trigger-sched', type: 'entity_event', entityType: 'person', eventType: 'created' }] },
      index.sync,
    );

    expect(await liveSchedules(id)).toHaveLength(0);
    expect(index.deletes().map((d) => d.args[0])).toEqual([row.id]);
  });

  it('retires the schedule when the workflow is deleted', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(
      db,
      { name: 'to delete', status: 'active', triggers: [scheduleTrigger()] },
      'user_1',
      index.sync,
    );
    await deleteWorkflow(db, id, index.sync);
    expect(await liveSchedules(id)).toHaveLength(0);
    expect(index.deletes()).toHaveLength(1);
  });

  it('leaves schedules it does not manage alone', async () => {
    const index = fakeIndex();
    const { id } = await createWorkflow(
      db,
      { name: 'external', status: 'active', triggers: [scheduleTrigger()] },
      'user_1',
      index.sync,
    );
    await db.insert(schema.workflowSchedules).values({
      id: 'sched_external',
      workflowId: id,
      triggerId: 'trg_external',
      cronExpression: '0 0 * * *',
      timezone: 'UTC',
      isEnabled: true,
    });

    await updateWorkflow(db, id, { triggers: [] }, index.sync);

    const rows = await liveSchedules(id);
    expect(rows.map((r) => r.id)).toEqual(['sched_external']);
  });
});
