/**
 * pglite-backed tests for who can open a mail account.
 *
 * A private mailbox belongs to its assigned users: the admin/owner role does
 * not open it. Admins still see it in the settings view (`scope: 'manage'`)
 * and can manage it, and they are the fallback readers of a private mailbox
 * nobody is assigned to.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getMailAccount, listMailAccounts } from './accounts';
import { listThreadsByLabel } from './threads';
import { checkAccountAccess, checkAccountManageAccess } from '@weldsuite/mail-domain/access';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const OWNER = 'user_owner';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;
let shared: string;
let privateAssigned: string;
let privateUnassigned: string;
let privateMessage: string;

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

async function seedMessage(accountId: string): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Access test',
    sentDate: new Date(),
    labels: ['INBOX'],
  });
  return id;
}

async function listedIds(userId: string, scope?: 'manage'): Promise<string[]> {
  const { data } = await listMailAccounts(db, userId, { limit: 100, scope });
  return data.map((a) => a.id);
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(OWNER, 'OWNER');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  shared = await seedAccount({ isShared: true });
  privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: null });

  await seedMessage(shared);
  privateMessage = await seedMessage(privateAssigned);
}, 60_000);

describe('opening a private mailbox', () => {
  it('is refused to admins and owners who are not assigned to it', async () => {
    expect(await checkAccountAccess(db, privateAssigned, ADMIN)).toBe(false);
    expect(await checkAccountAccess(db, privateAssigned, OWNER)).toBe(false);
    expect(await getMailAccount(db, privateAssigned, ADMIN)).toBeNull();
  });

  it('is allowed to its assigned users only', async () => {
    expect(await checkAccountAccess(db, privateAssigned, ASSIGNEE)).toBe(true);
    expect(await checkAccountAccess(db, privateAssigned, MEMBER)).toBe(false);
  });

  it('falls back to admins when nobody is assigned', async () => {
    expect(await checkAccountAccess(db, privateUnassigned, ADMIN)).toBe(true);
    expect(await checkAccountAccess(db, privateUnassigned, MEMBER)).toBe(false);
  });

  it('opens for an admin once they are assigned', async () => {
    const id = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE, ADMIN] });
    expect(await checkAccountAccess(db, id, ADMIN)).toBe(true);
    expect(await checkAccountAccess(db, id, OWNER)).toBe(false);
  });
});

describe('managing a private mailbox', () => {
  it('stays with admins even when they cannot open it', async () => {
    expect(await checkAccountManageAccess(db, privateAssigned, ADMIN)).toBe(true);
    expect(await checkAccountManageAccess(db, privateAssigned, ASSIGNEE)).toBe(true);
    expect(await checkAccountManageAccess(db, privateAssigned, MEMBER)).toBe(false);
  });
});

describe('listMailAccounts', () => {
  it('lists only the mailboxes an admin can open', async () => {
    const ids = await listedIds(ADMIN);
    expect(ids).toContain(shared);
    expect(ids).toContain(privateUnassigned);
    expect(ids).not.toContain(privateAssigned);
  });

  it('lists every account for an admin in the manage scope', async () => {
    const ids = await listedIds(ADMIN, 'manage');
    expect(ids).toEqual(expect.arrayContaining([shared, privateAssigned, privateUnassigned]));
  });

  it('does not widen the list for a member asking for the manage scope', async () => {
    const ids = await listedIds(MEMBER, 'manage');
    expect(ids).toContain(shared);
    expect(ids).not.toContain(privateAssigned);
    expect(ids).not.toContain(privateUnassigned);
  });

  it('lists a private mailbox for its assignee', async () => {
    expect(await listedIds(ASSIGNEE)).toContain(privateAssigned);
  });
});

describe('listThreadsByLabel', () => {
  it('keeps a private mailbox out of an admin\'s unified inbox', async () => {
    const { threads } = await listThreadsByLabel(db, ADMIN, { labelSlug: 'inbox' });
    expect(threads.map((t) => t.latestMessageId)).not.toContain(privateMessage);
    expect(threads.length).toBeGreaterThan(0);
  });

  it('returns nothing to an admin asking for the private mailbox directly', async () => {
    const { threads } = await listThreadsByLabel(db, ADMIN, {
      accountId: privateAssigned,
      labelSlug: 'inbox',
    });
    expect(threads).toEqual([]);
  });

  it('shows the private mailbox to its assignee', async () => {
    const { threads } = await listThreadsByLabel(db, ASSIGNEE, { labelSlug: 'inbox' });
    expect(threads.map((t) => t.latestMessageId)).toContain(privateMessage);
  });
});
