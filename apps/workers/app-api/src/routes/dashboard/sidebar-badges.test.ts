/**
 * pglite-backed access test for GET /api/dashboard/sidebar-badges.
 *
 * The unread-mail badge is not gated on a mail permission, and it used to
 * count unread messages across every mailbox. It must only count the
 * mailboxes the caller may open (`@weldsuite/mail-domain/access`).
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { dashboardRoutes } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;

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

async function seedMessages(accountId: string, count: number, isRead = false) {
  for (let i = 0; i < count; i++) {
    const id = generateId('mmsg');
    await db.insert(mailMessages).values({
      id,
      accountId,
      threadId: `thread_${id}`,
      messageId: `<${id}@test.dev>`,
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Badge test',
      sentDate: new Date(),
      labels: ['INBOX'],
      isRead,
    });
  }
}

async function unreadBadge(userId: string): Promise<number> {
  const { request } = createTestApp('/api/dashboard', dashboardRoutes, {
    context: { userId, tenantDb: db },
  });
  const res = await request('/api/dashboard/sidebar-badges');
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { unreadMessages: number } };
  return json.data.unreadMessages;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  const shared = await seedAccount({ isShared: true });
  const privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  const privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: null });

  await seedMessages(shared, 1);
  await seedMessages(shared, 3, true);
  await seedMessages(privateAssigned, 2);
  await seedMessages(privateUnassigned, 4);
}, 60_000);

describe('GET /api/dashboard/sidebar-badges · unreadMessages', () => {
  it('counts only shared mailboxes for an unassigned member', async () => {
    expect(await unreadBadge(MEMBER)).toBe(1);
  });

  it('adds a private mailbox for its assignee', async () => {
    expect(await unreadBadge(ASSIGNEE)).toBe(3);
  });

  it('gives an admin the unassigned mailbox but not a colleague\'s private one', async () => {
    expect(await unreadBadge(ADMIN)).toBe(5);
  });
});
