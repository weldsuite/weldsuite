/**
 * /api/workflow-variables on pglite: the routes integration.test.ts does not
 * reach (one variable, the global and per-workflow views, updates and
 * deletes) and their refusals.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowVariablesRoutes } = await import('./index');

let db: Database;

const ALL = ['workflow-variables:read', 'workflow-variables:create', 'workflow-variables:update', 'workflow-variables:delete'];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-variables', workflowVariablesRoutes, {
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
  await db.insert(schema.workflows).values({ id: 'wf_v_one', name: 'Vars', status: 'draft' });
  await db.insert(schema.workflowVariables).values([
    { id: 'var_v_api', name: 'API_BASE', type: 'string', value: 'https://x.test', scope: 'global' },
    { id: 'var_v_key', name: 'API_KEY', type: 'string', value: 'sk_live', isSecret: true, scope: 'global' },
    { id: 'var_v_own', name: 'retries', type: 'string', value: 'three', scope: 'workflow', workflowId: 'wf_v_one' },
  ]);
}, 60_000);

describe('reading variables', () => {
  it('reads one, masking a secret, and 404s an unknown one', async () => {
    const request = app();
    const secret = (await (await request('/api/workflow-variables/var_v_key')).json()) as { data: { value: string } };
    expect(secret.data.value).toBe('********');
    expect((await request('/api/workflow-variables/var_nope')).status).toBe(404);
  });

  it('lists the globals by name, and what a workflow sees', async () => {
    const request = app();
    const globals = (await (await request('/api/workflow-variables/global')).json()) as {
      data: Array<{ name: string; value: string }>;
    };
    expect(globals.data.map((v) => v.name)).toEqual(['API_BASE', 'API_KEY']);
    expect(globals.data[1].value).toBe('********');
    const visible = (await (await request('/api/workflow-variables/workflow/wf_v_one')).json()) as { data: unknown };
    expect(visible.data).toEqual([
      { name: 'API_BASE', type: 'string', isSecret: false, scope: 'global' },
      { name: 'API_KEY', type: 'string', isSecret: true, scope: 'global' },
      { name: 'retries', type: 'string', isSecret: false, scope: 'workflow' },
    ]);
  });

  it('filters the list by search, scope and secrecy', async () => {
    const request = app();
    const ids = async (query: string) =>
      ((await (await request(`/api/workflow-variables${query}`)).json()) as { data: Array<{ id: string }> }).data.map(
        (v) => v.id,
      );
    expect(await ids('?search=API')).toEqual(['var_v_key', 'var_v_api']);
    expect(await ids('?scope=workflow')).toEqual(['var_v_own']);
    expect(await ids('?isSecret=true')).toEqual(['var_v_key']);
    expect(await ids('?workflowId=wf_v_one')).toEqual(['var_v_own']);
  });
});

describe('changing variables', () => {
  it('updates a variable with PATCH and deletes it', async () => {
    const request = app();
    const patched = await request('/api/workflow-variables/var_v_own', send('PATCH', { value: 'five', description: 'Tries' }));
    expect(patched.status).toBe(200);
    const row = (await (await request('/api/workflow-variables/var_v_own')).json()) as { data: { description: string } };
    expect(row.data.description).toBe('Tries');
    expect((await request('/api/workflow-variables/var_v_own', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/api/workflow-variables/var_v_own')).status).toBe(404);
  });

  it('404s an unknown variable, validates the name, and refuses without permission', async () => {
    const request = app();
    expect((await request('/api/workflow-variables/var_nope', send('PATCH', { value: 'x' }))).status).toBe(404);
    expect((await request('/api/workflow-variables/var_nope', send('PATCH', { name: 'NEW_NAME' }))).status).toBe(404);
    expect((await request('/api/workflow-variables/var_nope', { method: 'DELETE' })).status).toBe(404);
    expect((await request('/api/workflow-variables/var_v_api', send('PATCH', { name: '1bad' }))).status).toBe(400);
    expect((await app(['workflow-variables:read'])('/api/workflow-variables/var_v_api', { method: 'DELETE' })).status).toBe(403);
  });
});
