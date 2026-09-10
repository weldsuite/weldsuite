/**
 * pglite-backed tests for mark-as-spam / not-spam label sync on updateMessage.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { updateMessage } from './messages';
import { createPgliteDb } from '../../test/pglite';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';

const { mailAccounts, mailMessages } = schema;

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({
    id,
    name: 'Test',
    email: 'me@test.dev',
    isShared: true,
  });
  return id;
}

async function seedMessage(accountId: string, labels: string[], isSpam = false): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Spam sync',
    sentDate: new Date(),
    labels,
    isSpam,
  });
  return id;
}

async function rowOf(messageId: string) {
  const [row] = await db
    .select({ labels: mailMessages.labels, isSpam: mailMessages.isSpam })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);
  return row!;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('updateMessage spam label sync', () => {
  it('moves INBOX → SPAM when marking as spam', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    const after = await updateMessage(db, id, { isSpam: true });
    expect(after?.isSpam).toBe(true);
    expect(after?.labels).toEqual(['SPAM']);

    const row = await rowOf(id);
    expect(row.isSpam).toBe(true);
    expect(row.labels).toEqual(['SPAM']);
  });

  it('moves SPAM → INBOX when marking as not spam', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['SPAM'], true);

    const after = await updateMessage(db, id, { isSpam: false });
    expect(after?.isSpam).toBe(false);
    expect(after?.labels).toEqual(['INBOX']);
  });

  it('does not re-add INBOX when not-spam on a trashed message', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['TRASH', 'SPAM'], true);

    const after = await updateMessage(db, id, { isSpam: false });
    expect(after?.isSpam).toBe(false);
    expect(after?.labels).toEqual(['TRASH']);
  });

  it('lets explicit labels override auto sync', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    const after = await updateMessage(db, id, {
      isSpam: true,
      labels: ['INBOX', 'SPAM', 'IMPORTANT'],
    });
    expect(after?.isSpam).toBe(true);
    expect(after?.labels).toEqual(['INBOX', 'SPAM', 'IMPORTANT']);
  });
});
