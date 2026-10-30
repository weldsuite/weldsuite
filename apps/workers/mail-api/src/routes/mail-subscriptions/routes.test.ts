/**
 * /api/mail-subscriptions against a pglite tenant DB (postgres mode): the
 * list and its filter, the scan (no raw MIME store, so it records nothing),
 * and every way to unsubscribe: one-click POST (to a fetch stub), mailto
 * (through SEND_EMAIL), the link, and the refusals.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mailSubscriptionsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers, seedMessages } from '../../test/mail-seed';

let db: Database;
const sendEmail = createSendEmailStub({});

// Anything else (the conformance harness's own calls) goes to the real fetch.
const realFetch = globalThis.fetch;
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://news.example.com/unsub/ok') return new Response(null, { status: 200 });
  if (url === 'https://news.example.com/unsub/broken') return new Response('no', { status: 500 });
  return realFetch(input, init);
});

const kv = {
  values: new Map<string, string>([['mx:lists.example.com', '1'], ['mx:nomx.example', '0']]),
  get: async (key: string) => kv.values.get(key) ?? null,
  put: async (key: string, value: string) => {
    kv.values.set(key, value);
  },
  delete: async (key: string) => {
    kv.values.delete(key);
  },
};

const at = new Date('2026-09-01T10:00:00.000Z');

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  await seedMessages(db, [{ id: 'mmsg_sub_1', subject: 'Weekly news' }]);
  await db.update(schema.mailMessages).set({ source: 'inbound', sentDate: new Date() });
  const row = (id: string, sender: string, extra: Record<string, unknown>) => ({
    id,
    accountId: SHARED,
    senderEmail: sender,
    senderDomain: sender.split('@')[1],
    messageCount: 3,
    firstReceivedAt: at,
    lastReceivedAt: new Date(at.getTime() + id.length * 60_000),
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
  await db.insert(schema.mailSubscriptions).values([
    row('msub_oneclick', 'a@news.example.com', { unsubscribeUrl: 'https://news.example.com/unsub/ok', oneClick: true }),
    row('msub_mailto', 'b@lists.example.com', { unsubscribeMailto: 'mailto:leave@lists.example.com?subject=Stop%20please' }),
    row('msub_link', 'c@news.example.com', { unsubscribeUrl: 'https://news.example.com/unsub/page' }),
    row('msub_broken', 'd@news.example.com', { unsubscribeUrl: 'https://news.example.com/unsub/broken', oneClick: true }),
    row('msub_none', 'e@news.example.com', { unsubscribeUrl: 'http://insecure.example.com/x' }),
    row('msub_badmail', 'g@news.example.com', { unsubscribeMailto: 'mailto:leave@nomx.example' }),
    { ...row('msub_private', 'f@news.example.com', { unsubscribeUrl: 'https://news.example.com/unsub/ok' }), accountId: PRIVATE },
  ] as never);
}, 60_000);

function as(userId: string) {
  const { request } = createTestApp('/api/mail-subscriptions', mailSubscriptionsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('messages:read', 'messages:update') },
    env: { SEND_EMAIL: sendEmail, WORKSPACE_CACHE: kv } as never,
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-subscriptions${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('mail subscriptions', () => {
  it('lists and scans', async () => {
    const member = as(MEMBER);
    expect((await member('GET', `?accountId=${SHARED}`)).status).toBe(200);
    expect((await member('GET', `?accountId=${SHARED}&status=active`)).status).toBe(200);
    expect((await member('GET', '')).status).toBe(400);
    expect((await member('GET', `?accountId=${SHARED}&status=gone`)).status).toBe(400);
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(404);
    expect((await member('POST', '/scan', { accountId: SHARED })).status).toBe(200);
    expect((await member('POST', '/scan', {})).status).toBe(400);
    expect((await as(STRANGER)('POST', '/scan', { accountId: PRIVATE })).status).toBe(404);
  });

  it('unsubscribes every way it can', async () => {
    const member = as(MEMBER);
    for (const id of ['msub_oneclick', 'msub_mailto', 'msub_link', 'msub_broken']) {
      expect((await member('POST', `/${id}/unsubscribe`)).status).toBe(200);
    }
    expect((await member('POST', '/msub_none/unsubscribe')).status).toBe(400);
    expect((await member('POST', '/msub_badmail/unsubscribe')).status).toBe(502);
    expect((await member('POST', '/msub_missing/unsubscribe')).status).toBe(404);
    expect((await as(STRANGER)('POST', '/msub_private/unsubscribe')).status).toBe(404);
    expect((await member('GET', `?accountId=${SHARED}&status=unsubscribed`)).status).toBe(200);
  });
});
