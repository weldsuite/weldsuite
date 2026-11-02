/**
 * /api/workflow-schedules on pglite, without a schedule index binding: list,
 * read, create, update, toggle and delete, and their refusals. (index.test.ts
 * checks what the routes write to Global's D1 schedule index.)
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowSchedulesRoutes } = await import('./index');

let db: Database;

const ALL = ['workflows:read', 'workflows:create', 'workflows:update', 'workflows:delete'];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-schedules', workflowSchedulesRoutes, {
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
  await db.insert(schema.workflows).values({ id: 'wf_s_one', name: 'Scheduled', status: 'active' });
  await db.insert(schema.workflowSchedules).values([
    {
      id: 'sched_s_a',
      workflowId: 'wf_s_one',
      name: 'Morning',
      cronExpression: '0 9 * * *',
      isEnabled: true,
      createdAt: new Date(Date.UTC(2026, 9, 1)),
    },
    {
      id: 'sched_s_b',
      workflowId: 'wf_s_one',
      name: 'Evening',
      cronExpression: '0 18 * * *',
      isEnabled: false,
      createdAt: new Date(Date.UTC(2026, 9, 2)),
    },
  ]);
}, 60_000);

describe('reading schedules', () => {
  it('lists them newest first, filtered by workflow and enabled state', async () => {
    const request = app();
    const ids = async (query: string) =>
      ((await (await request(`/api/workflow-schedules${query}`)).json()) as { data: Array<{ id: string }> }).data.map(
        (s) => s.id,
      );
    expect(await ids('?workflowId=wf_s_one')).toEqual(['sched_s_b', 'sched_s_a']);
    expect(await ids('?isEnabled=true')).toEqual(['sched_s_a']);
    expect(await ids('?isEnabled=false')).toEqual(['sched_s_b']);
  });

  it('reads one, 404s an unknown one', async () => {
    const request = app();
    const res = await request('/api/workflow-schedules/sched_s_a');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('Morning');
    expect((await request('/api/workflow-schedules/sched_nope')).status).toBe(404);
  });
});

describe('changing schedules', () => {
  it('creates, renames, retimes, toggles and deletes a schedule', async () => {
    const request = app();
    const created = await request(
      '/api/workflow-schedules',
      send('POST', {
        workflowId: 'wf_s_one',
        name: 'Weekly',
        cronExpression: '0 8 * * 1',
        timezone: 'Europe/Amsterdam',
        startDate: '2026-11-01T00:00:00.000Z',
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const renamed = await request(`/api/workflow-schedules/${data.id}`, send('PATCH', { name: 'Weekly sync' }));
    expect(renamed.status).toBe(200);
    const retimed = await request(
      `/api/workflow-schedules/${data.id}`,
      send('PUT', { cronExpression: '30 8 * * 1', endDate: null, isEnabled: true }),
    );
    expect(retimed.status).toBe(200);

    const toggled = await request(`/api/workflow-schedules/${data.id}/toggle`, send('PATCH', { enabled: false }));
    expect(toggled.status).toBe(200);
    expect(((await toggled.json()) as { data: unknown }).data).toEqual({ id: data.id, isEnabled: false });

    const row = (await (await request(`/api/workflow-schedules/${data.id}`)).json()) as {
      data: { name: string; cronExpression: string; isEnabled: boolean; timezone: string };
    };
    expect(row.data).toMatchObject({ name: 'Weekly sync', cronExpression: '30 8 * * 1', isEnabled: false, timezone: 'Europe/Amsterdam' });

    expect((await request(`/api/workflow-schedules/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/api/workflow-schedules/${data.id}`)).status).toBe(404);
  });

  it('404s an unknown workflow or schedule, and validates the bodies', async () => {
    const request = app();
    const unknownWorkflow = await request(
      '/api/workflow-schedules',
      send('POST', { workflowId: 'wf_nope', name: 'x', cronExpression: '* * * * *' }),
    );
    expect(unknownWorkflow.status).toBe(404);
    expect((await request('/api/workflow-schedules', send('POST', { workflowId: 'wf_s_one' }))).status).toBe(400);
    expect((await request('/api/workflow-schedules/sched_nope', send('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await request('/api/workflow-schedules/sched_nope/toggle', send('PATCH', { enabled: true }))).status).toBe(404);
    expect((await request('/api/workflow-schedules/sched_s_a/toggle', send('PATCH', { enabled: 'yes' }))).status).toBe(400);
    expect((await request('/api/workflow-schedules/sched_nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses without the workflows permission for the action', async () => {
    const readOnly = app(['workflows:read']);
    expect(
      (await readOnly('/api/workflow-schedules', send('POST', { workflowId: 'wf_s_one', name: 'x', cronExpression: '* * * * *' })))
        .status,
    ).toBe(403);
    expect((await readOnly('/api/workflow-schedules/sched_s_a', { method: 'DELETE' })).status).toBe(403);
    expect((await app(['workflows:create'])('/api/workflow-schedules')).status).toBe(403);
  });
});
