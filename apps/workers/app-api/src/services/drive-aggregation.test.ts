/**
 * pglite-backed access tests for the unified drive feed and its counters.
 *
 * Mail attachments are the one drive source with per-record access: a file
 * name from a private mailbox must only reach the users who may open that
 * mailbox (`@weldsuite/mail-domain/access`). `files:read` alone is not enough,
 * and neither is the admin/owner role.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { aggregateAllFiles, aggregateStats } from './drive-aggregation';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailAttachments, mailMessages, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const OWNER = 'user_owner';
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

/** One account holding one message with one attachment named `fileName`. */
async function seedMailbox(
  fileName: string,
  account: Partial<typeof mailAccounts.$inferInsert>,
  attachment: Partial<typeof mailAttachments.$inferInsert> = {},
) {
  const accountId = generateId('mail');
  await db
    .insert(mailAccounts)
    .values({ id: accountId, name: 'Test', email: `${accountId}@test.dev`, ...account });

  const messageId = generateId('mmsg');
  await db.insert(mailMessages).values({
    id: messageId,
    accountId,
    threadId: `thread_${messageId}`,
    messageId: `<${messageId}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Drive test',
    sentDate: new Date(),
    labels: ['INBOX'],
  });

  await db
    .insert(mailAttachments)
    .values({ id: generateId('matt'), messageId, fileName, ...attachment });
}

async function mailFileNames(userId: string): Promise<string[]> {
  const files = await aggregateAllFiles(db, { userId, source: 'mail' });
  return files.map((f) => f.name).sort();
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(OWNER, 'OWNER');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  await seedMailbox('shared.pdf', { isShared: true });
  await seedMailbox('private.pdf', { isShared: false, assignedUserIds: [ASSIGNEE] });
  await seedMailbox('unassigned.pdf', { isShared: false, assignedUserIds: null });
  await seedMailbox('removed.pdf', { isShared: true }, { deletedAt: new Date() });
  await seedMailbox('closed-account.pdf', { isShared: true, deletedAt: new Date() });
}, 60_000);

describe('aggregateAllFiles · mail attachments', () => {
  it('lists only shared-mailbox attachments for an unassigned member', async () => {
    expect(await mailFileNames(MEMBER)).toEqual(['shared.pdf']);
  });

  it('adds a private mailbox for its assignee', async () => {
    expect(await mailFileNames(ASSIGNEE)).toEqual(['private.pdf', 'shared.pdf']);
  });

  it('gives admins and owners the unassigned mailbox but not a colleague\'s private one', async () => {
    expect(await mailFileNames(ADMIN)).toEqual(['shared.pdf', 'unassigned.pdf']);
    expect(await mailFileNames(OWNER)).toEqual(['shared.pdf', 'unassigned.pdf']);
  });

  it('applies the same scope to the unfiltered feed', async () => {
    const names = (await aggregateAllFiles(db, { userId: MEMBER })).map((f) => f.name);
    expect(names).toContain('shared.pdf');
    expect(names).not.toContain('private.pdf');
    expect(names).not.toContain('unassigned.pdf');
  });

  it('skips the mail query entirely for another source', async () => {
    const files = await aggregateAllFiles(db, { userId: ASSIGNEE, source: 'drive' });
    expect(files.filter((f) => f.source === 'mail')).toEqual([]);
  });
});

describe('aggregateStats · mail counter', () => {
  it('counts what the feed would list, per caller', async () => {
    expect((await aggregateStats(db, MEMBER)).bySource.mail).toBe(1);
    expect((await aggregateStats(db, ASSIGNEE)).bySource.mail).toBe(2);
    expect((await aggregateStats(db, ADMIN)).bySource.mail).toBe(2);
  });

  it('keeps the total in step with the scoped counter', async () => {
    const member = await aggregateStats(db, MEMBER);
    const assignee = await aggregateStats(db, ASSIGNEE);
    expect(assignee.totalFiles - member.totalFiles).toBe(1);
  });
});
