/**
 * /api/workflow-variables as the WeldConnect › Variables page uses it: the
 * list reports each row's `scope`, secrets come back masked, and create keeps
 * the engine's lookup unambiguous (global = no workflowId; names that a run
 * would see twice are refused).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { workflowVariablesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

function app() {
  return createTestApp('/api/workflow-variables', workflowVariablesRoutes, {
    context: {
      permissions: permissions(
        'workflow-variables:read',
        'workflow-variables:create',
        'workflow-variables:update',
        'workflow-variables:delete',
      ),
      tenantDb: db,
    },
  }).request;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(body: Record<string, unknown>) {
  return app()('/api/workflow-variables', send('POST', body));
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workflows).values({ id: 'wf_vars', name: 'Vars', status: 'active' });
}, 60_000);

describe('POST /api/workflow-variables', () => {
  it('creates a global variable with no workflowId', async () => {
    const res = await create({ name: 'api_base', value: 'https://example.test', isGlobal: true });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.workflowVariables).where(eq(schema.workflowVariables.id, data.id));
    expect(row.scope).toBe('global');
    expect(row.workflowId).toBeNull();
  });

  it('creates a workflow variable for an existing workflow', async () => {
    const res = await create({ name: 'region', value: 'eu', scope: 'workflow', workflowId: 'wf_vars' });
    expect(res.status).toBe(201);
  });

  it('needs a workflowId for workflow scope, and a real workflow', async () => {
    expect((await create({ name: 'orphan', value: 'x', scope: 'workflow' })).status).toBe(400);
    expect((await create({ name: 'orphan', value: 'x', scope: 'workflow', workflowId: 'wf_missing' })).status).toBe(404);
  });

  it('refuses a name a run would see twice', async () => {
    // Same global name again.
    expect((await create({ name: 'api_base', value: 'y', isGlobal: true })).status).toBe(409);
    // A workflow variable shadowing a global.
    expect((await create({ name: 'api_base', value: 'y', scope: 'workflow', workflowId: 'wf_vars' })).status).toBe(409);
    // A global shadowing a workflow variable.
    expect((await create({ name: 'region', value: 'us', isGlobal: true })).status).toBe(409);
  });

  it('refuses names that {{variables.<name>}} cannot reach', async () => {
    expect((await create({ name: 'has space', value: 'x', isGlobal: true })).status).toBe(400);
    expect((await create({ name: '1st', value: 'x', isGlobal: true })).status).toBe(400);
  });
});

describe('GET /api/workflow-variables', () => {
  it('reports scope and masks secrets', async () => {
    expect((await create({ name: 'token', value: 'sk_live_123', isSecret: true, isGlobal: true })).status).toBe(201);
    const res = await app()('/api/workflow-variables?limit=100');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ name: string; scope: string; value: unknown }> };
    const byName = new Map(data.map((v) => [v.name, v]));
    expect(byName.get('api_base')?.scope).toBe('global');
    expect(byName.get('region')?.scope).toBe('workflow');
    expect(byName.get('token')?.value).toBe('********');
  });

  it('pages with the cursor without repeating rows', async () => {
    const first = await app()('/api/workflow-variables?limit=2');
    const page1 = (await first.json()) as { data: Array<{ id: string }>; pagination: { cursor: string; hasMore: boolean } };
    expect(page1.pagination.hasMore).toBe(true);
    const second = await app()(`/api/workflow-variables?limit=2&cursor=${page1.pagination.cursor}`);
    const page2 = (await second.json()) as { data: Array<{ id: string }> };
    const ids = [...page1.data, ...page2.data].map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });
});

describe('PUT /api/workflow-variables/:id', () => {
  it('refuses a rename onto a taken name', async () => {
    const res = await create({ name: 'renamable', value: 'x', scope: 'workflow', workflowId: 'wf_vars' });
    const { data } = (await res.json()) as { data: { id: string } };
    const clash = await app()(`/api/workflow-variables/${data.id}`, send('PUT', { name: 'api_base' }));
    expect(clash.status).toBe(409);
    const ok = await app()(`/api/workflow-variables/${data.id}`, send('PUT', { name: 'renamed' }));
    expect(ok.status).toBe(200);
  });
});
