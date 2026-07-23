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

  it('is a no-op for an unknown workflow', async () => {
    await expect(updateWorkflowStats(db, 'wfl_missing', true)).resolves.toBeUndefined();
  });
});
