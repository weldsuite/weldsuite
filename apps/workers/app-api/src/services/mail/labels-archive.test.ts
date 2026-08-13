/**
 * pglite-backed tests for archive/inbox location labels on a thread.
 *
 * Archiving must add ARCHIVE *and* strip INBOX so the conversation leaves
 * the inbox list (unified and per-account). The inverse — moving back to
 * the inbox — must drop ARCHIVE.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { applyLabelToThread } from './labels';
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

async function seedThread(
  accountId: string,
  labels: string[],
  threadId = 'thread_archive_1',
): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Archive me',
    sentDate: new Date(),
    labels,
  });
  return id;
}

async function labelsOf(messageId: string): Promise<string[]> {
  const [row] = await db
    .select({ labels: mailMessages.labels })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);
  return (row?.labels as string[] | null) ?? [];
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('applyLabelToThread · archive vs inbox', () => {
  it('adding ARCHIVE strips INBOX so the thread leaves the inbox', async () => {
    const accountId = await seedAccount();
    const messageId = await seedThread(accountId, ['INBOX']);

    const result = await applyLabelToThread(db, accountId, 'thread_archive_1', 'ARCHIVE', 'add');

    expect(result.affected).toBeGreaterThan(0);
    const labels = await labelsOf(messageId);
    expect(labels).toContain('ARCHIVE');
    expect(labels).not.toContain('INBOX');
  });

  it('normalises a lowercase archive slug and still strips INBOX', async () => {
    const accountId = await seedAccount();
    const threadId = 'thread_archive_lc';
    const messageId = await seedThread(accountId, ['INBOX'], threadId);

    await applyLabelToThread(db, accountId, threadId, 'archive', 'add');

    const labels = await labelsOf(messageId);
    expect(labels).toContain('ARCHIVE');
    expect(labels).not.toContain('INBOX');
  });

  it('strips INBOX even when ARCHIVE is already present', async () => {
    const accountId = await seedAccount();
    const threadId = 'thread_archive_both';
    const messageId = await seedThread(accountId, ['INBOX', 'ARCHIVE'], threadId);

    const result = await applyLabelToThread(db, accountId, threadId, 'ARCHIVE', 'add');

    expect(result.affected).toBeGreaterThan(0);
    const labels = await labelsOf(messageId);
    expect(labels).toContain('ARCHIVE');
    expect(labels).not.toContain('INBOX');
  });

  it('adding INBOX strips ARCHIVE', async () => {
    const accountId = await seedAccount();
    const threadId = 'thread_unarchive';
    const messageId = await seedThread(accountId, ['ARCHIVE'], threadId);

    await applyLabelToThread(db, accountId, threadId, 'INBOX', 'add');

    const labels = await labelsOf(messageId);
    expect(labels).toContain('INBOX');
    expect(labels).not.toContain('ARCHIVE');
  });

  it('does not touch a different account\'s thread with the same threadId', async () => {
    const accountA = await seedAccount();
    const accountB = await seedAccount();
    const threadId = 'thread_shared_id';
    const msgA = await seedThread(accountA, ['INBOX'], threadId);
    const msgB = await seedThread(accountB, ['INBOX'], threadId);

    await applyLabelToThread(db, accountA, threadId, 'ARCHIVE', 'add');

    expect(await labelsOf(msgA)).not.toContain('INBOX');
    expect(await labelsOf(msgB)).toEqual(['INBOX']);
  });
});
