/**
 * pglite-backed tests for `nextSnoozeDueAt`: the value the snooze sweep
 * stores in the D1 due index, so it must agree with what
 * `wakeDueSnoozedMessages` would later wake.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { nextSnoozeDueAt, snoozeMessage, unsnoozeMessage, wakeDueSnoozedMessages } from './snooze';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages } = schema;

let db: Database;
let accountId: string;

async function seedMessage(): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Snooze me',
    sentDate: new Date(),
    labels: ['INBOX'],
  });
  return id;
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name: 'Test', email: 'me@test.dev', isShared: true });
}, 60_000);

// nextSnoozeDueAt is workspace-wide, so every case starts from an empty mailbox.
beforeEach(async () => {
  await db.delete(mailMessages);
});

describe('nextSnoozeDueAt', () => {
  it('is null when nothing is snoozed', async () => {
    await seedMessage();
    expect(await nextSnoozeDueAt(db)).toBeNull();
  });

  it('is the earliest snooze time across the workspace', async () => {
    const later = inHours(5);
    const sooner = inHours(2);
    await snoozeMessage(db, accountId, await seedMessage(), later);
    await snoozeMessage(db, accountId, await seedMessage(), sooner);
    expect((await nextSnoozeDueAt(db))?.getTime()).toBe(sooner.getTime());
  });

  it('ignores mail that was unsnoozed or already woken', async () => {
    const early = await seedMessage();
    const kept = await seedMessage();
    const keptUntil = inHours(8);
    await snoozeMessage(db, accountId, early, inHours(1));
    await snoozeMessage(db, accountId, kept, keptUntil);
    await unsnoozeMessage(db, accountId, early);
    expect((await nextSnoozeDueAt(db))?.getTime()).toBe(keptUntil.getTime());

    // Once the remaining one has been woken there is nothing left to wait for.
    await wakeDueSnoozedMessages(db, { now: inHours(9) });
    expect(await nextSnoozeDueAt(db)).toBeNull();
  });
});
