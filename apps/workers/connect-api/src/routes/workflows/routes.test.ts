/**
 * /api/workflows on pglite: the routes integration.test.ts does not reach
 * (stats, metrics, duplicate, a manual trigger, the list's filters, the
 * single read) and their refusals.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowsRoutes } = await import('./index');

let db: Database;

const ALL = ['workflows:read', 'workflows:create', 'workflows:update', 'workflows:delete'];

/** An `EXECUTE_WORKFLOW` answering by method: every run gets the same instance id. */
function runtime() {
  const create = vi.fn(async (_init: { params: Record<string, unknown> }) => ({ id: 'cf_inst_manual' }));
  const get = vi.fn(async (_id: string) => ({ terminate: async () => undefined }));
  return { create, get } as unknown as Workflow;
}

function app(granted: string[] = ALL, env: Record<string, unknown> = {}) {
  return createTestApp('/api/workflows', workflowsRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
    env: env as never,
  }).request;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 9, minutes));
  await db.insert(schema.workflows).values([
    {
      id: 'wf_r_alpha',
      name: 'Alpha intake',
      description: 'Routes new leads',
      status: 'active',
      tags: ['sales', 'leads'],
      folderId: 'fld_a',
      executionCount: 4,
      successCount: 3,
      failureCount: 1,
      averageExecutionTime: '1250.50',
      updatedAt: at(1),
    },
    { id: 'wf_r_beta', name: 'Beta digest', status: 'draft', tags: ['sales'], updatedAt: at(2) },
    { id: 'wf_r_gamma', name: 'Gamma cleanup', status: 'paused', tags: [], updatedAt: at(3) },
    { id: 'wf_r_seq', name: 'Sequence', status: 'active', tags: ['__type:sequence'], updatedAt: at(4) },
    { id: 'wf_r_arch', name: 'Archived', status: 'archived', updatedAt: at(5) },
  ]);
  await db.insert(schema.workflowExecutions).values([
    { id: 'wex_r_1', workflowId: 'wf_r_alpha', status: 'completed', startedAt: at(10), duration: 900 },
    { id: 'wex_r_2', workflowId: 'wf_r_alpha', status: 'failed', startedAt: at(11) },
    { id: 'wex_r_3', workflowId: 'wf_r_alpha', status: 'running', startedAt: at(12) },
    { id: 'wex_r_4', workflowId: 'wf_r_seq', status: 'completed', startedAt: at(13) },
    {
      id: 'wex_r_5',
      workflowId: 'wf_r_alpha',
      status: 'completed',
      startedAt: at(14),
      executionContext: { isTest: true },
    },
  ]);
}, 60_000);

describe('GET /api/workflows', () => {
  it('filters by search, status, folder and tags, and pages by cursor', async () => {
    const request = app();
    const bySearch = (await (await request('/api/workflows?search=intake')).json()) as { data: Array<{ id: string }> };
    expect(bySearch.data.map((w) => w.id)).toEqual(['wf_r_alpha']);

    const byStatus = (await (await request('/api/workflows?status=draft')).json()) as { data: Array<{ id: string }> };
    expect(byStatus.data.map((w) => w.id)).toEqual(['wf_r_beta']);

    const byFolder = (await (await request('/api/workflows?folderId=fld_a')).json()) as { data: Array<{ id: string }> };
    expect(byFolder.data.map((w) => w.id)).toEqual(['wf_r_alpha']);

    const tagged = (await (await request('/api/workflows?tags=sales,leads')).json()) as { data: Array<{ id: string }> };
    expect(tagged.data.map((w) => w.id)).toEqual(['wf_r_alpha']);

    const noSequences = (await (await request('/api/workflows?excludeTags=__type:sequence&limit=2')).json()) as {
      data: Array<{ id: string }>;
      pagination: { hasMore: boolean; cursor: string | null; totalCount: number };
    };
    expect(noSequences.data.map((w) => w.id)).toEqual(['wf_r_arch', 'wf_r_gamma']);
    expect(noSequences.pagination).toMatchObject({ hasMore: true, totalCount: 4 });

    const next = (await (
      await request(`/api/workflows?excludeTags=__type:sequence&limit=2&cursor=${noSequences.pagination.cursor}`)
    ).json()) as { data: Array<{ id: string }> };
    // The cursor is the last id while the list is ordered by updatedAt: the
    // next page is every row with a smaller id, newest first.
    expect(next.data.map((w) => w.id)).toEqual(['wf_r_arch', 'wf_r_beta']);
  });

  it('refuses without workflows:read', async () => {
    expect((await app(['workflows:create'])('/api/workflows')).status).toBe(403);
  });
});

