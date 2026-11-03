/**
 * WeldConnect through the public API (pglite): webhooks (the inline schema,
 * `url` stored as `externalUrl`, the placeholder workflow), workflows with
 * their defaults, a workflow's schedules (dates as `Date`s) and its
 * read-only executions, and the event catalog in its declaration order.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { listAllEvents } from '@weldsuite/entity-events';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const api = () =>
  createExternalTestApp({
    scopes: ['webhooks:read', 'webhooks:write', 'workflows:read', 'workflows:write'],
    tenantDb: db,
  }).request;
const body = (method: string, value: unknown): RequestInit => ({ method, headers: JSON_HEADERS, body: JSON.stringify(value) });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

describe('/v1/webhooks', () => {
  it('lists every event in the catalog order', async () => {
    const res = await api()('/v1/webhooks/events');
    expect(res.status).toBe(200);
    const events = await data<{ event: string; entity: string; action: string }[]>(res);
    expect(events.map((e) => e.event)).toEqual(listAllEvents());
    expect(events[0]).toEqual({ event: events[0]!.event, entity: events[0]!.event.split('.')[0], action: events[0]!.event.split('.')[1] });
  });

  it('creates, filters, updates and deletes a webhook', async () => {
    const request = api();
    expect((await request('/v1/webhooks', body('POST', { name: 'Bad', url: 'not a url' }))).status).toBe(400);
    const res = await request(
      '/v1/webhooks',
      body('POST', { name: 'Ext hook', url: 'https://hooks.example.com/in', allowedMethods: ['POST'], headers: { 'X-Key': 'k' } }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const hook = await data<{ id: string; workflowId: string; externalUrl: string; isEnabled: boolean }>(res);
    expect(hook).toMatchObject({ workflowId: '', externalUrl: 'https://hooks.example.com/in', isEnabled: true });

    const disabled = await data<{ id: string }>(
      await request('/v1/webhooks', body('POST', { name: 'Ext off', url: 'https://hooks.example.com/off', isEnabled: false, workflowId: 'wf_ext_hooks' })),
    );
    // `z.coerce.boolean()`: any non-empty string is true, so only an empty value filters for disabled hooks.
    const off = await data<{ id: string }[]>(await request('/v1/webhooks?isEnabled=&workflowId=wf_ext_hooks'));
    expect(off.map((h) => h.id)).toEqual([disabled.id]);
    expect(await data(await request('/v1/webhooks?isEnabled=false&workflowId=wf_ext_hooks'))).toEqual([]);
    expect((await request(`/v1/webhooks/${hook.id}`)).status).toBe(200);

    const patched = await request(`/v1/webhooks/${hook.id}`, body('PATCH', { url: 'https://hooks.example.com/v2', workflowId: 'wf_ext_hooks' }));
    expect(patched.status).toBe(200);
    expect(await data(patched)).toMatchObject({ externalUrl: 'https://hooks.example.com/v2', workflowId: 'wf_ext_hooks' });
    expect((await request('/v1/webhooks/wh_missing', body('PATCH', { name: 'x' }))).status).toBe(404);

    expect((await request(`/v1/webhooks/${hook.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/v1/webhooks/${hook.id}`)).status).toBe(404);
    expect((await request(`/v1/webhooks/${hook.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('/v1/workflows', () => {
  it('fills a workflow in, then schedules it and reads its executions', async () => {
    const request = api();
    const res = await request('/v1/workflows', body('POST', { name: 'Ext flow', description: 'Nightly sync' }));
    expect(res.status, await res.clone().text()).toBe(201);
    const flow = await data<{ id: string; status: string; version: number; createdBy: string; steps: unknown[] }>(res);
    expect(flow).toMatchObject({ status: 'draft', version: 1, createdBy: 'user_test', steps: [] });
    expect((await data<{ id: string }[]>(await request('/v1/workflows?search=Nightly&status=draft'))).map((w) => w.id)).toContain(
      flow.id,
    );

    const base = `/v1/workflows/${flow.id}/schedules`;
    expect((await request('/v1/workflows/wf_missing/schedules', body('POST', { name: 'Hourly', cronExpression: '0 * * * *' }))).status).toBe(404);
    const scheduleRes = await request(base, body('POST', { name: 'Nightly', cronExpression: '0 3 * * *', startDate: '2026-01-01T00:00:00.000Z', endDate: '' }));
    expect(scheduleRes.status, await scheduleRes.clone().text()).toBe(201);
    const schedule = await data<{ id: string; workflowId: string; startDate: string }>(scheduleRes);
    expect(schedule.workflowId).toBe(flow.id);
    expect(schedule.startDate).toBe('2026-01-01T00:00:00.000Z');
    expect((await data<{ id: string }[]>(await request(`${base}?isEnabled=true`))).map((s) => s.id)).toEqual([schedule.id]);
    expect((await request(`${base}/${schedule.id}`)).status).toBe(200);
    const moved = await request(`${base}/${schedule.id}`, body('PATCH', { endDate: '2027-01-01T00:00:00.000Z', startDate: null, isEnabled: false }));
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await data(moved)).toMatchObject({ endDate: '2027-01-01T00:00:00.000Z', startDate: null, isEnabled: false });
    expect((await request(`${base}/wfs_missing`, body('PATCH', { isEnabled: true }))).status).toBe(404);
    expect((await request(`${base}/${schedule.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/${schedule.id}`)).status).toBe(404);

    await db.insert(schema.workflowExecutions).values({
      id: 'wfe_ext_one',
      workflowId: flow.id,
      status: 'completed',
      triggerType: 'manual',
    } as typeof schema.workflowExecutions.$inferInsert);
    const runs = await data<{ id: string }[]>(await request(`/v1/workflows/${flow.id}/executions?status=completed`));
    expect(runs.map((r) => r.id)).toEqual(['wfe_ext_one']);
    expect((await request(`/v1/workflows/${flow.id}/executions/wfe_ext_one`)).status).toBe(200);
    expect((await request(`/v1/workflows/${flow.id}/executions/wfe_missing`)).status).toBe(404);

    expect((await request(`/v1/workflows/${flow.id}`, body('PATCH', { status: 'active' }))).status).toBe(200);
    expect((await request(`/v1/workflows/${flow.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});
