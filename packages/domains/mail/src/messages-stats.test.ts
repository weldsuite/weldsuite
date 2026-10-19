/**
 * pglite-backed tests for getMessageStats' trash/spam handling.
 *
 * Legacy rows can carry a location label next to TRASH/SPAM (["INBOX","TRASH"])
 * or the isTrash/isSpam flag without the label. The thread listing keeps both
 * out of every other folder, so the sidebar badges must too: otherwise the
 * inbox badge shows mail the inbox never lists.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getMessageStats } from './messages';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages } = schema;

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, isShared: true });
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
    subject: 'Stats test',
    sentDate: new Date(),
    labels,
    isRead: false,
    ...extra,
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('getMessageStats · trash and spam never count towards another folder', () => {
  it('leaves INBOX+TRASH and INBOX+SPAM rows out of the inbox badge', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['INBOX', 'TRASH']);
    await seedMessage(accountId, ['INBOX', 'SPAM']);

    const stats = await getMessageStats(db, accountId);

    expect(stats.inboxUnread).toBe(1);
    // They still count in their own folder.
    expect(stats.trashUnread).toBe(1);
    expect(stats.spam).toBe(1);
  });

  it('leaves rows flagged isTrash / isSpam (no label) out of the inbox badge', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['INBOX'], { isTrash: true });
    await seedMessage(accountId, ['INBOX'], { isSpam: true });

    expect((await getMessageStats(db, accountId)).inboxUnread).toBe(1);
  });

  it('applies the same exclusion to the archive badge', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['ARCHIVE']);
    await seedMessage(accountId, ['ARCHIVE', 'TRASH']);
    await seedMessage(accountId, ['ARCHIVE'], { isSpam: true });

    expect((await getMessageStats(db, accountId)).archiveUnread).toBe(1);
  });

  it('keeps read mail and null flags out of the unread inbox count without dropping live mail', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX'], { isTrash: null, isSpam: null });
    await seedMessage(accountId, ['INBOX'], { isRead: true });

    expect((await getMessageStats(db, accountId)).inboxUnread).toBe(1);
  });

  it('counts only the given accounts, and nothing for an empty list', async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    await seedMessage(mine, ['INBOX']);
    await seedMessage(theirs, ['INBOX']);
    await seedMessage(theirs, ['INBOX']);

    expect((await getMessageStats(db, [mine])).inboxUnread).toBe(1);
    expect((await getMessageStats(db, [mine, theirs])).inboxUnread).toBe(3);
    expect(Object.values(await getMessageStats(db, [])).every((n) => n === 0)).toBe(true);
  });
});