describe('GET /api/workflows/stats and /:id', () => {
  it('counts WeldConnect workflows and runs, without sequences or Test runs', async () => {
    const res = await app()('/api/workflows/stats');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      totalWorkflows: 4,
      activeWorkflows: 1,
      draftWorkflows: 1,
      pausedWorkflows: 1,
      totalExecutions: 3,
      successfulExecutions: 1,
      failedExecutions: 1,
      pendingExecutions: 1,
    });
  });

  it('reads one workflow, with its numeric average as text', async () => {
    const res = await app()('/api/workflows/wf_r_alpha');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { name: string; averageExecutionTime: string } };
    expect(data.name).toBe('Alpha intake');
    expect(data.averageExecutionTime).toBe('1250.50');
  });

  it('lists chaining candidates without the excluded one or sequences', async () => {
    const res = await app()('/api/workflows/for-chaining?exclude=wf_r_beta');
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((w) => w.id)).toEqual(['wf_r_alpha', 'wf_r_arch', 'wf_r_gamma']);
  });
});

describe('GET /api/workflows/:id/metrics', () => {
  it('reports the counters and the last runs', async () => {
    const res = await app()('/api/workflows/wf_r_alpha/metrics');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { totalExecutions: number; averageExecutionTime: number; recentExecutions: Array<{ id: string }> };
    };
    expect(data.totalExecutions).toBe(4);
    expect(data.averageExecutionTime).toBe(1250.5);
    expect(data.recentExecutions.map((e) => e.id)).toEqual(['wex_r_5', 'wex_r_3', 'wex_r_2', 'wex_r_1']);
  });

  it('404s an unknown workflow', async () => {
    expect((await app()('/api/workflows/wf_nope/metrics')).status).toBe(404);
  });
});

describe('POST /api/workflows/:id/duplicate', () => {
  it('copies a workflow as a draft, with the given name or a (Copy) suffix', async () => {
    const request = app();
    const named = await request('/api/workflows/wf_r_alpha/duplicate', post({ name: 'Alpha v2' }));
    expect(named.status).toBe(201);
    const { data } = (await named.json()) as { data: { id: string } };
    const copy = (await (await request(`/api/workflows/${data.id}`)).json()) as {
      data: { name: string; status: string; tags: string[] };
    };
    expect(copy.data).toMatchObject({ name: 'Alpha v2', status: 'draft', tags: ['sales', 'leads'] });

    const unnamed = await request('/api/workflows/wf_r_gamma/duplicate', { method: 'POST' });
    expect(unnamed.status).toBe(201);
    const second = (await unnamed.json()) as { data: { id: string } };
    const gamma = (await (await request(`/api/workflows/${second.data.id}`)).json()) as { data: { name: string } };
    expect(gamma.data.name).toBe('Gamma cleanup (Copy)');
  });

  it('404s an unknown workflow and refuses without workflows:create', async () => {
    expect((await app()('/api/workflows/wf_nope/duplicate', post({}))).status).toBe(404);
    expect((await app(['workflows:read'])('/api/workflows/wf_r_alpha/duplicate', post({}))).status).toBe(403);
  });
});

describe('POST /api/workflows/:id/trigger', () => {
  it('starts a manual run on the runtime with the request data', async () => {
    const res = await app(ALL, { EXECUTE_WORKFLOW: runtime() })('/api/workflows/wf_r_alpha/trigger', post({ data: { a: 1 } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      executionId: 'cf_inst_manual',
      instanceId: 'cf_inst_manual',
    });
  });

  it('answers 500 without a runtime, and validates the body', async () => {
    expect((await app()('/api/workflows/wf_r_alpha/trigger', post({}))).status).toBe(500);
    const invalid = await app(ALL, { EXECUTE_WORKFLOW: runtime() })(
      '/api/workflows/wf_r_alpha/trigger',
      post({ triggerType: 'cron' }),
    );
    expect(invalid.status).toBe(400);
  });
});

describe('refusals', () => {
  it('404s updating, setting the status of and deleting an unknown workflow', async () => {
    const request = app();
    const put = await request('/api/workflows/wf_nope', { ...post({ name: 'x' }), method: 'PUT' });
    expect(put.status).toBe(404);
    const status = await request('/api/workflows/wf_nope/status', { ...post({ status: 'paused' }), method: 'PATCH' });
    expect(status.status).toBe(404);
    expect((await request('/api/workflows/wf_nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('validates the create body', async () => {
    const res = await app()('/api/workflows', post({ name: '', status: 'live', settings: { maxConcurrentRuns: 0 } }));
    expect(res.status).toBe(400);
  });
});
