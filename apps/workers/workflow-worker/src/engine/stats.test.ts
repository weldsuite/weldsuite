import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { updateWorkflowStats } from './stats';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';

describe('updateWorkflowStats (pglite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workflows).values({ id: 'wfl_stats', name: 'stats wf' });
  });

  it('increments executionCount + successCount on success', async () => {
    await updateWorkflowStats(db, 'wfl_stats', true);
    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, 'wfl_stats'));
    expect(row?.executionCount).toBe(1);
    expect(row?.successCount).toBe(1);
    expect(row?.lastExecutedAt).not.toBeNull();
  });

  it('increments executionCount + failureCount on failure', async () => {
    await updateWorkflowStats(db, 'wfl_stats', false);
    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, 'wfl_stats'));
    expect(row?.executionCount).toBe(2);
    expect(row?.successCount).toBe(1);
    expect(row?.failureCount).toBe(1);
  });

  it('does not touch updatedAt (the list shows it as "Last modified")', async () => {
    const before = new Date('2024-01-01T00:00:00Z');
    await db.insert(schema.workflows).values({ id: 'wfl_mod', name: 'modified wf', updatedAt: before });
    await updateWorkflowStats(db, 'wfl_mod', true);
    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, 'wfl_mod'));
    expect(row?.updatedAt.getTime()).toBe(before.getTime());
    expect(row?.lastExecutedAt).not.toBeNull();
  });

  it('keeps averageExecutionTime as the mean of timed non-test runs', async () => {
    await db.insert(schema.workflows).values({ id: 'wfl_avg', name: 'avg wf' });
    const run = (id: string, duration: number | null, ctx?: { isTest: boolean }) => ({
      id,
      workflowId: 'wfl_avg',
      status: 'completed',
      startedAt: new Date(),
      duration,
      executionContext: ctx,
    });
    await db.insert(schema.workflowExecutions).values([
      run('wex_avg1', 1000),
      run('wex_avg2', 3000),
      run('wex_avg_test', 90000, { isTest: true }),
      run('wex_avg_untimed', null),
    ]);

    await updateWorkflowStats(db, 'wfl_avg', true);

    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, 'wfl_avg'));
    expect(Number(row?.averageExecutionTime)).toBe(2000);
  });

  it('leaves averageExecutionTime unset while no run has a duration', async () => {
    await db.insert(schema.workflows).values({ id: 'wfl_noavg', name: 'no avg' });
    await updateWorkflowStats(db, 'wfl_noavg', true);
    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, 'wfl_noavg'));
    expect(row?.averageExecutionTime).toBeNull();
  });

  it('is a no-op for an unknown workflow', async () => {
    await expect(updateWorkflowStats(db, 'wfl_missing', true)).resolves.toBeUndefined();
  });
});
