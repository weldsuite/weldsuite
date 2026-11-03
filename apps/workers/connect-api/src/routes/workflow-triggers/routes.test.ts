/**
 * /api/workflow-triggers on pglite: the standalone trigger rows (generic,
 * entity-event and schedule shortcuts), enabling, updating and deleting
 * them, and the refusals.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowTriggersRoutes } = await import('./index');

let db: Database;

const ALL = ['workflows:read', 'workflows:create', 'workflows:update', 'workflows:delete'];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-triggers', workflowTriggersRoutes, {
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
  await db.insert(schema.workflows).values({ id: 'wf_t_one', name: 'Triggered', status: 'draft' });
  await db.insert(schema.workflowTriggers).values([
    {
      id: 'trg_t_a',
      workflowId: 'wf_t_one',
      name: 'Hook',
      category: 'webhook',
      config: { method: 'POST' },
      createdAt: new Date(Date.UTC(2026, 9, 1)),
    },
    {
      id: 'trg_t_b',
      workflowId: 'wf_t_one',
      name: 'Manual',
      category: 'manual',
      config: {},
      isEnabled: false,
      createdAt: new Date(Date.UTC(2026, 9, 2)),
    },
  ]);
}, 60_000);

describe('reading triggers', () => {
  it('lists them with the workflow name, filtered, newest first', async () => {
    const request = app();
    const list = (await (await request('/api/workflow-triggers?workflowId=wf_t_one')).json()) as {
      data: Array<{ id: string; workflowName: string }>;
    };
    expect(list.data.map((t) => t.id)).toEqual(['trg_t_b', 'trg_t_a']);
    expect(list.data[0].workflowName).toBe('Triggered');
    const hooks = (await (await request('/api/workflow-triggers?category=webhook&isEnabled=true')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(hooks.data.map((t) => t.id)).toEqual(['trg_t_a']);
  });

  it('reads one, 404s an unknown one', async () => {
    const request = app();
    const res = await request('/api/workflow-triggers/trg_t_a');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { workflowName: string } }).data.workflowName).toBe('Triggered');
    expect((await request('/api/workflow-triggers/trg_nope')).status).toBe(404);
  });
});

describe('creating triggers', () => {
  it('creates a generic trigger, an entity trigger and a schedule trigger', async () => {
    const request = app();
    const generic = await request(
      '/api/workflow-triggers',
      send('POST', { workflowId: 'wf_t_one', name: 'API', category: 'api', config: { key: 'v' } }),
    );
    expect(generic.status).toBe(201);
    expect(((await generic.json()) as { data: { category: string; isEnabled: boolean } }).data).toMatchObject({
      category: 'api',
      isEnabled: true,
    });

    const entity = await request(
      '/api/workflow-triggers/entity',
      send('POST', { workflowId: 'wf_t_one', entityType: 'person', eventType: 'created' }),
    );
    expect(entity.status).toBe(201);
    expect(((await entity.json()) as { data: { name: string; config: unknown } }).data).toMatchObject({
      name: 'Entity Event Trigger',
      config: { entityType: 'person', eventType: 'created' },
    });

    const scheduled = await request(
      '/api/workflow-triggers/schedule',
      send('POST', { workflowId: 'wf_t_one', name: 'Daily', cronExpression: '0 7 * * *' }),
    );
    expect(scheduled.status).toBe(201);
    const trigger = (await scheduled.json()) as { data: { id: string; config: { timezone: string } } };
    expect(trigger.data.config.timezone).toBe('UTC');
    const [schedule] = await db.select().from(schema.workflowSchedules);
    expect(schedule).toMatchObject({ triggerId: trigger.data.id, name: 'Daily', cronExpression: '0 7 * * *' });
  });

  it('404s an unknown workflow and validates the bodies', async () => {
    const request = app();
    expect(
      (await request('/api/workflow-triggers', send('POST', { workflowId: 'wf_nope', name: 'x', category: 'manual' }))).status,
    ).toBe(404);
    expect(
      (await request('/api/workflow-triggers', send('POST', { workflowId: 'wf_t_one', name: 'x', category: 'cron' }))).status,
    ).toBe(400);
    expect(
      (await request('/api/workflow-triggers/entity', send('POST', { workflowId: 'wf_nope', entityType: 'a', eventType: 'b' })))
        .status,
    ).toBe(404);
    expect((await request('/api/workflow-triggers/schedule', send('POST', { workflowId: 'wf_t_one' }))).status).toBe(400);
    expect(
      (await request('/api/workflow-triggers/schedule', send('POST', { workflowId: 'wf_nope', cronExpression: '* * * * *' })))
        .status,
    ).toBe(404);
  });
});

describe('changing triggers', () => {
  it('updates, disables, enables and deletes a trigger', async () => {
    const request = app();
    const updated = await request('/api/workflow-triggers/trg_t_a', send('PATCH', { name: 'Inbound hook', config: { method: 'PUT' } }));
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { data: { name: string } }).data.name).toBe('Inbound hook');
    const put = await request('/api/workflow-triggers/trg_t_a', send('PUT', { category: 'webhook' }));
    expect(put.status).toBe(200);

    const disabled = await request('/api/workflow-triggers/trg_t_a/disable', { method: 'PATCH' });
    expect(((await disabled.json()) as { data: { isEnabled: boolean } }).data.isEnabled).toBe(false);
    const enabled = await request('/api/workflow-triggers/trg_t_a/enable', { method: 'PATCH' });
    expect(((await enabled.json()) as { data: { isEnabled: boolean } }).data.isEnabled).toBe(true);

    expect((await request('/api/workflow-triggers/trg_t_b', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/api/workflow-triggers/trg_t_b')).status).toBe(404);
  });

  it('404s an unknown trigger', async () => {
    const request = app();
    expect((await request('/api/workflow-triggers/trg_nope', send('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await request('/api/workflow-triggers/trg_nope/enable', { method: 'PATCH' })).status).toBe(404);
    expect((await request('/api/workflow-triggers/trg_nope/disable', { method: 'PATCH' })).status).toBe(404);
    expect((await request('/api/workflow-triggers/trg_nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses without the workflows permission for the action', async () => {
    const readOnly = app(['workflows:read']);
    expect((await readOnly('/api/workflow-triggers/trg_t_a/enable', { method: 'PATCH' })).status).toBe(403);
    expect((await readOnly('/api/workflow-triggers/trg_t_a', { method: 'DELETE' })).status).toBe(403);
    expect((await app(['workflows:update'])('/api/workflow-triggers')).status).toBe(403);
  });
});
