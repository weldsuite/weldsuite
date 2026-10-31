/**
 * Every /api/parcel-notifications route on pglite: the email, SMS and
 * WhatsApp templates (list with filters and offset paging, detail, create,
 * update, toggle, delete) and the outbound webhooks (the same, plus enable,
 * disable, a test delivery and its logs). Runs against Rust in conformance
 * mode.
 *
 * Every route takes `orders:read`, writes included. The test delivery goes
 * through a `fetch` stub that answers by URL: one hook answers 200, one 500,
 * one throws as a network failure does.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { parcelNotificationsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

type Row = Record<string, unknown>;

const BASE = '/api/parcel-notifications';
const HOOKS = 'https://hooks.example';
const { emailTemplates, smsTemplates, whatsAppTemplates, externalWebhooks, webhookDeliveries } = schema;
const events = vi.mocked(publishEntityEvent);

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, parcelNotificationsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
const reader = () => app('orders:read');
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const dataOf = async (res: Response) => ((await res.json()) as { data: Row }).data;
const published = () =>
  events.mock.calls.map(([p]) => ({ entityType: p.entityType, action: p.action, entityId: p.entityId, data: p.data }));
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const notFound = (resource: string, id: string) => ({
  error: { code: 'NOT_FOUND', message: `${resource} with ID '${id}' not found` },
});
const internal = (message: string) => ({ error: { code: 'INTERNAL_ERROR', message } });

// ── The webhook receivers, answered by URL ───────────────────────────────────

const realFetch = globalThis.fetch;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = urlOf(input);
  if (url === `${HOOKS}/ok`) return new Response('ok', { status: 200 });
  if (url === `${HOOKS}/fail`) return new Response('boom', { status: 500 });
  if (url === `${HOOKS}/down`) throw new TypeError('fetch failed');
  return realFetch(input, init);
});

/** The calls that reached a receiver, with their signature checked against `secret`. */
function deliveriesTo(url: string, secret: string) {
  return fetchStub.mock.calls
    .filter(([input]) => urlOf(input) === url)
    .map(([, init]) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      return {
        method: init?.method,
        contentType: headers.get('content-type'),
        event: headers.get('x-webhook-event'),
        custom: headers.get('x-custom'),
        signed: headers.get('x-webhook-signature') === createHmac('sha256', secret).update(body).digest('hex'),
        body: JSON.parse(body) as unknown,
      };
    });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  vi.stubGlobal('fetch', fetchStub);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  events.mockClear();
  fetchStub.mockClear();
});

// ── Templates ────────────────────────────────────────────────────────────────

interface TemplateKind {
  path: 'email' | 'sms' | 'whatsapp';
  table: PgTable & { id: AnyPgColumn };
  idPrefix: string;
  /** `error.notFound`'s resource. */
  resource: string;
  /** The 500 messages' noun: `Failed to create ${one}`, `Failed to fetch ${many}`. */
  one: string;
  many: string;
  /** The column `search` looks in besides `name`. */
  text: 'subject' | 'message';
  seed: (n: number) => Row;
  create: { body: Row; stored: Row };
  invalid: Row[];
  /** A body the schema accepts that the table can't store. */
  unstorable: Row;
  update: { body: Row; stored: Row };
  invalidUpdate: Row;
}

