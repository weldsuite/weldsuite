/**
 * pglite-backed access tests for GET /api/mail-messages/stats.
 *
 * Without an `accountId` the sidebar counters are unified. They must cover
 * the mailboxes the caller may open, not every mailbox in the workspace: a
 * count is metadata about a colleague's private mailbox too.
 *
 * Runs against the real access module (the sibling `access.test.ts` mocks it).
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { mailMessagesRoutes } from './index';
import { getMessageStats } from '@weldsuite/mail-domain/messages';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailDrafts, mailMessages, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;
let shared: string;
let privateAssigned: string;
let privateUnassigned: string;

async function seedMember(userId: string, role: string) {
  const now = new Date();
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceMembers.$inferInsert);
}

async function seedAccount(values: Partial<typeof mailAccounts.$inferInsert>): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, ...values });
  return id;
}

async function seedMessages(accountId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const id = generateId('mmsg');
    await db.insert(mailMessages).values({
      id,
      accountId,
      threadId: `thread_${id}`,
      messageId: `<${id}@test.dev>`,
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Stats test',
      sentDate: new Date(),
      labels: ['INBOX'],
      isRead: false,
    });
  }
}

async function seedDraft(accountId: string) {
  await db.insert(mailDrafts).values({
    id: generateId('draft'),
    accountId,
    subject: 'Draft',
  } as typeof mailDrafts.$inferInsert);
}

async function stats(userId: string, query = '') {
  const { request } = createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('messages:read') },
  });
  const res = await request(`/api/mail-messages/stats${query}`);
  const json = (await res.json()) as { data?: { total: number; inboxUnread: number; drafts: number } };
  return { status: res.status, data: json.data };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  shared = await seedAccount({ isShared: true });
  privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: [] });

  await seedMessages(shared, 1);
  await seedMessages(privateAssigned, 2);
  await seedMessages(privateUnassigned, 4);
  await seedDraft(shared);
  await seedDraft(privateAssigned);
}, 60_000);

describe('GET /api/mail-messages/stats · unified counters', () => {
  it('counts only shared mailboxes for an unassigned member', async () => {
    const { status, data } = await stats(MEMBER);
    expect(status).toBe(200);
    expect(data).toMatchObject({ total: 1, inboxUnread: 1, drafts: 1 });
  });

  it('adds a private mailbox for its assignee', async () => {
    const { data } = await stats(ASSIGNEE);
    expect(data).toMatchObject({ total: 3, inboxUnread: 3, drafts: 2 });
  });

  it('gives an admin the unassigned mailbox but not a colleague\'s private one', async () => {
    const { data } = await stats(ADMIN);
    expect(data).toMatchObject({ total: 5, inboxUnread: 5, drafts: 1 });
  });

  it('still refuses a specific private mailbox', async () => {
    expect((await stats(MEMBER, `?accountId=${privateAssigned}`)).status).toBe(403);
    expect((await stats(ADMIN, `?accountId=${privateAssigned}`)).status).toBe(403);
    expect((await stats(ASSIGNEE, `?accountId=${privateAssigned}`)).data).toMatchObject({ total: 2 });
  });
});

describe('getMessageStats', () => {
  it('counts nothing for an empty account list instead of every mailbox', async () => {
    const empty = await getMessageStats(db, []);
    expect(empty.total).toBe(0);
    expect(empty.drafts).toBe(0);
  });
});
