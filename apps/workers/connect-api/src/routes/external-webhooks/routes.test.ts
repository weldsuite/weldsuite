/**
 * `/api/external-webhooks` on a real (pglite) tenant database: the event
 * picker with the tenant's WeldObjects events, list/get/deliveries with
 * their cursors, create/update with the catalog and custom-object checks,
 * secret rotation, the test delivery (through the test's fetch stub, which
 * answers by URL) and the soft delete, with the permission refusals.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { externalWebhooksRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const ALL = ['webhooks:read', 'webhooks:create', 'webhooks:update', 'webhooks:delete'] as const;

/** The fetch the stub hands loopback calls to: the conformance harness's own. */
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

/** A receiver per URL: 200 for `ok.example.com`, 500 for `down.example.com`. */
function stubReceivers() {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isLoopback(url)) return realFetch(input, init);
    if (url.startsWith('https://ok.example.com')) return new Response('thanks', { status: 200 });
    if (url.startsWith('https://down.example.com')) return new Response('upstream down', { status: 500 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.customObjects).values([
    {
      id: 'cob_machines0001',
      slug: 'machine',
      entityKey: 'co_machine',
      labelSingular: 'Machine',
      labelPlural: 'Machines',
      status: 'active',
      enableEvents: true,
      sortOrder: 1,
    },
    {
      id: 'cob_silent00001',
      slug: 'silent',
      entityKey: 'co_silent',
      labelSingular: 'Silent',
      labelPlural: 'Silents',
      status: 'active',
      enableEvents: false,
      sortOrder: 2,
    },
  ] as unknown as (typeof schema.customObjects.$inferInsert)[]);
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/external-webhooks', externalWebhooksRoutes, {
    context: { tenantDb: db, permissions: permissions(...(granted.length ? granted : ALL)) },
  }).request;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(body: Record<string, unknown>): Promise<{ id: string; secret: string }> {
  const res = await app()('/api/external-webhooks', json(body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string; secret: string } }).data;
}

describe('GET /events', () => {
  it('lists the catalog events and the WeldObjects with events switched on', async () => {
    const res = await app('webhooks:read')('/api/external-webhooks/events');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ event: string; entity: string; action: string; label?: string }> };
    expect(data.some((e) => e.event === 'company.created' && e.entity === 'company' && e.action === 'created')).toBe(true);
    expect(data.some((e) => e.entity === 'customer')).toBe(false);
    expect(data.find((e) => e.event === 'co_machine.created')?.label).toBe('Machines');
    expect(data.some((e) => e.entity === 'co_silent')).toBe(false);
  });

  it('is refused without webhooks:read', async () => {
    const res = await app('companies:read')('/api/external-webhooks/events');
    expect(res.status).toBe(403);
  });
});