const KINDS: TemplateKind[] = [
  {
    path: 'email',
    table: emailTemplates,
    idPrefix: 'etpl',
    resource: 'Email template',
    one: 'email template',
    many: 'email templates',
    text: 'subject',
    seed: (n) => ({ name: `Email ${n}`, subject: `Subject ${n}` }),
    create: {
      body: {
        name: 'Shipped',
        subject: 'Your parcel {{tracking}} shipped',
        body: 'Hi',
        htmlBody: '<p>Hi</p>',
        variables: ['tracking'],
        triggerEvent: 'parcel_shipped',
        description: 'Sent on shipping',
        tags: ['shipping'],
        notInTheSchema: true,
      },
      stored: {
        name: 'Shipped',
        subject: 'Your parcel {{tracking}} shipped',
        body: 'Hi',
        htmlBody: '<p>Hi</p>',
        variables: ['tracking'],
        triggerEvent: 'parcel_shipped',
        description: 'Sent on shipping',
        tags: ['shipping'],
        isActive: true,
        isDefault: false,
        usageCount: 0,
      },
    },
    invalid: [
      {},
      { name: 'No subject' },
      { name: '', subject: 's' },
      { name: 'x', subject: 's', variables: 'tracking' },
      { name: 'x', subject: 's', isActive: 'yes' },
      { name: 'x', subject: 's', tags: [1] },
    ],
    unstorable: { name: 'x'.repeat(256), subject: 's' },
    update: {
      body: { name: 'Renamed', isDefault: true, tags: ['a'], htmlBody: '<p>New</p>' },
      stored: { name: 'Renamed', isDefault: true, tags: ['a'], htmlBody: '<p>New</p>', subject: 'Subject 9', isActive: true },
    },
    invalidUpdate: { htmlBody: null },
  },
  {
    path: 'sms',
    table: smsTemplates,
    idPrefix: 'stpl',
    resource: 'SMS template',
    one: 'SMS template',
    many: 'SMS templates',
    text: 'message',
    seed: (n) => ({ name: `SMS ${n}`, message: `Message ${n}` }),
    create: {
      body: { name: 'Out for delivery', message: 'Parcel {{tracking}} arrives today', variables: ['tracking'], isDefault: true },
      stored: {
        name: 'Out for delivery',
        message: 'Parcel {{tracking}} arrives today',
        variables: ['tracking'],
        maxLength: 160,
        isActive: true,
        isDefault: true,
        triggerEvent: null,
      },
    },
    invalid: [{}, { name: 'No message' }, { name: 'x', message: '' }, { name: 'x', message: 'm', maxLength: '160' }],
    unstorable: { name: 'x'.repeat(256), message: 'm' },
    update: {
      body: { message: 'Updated text', maxLength: 70 },
      stored: { message: 'Updated text', maxLength: 70, name: 'SMS 9' },
    },
    invalidUpdate: { maxLength: 'long' },
  },
  {
    path: 'whatsapp',
    table: whatsAppTemplates,
    idPrefix: 'wtpl',
    resource: 'WhatsApp template',
    one: 'WhatsApp template',
    many: 'WhatsApp templates',
    text: 'message',
    seed: (n) => ({ name: `WhatsApp ${n}`, message: `Message ${n}` }),
    create: {
      body: {
        name: 'Delivered',
        message: 'Delivered!',
        headerText: 'WeldSuite',
        footerText: 'Reply STOP',
        mediaType: 'image',
        mediaUrl: 'https://cdn.example/box.png',
        buttons: [{ type: 'url', text: 'Track', url: 'https://track.example' }],
        isActive: false,
        // Not in the create schema: every new template is pending.
        approvalStatus: 'approved',
      },
      stored: {
        name: 'Delivered',
        message: 'Delivered!',
        headerText: 'WeldSuite',
        footerText: 'Reply STOP',
        mediaType: 'image',
        mediaUrl: 'https://cdn.example/box.png',
        buttons: [{ type: 'url', text: 'Track', url: 'https://track.example' }],
        isActive: false,
        isDefault: false,
        approvalStatus: 'pending',
      },
    },
    invalid: [
      {},
      { name: 'x', message: 'm', buttons: [{ type: 'link', text: 'x' }] },
      { name: 'x', message: 'm', buttons: [{ type: 'url' }] },
      { name: 'x', message: 'm', mediaUrl: 5 },
    ],
    unstorable: { name: 'x', message: 'm', mediaType: 'x'.repeat(21) },
    update: {
      body: { approvalStatus: 'approved', footerText: 'Bye' },
      stored: { approvalStatus: 'approved', footerText: 'Bye', name: 'WhatsApp 9' },
    },
    invalidUpdate: { approvalStatus: 'maybe' },
  },
];

