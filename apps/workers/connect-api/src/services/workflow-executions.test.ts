/**
 * Service-level tests for `services/workflow-executions.ts` against pglite:
 * retry/test-run row creation, and the sequence / test-run exclusions.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  getExecutionTrends,
  getRecentExecutions,
  getSlowExecutions,
  getStartDate,
  listExecutions,
  resolveTestTriggerType,
  retryExecution,
  startTestRun,
  trendBucket,
} from './workflow-executions';
import { getWorkflowStats } from './workflows';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

let seq = 0;
const nextId = (prefix: string) => `${prefix}_t${++seq}`;

async function seedWorkflow(over: Partial<typeof schema.workflows.$inferInsert> = {}) {
  const id = nextId('wf');
  await db.insert(schema.workflows).values({
    id,
    name: `Workflow ${id}`,
    status: 'active',
    version: 3,
    steps: [{ id: 's1', type: 'send_email' }, { id: 's2', type: 'create_customer' }] as never,
    ...over,
  });
  return id;
}

async function seedRun(workflowId: string, over: Partial<typeof schema.workflowExecutions.$inferInsert> = {}) {
  const id = nextId('wex');
  await db.insert(schema.workflowExecutions).values({
    id,
    workflowId,
    status: 'completed',
    startedAt: new Date(),
    ...over,
  });
  return id;
}

function fakeExecuteWorkflow() {
  const create = vi.fn(async (_init: { params: Record<string, unknown> }) => ({ id: 'cf_instance_1' }));
  return { binding: { create } as unknown as Workflow, create };
}

const runRow = async (id: string) =>
  (await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, id)))[0];

describe('retryExecution', () => {
  it('creates a real queued execution row and returns ITS id (not the Cloudflare instance id)', async () => {
    const wfId = await seedWorkflow();
    const original = await seedRun(wfId, {
      status: 'failed',
      triggerType: 'entity_event',
      triggerId: 'trg_1',
      triggerData: { entityType: 'person', data: { email: 'a@b.co' } },
      retryCount: 1,
    });
    const { binding, create } = fakeExecuteWorkflow();

    const res = await retryExecution(db, original, 'org_1', 'user_9', binding);

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.id).toMatch(/^wex_/);
    expect(res.executionId).toBe(res.id);
    expect(res.instanceId).toBe('cf_instance_1');
    expect(res.retryOf).toBe(original);

    const row = await runRow(res.id);
    expect(row).toMatchObject({
      workflowId: wfId,
      workflowVersion: 3,
      status: 'queued',
      triggeredBy: 'user_9',
      triggerType: 'entity_event',
      triggerId: 'trg_1',
      triggerData: { entityType: 'person', data: { email: 'a@b.co' } },
      totalSteps: 2,
      parentExecutionId: original,
      retryCount: 2,
      cfWorkflowInstanceId: 'cf_instance_1',
    });
    expect(row.startedAt).not.toBeNull();

    const { params } = create.mock.calls[0][0];
    expect(params).toMatchObject({
      workspaceId: 'org_1',
      userId: 'user_9',
      workflowId: wfId,
      triggerType: 'entity_event',
      executionId: res.id,
    });
    expect(params.isTest).toBeUndefined();
  });

  it('refuses an inactive workflow without inserting a row', async () => {
    const wfId = await seedWorkflow({ status: 'paused' });
    const original = await seedRun(wfId, { status: 'failed' });
    const { binding, create } = fakeExecuteWorkflow();

    const res = await retryExecution(db, original, 'org_1', 'user_9', binding);

    expect(res).toMatchObject({ kind: 'workflow_inactive', workflowId: wfId, status: 'paused' });
    expect(create).not.toHaveBeenCalled();
    const children = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.parentExecutionId, original));
    expect(children).toHaveLength(0);
  });

  it('retries a failed TEST run of a draft workflow, as a test run', async () => {
    const wfId = await seedWorkflow({ status: 'draft' });
    const original = await seedRun(wfId, { status: 'failed', executionContext: { isTest: true } });
    const { binding, create } = fakeExecuteWorkflow();

    const res = await retryExecution(db, original, 'org_1', 'user_9', binding);

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect((await runRow(res.id)).executionContext).toEqual({ isTest: true });
    expect(create.mock.calls[0][0].params.isTest).toBe(true);
  });

  it('marks the new row failed (no ghost queued row) when the workflow cannot be started', async () => {
    const wfId = await seedWorkflow();
    const original = await seedRun(wfId, { status: 'failed' });
    const create = vi.fn(async () => {
      throw new Error('binding exploded');
    });

    await expect(retryExecution(db, original, 'org_1', 'u', { create } as unknown as Workflow)).rejects.toThrow(
      'binding exploded',
    );

    const [child] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.parentExecutionId, original));
    expect(child.status).toBe('failed');
    expect(child.error?.message).toContain('binding exploded');
  });

  it('keeps the existing not_found / not_failed / workflow_missing outcomes', async () => {
    const { binding } = fakeExecuteWorkflow();
    expect((await retryExecution(db, 'wex_nope', 'o', 'u', binding)).kind).toBe('not_found');
    const wfId = await seedWorkflow();
    expect((await retryExecution(db, await seedRun(wfId, { status: 'completed' }), 'o', 'u', binding)).kind).toBe(
      'not_failed',
    );
    expect((await retryExecution(db, await seedRun('wf_gone', { status: 'failed' }), 'o', 'u', binding)).kind).toBe(
      'workflow_missing',
    );
  });
});

describe('startTestRun', () => {
  it('creates a queued, flagged row for a DRAFT workflow and uses the first enabled trigger type', async () => {
    const wfId = await seedWorkflow({
      status: 'draft',
      triggers: [
        { id: 't0', type: 'schedule', isEnabled: false },
        { id: 't1', type: 'entity_event', entityType: 'lead', eventType: 'created' },
      ] as never,
    });
    const { binding, create } = fakeExecuteWorkflow();
    const testData = { entityType: 'lead', entityId: 'lead_1', action: 'created', data: { email: 'x@y.co' } };

    const res = await startTestRun(db, binding, { workspaceId: 'org_1', userId: 'u1', workflowId: wfId, testData });

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.executionId).toMatch(/^wex_/);
    expect(res.triggerType).toBe('entity_event');

    const row = await runRow(res.executionId);
    expect(row).toMatchObject({
      status: 'queued',
      triggerType: 'entity_event',
      triggerData: testData,
      executionContext: { isTest: true },
      triggeredBy: 'u1',
    });
    expect(create.mock.calls[0][0].params).toMatchObject({
      isTest: true,
      executionId: res.executionId,
      triggerType: 'entity_event',
      triggerData: testData,
    });
  });

  it('honours an explicit triggerType, falls back to manual, and adds the schedule timezone', async () => {
    const noTriggers = await seedWorkflow({ status: 'draft', triggers: [] as never });
    const sched = await seedWorkflow({
      status: 'draft',
      triggers: [{ id: 't', type: 'schedule', cronExpression: '0 9 * * *', timezone: 'Europe/Amsterdam' }] as never,
    });
    const { binding } = fakeExecuteWorkflow();
    const base = { workspaceId: 'o', userId: 'u' };

    const manual = await startTestRun(db, binding, { ...base, workflowId: noTriggers });
    expect(manual.kind === 'ok' && manual.triggerType).toBe('manual');

    const explicit = await startTestRun(db, binding, { ...base, workflowId: noTriggers, triggerType: 'api' });
    expect(explicit.kind === 'ok' && explicit.triggerType).toBe('api');

    const schedule = await startTestRun(db, binding, { ...base, workflowId: sched });
    if (schedule.kind !== 'ok') throw new Error('expected ok');
    expect(schedule.triggerType).toBe('schedule');
    expect((await runRow(schedule.executionId)).triggerData).toEqual({ timezone: 'Europe/Amsterdam' });
  });

  it('reports a missing workflow', async () => {
    const { binding } = fakeExecuteWorkflow();
    expect(await startTestRun(db, binding, { workspaceId: 'o', userId: 'u', workflowId: 'wf_missing' })).toEqual({
      kind: 'workflow_missing',
    });
  });
});

describe('resolveTestTriggerType', () => {
  it('ignores unknown requested types and disabled triggers', () => {
    expect(resolveTestTriggerType({ triggers: [{ type: 'weird' }] as never }, 'bogus')).toBe('manual');
    expect(resolveTestTriggerType({ triggers: [{ type: 'schedule', isEnabled: false }] as never })).toBe('manual');
    expect(resolveTestTriggerType({ triggers: null as never })).toBe('manual');
  });
});

describe('sequence and test-run exclusions', () => {
  it('leaves sequence runs out of list / recent / slow / trends / stats but keeps them reachable by workflowId', async () => {
    const sequenceWf = await seedWorkflow({ tags: ['__type:sequence'] as never });
    const normalWf = await seedWorkflow();
    const sequenceRun = await seedRun(sequenceWf, { duration: 999_999 });
    const normalRun = await seedRun(normalWf, { duration: 10 });

    const listed = (await listExecutions(db, { limit: 100 })).data.map((r) => r.id);
    expect(listed).toContain(normalRun);
    expect(listed).not.toContain(sequenceRun);

    const byWorkflow = (await listExecutions(db, { workflowId: sequenceWf })).data.map((r) => r.id);
    expect(byWorkflow).toEqual([sequenceRun]);

    expect((await getRecentExecutions(db, 100)).map((r) => r.id)).not.toContain(sequenceRun);
    expect((await getSlowExecutions(db, 50)).map((r) => r.id)).not.toContain(sequenceRun);

    const stats = await getWorkflowStats(db);
    const baseline = await db.select().from(schema.workflows);
    const sequences = baseline.filter((w) => (w.tags as string[] | null)?.includes('__type:sequence')).length;
    expect(stats.totalWorkflows).toBe(baseline.filter((w) => !w.deletedAt).length - sequences);
  });

  it('keeps test runs in the list but out of trends, slow runs and stats', async () => {
    const wf = await seedWorkflow();
    const testRun = await seedRun(wf, { status: 'failed', executionContext: { isTest: true }, duration: 5 });
    const before = await getWorkflowStats(db);

    expect((await listExecutions(db, { workflowId: wf })).data.map((r) => r.id)).toContain(testRun);
    expect((await getRecentExecutions(db, 100)).map((r) => r.id)).toContain(testRun);
    expect((await getSlowExecutions(db, 50)).map((r) => r.id)).not.toContain(testRun);

    await db
      .update(schema.workflowExecutions)
      .set({ executionContext: null })
      .where(eq(schema.workflowExecutions.id, testRun));
    const after = await getWorkflowStats(db);
    // flipping the flag off makes the same row count, so with the flag on it did not.
    expect(after.failedExecutions).toBe(before.failedExecutions + 1);
  });
});

describe('listExecutions status filter', () => {
  it('accepts a single status or a comma-separated list; unknown values match nothing', async () => {
    const wf = await seedWorkflow();
    const running = await seedRun(wf, { status: 'running' });
    const queued = await seedRun(wf, { status: 'queued' });
    const failed = await seedRun(wf, { status: 'failed' });
    const ids = async (status: string) =>
      (await listExecutions(db, { workflowId: wf, status, limit: 100 })).data.map((r) => r.id).sort();

    expect(await ids('running')).toEqual([running]);
    expect(await ids('running,queued')).toEqual([running, queued].sort());
    expect(await ids(' running , queued ,')).toEqual([running, queued].sort());
    expect(await ids('queued,failed')).toEqual([queued, failed].sort());
    expect(await ids('bogus')).toEqual([]);
    expect(await ids('running,bogus')).toEqual([running]);
    const total = (await listExecutions(db, { workflowId: wf, status: 'running,queued' })).totalCount;
    expect(total).toBe(2);
  });
});

describe('trends', () => {
  it('buckets the year view per month (YYYY-MM-01) and leaves day/week/month per day', async () => {
    const wf = await seedWorkflow();
    await seedRun(wf, { status: 'completed', startedAt: new Date(Date.now() - 100 * 86_400_000) });
    await seedRun(wf, { status: 'failed', startedAt: new Date(Date.now() - 100 * 86_400_000 + 60_000) });
    await seedRun(wf, { status: 'completed', startedAt: new Date(Date.now() - 400 * 86_400_000) });

    const year = await getExecutionTrends(db, 'year');
    expect(year.every((t) => /^\d{4}-\d{2}-01$/.test(t.date))).toBe(true);
    const month = trendBucket('year', new Date(Date.now() - 100 * 86_400_000)).slice(0, 7);
    const bucket = year.find((t) => t.date.startsWith(month));
    expect(bucket && bucket.total >= 2).toBe(true);
    // 400 days ago is outside the 365-day window
    const tooOld = trendBucket('year', new Date(Date.now() - 400 * 86_400_000));
    expect(year.some((t) => t.date === tooOld && t.total === 1 && tooOld !== bucket?.date)).toBe(false);

    const week = await getExecutionTrends(db, 'week');
    expect(week.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
  });

  it('computes windows and buckets', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    expect(getStartDate('year', now).toISOString()).toBe('2025-10-06T12:00:00.000Z');
    expect(getStartDate('month', now).toISOString()).toBe('2026-09-06T12:00:00.000Z');
    expect(trendBucket('year', new Date('2026-03-17T08:00:00Z'))).toBe('2026-03-01');
    expect(trendBucket('week', new Date('2026-03-17T08:00:00Z'))).toBe('2026-03-17');
  });
});
