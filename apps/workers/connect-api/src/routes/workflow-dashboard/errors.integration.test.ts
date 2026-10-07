/**
 * The Errors view behind WeldConnect › Analytics: /api/workflow-dashboard/errors
 * lists the `workflow_error_logs` rows the engine writes, leaving out Test runs
 * and CRM sequences like the other analytics figures, and the acknowledge
 * routes (single + bulk) mark them handled.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { workflowDashboardRoutes } from './index';

let db: Database;

interface ErrorsBody {
  data: {
    total: number;
    unacknowledged: number;
    byType: Record<string, number>;
    byWorkflow: Array<{ workflowId: string | null; workflowName: string | null; count: number }>;
    items: Array<{ id: string; workflowName: string | null; acknowledgedAt: string | null; acknowledgedBy: string | null }>;
    page: number;
    limit: number;
  };
}

function app() {
  return createTestApp('/api/workflow-dashboard', workflowDashboardRoutes, {
    context: { permissions: permissions('workflows:read', 'workflows:update'), tenantDb: db, userId: 'user_ack' },
  }).request;
}

async function getErrors(query = '') {
  const res = await app()(`/api/workflow-dashboard/errors${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as ErrorsBody).data;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

let seq = 0;
async function seedError(values: {
  workflowId: string;
  executionId?: string;
  errorType?: string;
  acknowledged?: boolean;
  occurredAt?: Date;
}) {
  seq += 1;
  const id = `wel_test_${String(seq).padStart(3, '0')}`;
  await db.insert(schema.workflowErrorLogs).values({
    id,
    workflowId: values.workflowId,
    executionId: values.executionId ?? null,
    errorMessage: `boom ${seq}`,
    errorType: values.errorType ?? null,
    stepId: 's1',
    stepType: 'http_request',
    isAcknowledged: values.acknowledged ?? false,
    acknowledgedAt: values.acknowledged ? new Date() : null,
    occurredAt: values.occurredAt ?? new Date(Date.UTC(2026, 0, 1, 0, seq)),
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workflows).values([
    { id: 'wf_err_a', name: 'Order sync', status: 'active', tags: [] },
    { id: 'wf_err_b', name: 'Lead router', status: 'active' },
    { id: 'wf_err_seq', name: 'Nurture sequence', status: 'active', tags: ['__type:sequence'] },
  ]);
  await db.insert(schema.workflowExecutions).values([
    { id: 'wex_err_live', workflowId: 'wf_err_a', status: 'failed' },
    { id: 'wex_err_test', workflowId: 'wf_err_a', status: 'failed', executionContext: { isTest: true } },
    { id: 'wex_err_seq', workflowId: 'wf_err_seq', status: 'failed' },
  ]);
  // Visible: 3 for A (one acknowledged), 1 for B.
  await seedError({ workflowId: 'wf_err_a', executionId: 'wex_err_live', errorType: 'NetworkError' });
  await seedError({ workflowId: 'wf_err_a', executionId: 'wex_err_live', errorType: 'NetworkError' });
  await seedError({ workflowId: 'wf_err_a', executionId: 'wex_err_live', errorType: 'ValidationError', acknowledged: true });
  await seedError({ workflowId: 'wf_err_b', errorType: 'TimeoutError' });
  // Hidden: a Test run's error and a CRM sequence's error.
  await seedError({ workflowId: 'wf_err_a', executionId: 'wex_err_test', errorType: 'NetworkError' });
  await seedError({ workflowId: 'wf_err_seq', executionId: 'wex_err_seq', errorType: 'NetworkError' });
}, 60_000);

describe('GET /api/workflow-dashboard/errors', () => {
  it('leaves out Test runs and CRM sequences, newest first, with workflow names', async () => {
    const data = await getErrors();
    expect(data.total).toBe(4);
    expect(data.unacknowledged).toBe(3);
    expect(data.byType).toEqual({ NetworkError: 2, ValidationError: 1, TimeoutError: 1 });
    expect(data.items.map((i) => i.id)).toEqual(['wel_test_004', 'wel_test_003', 'wel_test_002', 'wel_test_001']);
    expect(data.items[0].workflowName).toBe('Lead router');
    expect(data.byWorkflow[0]).toEqual({ workflowId: 'wf_err_a', workflowName: 'Order sync', count: 3 });
  });

  it('filters by acknowledgement through status and the legacy isAcknowledged flag', async () => {
    const open = await getErrors('?status=unacknowledged');
    expect(open.total).toBe(3);
    expect(open.items.every((i) => i.acknowledgedAt === null)).toBe(true);
    expect(open.unacknowledged).toBe(3);

    // 'false' used to be coerced to true and filter nothing.
    const legacyOpen = await getErrors('?isAcknowledged=false');
    expect(legacyOpen.total).toBe(3);

    const handled = await getErrors('?isAcknowledged=true');
    expect(handled.total).toBe(1);
    expect(handled.items[0].id).toBe('wel_test_003');
  });

  it('filters by workflow and pages', async () => {
    const first = await getErrors('?workflowId=wf_err_a&limit=2');
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    const second = await getErrors('?workflowId=wf_err_a&limit=2&page=2');
    expect(second.items.map((i) => i.id)).toEqual(['wel_test_001']);
  });

  it('rejects a malformed flag', async () => {
    const res = await app()('/api/workflow-dashboard/errors?isAcknowledged=maybe');
    expect(res.status).toBe(400);
  });
});

describe('acknowledging errors', () => {
  it('PATCH /errors/:id/acknowledge stamps the row; unknown ids are 404', async () => {
    const id = await seedError({ workflowId: 'wf_err_b', errorType: 'TimeoutError' });
    const res = await app()(`/api/workflow-dashboard/errors/${id}/acknowledge`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.workflowErrorLogs).where(eq(schema.workflowErrorLogs.id, id));
    expect(row.isAcknowledged).toBe(true);
    expect(row.acknowledgedBy).toBe('user_ack');
    expect(row.acknowledgedAt).not.toBeNull();

    const missing = await app()('/api/workflow-dashboard/errors/wel_nope/acknowledge', { method: 'PATCH' });
    expect(missing.status).toBe(404);
  });

  it('POST /errors/acknowledge with ids acknowledges just those', async () => {
    const a = await seedError({ workflowId: 'wf_err_b' });
    const b = await seedError({ workflowId: 'wf_err_b' });
    const res = await app()('/api/workflow-dashboard/errors/acknowledge', post({ ids: [a] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { acknowledged: number } }).data.acknowledged).toBe(1);
    const rows = await db.select().from(schema.workflowErrorLogs);
    expect(rows.find((r) => r.id === a)?.acknowledgedAt).not.toBeNull();
    expect(rows.find((r) => r.id === b)?.acknowledgedAt).toBeNull();
  });

  it('POST /errors/acknowledge with all: true clears the visible list for a workflow, not hidden rows', async () => {
    const res = await app()('/api/workflow-dashboard/errors/acknowledge', post({ all: true, workflowId: 'wf_err_a' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { acknowledged: number } }).data.acknowledged).toBe(2);

    expect((await getErrors('?workflowId=wf_err_a&status=unacknowledged')).total).toBe(0);
    // The Test run's row is not part of the view and stays as it was.
    const [testRow] = await db
      .select()
      .from(schema.workflowErrorLogs)
      .where(eq(schema.workflowErrorLogs.executionId, 'wex_err_test'));
    expect(testRow.acknowledgedAt).toBeNull();
  });

  it('rejects an empty bulk request', async () => {
    const res = await app()('/api/workflow-dashboard/errors/acknowledge', post({ ids: [] }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/workflow-dashboard/performance', () => {
  it('aggregates completed run durations, without Test runs', async () => {
    await db.insert(schema.workflows).values({ id: 'wf_perf', name: 'Perf', status: 'active' });
    await db.insert(schema.workflowExecutions).values([
      { id: 'wex_p1', workflowId: 'wf_perf', status: 'completed', duration: 100 },
      { id: 'wex_p2', workflowId: 'wf_perf', status: 'completed', duration: 300 },
      { id: 'wex_p3', workflowId: 'wf_perf', status: 'failed', duration: 999 },
      { id: 'wex_p4', workflowId: 'wf_perf', status: 'completed', duration: 5000, executionContext: { isTest: true } },
    ]);
    const res = await app()('/api/workflow-dashboard/performance?workflowId=wf_perf');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, number> };
    expect(data).toEqual({
      totalExecutions: 3,
      completedExecutions: 2,
      averageDuration: 200,
      minDuration: 100,
      maxDuration: 300,
    });
  });
});