describe('POST /', () => {
  it('creates an active webhook and answers its secret once', async () => {
    const res = await app('webhooks:create')('/api/external-webhooks', json({
      name: 'Orders feed',
      description: 'Every new order',
      url: 'https://ok.example.com/hooks/orders',
      events: ['order.created', 'co_machine.updated'],
      headers: { 'X-Tenant': 'acme' },
    }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.status).toBe('active');
    expect(String(data.secret)).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(data.headers).toEqual({ 'X-Tenant': 'acme' });
  });

  it('refuses a plain-http URL, an empty event list and an event outside the catalog', async () => {
    const http = await app()('/api/external-webhooks', json({ name: 'x', url: 'http://ok.example.com/h', events: ['order.created'] }));
    expect(http.status).toBe(400);
    const none = await app()('/api/external-webhooks', json({ name: 'x', url: 'https://ok.example.com/h', events: [] }));
    expect(none.status).toBe(400);
    const unknown = await app()('/api/external-webhooks', json({ name: 'x', url: 'https://ok.example.com/h', events: ['nope.created'] }));
    expect(unknown.status).toBe(400);
    const noName = await app()('/api/external-webhooks', json({ url: 'not a url', events: ['order.created'] }));
    expect(noName.status).toBe(400);
  });

  it('refuses more than 20 custom headers', async () => {
    const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, 'v']));
    const res = await app()('/api/external-webhooks', json({ name: 'x', url: 'https://ok.example.com/h', events: ['order.created'], headers }));
    expect(res.status).toBe(400);
  });

  it('refuses events of a custom object that is missing or silent', async () => {
    const res = await app()('/api/external-webhooks', json({
      name: 'x',
      url: 'https://ok.example.com/h',
      events: ['co_silent.created', 'co_ghost.deleted', 'co_machine.created'],
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('co_silent.created, co_ghost.deleted');
  });

  it('is refused without webhooks:create', async () => {
    const res = await app('webhooks:read')('/api/external-webhooks', json({ name: 'x', url: 'https://ok.example.com/h', events: ['order.created'] }));
    expect(res.status).toBe(403);
  });
});

describe('reading webhooks', () => {
  it('lists, filters by status and pages with a cursor', async () => {
    const a = await create({ name: 'Paged A', url: 'https://ok.example.com/a', events: ['order.created'] });
    await create({ name: 'Paged B', url: 'https://ok.example.com/b', events: ['order.created'] });
    const paused = await app()(`/api/external-webhooks/${a.id}`, json({ status: 'paused' }, 'PATCH'));
    expect(paused.status).toBe(200);

    const all = await app('webhooks:read')('/api/external-webhooks');
    expect(all.status).toBe(200);
    const first = await app('webhooks:read')('/api/external-webhooks?limit=1');
    const page = (await first.json()) as { data: Array<{ id: string }>; pagination: { hasMore: boolean; cursor: string | null } };
    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(true);
    const next = await app('webhooks:read')(`/api/external-webhooks?limit=1&cursor=${page.pagination.cursor}`);
    expect(next.status).toBe(200);

    const onlyPaused = await app('webhooks:read')('/api/external-webhooks?status=paused');
    const pausedBody = (await onlyPaused.json()) as { data: Array<{ id: string; secret?: string }> };
    expect(pausedBody.data.map((w) => w.id)).toContain(a.id);
    expect(pausedBody.data[0].secret).toBeUndefined();
  });

  it('refuses a bad list query', async () => {
    expect((await app()('/api/external-webhooks?limit=0')).status).toBe(400);
    expect((await app()('/api/external-webhooks?status=gone')).status).toBe(400);
  });

  it('gets one webhook without its secret, and 404s an unknown one', async () => {
    const w = await create({ name: 'Single', url: 'https://ok.example.com/s', events: ['company.created'] });
    const res = await app('webhooks:read')(`/api/external-webhooks/${w.id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.secret).toBeUndefined();
    expect((await app()('/api/external-webhooks/ewh_missing000000')).status).toBe(404);
  });
});

describe('PATCH /:id', () => {
  it('updates the fields it is given', async () => {
    const w = await create({ name: 'Before', url: 'https://ok.example.com/p', events: ['order.created'] });
    const res = await app('webhooks:update')(`/api/external-webhooks/${w.id}`, json({
      name: 'After',
      description: 'renamed',
      url: 'https://ok.example.com/p2',
      events: ['order.updated', 'co_machine.deleted'],
      headers: { 'X-One': '1' },
    }, 'PATCH'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.name).toBe('After');
    expect(data.events).toEqual(['order.updated', 'co_machine.deleted']);
  });

  it('refuses an unknown custom object event, a bad status and an unknown webhook', async () => {
    const w = await create({ name: 'Guarded', url: 'https://ok.example.com/g', events: ['order.created'] });
    expect((await app()(`/api/external-webhooks/${w.id}`, json({ events: ['co_ghost.created'] }, 'PATCH'))).status).toBe(400);
    expect((await app()(`/api/external-webhooks/${w.id}`, json({ status: 'deleted' }, 'PATCH'))).status).toBe(400);
    expect((await app()('/api/external-webhooks/ewh_missing000000', json({ name: 'x' }, 'PATCH'))).status).toBe(404);
  });

  it('is refused without webhooks:update', async () => {
    const res = await app('webhooks:read')('/api/external-webhooks/ewh_missing000000', json({ name: 'x' }, 'PATCH'));
    expect(res.status).toBe(403);
  });
});

describe('POST /:id/rotate-secret', () => {
  it('answers a new secret', async () => {
    const w = await create({ name: 'Rotating', url: 'https://ok.example.com/r', events: ['order.created'] });
    const res = await app('webhooks:update')(`/api/external-webhooks/${w.id}/rotate-secret`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { secret: string } };
    expect(data.secret).toMatch(/^whsec_/);
    expect((await app()('/api/external-webhooks/ewh_missing000000/rotate-secret', { method: 'POST' })).status).toBe(404);
  });
});

describe('POST /:id/test and GET /:id/deliveries', () => {
  it('delivers a signed webhook.test event and records it', async () => {
    const fetchMock = stubReceivers();
    const w = await create({ name: 'Tested', url: 'https://ok.example.com/t', events: ['order.created'], headers: { 'X-Extra': 'yes' } });
    const res = await app('webhooks:update')(`/api/external-webhooks/${w.id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toEqual({ delivered: true, responseStatus: 200, responseBody: 'thanks', errorMessage: null });
    const sent = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://ok.example.com/t'));
    expect(sent.length).toBeGreaterThan(0);

    const deliveries = await app('webhooks:read')(`/api/external-webhooks/${w.id}/deliveries?limit=10`);
    expect(deliveries.status).toBe(200);
    const list = (await deliveries.json()) as { data: Array<{ eventType: string; status: string }> };
    expect(list.data[0]).toMatchObject({ eventType: 'webhook.test', status: 'delivered' });
  });

  it('records a failed delivery after its one retry', async () => {
    stubReceivers();
    const w = await create({ name: 'Down', url: 'https://down.example.com/t', events: ['order.created'] });
    const res = await app()(`/api/external-webhooks/${w.id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toEqual({ delivered: false, responseStatus: 500, responseBody: 'upstream down', errorMessage: 'HTTP 500' });

    const [row] = await db.select().from(schema.externalWebhooks).where(eq(schema.externalWebhooks.id, w.id));
    expect(row.consecutiveFailures).toBe(1);
    const deliveries = await app()(`/api/external-webhooks/${w.id}/deliveries`);
    const list = (await deliveries.json()) as { data: Array<{ status: string; attemptNumber: number }> };
    expect(list.data[0]).toMatchObject({ status: 'failed', attemptNumber: 2 });
  });

  it('404s an unknown webhook and refuses a bad deliveries query', async () => {
    expect((await app()('/api/external-webhooks/ewh_missing000000/test', { method: 'POST' })).status).toBe(404);
    expect((await app()('/api/external-webhooks/ewh_missing000000/deliveries')).status).toBe(404);
    expect((await app()('/api/external-webhooks/ewh_missing000000/deliveries?limit=500')).status).toBe(400);
  });
});

describe('DELETE /:id', () => {
  it('soft-deletes, then 404s', async () => {
    const w = await create({ name: 'Doomed', url: 'https://ok.example.com/d', events: ['order.created'] });
    expect((await app('webhooks:delete')(`/api/external-webhooks/${w.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app()(`/api/external-webhooks/${w.id}`)).status).toBe(404);
    expect((await app()(`/api/external-webhooks/${w.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('is refused without webhooks:delete', async () => {
    const res = await app('webhooks:read')('/api/external-webhooks/ewh_missing000000', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});
