/**
 * pglite-backed tests for "mark all as read" (`markFolderRead`): it acts on
 * the threads the folder lists, whole threads, and only in mailboxes the
 * caller may open.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { inArray } from 'drizzle-orm';

import { markFolderRead } from './thread-ops';
import { listThreadsByLabel } from './threads';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages } = schema;

const USER = 'user_test';

let db: Database;

async function seedAccount(access: { isShared?: boolean; assignedUserIds?: string[] } = { isShared: true }) {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, ...access });
  return id;
}

async function seedMessage(
  accountId: string,
  labels: string[],
  extra: Partial<typeof mailMessages.$inferInsert> = {},
): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Mark all test',
    sentDate: new Date(),
    labels,
    isRead: false,
    ...extra,
  });
  return id;
}

async function unreadIds(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: mailMessages.id, isRead: mailMessages.isRead })
    .from(mailMessages)
    .where(inArray(mailMessages.id, ids));
  return rows.filter((r) => !r.isRead).map((r) => r.id).sort();
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('markFolderRead', () => {
  it('marks every thread the folder lists, replies in other folders included', async () => {
    const accountId = await seedAccount();
    const inbox = await seedMessage(accountId, ['INBOX']);
    const head = await seedMessage(accountId, ['INBOX']);
    const archivedReply = await seedMessage(accountId, ['ARCHIVE'], { threadId: `thread_${head}` });
    const alreadyRead = await seedMessage(accountId, ['INBOX'], { isRead: true });
    const trashed = await seedMessage(accountId, ['TRASH']);
    const archived = await seedMessage(accountId, ['ARCHIVE']);

    const result = await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' });

    expect(result.updatedCount).toBe(3);
    expect(result.updated.map((r) => r.id).sort()).toEqual([inbox, head, archivedReply].sort());
    expect(await unreadIds([inbox, head, archivedReply, alreadyRead, trashed, archived])).toEqual(
      [trashed, archived].sort(),
    );

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'inbox' });
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.every((t) => t.unreadCount === 0)).toBe(true);
  });

  it('leaves the other mailboxes alone', async () => {
    const accountId = await seedAccount();
    const other = await seedAccount();
    const mine = await seedMessage(accountId, ['INBOX']);
    const theirs = await seedMessage(other, ['INBOX']);

    await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' });

    expect(await unreadIds([mine, theirs])).toEqual([theirs]);
  });

  it('does nothing in a mailbox the caller may not open', async () => {
    const privateAccount = await seedAccount({ isShared: false, assignedUserIds: ['user_someone_else'] });
    const message = await seedMessage(privateAccount, ['INBOX']);

    const result = await markFolderRead(db, USER, { accountId: privateAccount, labelSlug: 'inbox' });

    expect(result).toEqual({ updatedCount: 0, updated: [] });
    expect(await unreadIds([message])).toEqual([message]);
  });

  it('covers only the readable mailboxes in the unified folder', async () => {
    const shared = await seedAccount();
    const privateAccount = await seedAccount({ isShared: false, assignedUserIds: ['user_someone_else'] });
    const readable = await seedMessage(shared, ['INBOX']);
    const hidden = await seedMessage(privateAccount, ['INBOX']);

    const result = await markFolderRead(db, USER, { labelSlug: 'inbox' });

    expect(result.updated.some((r) => r.id === readable)).toBe(true);
    expect(result.updated.some((r) => r.id === hidden)).toBe(false);
    expect(await unreadIds([readable, hidden])).toEqual([hidden]);
  });

  it('lists the updated messages newest first', async () => {
    const accountId = await seedAccount();
    const older = await seedMessage(accountId, ['INBOX'], { receivedDate: new Date('2026-01-01T00:00:00Z') });
    const newer = await seedMessage(accountId, ['INBOX'], { receivedDate: new Date('2026-06-01T00:00:00Z') });

    const result = await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' });

    expect(result.updated).toEqual([
      { id: newer, accountId },
      { id: older, accountId },
    ]);
  });

  describe('in batches', () => {
    async function seedDated(accountId: string, count: number): Promise<string[]> {
      const ids: string[] = [];
      // Oldest first, so ids[count - 1] is the newest message.
      for (let i = 0; i < count; i++) {
        ids.push(await seedMessage(accountId, ['INBOX'], { receivedDate: new Date(Date.UTC(2026, 0, 1 + i)) }));
      }
      return ids;
    }

    it('marks everything across several batches and counts it all', async () => {
      const accountId = await seedAccount();
      const ids = await seedDated(accountId, 7);

      const result = await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' }, { batchSize: 3 });

      expect(result.updatedCount).toBe(7);
      expect(result.updated.map((r) => r.id)).toEqual([...ids].reverse());
      expect(await unreadIds(ids)).toEqual([]);
    });

    it('keeps the newest messages per mailbox for the push and still counts all', async () => {
      const accountId = await seedAccount();
      const ids = await seedDated(accountId, 5);

      const result = await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' }, { batchSize: 2, updatedPerAccount: 3 });

      expect(result.updatedCount).toBe(5);
      expect(result.updated.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
      expect(await unreadIds(ids)).toEqual([]);
    });

    it('stops at the batch cap, newest mail first, and a second call finishes the rest', async () => {
      const accountId = await seedAccount();
      const ids = await seedDated(accountId, 5);

      const first = await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' }, { batchSize: 2, maxBatches: 2 });
      expect(first.updatedCount).toBe(4);
      expect(await unreadIds(ids)).toEqual([ids[0]]);

      const second = await markFolderRead(db, USER, { accountId, labelSlug: 'inbox' }, { batchSize: 2, maxBatches: 2 });
      expect(second.updatedCount).toBe(1);
      expect(await unreadIds(ids)).toEqual([]);
    });
  });
});
