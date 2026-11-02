/**
 * /api/mail-messages against a pglite tenant DB (postgres mode): the list and
 * its filters and cursor, counters, the reading pane and thread, flag / label
 * / thread updates, every bulk action, delete and label changes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  ADMIN,
  MEMBER,
  PRIVATE,
  SHARED,
  STRANGER,
  UNASSIGNED,
  seedMailboxes,
  seedMembers,
  seedMessages,
  seedPeople,
} from '../../test/mail-seed';

const ALL = ['messages:read', 'messages:update', 'messages:delete', 'messages:create'];

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  await seedPeople(db);
  await seedMessages(db, [
    { id: 'mmsg_m1', threadId: 'thr_m1', subject: 'Invoice 50% off', labels: ['INBOX', 'Invoices'], minutes: 1, hasAttachments: true },
    { id: 'mmsg_m2', threadId: 'thr_m1', subject: 'Re: Invoice', labels: ['INBOX'], minutes: 2, isRead: true, from: { email: 'support@acme.test', name: 'Me' } },
    { id: 'mmsg_m3', threadId: null, subject: 'No thread', labels: ['INBOX', 'STARRED'], minutes: 3, to: [{ email: 'boss@example.com', name: 'Boss' }] },
    { id: 'mmsg_m4', subject: 'Spammy', labels: ['SPAM'], minutes: 4 },
    { id: 'mmsg_m5', subject: 'Trashed', labels: ['TRASH'], minutes: 5 },
    { id: 'mmsg_m6', subject: 'Snoozed', labels: ['SNOOZED'], minutes: 6 },
    { id: 'mmsg_m7', accountId: PRIVATE, subject: 'Private', labels: ['INBOX'], minutes: 7 },
    { id: 'mmsg_m8', accountId: UNASSIGNED, subject: 'Unassigned', labels: ['INBOX'], minutes: 8 },
    { id: 'mmsg_m9', subject: 'Bulk one', labels: ['INBOX'], minutes: 9 },
    { id: 'mmsg_m10', subject: 'Bulk two', labels: ['INBOX'], minutes: 10 },
  ]);
  await db.insert(schema.mailAttachments).values([
    { id: 'attach_m1', messageId: 'mmsg_m1', fileName: 'invoice.pdf', contentType: 'application/pdf', size: 1200, storagePath: 'mail/x/invoice.pdf' },
    { id: 'attach_m1_gone', messageId: 'mmsg_m1', fileName: 'old.pdf', size: 10, deletedAt: new Date('2026-03-02T00:00:00.000Z') },
  ] as never);
  await db.insert(schema.mailDrafts).values({ id: 'draft_m1', accountId: SHARED, subject: 'Draft' } as never);
}, 60_000);

function as(userId: string, keys: string[] = ALL) {
  const { request } = createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-messages${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('reads', () => {
  it('lists with filters and pages with the message cursor', async () => {
    const member = as(MEMBER);
    for (const q of [
      '',
      `?accountId=${SHARED}`,
      `?accountId=${SHARED}&label=invoices`,
      '?label=starred',
      '?search=50%25',
      '?search=invoice%20customer',
      '?isRead=true',
      '?isRead=false&hasAttachments=true',
      '?isStarred=true&isFlagged=false',
      '?threadId=thr_m1',
      '?counterparty=BOSS@example.com',
      '?limit=2',
    ]) {
      expect((await member('GET', q)).status).toBe(200);
    }
    const first = await member('GET', '?limit=2');
    const page = (await first.json()) as { pagination: { cursor: string | null } };
    expect(page.pagination.cursor).not.toBeNull();
    expect((await member('GET', `?limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await member('GET', `?accountId=${SHARED}&limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await member('GET', '?cursor=mmsg_unknown')).status).toBe(200);
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(403);
    expect((await member('GET', '?limit=0')).status).toBe(400);
    expect((await member('GET', '?counterparty=')).status).toBe(400);
    expect((await as(ADMIN)('GET', '')).status).toBe(200);
  });

  it('counts per mailbox and across mailboxes', async () => {
    const member = as(MEMBER);
    expect((await member('GET', '/stats')).status).toBe(200);
    expect((await member('GET', `/stats?accountId=${SHARED}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `/stats?accountId=${PRIVATE}`)).status).toBe(403);
  });

  it('opens a message and its thread', async () => {
    const member = as(MEMBER);
    expect((await member('GET', '/mmsg_m1')).status).toBe(200);
    expect((await member('GET', '/mmsg_m3')).status).toBe(200);
    expect((await member('GET', `/mmsg_m1?accountId=${SHARED}`)).status).toBe(200);
    expect((await member('GET', '/mmsg_m1/thread')).status).toBe(200);
    expect((await member('GET', '/mmsg_m3/thread')).status).toBe(200);
    expect((await as(STRANGER)('GET', '/mmsg_m7')).status).toBe(403);
    expect((await as(STRANGER)('GET', '/mmsg_m7/thread')).status).toBe(403);
    expect((await member('GET', '/mmsg_missing')).status).toBe(404);
    expect((await member('GET', '/mmsg_missing/thread')).status).toBe(404);
  });
});

describe('writes', () => {
  it('updates flags, labels and threads', async () => {
    const member = as(MEMBER);
    expect((await member('PATCH', '/mmsg_m1', { isRead: true, isStarred: true })).status).toBe(200);
    expect((await member('PUT', '/mmsg_m1', { isImportant: true, isFlagged: true })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m3', { isTrash: true })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m3', { isTrash: false })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m4', { isSpam: false })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m2', { labels: ['inbox', 'invoices', 'Invoices', 'starred'] })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m2', { labels: ['ARCHIVE'], isRead: false })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m2', { threadId: 'thr_moved' })).status).toBe(200);
    expect((await member('PATCH', '/mmsg_m2', { isRead: 'yes' })).status).toBe(400);
    expect((await as(STRANGER)('PATCH', '/mmsg_m7', { isRead: true })).status).toBe(403);
    expect((await member('PATCH', '/mmsg_missing', { isRead: true })).status).toBe(404);
  });

  it('adds and removes labels on one message', async () => {
    const member = as(MEMBER);
    expect((await member('POST', '/mmsg_m9/labels/add', { labels: ['invoices', 'IMPORTANT'] })).status).toBe(200);
    expect((await member('POST', '/mmsg_m9/labels/add', { labels: ['trash'] })).status).toBe(200);
    expect((await member('POST', '/mmsg_m9/labels/remove', { labels: ['TRASH', 'Invoices'] })).status).toBe(200);
    expect((await member('POST', '/mmsg_m9/labels/add', { labels: [] })).status).toBe(400);
    expect((await as(STRANGER)('POST', '/mmsg_m7/labels/add', { labels: ['x'] })).status).toBe(403);
    expect((await member('POST', '/mmsg_missing/labels/remove', { labels: ['x'] })).status).toBe(404);
  });

  it('applies every bulk action', async () => {
    const member = as(MEMBER);
    const ids = ['mmsg_m9', 'mmsg_m10', 'mmsg_m7', 'mmsg_missing'];
    for (const action of ['markRead', 'markUnread', 'star', 'unstar', 'flag', 'unflag', 'trash', 'restore']) {
      expect((await member('POST', '/bulk', { messageIds: ids, action })).status).toBe(200);
    }
    expect((await as(STRANGER)('POST', '/bulk', { messageIds: ['mmsg_m7'], action: 'markRead' })).status).toBe(403);
    expect((await member('POST', '/bulk', { messageIds: [], action: 'markRead' })).status).toBe(400);
    expect((await member('POST', '/bulk', { messageIds: ['mmsg_m9'], action: 'explode' })).status).toBe(400);
    expect((await member('POST', '/bulk', { messageIds: ['mmsg_m10'], action: 'delete' })).status).toBe(200);
  });

  it('deletes a message', async () => {
    const member = as(MEMBER);
    expect((await as(STRANGER)('DELETE', '/mmsg_m7')).status).toBe(403);
    expect((await member('DELETE', '/mmsg_m6')).status).toBe(204);
    expect((await member('DELETE', '/mmsg_m6')).status).toBe(404);
    expect((await member('GET', '/mmsg_m6')).status).toBe(404);
  });
});
