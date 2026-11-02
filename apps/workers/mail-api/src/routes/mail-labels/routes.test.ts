/**
 * /api/mail-labels against a pglite tenant DB (postgres mode): label CRUD,
 * bulk apply and remove, thread labels and the folder lists of threads with
 * their filters and paging.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailLabelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  ADMIN,
  MEMBER,
  PRIVATE,
  SHARED,
  STRANGER,
  seedMailboxes,
  seedMembers,
  seedMessages,
  seedPeople,
} from '../../test/mail-seed';

const ALL = ['accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete', 'messages:read', 'messages:update'];

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  await seedPeople(db);
  await seedMessages(db, [
    { id: 'mmsg_l1', threadId: 'thr_a', subject: 'Invoice March', labels: ['INBOX', 'Invoices'], minutes: 1 },
    { id: 'mmsg_l2', threadId: 'thr_a', subject: 'Re: Invoice March', labels: ['INBOX'], minutes: 5, isRead: true, from: { email: 'support@acme.test', name: 'Me' } },
    { id: 'mmsg_l3', threadId: 'thr_b', subject: 'Hello there', labels: ['INBOX', 'STARRED'], minutes: 3 },
    { id: 'mmsg_l4', threadId: 'thr_c', subject: 'Spam offer', labels: ['SPAM'], minutes: 4 },
    { id: 'mmsg_l5', threadId: null, subject: 'Archived note', labels: ['ARCHIVE', 'Invoices'], minutes: 2, hasAttachments: true },
    { id: 'mmsg_l6', accountId: PRIVATE, threadId: 'thr_p', subject: 'Private thing', labels: ['INBOX'], minutes: 6, from: { email: 'friend@example.com' } },
  ]);
}, 60_000);

function as(userId: string, keys: string[] = ALL) {
  const { request } = createTestApp('/api/mail-labels', mailLabelsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-labels${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('threads by label', () => {
  it('lists folders, searches and pages', async () => {
    const member = as(MEMBER);
    for (const q of [
      '?labelSlug=inbox',
      `?labelSlug=inbox&accountId=${SHARED}`,
      '?labelSlug=invoices',
      `?labelSlug=Invoices&accountId=${SHARED}`,
      '?labelSlug=starred',
      '?labelSlug=spam',
      '?labelSlug=archive',
      '?labelSlug=all',
      '?labelSlug=inbox&search=invoice',
      '?labelSlug=inbox&from=customer',
      '?labelSlug=inbox&to=support',
      '?labelSlug=inbox&subject=hello',
      '?labelSlug=all&hasAttachment=true',
      '?labelSlug=inbox&excludeWords=invoice%20spam',
      '?labelSlug=inbox&pageSize=1',
      '?labelSlug=inbox&pageSize=1&page=2',
    ]) {
      const res = await member('GET', `/threads${q}`);
      expect(res.status).toBe(200);
    }
    const first = await member('GET', '/threads?labelSlug=inbox&pageSize=1');
    const page = (await first.json()) as { data: { nextCursor: string | null; threads: unknown[] } };
    expect(page.data.threads).toHaveLength(1);
    expect(page.data.nextCursor).not.toBeNull();
    const next = await member('GET', `/threads?labelSlug=inbox&pageSize=1&cursor=${page.data.nextCursor}`);
    expect(next.status).toBe(200);
    expect((await member('GET', '/threads?labelSlug=inbox&cursor=garbage')).status).toBe(200);
    expect((await as(STRANGER)('GET', `/threads?labelSlug=inbox&accountId=${PRIVATE}`)).status).toBe(200);
    expect((await member('GET', '/threads')).status).toBe(400);
    expect((await member('GET', '/threads?labelSlug=inbox&pageSize=500')).status).toBe(400);
  });
});

describe('bulk and thread labels', () => {
  it('adds and removes labels on messages and threads', async () => {
    const member = as(MEMBER);
    const add = await member('POST', '/add-to-messages', { labelName: 'Projects', messageIds: ['mmsg_l3', 'mmsg_l6', 'mmsg_missing'] });
    expect(add.status).toBe(200);
    const removed = await member('POST', '/remove-from-messages', { labelName: 'Projects', messageIds: ['mmsg_l3'] });
    expect(removed.status).toBe(200);
    expect((await as(STRANGER)('POST', '/add-to-messages', { labelName: 'X', messageIds: ['mmsg_l6'] })).status).toBe(403);
    expect((await member('POST', '/add-to-messages', { labelName: '', messageIds: [] })).status).toBe(400);

    const thread = await member('POST', '/apply-to-thread', { accountId: SHARED, threadId: 'thr_a', labelName: 'IMPORTANT', action: 'add' });
    expect(thread.status).toBe(200);
    expect((await member('POST', '/apply-to-thread', { accountId: SHARED, threadId: 'thr_a', labelName: 'TRASH', action: 'add' })).status).toBe(200);
    expect((await member('POST', '/apply-to-thread', { accountId: SHARED, threadId: 'thr_a', labelName: 'TRASH', action: 'remove' })).status).toBe(200);
    expect((await member('POST', '/apply-to-thread', { accountId: SHARED, threadId: 'thr_none', labelName: 'X', action: 'add' })).status).toBe(200);
    expect((await as(STRANGER)('POST', '/apply-to-thread', { accountId: PRIVATE, threadId: 'thr_p', labelName: 'X', action: 'add' })).status).toBe(403);
    expect((await member('POST', '/apply-to-thread', { accountId: SHARED, threadId: 'thr_a', labelName: 'X', action: 'toggle' })).status).toBe(400);
  });
});

describe('label CRUD', () => {
  it('creates, reads, renames and deletes labels', async () => {
    const member = as(MEMBER);
    expect((await member('GET', '')).status).toBe(200);
    expect((await member('GET', `?accountId=${SHARED}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(403);
    expect((await member('GET', '/label_seed_invoices')).status).toBe(200);
    expect((await as(STRANGER)('GET', '/label_seed_private')).status).toBe(403);
    expect((await member('GET', '/label_missing')).status).toBe(404);

    const created = await member('POST', '', { accountId: SHARED, name: 'Receipts', color: '#00ff00', aiEnabled: true, aiKeywords: ['receipt'], aiConfidence: 80 });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await member('POST', '', { accountId: SHARED, name: 'receipts' })).status).toBe(409);
    expect((await member('POST', '', { accountId: SHARED, name: 'Inbox' })).status).toBe(409);
    expect((await member('POST', '', { accountId: SHARED, name: 'x', aiConfidence: 120 })).status).toBe(400);
    expect((await as(STRANGER)('POST', '', { accountId: PRIVATE, name: 'Mine' })).status).toBe(403);

    expect((await member('PATCH', `/${id}`, { name: 'Bills', position: 3 })).status).toBe(200);
    expect((await member('PUT', `/${id}`, { color: '#0000ff' })).status).toBe(200);
    expect((await member('PATCH', '/label_seed_inbox', { name: 'Box' })).status).toBe(403);
    expect((await member('PATCH', '/label_missing', { name: 'Box' })).status).toBe(404);
    expect((await member('PATCH', '/label_seed_invoices', { name: 'Bills' })).status).toBe(409);
    expect((await member('PATCH', '/label_seed_invoices', { name: 'Invoices 2026' })).status).toBe(200);

    expect((await member('DELETE', `/${id}`)).status).toBe(200);
    expect((await member('DELETE', `/${id}`)).status).toBe(404);
    expect((await member('DELETE', '/label_seed_inbox')).status).toBe(403);
    expect((await as(ADMIN)('GET', '')).status).toBe(200);
  });
});