function describeTemplates(kind: TemplateKind): void {
  const base = `${BASE}/${kind.path}`;
  const t = kind.table;
  const p = kind.idPrefix;
  const id = (name: string) => `${p}_${name}`;
  const row = async (rowId: string) => (await db.select().from(t).where(eq(t.id, rowId)).limit(1))[0] as Row | undefined;
  type Page = { data: { templates: Row[]; pagination: Row } };
  const page = async (query = '') => {
    const res = await reader().request(`${base}${query}`);
    expect(res.status, query).toBe(200);
    return ((await res.json()) as Page).data;
  };
  const listed = async (query = '') => (await page(query)).templates.map((r) => r.id);
  // Newest first.
  const live = ['put', 'del', 't6', 't5', 't4', 't3', 't2', 't1'].map(id);

  describe(`${base}`, () => {
    it('GET / answers an empty first page on an empty table', async () => {
      expect(await page()).toEqual({
        templates: [],
        pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
      });
    });

    describe('with templates', () => {
      beforeAll(async () => {
        const seed = (name: string, n: number, extra: Row = {}) =>
          db.insert(t).values({ ...kind.seed(n), id: id(name), createdAt: at(n), updatedAt: at(n), ...extra } as never);
        await seed('t1', 1);
        await seed('t2', 2, { isActive: false, triggerEvent: 'parcel_delivered' });
        await seed('t3', 3, { name: 'Needle notice' });
        await seed('t4', 4, { [kind.text]: 'Your needle has shipped' });
        await seed('t5', 5, {
          lastUsedAt: at(50),
          usageCount: 7,
          tags: ['vip'],
          variables: ['name'],
          ...(kind.path === 'whatsapp' ? { approvalStatus: 'approved' } : {}),
        });
        await seed('t6', 6, { isActive: null });
        await seed('gone', 7, { deletedAt: at(60) });
        await seed('del', 8);
        await seed('put', 9);
      });

      it('GET / lists the live templates newest first, with offset paging', async () => {
        const first = await page();
        expect(first.templates.map((r) => r.id)).toEqual(live);
        expect(first.pagination).toEqual({ page: 1, pageSize: 20, totalCount: 8, totalPages: 1, hasMore: false });
        expect(await page('?page=2&pageSize=3')).toEqual({
          templates: expect.any(Array),
          pagination: { page: 2, pageSize: 3, totalCount: 8, totalPages: 3, hasMore: true },
        });
        expect(await listed('?page=2&pageSize=3')).toEqual(live.slice(3, 6));
        expect((await page('?page=3&pageSize=3')).pagination).toEqual({ page: 3, pageSize: 3, totalCount: 8, totalPages: 3, hasMore: false });
        expect(await listed('?page=3&pageSize=3')).toEqual(live.slice(6));
      });

      it('GET / answers each row whole, its dates as ISO strings; an unset lastUsedAt is left out', async () => {
        const { templates } = await page();
        const t5 = templates.find((r) => r.id === id('t5'))!;
        expect(t5).toMatchObject({
          ...kind.seed(5),
          id: id('t5'),
          createdAt: '2026-01-01T12:00:05.000Z',
          updatedAt: '2026-01-01T12:00:05.000Z',
          deletedAt: null,
          lastUsedAt: '2026-01-01T12:00:50.000Z',
          usageCount: 7,
          tags: ['vip'],
          variables: ['name'],
          isActive: true,
          isDefault: false,
          description: null,
          triggerEvent: null,
        });
        const t1 = templates.find((r) => r.id === id('t1'))!;
        expect(t1).not.toHaveProperty('lastUsedAt');
        expect(t1).toMatchObject({ tags: null, variables: null, usageCount: 0 });
      });

      it('GET / page and pageSize follow JavaScript', async () => {
        // NaN serialises as null; a NaN LIMIT or OFFSET is left out.
        expect(await page('?page=abc')).toEqual({
          templates: expect.any(Array),
          pagination: { page: null, pageSize: 20, totalCount: 8, totalPages: 1, hasMore: false },
        });
        expect(await listed('?page=abc')).toEqual(live);
        expect(await page('?pageSize=abc')).toEqual({
          templates: expect.any(Array),
          pagination: { page: 1, pageSize: null, totalCount: 8, totalPages: null, hasMore: false },
        });
        expect(await listed('?pageSize=abc')).toEqual(live);
        // LIMIT 0; 8 / 0 is Infinity, serialised as null.
        expect(await page('?pageSize=0')).toEqual({
          templates: [],
          pagination: { page: 1, pageSize: 0, totalCount: 8, totalPages: null, hasMore: true },
        });
        // A negative LIMIT is left out.
        expect((await page('?pageSize=-5')).pagination).toEqual({ page: 1, pageSize: -5, totalCount: 8, totalPages: -1, hasMore: true });
        expect(await listed('?pageSize=-5')).toEqual(live);
        expect((await page('?page=0&pageSize=2.9')).pagination).toEqual({ page: 1, pageSize: 2, totalCount: 8, totalPages: 4, hasMore: true });
        expect((await page('?pageSize=500')).pagination).toMatchObject({ pageSize: 100 });
        // A negative OFFSET is a database error.
        const res = await reader().request(`${base}?page=2&pageSize=-5`);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual(internal(`Failed to fetch ${kind.many}`));
      });

      it('GET / filters by search, isActive and triggerEvent', async () => {
        // LIKE on name or the text column: case-sensitive.
        expect(await listed('?search=Needle')).toEqual([id('t3')]);
        expect(await listed('?search=needle')).toEqual([id('t4')]);
        expect(await listed('?search=')).toEqual(live);
        // isActive is `=== 'true'`: anything else, an empty value included, is false. NULL matches neither.
        expect(await listed('?isActive=true')).toEqual(live.filter((r) => r !== id('t2') && r !== id('t6')));
        expect(await listed('?isActive=false')).toEqual([id('t2')]);
        expect(await listed('?isActive=')).toEqual([id('t2')]);
        expect(await listed('?isActive=yes')).toEqual([id('t2')]);
        expect(await listed('?triggerEvent=parcel_delivered')).toEqual([id('t2')]);
        expect(await listed('?triggerEvent=')).toEqual(live);
        expect((await page('?triggerEvent=parcel_delivered&isActive=true')).pagination).toMatchObject({ totalCount: 0 });
        if (kind.path === 'whatsapp') {
          expect(await listed('?approvalStatus=approved')).toEqual([id('t5')]);
          expect(await listed('?approvalStatus=pending')).toEqual(live.filter((r) => r !== id('t5')));
        }
      });

      it('GET /:id answers the template; 404 when missing or deleted', async () => {
        const { request } = reader();
        const res = await request(`${base}/${id('t5')}`);
        expect(res.status).toBe(200);
        expect(await dataOf(res)).toMatchObject({ id: id('t5'), lastUsedAt: '2026-01-01T12:00:50.000Z', usageCount: 7 });
        expect(await dataOf(await request(`${base}/${id('t1')}`))).not.toHaveProperty('lastUsedAt');
        const missing = await request(`${base}/${p}_missing`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual(notFound(kind.resource, `${p}_missing`));
        expect((await request(`${base}/${id('gone')}`)).status).toBe(404);
      });

      it('POST / creates with the schema defaults and publishes created', async () => {
        const res = await reader().request(base, json(kind.create.body));
        expect(res.status).toBe(201);
        const data = await dataOf(res);
        expect(Object.keys(data)).toEqual(['id']);
        expect(data.id).toMatch(new RegExp(`^${p}_[0-9a-z]+$`));
        expect(await dataOf(await reader().request(`${base}/${String(data.id)}`))).toMatchObject({
          ...kind.create.stored,
          createdAt: expect.stringMatching(ISO),
        });
        expect(published()).toEqual([
          {
            entityType: 'notification_template',
            action: 'created',
            entityId: expect.stringMatching(new RegExp(`^${p}_`)),
            data: { id: expect.stringMatching(new RegExp(`^${p}_`)), templateType: kind.path, name: kind.create.body.name },
          },
        ]);
      });

      it('POST / refusals: 400 for a bad body, the route 500 for one the table cannot store', async () => {
        const { request } = reader();
        for (const body of kind.invalid) {
          expect((await request(base, json(body))).status, JSON.stringify(body)).toBe(400);
        }
        const res = await request(base, json(kind.unstorable));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual(internal(`Failed to create ${kind.one}`));
        expect(published()).toEqual([]);
      });

      it('PUT /:id writes the keys sent and publishes updated', async () => {
        const res = await reader().request(`${base}/${id('put')}`, json(kind.update.body, 'PUT'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: { id: id('put') } });
        expect(await row(id('put'))).toMatchObject(kind.update.stored);
        expect(published()).toEqual([
          { entityType: 'notification_template', action: 'updated', entityId: id('put'), data: { id: id('put'), templateType: kind.path } },
        ]);
      });

      it("PUT /:id leaves out the create schema's defaults", async () => {
        const res = await reader().request(`${base}/${id('t2')}`, json({ description: 'Still off' }, 'PUT'));
        expect(res.status).toBe(200);
        expect(await row(id('t2'))).toMatchObject({ description: 'Still off', isActive: false, isDefault: false });
        expect((await reader().request(`${base}/${id('t2')}`, json({}, 'PUT'))).status).toBe(200);
      });

      it('PUT /:id refusals: 404, 400 and the route 500', async () => {
        const { request } = reader();
        const missing = await request(`${base}/${p}_missing`, json(kind.update.body, 'PUT'));
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual(notFound(kind.resource, `${p}_missing`));
        expect((await request(`${base}/${id('gone')}`, json(kind.update.body, 'PUT'))).status).toBe(404);
        expect((await request(`${base}/${id('put')}`, json(kind.invalidUpdate, 'PUT'))).status).toBe(400);
        const res = await request(`${base}/${id('put')}`, json({ name: 'x'.repeat(256) }, 'PUT'));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual(internal(`Failed to update ${kind.one}`));
        expect(published()).toEqual([]);
      });

      it('PATCH /:id/toggle flips isActive (NULL counts as off) and publishes it', async () => {
        const { request } = reader();
        const on = await request(`${base}/${id('t6')}/toggle`, { method: 'PATCH' });
        expect(on.status).toBe(200);
        expect(await on.json()).toEqual({ data: { id: id('t6'), isActive: true } });
        expect(await row(id('t6'))).toMatchObject({ isActive: true });
        const off = await request(`${base}/${id('t6')}/toggle`, { method: 'PATCH' });
        expect(await off.json()).toEqual({ data: { id: id('t6'), isActive: false } });
        expect(published()).toEqual([
          { entityType: 'notification_template', action: 'updated', entityId: id('t6'), data: { id: id('t6'), templateType: kind.path, isActive: true } },
          { entityType: 'notification_template', action: 'updated', entityId: id('t6'), data: { id: id('t6'), templateType: kind.path, isActive: false } },
        ]);
        const missing = await request(`${base}/${id('gone')}/toggle`, { method: 'PATCH' });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual(notFound(kind.resource, id('gone')));
      });

      it('DELETE /:id soft-deletes and publishes deleted; 404 once gone', async () => {
        const { request } = reader();
        const res = await request(`${base}/${id('del')}`, { method: 'DELETE' });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
        expect((await row(id('del')))?.deletedAt).toBeInstanceOf(Date);
        expect(published()).toEqual([
          { entityType: 'notification_template', action: 'deleted', entityId: id('del'), data: { id: id('del'), templateType: kind.path } },
        ]);
        const again = await request(`${base}/${id('del')}`, { method: 'DELETE' });
        expect(again.status).toBe(404);
        expect(await again.json()).toEqual(notFound(kind.resource, id('del')));
        expect((await request(`${base}/${id('del')}`)).status).toBe(404);
      });
    });
  });
}

for (const kind of KINDS) describeTemplates(kind);

// ── Webhooks ─────────────────────────────────────────────────────────────────

describe(`${BASE}/webhooks`, () => {
  const W = `${BASE}/webhooks`;
  const hook = async (webhookId: string) =>
    (await db.select().from(externalWebhooks).where(eq(externalWebhooks.id, webhookId)).limit(1))[0];
  const lastDelivery = async (webhookId: string) =>
    (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, webhookId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(1)
    )[0];
  type WebhookPage = { webhooks: Row[]; pagination: Row };
  const list = async (query = '') => (await dataOf(await reader().request(`${W}${query}`))) as unknown as WebhookPage;
  const live = ['whk_put', 'whk_del', 'whk_c', 'whk_b', 'whk_a'];
  const TEST_PAYLOAD = { event: 'test', timestamp: expect.stringMatching(ISO), data: { message: 'This is a test webhook delivery' } };

  it('GET / answers an empty first page before any webhook exists', async () => {
    expect(await list()).toEqual({
      webhooks: [],
      pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
    });
  });

  describe('with webhooks', () => {
    beforeAll(async () => {
      const base = (webhookId: string, second: number) => ({
        id: webhookId,
        name: `Hook ${webhookId}`,
        url: `${HOOKS}/${webhookId}`,
        secret: `whksec_${webhookId}`,
        createdBy: 'user_seed',
        createdAt: at(second),
        updatedAt: at(second),
      });
      await db.insert(externalWebhooks).values([
        {
          ...base('whk_a', 1),
          name: 'Ops',
          description: 'Ops hook',
          url: `${HOOKS}/ok`,
          events: ['parcel.shipped'],
          headers: { 'X-Custom': '1' },
          totalDeliveries: 3,
          totalFailures: 2,
          consecutiveFailures: 2,
          lastDeliveredAt: at(40),
        },
        {
          ...base('whk_b', 2),
          url: `${HOOKS}/fail`,
          status: 'paused',
          events: ['parcel.delivered'],
          totalFailures: 1,
          consecutiveFailures: 1,
          lastFailedAt: at(41),
          lastFailureReason: 'HTTP 502',
        },
        { ...base('whk_c', 3), url: `${HOOKS}/down`, status: 'disabled' },
        { ...base('whk_gone', 4), deletedAt: at(50) },
        { ...base('whk_del', 5), events: ['a'] },
        { ...base('whk_put', 6), events: ['a'] },
      ]);
      const delivery = (deliveryId: string, webhookId: string, createdAt: Date, extra: Row = {}) => ({
        id: deliveryId,
        webhookId,
        eventType: 'parcel.shipped',
        eventId: `evt_${deliveryId}`,
        payload: { parcelId: 'par_1' },
        createdAt,
        ...extra,
      });
      await db.insert(webhookDeliveries).values([
        delivery('whdel_1', 'whk_a', new Date(Date.UTC(2026, 0, 1, 10)), {
          status: 'delivered',
          responseStatus: 200,
          responseTimeMs: 120,
          deliveredAt: new Date(Date.UTC(2026, 0, 1, 10, 0, 1)),
        }),
        delivery('whdel_2', 'whk_a', new Date(Date.UTC(2026, 0, 1, 11)), {
          status: 'failed',
          responseStatus: 503,
          errorMessage: 'HTTP 503',
          attemptNumber: 2,
        }),
        delivery('whdel_3', 'whk_a', new Date(Date.UTC(2026, 0, 1, 12))),
        delivery('whdel_gone', 'whk_gone', new Date(Date.UTC(2026, 0, 1, 12))),
      ]);
    });

    it('GET / lists the live webhooks newest first', async () => {
      const page = await list();
      expect(page.webhooks.map((w) => w.id)).toEqual(live);
      expect(page.pagination).toEqual({ page: 1, pageSize: 20, totalCount: 5, totalPages: 1, hasMore: false });
      expect(page.webhooks.find((w) => w.id === 'whk_a')).toEqual({
        id: 'whk_a',
        name: 'Ops',
        description: 'Ops hook',
        url: `${HOOKS}/ok`,
        events: ['parcel.shipped'],
        status: 'active',
        isActive: true,
        callCount: 3,
        totalDeliveries: 3,
        totalFailures: 2,
        consecutiveFailures: 2,
        lastDeliveredAt: '2026-01-01T12:00:40.000Z',
        createdAt: '2026-01-01T12:00:01.000Z',
        updatedAt: '2026-01-01T12:00:01.000Z',
      });
      // An empty events column is [], unset dates are left out.
      expect(page.webhooks.find((w) => w.id === 'whk_c')).toEqual({
        id: 'whk_c',
        name: 'Hook whk_c',
        description: null,
        url: `${HOOKS}/down`,
        events: [],
        status: 'disabled',
        isActive: false,
        callCount: 0,
        totalDeliveries: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        createdAt: '2026-01-01T12:00:03.000Z',
        updatedAt: '2026-01-01T12:00:03.000Z',
      });
    });

    it('GET / filters by status (all, or none, is every status) and pages', async () => {
      const ids = async (query: string) => (await list(query)).webhooks.map((w) => w.id);
      expect(await ids('?status=active')).toEqual(['whk_put', 'whk_del', 'whk_a']);
      expect(await ids('?status=paused')).toEqual(['whk_b']);
      expect(await ids('?status=disabled')).toEqual(['whk_c']);
      expect(await ids('?status=all')).toEqual(live);
      expect(await ids('?status=')).toEqual(live);
      expect((await list('?page=2&pageSize=2')).pagination).toEqual({ page: 2, pageSize: 2, totalCount: 5, totalPages: 3, hasMore: true });
      expect(await ids('?page=2&pageSize=2')).toEqual(['whk_c', 'whk_b']);
      expect((await list('?page=x&pageSize=0')).pagination).toEqual({ page: null, pageSize: 0, totalCount: 5, totalPages: null, hasMore: false });
      const res = await reader().request(`${W}?page=3&pageSize=-1`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(internal('Failed to fetch webhooks'));
    });

    it('GET /:id answers the webhook with its headers and failure reason; 404 when missing or deleted', async () => {
      const { request } = reader();
      expect(await dataOf(await request(`${W}/whk_b`))).toEqual({
        id: 'whk_b',
        name: 'Hook whk_b',
        description: null,
        url: `${HOOKS}/fail`,
        events: ['parcel.delivered'],
        status: 'paused',
        isActive: false,
        headers: null,
        totalDeliveries: 0,
        totalFailures: 1,
        consecutiveFailures: 1,
        lastFailedAt: '2026-01-01T12:00:41.000Z',
        lastFailureReason: 'HTTP 502',
        createdAt: '2026-01-01T12:00:02.000Z',
        updatedAt: '2026-01-01T12:00:02.000Z',
      });
      expect(await dataOf(await request(`${W}/whk_a`))).toMatchObject({ headers: { 'X-Custom': '1' }, lastFailureReason: null });
      const missing = await request(`${W}/whk_missing`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(notFound('Webhook', 'whk_missing'));
      expect((await request(`${W}/whk_gone`)).status).toBe(404);
    });

    it('POST / stores the webhook with the secret sent, active, by the caller', async () => {
      const body = {
        name: 'Warehouse',
        url: `${HOOKS}/warehouse`,
        events: ['parcel.created', 'parcel.shipped'],
        secret: 'whksec_given',
        description: 'Tells the warehouse',
        headers: { Authorization: 'Bearer x' },
      };
      const res = await reader().request(W, json(body));
      expect(res.status).toBe(201);
      const data = await dataOf(res);
      expect(data).toEqual({ id: expect.stringMatching(/^whk_[0-9a-z]+$/), secret: 'whksec_given' });
      expect(await hook(String(data.id))).toMatchObject({
        ...body,
        status: 'active',
        createdBy: 'user_test_default',
        totalDeliveries: 0,
        consecutiveFailures: 0,
        deletedAt: null,
      });
      expect(published()).toEqual([
        {
          entityType: 'notification_template',
          action: 'created',
          entityId: expect.stringMatching(/^whk_/),
          data: { id: expect.stringMatching(/^whk_/), templateType: 'webhook', name: 'Warehouse' },
        },
      ]);
    });

    it('POST / draws a signing secret when none is sent', async () => {
      const res = await reader().request(W, json({ name: 'Drawn', url: `${HOOKS}/drawn`, events: ['parcel.created'] }));
      expect(res.status).toBe(201);
      const data = await dataOf(res);
      expect(data.secret).toMatch(/^whksec_[A-Za-z0-9]{32}$/);
      expect(await hook(String(data.id))).toMatchObject({ secret: data.secret, description: null, headers: null });
    });

    it('POST / refusals: 400 for a bad body, the route 500 for one the table cannot store', async () => {
      const { request } = reader();
      const valid = { name: 'x', url: `${HOOKS}/x`, events: ['a'] };
      for (const body of [
        {},
        { ...valid, name: '' },
        { ...valid, url: 'not a url' },
        { ...valid, events: [] },
        { ...valid, events: 'a' },
        { ...valid, headers: { 'X-Number': 1 } },
        { ...valid, secret: 5 },
      ]) {
        expect((await request(W, json(body))).status, JSON.stringify(body)).toBe(400);
      }
      const res = await request(W, json({ ...valid, name: 'x'.repeat(256) }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(internal('Failed to create webhook'));
      expect(published()).toEqual([]);
    });

    it('PUT /:id writes the keys sent and publishes updated', async () => {
      const body = { url: `${HOOKS}/new`, events: ['b', 'c'], secret: 'whksec_new', headers: { 'X-A': 'b' } };
      const res = await reader().request(`${W}/whk_put`, json(body, 'PUT'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: 'whk_put' } });
      expect(await hook('whk_put')).toMatchObject({ ...body, name: 'Hook whk_put', status: 'active' });
      expect(published()).toEqual([
        { entityType: 'notification_template', action: 'updated', entityId: 'whk_put', data: { id: 'whk_put', templateType: 'webhook' } },
      ]);
      expect((await reader().request(`${W}/whk_put`, json({}, 'PUT'))).status).toBe(200);
    });

    it('PUT /:id refusals: 404, 400 and the route 500', async () => {
      const { request } = reader();
      const missing = await request(`${W}/whk_missing`, json({ name: 'x' }, 'PUT'));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(notFound('Webhook', 'whk_missing'));
      expect((await request(`${W}/whk_gone`, json({ name: 'x' }, 'PUT'))).status).toBe(404);
      expect((await request(`${W}/whk_put`, json({ url: 'nope' }, 'PUT'))).status).toBe(400);
      expect((await request(`${W}/whk_put`, json({ events: [] }, 'PUT'))).status).toBe(400);
      const res = await request(`${W}/whk_put`, json({ name: 'x'.repeat(256) }, 'PUT'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(internal('Failed to update webhook'));
    });

    it('PATCH /:id/disable and /:id/enable set the status and publish it', async () => {
      const { request } = reader();
      const off = await request(`${W}/whk_put/disable`, { method: 'PATCH' });
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ data: { id: 'whk_put', status: 'paused' } });
      expect(await hook('whk_put')).toMatchObject({ status: 'paused' });
      const on = await request(`${W}/whk_put/enable`, { method: 'PATCH' });
      expect(await on.json()).toEqual({ data: { id: 'whk_put', status: 'active' } });
      expect(await hook('whk_put')).toMatchObject({ status: 'active' });
      expect(published()).toEqual([
        { entityType: 'notification_template', action: 'updated', entityId: 'whk_put', data: { id: 'whk_put', templateType: 'webhook', status: 'paused' } },
        { entityType: 'notification_template', action: 'updated', entityId: 'whk_put', data: { id: 'whk_put', templateType: 'webhook', status: 'active' } },
      ]);
      for (const action of ['enable', 'disable']) {
        const missing = await request(`${W}/whk_gone/${action}`, { method: 'PATCH' });
        expect(missing.status, action).toBe(404);
        expect(await missing.json()).toEqual(notFound('Webhook', 'whk_gone'));
      }
    });

    it('GET /:id/logs pages the deliveries newest first', async () => {
      const logs = (await dataOf(await reader().request(`${W}/whk_a/logs`))) as { items: Row[]; meta: Row };
      expect(logs.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
      expect(logs.items).toEqual([
        {
          id: 'whdel_3',
          eventType: 'parcel.shipped',
          eventId: 'evt_whdel_3',
          status: 'pending',
          responseStatus: null,
          responseTimeMs: null,
          errorMessage: null,
          attemptNumber: 1,
          createdAt: '2026-01-01T12:00:00.000Z',
        },
        {
          id: 'whdel_2',
          eventType: 'parcel.shipped',
          eventId: 'evt_whdel_2',
          status: 'failed',
          responseStatus: 503,
          responseTimeMs: null,
          errorMessage: 'HTTP 503',
          attemptNumber: 2,
          createdAt: '2026-01-01T11:00:00.000Z',
        },
        {
          id: 'whdel_1',
          eventType: 'parcel.shipped',
          eventId: 'evt_whdel_1',
          status: 'delivered',
          responseStatus: 200,
          responseTimeMs: 120,
          errorMessage: null,
          attemptNumber: 1,
          createdAt: '2026-01-01T10:00:00.000Z',
          deliveredAt: '2026-01-01T10:00:01.000Z',
        },
      ]);
      const second = (await dataOf(await reader().request(`${W}/whk_a/logs?page=2&pageSize=2`))) as { items: Row[]; meta: Row };
      expect(second.items.map((d) => d.id)).toEqual(['whdel_1']);
      expect(second.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it("GET /:id/logs doesn't look the webhook up: a deleted or unknown one answers its deliveries", async () => {
      const gone = (await dataOf(await reader().request(`${W}/whk_gone/logs`))) as { items: Row[]; meta: Row };
      expect(gone.items.map((d) => d.id)).toEqual(['whdel_gone']);
      expect(await dataOf(await reader().request(`${W}/whk_missing/logs?page=abc`))).toEqual({
        items: [],
        meta: { page: null, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('POST /:id/test delivers a signed test payload and records the delivery', async () => {
      const res = await reader().request(`${W}/whk_a/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await dataOf(res)).toEqual({ delivered: true, status: 200, responseTimeMs: expect.any(Number) });
      const sent = deliveriesTo(`${HOOKS}/ok`, 'whksec_whk_a');
      expect(sent.length).toBeGreaterThan(0);
      for (const call of sent) {
        expect(call).toEqual({
          method: 'POST',
          contentType: 'application/json',
          event: 'test',
          // The webhook's own headers go along.
          custom: '1',
          signed: true,
          body: TEST_PAYLOAD,
        });
      }
      expect(await lastDelivery('whk_a')).toMatchObject({
        eventType: 'test',
        eventId: expect.stringMatching(/^test_\d+$/),
        payload: TEST_PAYLOAD,
        status: 'delivered',
        responseStatus: 200,
        responseBody: 'ok',
        responseTimeMs: expect.any(Number),
        attemptNumber: 1,
        errorMessage: null,
        deliveredAt: expect.any(Date),
      });
      expect(await hook('whk_a')).toMatchObject({ totalDeliveries: 4, consecutiveFailures: 0, totalFailures: 2 });
      const logs = (await dataOf(await reader().request(`${W}/whk_a/logs`))) as { items: Row[]; meta: Row };
      expect(logs.meta).toMatchObject({ total: 4 });
      expect(logs.items[0]).toMatchObject({ eventType: 'test', status: 'delivered', responseStatus: 200, deliveredAt: expect.stringMatching(ISO) });
    });

    it('POST /:id/test records a non-2xx answer as a failure, whatever the status', async () => {
      // whk_b is paused: the test delivery doesn't look.
      const res = await reader().request(`${W}/whk_b/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await dataOf(res)).toEqual({ delivered: false, status: 500, error: 'boom' });
      expect(deliveriesTo(`${HOOKS}/fail`, 'whksec_whk_b').every((call) => call.signed && call.custom === null)).toBe(true);
      expect(await lastDelivery('whk_b')).toMatchObject({
        eventType: 'test',
        status: 'failed',
        responseStatus: 500,
        responseBody: 'boom',
        errorMessage: 'HTTP 500',
        deliveredAt: null,
      });
      expect(await hook('whk_b')).toMatchObject({
        totalFailures: 2,
        consecutiveFailures: 2,
        lastFailureReason: 'HTTP 500',
        lastFailedAt: expect.any(Date),
        totalDeliveries: 0,
      });
    });

    it('POST /:id/test records a network failure with its message', async () => {
      const res = await reader().request(`${W}/whk_c/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await dataOf(res)).toEqual({ delivered: false, error: 'fetch failed' });
      expect(deliveriesTo(`${HOOKS}/down`, 'whksec_whk_c').length).toBeGreaterThan(0);
      expect(await lastDelivery('whk_c')).toMatchObject({
        status: 'failed',
        responseStatus: null,
        responseBody: null,
        responseTimeMs: null,
        errorMessage: 'fetch failed',
      });
      expect(await hook('whk_c')).toMatchObject({ totalFailures: 1, consecutiveFailures: 1, lastFailureReason: 'fetch failed' });
    });

    it('POST /:id/test 404 for a missing or deleted webhook, calling nobody', async () => {
      const { request } = reader();
      const missing = await request(`${W}/whk_missing/test`, { method: 'POST' });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(notFound('Webhook', 'whk_missing'));
      expect((await request(`${W}/whk_gone/test`, { method: 'POST' })).status).toBe(404);
      expect(fetchStub.mock.calls.filter(([input]) => urlOf(input).startsWith(HOOKS))).toEqual([]);
    });

    it('DELETE /:id soft-deletes and publishes deleted; 404 once gone', async () => {
      const { request } = reader();
      const res = await request(`${W}/whk_del`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect((await hook('whk_del'))?.deletedAt).toBeInstanceOf(Date);
      expect(published()).toEqual([
        { entityType: 'notification_template', action: 'deleted', entityId: 'whk_del', data: { id: 'whk_del', templateType: 'webhook' } },
      ]);
      const again = await request(`${W}/whk_del`, { method: 'DELETE' });
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual(notFound('Webhook', 'whk_del'));
    });
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────

describe('refusals', () => {
  const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
    ...KINDS.flatMap(({ path }) => [
      { method: 'GET', path: `/${path}` },
      { method: 'GET', path: `/${path}/x` },
      { method: 'POST', path: `/${path}`, body: { name: 'x', subject: 'x', message: 'x' } },
      { method: 'PUT', path: `/${path}/x`, body: { name: 'x' } },
      { method: 'PATCH', path: `/${path}/x/toggle` },
      { method: 'DELETE', path: `/${path}/x` },
    ]),
    { method: 'GET', path: '/webhooks' },
    { method: 'GET', path: '/webhooks/x' },
    { method: 'POST', path: '/webhooks', body: { name: 'x', url: `${HOOKS}/x`, events: ['a'] } },
    { method: 'PUT', path: '/webhooks/x', body: { name: 'x' } },
    { method: 'PATCH', path: '/webhooks/x/enable' },
    { method: 'PATCH', path: '/webhooks/x/disable' },
    { method: 'POST', path: '/webhooks/x/test' },
    { method: 'GET', path: '/webhooks/x/logs' },
    { method: 'DELETE', path: '/webhooks/x' },
  ];

  it('every route needs orders:read, writes included', async () => {
    expect(ROUTES).toHaveLength(27);
    const { request } = app('orders:create', 'orders:update', 'orders:delete');
    for (const route of ROUTES) {
      const init = route.body === undefined ? { method: route.method } : json(route.body, route.method);
      expect((await request(`${BASE}${route.path}`, init)).status, `${route.method} ${route.path}`).toBe(403);
    }
    expect(published()).toEqual([]);
  });
});
