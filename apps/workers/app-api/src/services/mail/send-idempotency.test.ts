/**
 * pglite-backed tests for the send idempotency dedup in `sendAndPersist`.
 *
 * Runs the real send+persist path under `dryRun` (skips the Cloudflare transmit,
 * MX lookup, R2, and contact upsert, but does the genuine DB work) against an
 * in-memory Postgres with the full tenant schema — including the new
 * `mail_messages.idempotency_key` column + unique index. Verifies that a
 * replayed send with the same key returns the original message without
 * recording a second one, which is the guarantee the offline-send queue relies
 * on to be safe to retry.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// `cloudflare:email` is a Workers runtime module that Vitest can't resolve in
// Node. The send path imports it transitively, but `dryRun` never invokes it —
// a stub is enough to satisfy the import. (Hoisted above the imports below.)
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { sendAndPersist } from './send';
import { createPgliteDb } from '../../test/pglite';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';
import type { Env } from '../../types';

const { mailAccounts, mailMessages } = schema;

// dryRun bypasses every binding the send path would otherwise touch, so an
// empty env is sufficient.
const env = {} as unknown as Env;
const ORG = 'org_test';
const USER = 'user_test';
const base = { to: ['rcpt@example.com'], subject: 'Hi', body: 'Body' };

let db: Database;

/** A shared account (access passes without seeding users/members). */
async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: 'sender@test.dev', isShared: true });
  return id;
}

async function countSent(accountId: string): Promise<number> {
  const rows = await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.accountId, accountId));
  return rows.length;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('sendAndPersist · idempotency (pglite, dryRun)', () => {
  it('a replayed send with the same key returns the original message and does not double-record', async () => {
    const accountId = await seedAccount();
    const first = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'key-1' }, undefined, { dryRun: true });
    const second = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'key-1' }, undefined, { dryRun: true });

    expect(second.messageId).toBe(first.messageId);
    expect(second.smtpMessageId).toBe(first.smtpMessageId);
    expect(await countSent(accountId)).toBe(1);
  });

  it('different keys produce distinct sent messages', async () => {
    const accountId = await seedAccount();
    const a = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'k-a' }, undefined, { dryRun: true });
    const b = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'k-b' }, undefined, { dryRun: true });

    expect(b.messageId).not.toBe(a.messageId);
    expect(await countSent(accountId)).toBe(2);
  });

  it('without a key every send records a new message (no dedup)', async () => {
    const accountId = await seedAccount();
    await sendAndPersist(env, db, ORG, USER, accountId, base, undefined, { dryRun: true });
    await sendAndPersist(env, db, ORG, USER, accountId, base, undefined, { dryRun: true });

    expect(await countSent(accountId)).toBe(2);
  });
});
