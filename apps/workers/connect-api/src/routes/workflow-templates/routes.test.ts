/**
 * /api/workflow-templates on pglite: the category counts and replacing a
 * workspace template with PUT (integration.test.ts covers the rest).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowTemplatesRoutes } = await import('./index');

let db: Database;

function app(granted = ['workflow-templates:read', 'workflow-templates:update']) {
  return createTestApp('/api/workflow-templates', workflowTemplatesRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
  }).request;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workflowTemplates).values([
    { id: 'tmpl_c_a', name: 'Ops one', category: 'operations', rating: '4.50' },
    { id: 'tmpl_c_b', name: 'Mine', category: 'my_flows' },
  ]);
}, 60_000);

describe('GET /api/workflow-templates/categories', () => {
  it('counts the built-ins and the workspace templates per category', async () => {
    const res = await app()('/api/workflow-templates/categories');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; name: string; count: number }> };
    expect(data.find((c) => c.id === 'my_flows')).toEqual({ id: 'my_flows', name: 'My flows', count: 1 });
    expect(data.find((c) => c.id === 'operations')?.count).toBeGreaterThanOrEqual(1);
  });
});

describe('PUT /api/workflow-templates/:id', () => {
  it('replaces a workspace template', async () => {
    const request = app();
    const res = await request('/api/workflow-templates/tmpl_c_a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ops renamed', difficulty: 'advanced', tags: ['x'] }),
    });
    expect(res.status).toBe(200);
    const read = (await (await request('/api/workflow-templates/tmpl_c_a')).json()) as { data: { name: string } };
    expect(read.data.name).toBe('Ops renamed');
  });

  it('404s an unknown template and validates the body', async () => {
    const request = app();
    const put = (body: unknown) =>
      request('/api/workflow-templates/tmpl_nope', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await put({ name: 'x' })).status).toBe(404);
    expect((await put({ difficulty: 'expert' })).status).toBe(400);
  });
});
