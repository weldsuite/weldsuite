/**
 * POST /api/mail-threads/:threadId/read against a pglite tenant DB (postgres
 * mode): one conversation read or unread, per mailbox access.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailThreadsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers, seedMessages } from '../../test/mail-seed';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  await seedMessages(db, [
    { id: 'mmsg_t1', threadId: 'thr_t', labels: ['INBOX'], minutes: 1 },
    { id: 'mmsg_t2', threadId: 'thr_t', labels: ['INBOX'], minutes: 2 },
    { id: 'mmsg_t3', threadId: null, labels: ['INBOX', 'Invoices'], minutes: 3 },
    { id: 'mmsg_t4', accountId: PRIVATE, threadId: 'thr_p', labels: ['INBOX'], minutes: 4 },
  ]);
}, 60_000);

function as(userId: string) {
  const { request } = createTestApp('/api/mail-threads', mailThreadsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('messages:update') },
  });
  return (path: string, body: unknown) =>
    request(`/api/mail-threads${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
}

describe('thread read state', () => {
  it('marks one thread read and unread', async () => {
    const member = as(MEMBER);
    expect((await member(`/thr_t/read?accountId=${SHARED}`, { isRead: true })).status).toBe(200);
    expect((await member(`/thr_t/read?accountId=${SHARED}`, { isRead: true })).status).toBe(200);
    expect((await member(`/thr_t/read?accountId=${SHARED}`, { isRead: false })).status).toBe(200);
    expect((await member(`/mmsg_t3/read?accountId=${SHARED}`, { isRead: true })).status).toBe(200);
    expect((await member('/thr_t/read', { isRead: true })).status).toBe(400);
    expect((await member(`/thr_t/read?accountId=${SHARED}`, { isRead: 'yes' })).status).toBe(400);
    expect((await as(STRANGER)(`/thr_p/read?accountId=${PRIVATE}`, { isRead: true })).status).toBe(403);
  });

  it('marks a custom-label folder read', async () => {
    const member = as(MEMBER);
    expect((await member('/read-all', { labelSlug: 'invoices' })).status).toBe(200);
    expect((await member('/read-all', { labelSlug: 'inbox', accountId: PRIVATE })).status).toBe(200);
  });
});
