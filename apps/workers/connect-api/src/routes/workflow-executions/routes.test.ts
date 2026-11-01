/**
 * /api/workflow-executions on pglite: the routes integration.test.ts does
 * not reach (one run, its steps and logs, the list's filters, trends, and
 * the generic create/update/delete) and their refusals.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowExecutionsRoutes } = await import('./index');

let db: Database;

const ALL = ['workflow-executions:read', 'workflow-executions:update', 'workflows:create', 'workflows:delete'];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
  }).request;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const day = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h));
  await db.insert(schema.workflows).values([
    { id: 'wf_x_one', name: 'One', status: 'active' },
    { id: 'wf_x_seq', name: 'Seq', status: 'active', tags: ['__type:sequence'] },
  ]);
  await db.insert(schema.workflowExecutions).values([
    { id: 'wex_x_1', workflowId: 'wf_x_one', status: 'completed', triggerType: 'manual', startedAt: day(1) },
    { id: 'wex_x_2', workflowId: 'wf_x_one', status: 'failed', triggerType: 'webhook', startedAt: day(2) },
    { id: 'wex_x_3', workflowId: 'wf_x_one', status: 'running', triggerType: 'manual', startedAt: day(3) },
    { id: 'wex_x_4', workflowId: 'wf_x_seq', status: 'completed', triggerType: 'manual', startedAt: day(4) },
  ]);
  await db.insert(schema.workflowExecutionSteps).values([
    {
      id: 'wes_x_2',
      executionId: 'wex_x_1',
      stepId: 'send',
      stepName: 'Send it',
      stepType: 'send_email',
      stepIndex: 1,
      status: 'completed',
      logs: [
        { timestamp: '2026-10-01T09:00:03.000Z', level: 'info', message: 'sent' },
        { timestamp: '2026-10-01T09:00:01.000Z', level: 'debug', message: 'rendering' },
      ],
    },
    {
      id: 'wes_x_1',
      executionId: 'wex_x_1',
      stepId: 'check',
      stepType: 'condition',
      stepIndex: 0,
      status: 'completed',
      logs: [{ timestamp: '2026-10-01T09:00:02.000Z', level: 'info', message: 'true branch' }],
    },
  ]);
}, 60_000);

describe('reading runs', () => {
  it('reads one run, 404s an unknown one', async () => {
    const request = app();
    const res = await request('/api/workflow-executions/wex_x_2');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('failed');
    expect((await request('/api/workflow-executions/wex_nope')).status).toBe(404);
  });

  it('lists the steps in order and merges their logs by time', async () => {
    const request = app();
    const steps = (await (await request('/api/workflow-executions/wex_x_1/steps')).json()) as {
      data: Array<{ stepId: string }>;
    };
    expect(steps.data.map((s) => s.stepId)).toEqual(['check', 'send']);
    const logs = (await (await request('/api/workflow-executions/wex_x_1/logs')).json()) as {
      data: Array<{ message: string; stepId: string; stepName?: string }>;
    };
    expect(logs.data.map((l) => l.message)).toEqual(['rendering', 'true branch', 'sent']);
    expect(logs.data[1]).not.toHaveProperty('stepName');
    expect(logs.data[0].stepName).toBe('Send it');
  });

  it('filters the list by workflow, statuses, trigger type and dates', async () => {
    const request = app();
    const ids = async (query: string) =>
      ((await (await request(`/api/workflow-executions${query}`)).json()) as { data: Array<{ id: string }> }).data.map(
        (e) => e.id,
      );
    expect(await ids('')).toEqual(['wex_x_3', 'wex_x_2', 'wex_x_1']);
    expect(await ids('?workflowId=wf_x_seq')).toEqual(['wex_x_4']);
    expect(await ids('?status=running,failed')).toEqual(['wex_x_3', 'wex_x_2']);
    expect(await ids('?status=completed')).toEqual(['wex_x_1']);
    expect(await ids('?triggerType=webhook')).toEqual(['wex_x_2']);
    expect(await ids('?startDate=2026-10-02T00:00:00Z&endDate=2026-10-02T23:59:59Z')).toEqual(['wex_x_2']);
    expect(await ids('?limit=1&cursor=wex_x_3')).toEqual(['wex_x_2']);
  });

  it('answers trends per period', async () => {
    for (const period of ['day', 'week', 'month', 'year']) {
      const res = await app()(`/api/workflow-executions/trends?period=${period}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { trends: unknown[] } }).data.trends).toBeInstanceOf(Array);
    }
  });

  it('refuses without workflow-executions:read', async () => {
    expect((await app(['workflows:create'])('/api/workflow-executions/wex_x_1')).status).toBe(403);
  });
});

describe('the generic create, update and delete', () => {
  it('creates a run row, updates it and deletes it', async () => {
    const request = app();
    const created = await request('/api/workflow-executions', send('POST', { workflowId: 'wf_x_one', status: 'queued', triggerType: 'api' }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const updated = await request(`/api/workflow-executions/${data.id}`, send('PATCH', { status: 'completed', duration: 42 }));
    expect(updated.status).toBe(200);
    const row = (await (await request(`/api/workflow-executions/${data.id}`)).json()) as {
      data: { status: string; duration: number; triggerType: string };
    };
    expect(row.data).toMatchObject({ status: 'completed', duration: 42, triggerType: 'api' });

    expect((await request(`/api/workflow-executions/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/api/workflow-executions/${data.id}`)).status).toBe(404);
  });

  it('validates, and 404s an unknown run', async () => {
    const request = app();
    expect((await request('/api/workflow-executions', send('POST', { status: 'queued' }))).status).toBe(400);
    expect((await request('/api/workflow-executions/wex_nope', send('PATCH', { status: 'failed' }))).status).toBe(404);
    expect((await request('/api/workflow-executions/wex_nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a delete without workflows:delete', async () => {
    expect((await app(['workflow-executions:read'])('/api/workflow-executions/wex_x_1', { method: 'DELETE' })).status).toBe(
      403,
    );
  });
});
