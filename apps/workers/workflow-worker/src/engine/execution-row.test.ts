import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { cancelQueuedExecutionRow, startExecutionRow } from './execution-row';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';

describe('execution row lifecycle (pglite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  });

  const row = async (id: string) =>
    (await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, id)))[0];

  const base = {
    workflowId: 'wf_1',
    workflowVersion: 4,
    workflowName: 'Welcome',
    triggeredBy: 'user_1',
    totalSteps: 2,
    cfWorkflowInstanceId: 'cf_inst_1',
  };

  it('inserts a running row when the dispatcher did not create one', async () => {
    await startExecutionRow(db, { ...base, id: 'wex_new', triggerType: 'schedule', triggerData: { a: 1 } });
    const r = await row('wex_new');
    expect(r).toMatchObject({
      status: 'running',
      triggerType: 'schedule',
      triggerData: { a: 1 },
      totalSteps: 2,
      currentStepIndex: 0,
      cfWorkflowInstanceId: 'cf_inst_1',
      workflowVersion: 4,
    });
    expect(r.executionContext).toBeNull();
  });

  it('upgrades the dispatcher-created queued row in place, keeping its trigger data and retry lineage', async () => {
    await db.insert(schema.workflowExecutions).values({
      id: 'wex_queued',
      workflowId: 'wf_1',
      workflowName: 'stale name',
      status: 'queued',
      triggeredBy: 'user_1',
      triggerType: 'entity_event',
      triggerData: { entityType: 'person' },
      startedAt: new Date('2020-01-01T00:00:00Z'),
      parentExecutionId: 'wex_orig',
      retryCount: 2,
      executionContext: { isTest: true },
    });

    await startExecutionRow(db, { ...base, id: 'wex_queued', triggerType: 'manual', triggerData: { other: true } });

    const r = await row('wex_queued');
    expect(r.status).toBe('running');
    expect(r.workflowName).toBe('Welcome');
    expect(r.cfWorkflowInstanceId).toBe('cf_inst_1');
    expect(r.startedAt!.getTime()).toBeGreaterThan(new Date('2021-01-01').getTime());
    // untouched by the upgrade:
    expect(r.triggerType).toBe('entity_event');
    expect(r.triggerData).toEqual({ entityType: 'person' });
    expect(r.parentExecutionId).toBe('wex_orig');
    expect(r.retryCount).toBe(2);
    expect(r.executionContext).toEqual({ isTest: true });
  });

  it('merges isTest into an existing execution context instead of replacing it', async () => {
    await db.insert(schema.workflowExecutions).values({
      id: 'wex_ctx',
      workflowId: 'wf_1',
      status: 'queued',
      executionContext: { conversationId: 'conv_1' },
    });
    await startExecutionRow(db, { ...base, id: 'wex_ctx', isTest: true });
    expect((await row('wex_ctx')).executionContext).toEqual({ conversationId: 'conv_1', isTest: true });
  });

  it('flags a fresh row as a test run', async () => {
    await startExecutionRow(db, { ...base, id: 'wex_test_new', isTest: true });
    expect((await row('wex_test_new')).executionContext).toEqual({ isTest: true });
  });

  it('cancels a queued row with the reason', async () => {
    await db.insert(schema.workflowExecutions).values({ id: 'wex_skip', workflowId: 'wf_1', status: 'queued' });
    await cancelQueuedExecutionRow(db, 'wex_skip', 'Workflow not active');
    const r = await row('wex_skip');
    expect(r.status).toBe('cancelled');
    expect(r.error).toEqual({ message: 'Not run: Workflow not active' });
    expect(r.completedAt).not.toBeNull();
  });
});
