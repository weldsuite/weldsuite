/**
 * /api/workflow-dashboard on pglite: stats, search, resource usage and the
 * editor's static pickers (errors.integration.test.ts covers the Errors view
 * and performance).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { workflowDashboardRoutes } from './index';

let db: Database;

function app(granted: string[] = ['workflows:read']) {
  return createTestApp('/api/workflow-dashboard', workflowDashboardRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
  }).request;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
  await db.insert(schema.workflows).values([
    { id: 'wf_d_orders', name: 'Order sync', description: 'Syncs orders', status: 'active', updatedAt: at(1) },
    { id: 'wf_d_invoices', name: 'Invoice reminders', status: 'paused', updatedAt: at(2) },
    { id: 'wf_d_seq', name: 'Order sequence', status: 'active', tags: ['__type:sequence'], updatedAt: at(3) },
  ]);
  await db.insert(schema.workflowTemplates).values({ id: 'tmpl_d_order', name: 'Order alert', category: 'operations' });
  await db.insert(schema.workflowExecutions).values([
    { id: 'wex_d_1', workflowId: 'wf_d_orders', status: 'completed', startedAt: at(5) },
    { id: 'wex_d_2', workflowId: 'wf_d_orders', status: 'running', startedAt: at(6) },
    { id: 'wex_d_3', workflowId: 'wf_d_seq', status: 'failed', startedAt: at(7) },
  ]);
  await db.insert(schema.workflowSchedules).values({ id: 'sched_d_1', workflowId: 'wf_d_orders', cronExpression: '0 * * * *' });
  await db.insert(schema.workflowWebhooks).values({ id: 'wh_d_1', workflowId: 'wf_d_orders', name: 'Hook', url: '/x' });
}, 60_000);

describe('GET /api/workflow-dashboard/stats and /resource-usage', () => {
  it('counts workflows, runs, schedules and webhooks without sequences', async () => {
    const stats = (await (await app()('/api/workflow-dashboard/stats')).json()) as { data: unknown };
    expect(stats.data).toEqual({
      workflows: { total: 2, active: 1, draft: 0, paused: 1, archived: 0 },
      executions: { total: 2, running: 1, completed: 1, failed: 0, queued: 0 },
      triggers: { schedules: 1, webhooks: 1 },
    });
    const usage = (await (await app()('/api/workflow-dashboard/resource-usage')).json()) as { data: unknown };
    expect(usage.data).toEqual({
      workflows: { total: 2, active: 1 },
      executions: { total: 2, running: 1, completed: 1, failed: 0 },
      triggers: { schedules: 1, webhooks: 1 },
    });
  });
});

describe('GET /api/workflow-dashboard/search', () => {
  it('lists recent workflows for a short query', async () => {
    const res = await app()('/api/workflow-dashboard/search?q=o');
    const { data } = (await res.json()) as { data: Array<{ id: string; type: string }> };
    expect(data.map((r) => r.id)).toEqual(['wf_d_invoices', 'wf_d_orders']);
  });

  it('finds workflows, templates and runs by name, up to the limit', async () => {
    const all = (await (await app()('/api/workflow-dashboard/search?q=Order')).json()) as {
      data: Array<{ id: string; type: string; href: string }>;
    };
    expect(all.data.map((r) => `${r.type}:${r.id}`)).toEqual([
      'workflow:wf_d_orders',
      'template:tmpl_d_order',
      'execution:wex_d_2',
      'execution:wex_d_1',
    ]);
    const limited = (await (await app()('/api/workflow-dashboard/search?q=Order&limit=2')).json()) as { data: unknown[] };
    expect(limited.data).toHaveLength(2);
    expect((await app()('/api/workflow-dashboard/search?limit=99')).status).toBe(400);
  });
});

describe('the static pickers', () => {
  it('filters action and trigger types by category and search', async () => {
    const actions = (await (await app()('/api/workflow-dashboard/action-types?category=logic')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(actions.data.map((a) => a.id)).toContain('condition');
    const searched = (await (await app()('/api/workflow-dashboard/action-types?search=EMAIL')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(searched.data.map((a) => a.id)).toContain('send_email');
    const triggers = (await (await app()('/api/workflow-dashboard/trigger-types?search=schedule')).json()) as {
      data: unknown[];
    };
    expect(triggers.data.length).toBeGreaterThan(0);
    const all = (await (await app()('/api/workflow-dashboard/trigger-types')).json()) as { data: unknown[] };
    expect(all.data.length).toBeGreaterThan(triggers.data.length);
  });

  it('lists the entity events', async () => {
    const res = await app()('/api/workflow-dashboard/entity-events');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it('refuses without workflows:read', async () => {
    expect((await app(['workflows:update'])('/api/workflow-dashboard/entity-events')).status).toBe(403);
  });
});
