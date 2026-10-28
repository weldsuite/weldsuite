/**
 * pglite-backed tests that the thread list keeps working when the write half
 * of its two batches can't land — the concrete case is a workspace that is
 * read-only during a database move (`readOnlyReason: 'database_move'`,
 * `packages/core/worker-kit/src/db.ts`): Postgres refuses the write with a
 * read-only-transaction error, and inside a shared `db.batch` that would
 * otherwise take the batch's reads down with it (`batchWriteThenReads` in
 * `db-batch.ts`, docs/plans/weldmail-mailbox-storage.md phase 1 items 2–3).
 *
 * A `CHECK (false) NOT VALID` constraint on `mail_messages`, added after
 * seeding, simulates "every write to this table fails" without needing a
 * real read-only transaction: `NOT VALID` skips checking the rows already in
 * the table, but still enforces the check on every row an UPDATE or INSERT
 * touches from here on — exactly a write failure, nothing read-only-specific
 * about it, so this double as a test of the fallback for any write failure,
 * not only 25006. This file gets its own pglite instance (vitest resets the
 * module registry per file), so the blocking constraint never reaches the
 * other pglite-backed mail tests.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { listThreadsByLabel } from './threads';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages } = schema;

const USER = 'user_test';

let db: Database;
let accountId: string;
let dueSnoozed: string;
let expiredScheduled: string;

async function seedMessage(
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
    subject: 'Write-resilience test',
    sentDate: new Date(),
    labels,
    ...extra,
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name: 'Test', email: `${accountId}@test.dev`, isShared: true });

  dueSnoozed = await seedMessage(['SNOOZED'], { snoozedUntil: new Date(Date.now() - 60_000), isRead: true });
  expiredScheduled = await seedMessage(['SENT', 'SCHEDULED'], {
    sendStatus: 'scheduled',
    scheduledFor: new Date(Date.now() - 60_000),
  });

  // Every write to mail_messages fails from here on; reads are untouched.
  await db.execute(
    sql`ALTER TABLE mail_messages ADD CONSTRAINT mail_messages_test_block_writes CHECK (false) NOT VALID`,
  );
}, 60_000);

describe('listThreadsByLabel keeps working when its write half fails', () => {
  it('still returns the list when the snooze-wake UPDATE fails, leaving the mail snoozed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'snoozed' });

    // The wake couldn't apply, so the due mail is still labelled SNOOZED
    // instead of having moved to INBOX — proof the retry, not a lucky
    // no-op, is what kept the read alive.
    expect(threads.map((t) => t.latestMessageId)).toContain(dueSnoozed);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('waking snoozed mail'),
      expect.anything(),
    );

    warn.mockRestore();
  });

  it('still returns the list when the expire-scheduled UPDATE fails, leaving the message scheduled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'sent' });

    const thread = threads.find((t) => t.latestMessageId === expiredScheduled);
    expect(thread).toBeDefined();
    // The resolving UPDATE couldn't apply, so it reads back as still scheduled.
    expect(thread!.sendStatus).toBe('scheduled');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('resolving expired scheduled mail'),
      expect.anything(),
    );

    warn.mockRestore();
  });
});
