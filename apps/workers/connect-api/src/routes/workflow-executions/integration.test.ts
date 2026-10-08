/**
 * Route-level tests for the execution-id contract: retry and Test runs return a
 * real `wex_` id backed by a row, an inactive workflow is refused with a
 * reason, trends accept `period=year`, and `maxCreditsPerRun` is validated.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { workflowExecutionsRoutes } from './index';
import { workflowsRoutes } from '../workflows/index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;
beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function executeWorkflowBinding() {
  const create = vi.fn(async (_init: { params: Record<string, unknown> }) => ({ id: 'cf_inst_route' }));
  return { binding: { create } as unknown as Workflow, create };
}

async function seedWorkflow(status: string) {
  const id = `wf_route_${status}_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(schema.workflows).values({
    id,
    name: 'Route wf',
    status,
    steps: [{ id: 's1', type: 'send_email' }] as never,
    triggers: [{ id: 't1', type: 'entity_event', entityType: 'lead', eventType: 'created' }] as never,
  });
  return id;
}

describe('POST /api/workflow-executions/:id/retry', () => {
  it('returns the new execution id, the instance id and retryOf', async () => {
    const wfId = await seedWorkflow('active');
    await db.insert(schema.workflowExecutions).values({ id: 'wex_route_failed', workflowId: wfId, status: 'failed' });
    const { binding } = executeWorkflowBinding();
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflows:create'), tenantDb: db },
      env: { EXECUTE_WORKFLOW: binding } as never,
    });

    const res = await request('/api/workflow-executions/wex_route_failed/retry', json({}));

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; executionId: string; instanceId: string; retryOf: string };
    };
    expect(data.id).toMatch(/^wex_/);
    expect(data.executionId).toBe(data.id);
    expect(data.instanceId).toBe('cf_inst_route');
    expect(data.retryOf).toBe('wex_route_failed');
    const [row] = await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, data.id));
    expect(row.status).toBe('queued');
  });

  it('answers 400 with details.reason = workflow_inactive for a paused workflow', async () => {
    const wfId = await seedWorkflow('paused');
    await db.insert(schema.workflowExecutions).values({ id: 'wex_route_paused', workflowId: wfId, status: 'failed' });
    const { binding, create } = executeWorkflowBinding();
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflows:create'), tenantDb: db },
      env: { EXECUTE_WORKFLOW: binding } as never,
    });

    const res = await request('/api/workflow-executions/wex_route_paused/retry', json({}));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe('workflow_inactive');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/workflow-executions/:id/cancel', () => {
  function cancelBinding() {
    const terminate = vi.fn(async () => undefined);
    const get = vi.fn(async (_id: string) => ({ terminate }));
    return { binding: { get } as unknown as Workflow, get, terminate };
  }
  const patch: RequestInit = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' };

  it('cancels a running run, terminates its instance and publishes a cancelled event', async () => {
    const wfId = await seedWorkflow('active');
    await db.insert(schema.workflowExecutions).values({
      id: 'wex_route_cancel',
      workflowId: wfId,
      status: 'running',
      cfWorkflowInstanceId: 'cf_inst_cancel',
    });
    const { binding, get, terminate } = cancelBinding();
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflow-executions:update'), tenantDb: db },
      env: { EXECUTE_WORKFLOW: binding } as never,
    });

    const res = await request('/api/workflow-executions/wex_route_cancel/cancel', patch);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string; status: string } }).data).toEqual({
      id: 'wex_route_cancel',
      status: 'cancelled',
    });
    expect(get).toHaveBeenCalledWith('cf_inst_cancel');
    expect(terminate).toHaveBeenCalledOnce();
    const [row] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, 'wex_route_cancel'));
    expect(row.status).toBe('cancelled');
    expect(publishEntityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'workflow_execution', entityId: 'wex_route_cancel', action: 'cancelled' }),
    );
  });

  it('answers 400 not_cancellable for a finished run and 404 for an unknown one', async () => {
    const wfId = await seedWorkflow('active');
    await db.insert(schema.workflowExecutions).values({ id: 'wex_route_done', workflowId: wfId, status: 'completed' });
    const { binding, terminate } = cancelBinding();
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflow-executions:update'), tenantDb: db },
      env: { EXECUTE_WORKFLOW: binding } as never,
    });

    const done = await request('/api/workflow-executions/wex_route_done/cancel', patch);
    expect(done.status).toBe(400);
    const body = (await done.json()) as { error: { details: { reason: string; status: string } } };
    expect(body.error.details).toEqual({ reason: 'not_cancellable', status: 'completed' });
    expect(terminate).not.toHaveBeenCalled();

    expect((await request('/api/workflow-executions/wex_missing/cancel', patch)).status).toBe(404);
  });

  it('is refused without workflow-executions:update', async () => {
    const wfId = await seedWorkflow('active');
    await db.insert(schema.workflowExecutions).values({ id: 'wex_route_noperm', workflowId: wfId, status: 'running' });
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflow-executions:read'), tenantDb: db },
    });

    expect((await request('/api/workflow-executions/wex_route_noperm/cancel', patch)).status).toBe(403);
    const [row] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, 'wex_route_noperm'));
    expect(row.status).toBe('running');
  });
});

describe('POST /api/workflows/:id/test', () => {
  it('returns a real wex_ executionId plus the instance id, for a draft workflow', async () => {
    const wfId = await seedWorkflow('draft');
    const { binding, create } = executeWorkflowBinding();
    const { request } = createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('workflows:create'), tenantDb: db },
      env: { EXECUTE_WORKFLOW: binding } as never,
    });
    const testData = { entityType: 'lead', entityId: 'lead_1', action: 'created', data: { email: 'a@b.co' } };

    const res = await request(`/api/workflows/${wfId}/test`, json({ testData }));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { executionId: string; instanceId: string; triggerType: string; isTest: boolean };
    };
    expect(data.executionId).toMatch(/^wex_/);
    expect(data.instanceId).toBe('cf_inst_route');
    expect(data.triggerType).toBe('entity_event');
    expect(data.isTest).toBe(true);
    const [row] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, data.executionId));
    expect(row.executionContext).toEqual({ isTest: true });
    expect(create.mock.calls[0][0].params.executionId).toBe(data.executionId);
  });

  it('accepts an explicit triggerType and 404s an unknown workflow', async () => {
    const wfId = await seedWorkflow('draft');
    const { binding } = executeWorkflowBinding();
    const { request } = createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('workflows:create'), tenantDb: db },
      env: { EXECUTE_WORKFLOW: binding } as never,
    });

    const ok = await request(`/api/workflows/${wfId}/test`, json({ triggerType: 'manual' }));
    expect(((await ok.json()) as { data: { triggerType: string } }).data.triggerType).toBe('manual');

    const missing = await request('/api/workflows/wf_does_not_exist/test', json({}));
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/workflow-executions/trends', () => {
  it('supports period=year', async () => {
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflow-executions:read'), tenantDb: db },
    });
    const res = await request('/api/workflow-executions/trends?period=year');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { trends: Array<{ date: string }> } };
    expect(data.trends.every((t) => /^\d{4}-\d{2}-01$/.test(t.date))).toBe(true);
  });
});

describe('workflow settings validation', () => {
  function app() {
    return createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('workflows:create', 'workflows:update'), tenantDb: db },
    }).request;
  }

  it.each([-5, 0, 1.5, 1_000_000])('rejects maxCreditsPerRun = %s', async (maxCreditsPerRun) => {
    const res = await app()('/api/workflows', json({ name: 'bad credits', settings: { maxCreditsPerRun } }));
    expect(res.status).toBe(400);
  });

  it('accepts a sane maxCreditsPerRun, null, and unknown keys', async () => {
    const request = app();
    expect((await request('/api/workflows', json({ name: 'ok', settings: { maxCreditsPerRun: 50 } }))).status).toBe(201);
    expect((await request('/api/workflows', json({ name: 'ok2', settings: { maxCreditsPerRun: null } }))).status).toBe(
      201,
    );
    expect(
      (await request('/api/workflows', json({ name: 'ok3', settings: { notifyOnError: false, custom: 'x' } }))).status,
    ).toBe(201);
  });

  it('rejects a bad maxCreditsPerRun on update too', async () => {
    const request = app();
    const created = await request('/api/workflows', json({ name: 'to update' }));
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    const res = await request(`/api/workflows/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { maxCreditsPerRun: -5 } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/workflow-dashboard/stats', () => {
  it('leaves CRM sequences and test runs out of both the workflow and the run counts', async () => {
    const { workflowDashboardRoutes } = await import('../workflow-dashboard/index');
    const { request } = createTestApp('/api/workflow-dashboard', workflowDashboardRoutes, {
      context: { permissions: permissions('workflows:read'), tenantDb: db },
    });
    const read = async () =>
      ((await (await request('/api/workflow-dashboard/stats')).json()) as {
        data: { workflows: { total: number }; executions: { total: number; queued: number } };
      }).data;
    const before = await read();

    const sequence = `wf_seq_${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(schema.workflows).values({ id: sequence, name: 'Seq', tags: ['__type:sequence'] as never });
    await db.insert(schema.workflowExecutions).values([
      { id: `wex_seq_${sequence}`, workflowId: sequence, status: 'queued' },
      { id: `wex_test_${sequence}`, workflowId: 'wf_any', status: 'queued', executionContext: { isTest: true } },
    ]);

    const after = await read();
    expect(after.workflows.total).toBe(before.workflows.total);
    expect(after.executions.total).toBe(before.executions.total);
    expect(after.executions.queued).toBe(before.executions.queued);
  });
});

describe('limit query params on /recent, /slow and the list', () => {
  const paths = ['/api/workflow-executions/recent', '/api/workflow-executions/slow', '/api/workflow-executions'];

  it.each(paths)('%s answers 200 for a non-numeric, negative, zero or huge limit', async (path) => {
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflow-executions:read'), tenantDb: db },
    });
    for (const limit of ['abc', '-1', '0', '', '999999', '1.5', 'NaN']) {
      const res = await request(`${path}?limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBe(200);
    }
  });

  it('caps /recent at 100 rows and honours a small limit', async () => {
    const wfId = await seedWorkflow('active');
    await db.insert(schema.workflowExecutions).values(
      Array.from({ length: 105 }, (_, i) => ({ id: `wex_lim_${i}`, workflowId: wfId, status: 'completed' })),
    );
    const { request } = createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
      context: { permissions: permissions('workflow-executions:read'), tenantDb: db },
    });
    const rows = async (limit: string) =>
      ((await (await request(`/api/workflow-executions/recent?limit=${limit}`)).json()) as { data: unknown[] }).data;

    expect(await rows('3')).toHaveLength(3);
    expect(await rows('5000')).toHaveLength(100);
    expect(await rows('-1')).toHaveLength(1);
    expect(await rows('abc')).toHaveLength(10);
  });
});
