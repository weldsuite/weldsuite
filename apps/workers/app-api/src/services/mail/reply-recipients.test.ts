/**
 * pglite-backed tests for the recipients `replyAndPersist` derives from the
 * original message.
 *
 * A plain reply goes to the sender alone; a reply-all also keeps everyone on
 * the original To/Cc lines — Cc recipients staying on Cc — minus the mailbox
 * doing the replying. The WeldMail "Reply all" button shows that same set in
 * its To field, so a drift here is a drift between what the user sees and who
 * actually receives the mail.
 *
 * Runs under `dryRun`: real DB work, no Cloudflare transmit or MX lookup.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// `cloudflare:email` is a Workers runtime module Vitest can't resolve in Node;
// `dryRun` never invokes it, so a stub satisfies the transitive import.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { replyAndPersist } from './send';
import { createPgliteDb } from '../../test/pglite';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';
import type { Env } from '../../types';

const { mailAccounts, mailMessages } = schema;

const env = {} as unknown as Env;
const ORG = 'org_test';
const USER = 'user_test';
const SELF = 'me@test.dev';

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: SELF, isShared: true });
  return id;
}

/** An inbound message addressed to us plus a couple of other people. */
async function seedIncoming(accountId: string): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: SELF }, { email: 'teammate@example.com' }],
    cc: [{ email: 'watcher@example.com' }, { email: SELF }],
    subject: 'Quarterly numbers',
    sentDate: new Date(),
  });
  return id;
}

async function sentRecipients(messageId: string) {
  const [row] = await db
    .select({ to: mailMessages.to, cc: mailMessages.cc })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);
  return {
    to: (row?.to ?? []).map((a) => a.email),
    cc: (row?.cc ?? []).map((a) => a.email),
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('replyAndPersist · recipients (pglite, dryRun)', () => {
  it('a plain reply goes to the original sender only', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);

    const result = await replyAndPersist(env, db, ORG, USER, original, { body: 'Thanks' }, undefined, { dryRun: true });

    expect(await sentRecipients(result.messageId)).toEqual({ to: ['sender@example.com'], cc: [] });
  });

  it('reply-all keeps the other To recipients and Cc recipients, dropping our own address', async () => {
    const accountId = await seedAccount();
    const original = await seedIncoming(accountId);

    const result = await replyAndPersist(
      env,
      db,
      ORG,
      USER,
      original,
      { body: 'Thanks all', replyAll: true },
      undefined,
      { dryRun: true },
    );

    expect(await sentRecipients(result.messageId)).toEqual({
      to: ['sender@example.com', 'teammate@example.com'],
      cc: ['watcher@example.com'],
    });
  });

  it('reply-all on a message with no other recipients matches a plain reply', async () => {
    const accountId = await seedAccount();
    const id = generateId('mmsg');
    await db.insert(mailMessages).values({
      id,
      accountId,
      messageId: `<${id}@test.dev>`,
      from: { email: 'solo@example.com' },
      to: [{ email: SELF }],
      subject: 'Just you',
      sentDate: new Date(),
    });

    const result = await replyAndPersist(env, db, ORG, USER, id, { body: 'Hi', replyAll: true }, undefined, { dryRun: true });

    expect(await sentRecipients(result.messageId)).toEqual({ to: ['solo@example.com'], cc: [] });
  });
});
