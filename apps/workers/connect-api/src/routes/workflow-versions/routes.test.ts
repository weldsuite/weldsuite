/**
 * /api/workflow-versions on pglite: reading one version, the list's cursor,
 * and the refusals (integration.test.ts covers snapshots and restoring).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { workflowVersionsRoutes } from './index';

let db: Database;

function app(granted = ['workflows:read']) {
  return createTestApp('/api/workflow-versions', workflowVersionsRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
  }).request;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workflows).values({ id: 'wf_ver_one', name: 'Versioned', status: 'active', version: 2 });
  await db.insert(schema.workflowVersions).values([
    { id: 'wfv_one_1', workflowId: 'wf_ver_one', version: 1, name: 'Versioned', status: 'active', reason: 'activated', triggers: [], steps: [] },
    { id: 'wfv_one_2', workflowId: 'wf_ver_one', version: 2, name: 'Versioned', status: 'active', reason: 'saved', triggers: [], steps: [] },
  ]);
}, 60_000);

describe('/api/workflow-versions', () => {
  it('reads one version and 404s an unknown one', async () => {
    const request = app();
    const res = await request('/api/workflow-versions/wfv_one_1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { version: number; reason: string } }).data).toMatchObject({
      version: 1,
      reason: 'activated',
    });
    expect((await request('/api/workflow-versions/wfv_nope')).status).toBe(404);
  });

  it('pages by version number', async () => {
    const request = app();
    const first = (await (await request('/api/workflow-versions?workflowId=wf_ver_one&limit=1')).json()) as {
      data: Array<{ version: number }>;
      pagination: { cursor: string | null; hasMore: boolean };
    };
    expect(first.data.map((v) => v.version)).toEqual([2]);
    expect(first.pagination).toMatchObject({ cursor: '2', hasMore: true });
    const next = (await (await request(`/api/workflow-versions?workflowId=wf_ver_one&cursor=${first.pagination.cursor}`)).json()) as {
      data: Array<{ version: number }>;
    };
    expect(next.data.map((v) => v.version)).toEqual([1]);
  });

  it('refuses without permission, and 404s restoring an unknown version', async () => {
    expect((await app(['workflows:update'])('/api/workflow-versions/wfv_one_1')).status).toBe(403);
    expect((await app(['workflows:update'])('/api/workflow-versions/wfv_nope/restore', { method: 'POST' })).status).toBe(404);
  });
});
