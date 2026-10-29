/**
 * Object-mode tests for `sendAndPersist`'s store wiring (design task D1):
 * the SENT copy and its attachments go through an `ingest` op (bodies land in
 * R2), idempotency replay and the daily limit are answered by the store
 * instead of a direct Postgres query. Runs `dryRun` (skips the Cloudflare
 * transmit, MX lookup and contact upsert — see send.ts's own doc comment on
 * `SendOptions.dryRun`) against a real `ObjectMailboxStore` backed by the C2
 * fakes (`store/object/testing/fake-env`, `fake-stub`), which run the real
 * `MailboxObject` class underneath — the same "fakes run the real object"
 * approach `store/object/*.test.ts` and the route-level object-mode tests use.
 *
 * `mail_accounts` stays Postgres in every mode (design §6): `sendAndPersist`
 * still loads the sending account from `db`, only the message write/reads go
 * through the store.
 */

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sendAndPersist, type MailSendEnv as Env } from './send';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { ObjectMailboxStore } from './store/object';
import { createFakeMailboxNamespace } from './store/object/testing/fake-env';
import type { MailboxRef } from './store/types';

const { mailAccounts } = schema;

const env = {} as unknown as Env;
const ORG = 'org_test';
const USER = 'user_test';
const WORKSPACE_ID = 'ws_object_send';
const base = { to: ['rcpt@example.com'], subject: 'Hi', body: 'Body text', htmlBody: '<p>Body text</p>' };

let db: Database;

async function seedAccount(opts: { dailySendLimit?: number } = {}): Promise<string> {
  const id = generateId('mail');
  await db
    .insert(mailAccounts)
    .values({ id, name: 'Test', email: 'sender@test.dev', isShared: true, dailySendLimit: opts.dailySendLimit });
  return id;
}

function storeFor(accountId: string): ObjectMailboxStore {
  const mailbox = createFakeMailboxNamespace();
  const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG };
  return new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('sendAndPersist · object mode (store supplied)', () => {
  it('persists the SENT copy through the store, with bodies readable back from R2', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);

    const result = await sendAndPersist(env, db, ORG, USER, accountId, base, { dryRun: true, store });

    const record = await store.getMessage(result.messageId, { bodies: true });
    expect(record).not.toBeNull();
    expect(record!.labels).toEqual(['SENT']);
    expect(record!.subject).toBe('Hi');
    expect(record!.textBody).toBe('Body text');
    expect(record!.htmlBody).toContain('Body text');
    expect(record!.source).toBe('sent');

    // Nothing was written to the tenant Postgres `mail_messages` row for this
    // account — the object is the whole story in object mode.
    const pgRows = await db
      .select({ id: schema.mailMessages.id })
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.accountId, accountId));
    expect(pgRows).toHaveLength(0);
  });

  it('a replayed send with the same idempotency key returns the original message, without a second ingest', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);

    const first = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'k-1' }, { dryRun: true, store });
    const second = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'k-1' }, { dryRun: true, store });

    expect(second.messageId).toBe(first.messageId);
    expect(await store.countSentSince(0)).toBe(1);
  });

  it('different idempotency keys each ingest their own message', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);

    const a = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'k-a' }, { dryRun: true, store });
    const b = await sendAndPersist(env, db, ORG, USER, accountId, { ...base, idempotencyKey: 'k-b' }, { dryRun: true, store });

    expect(b.messageId).not.toBe(a.messageId);
    expect(await store.countSentSince(0)).toBe(2);
  });

  it('the daily limit is counted from the store, not Postgres', async () => {
    const accountId = await seedAccount({ dailySendLimit: 2 });
    const store = storeFor(accountId);

    await sendAndPersist(env, db, ORG, USER, accountId, base, { dryRun: true, store, enforceDailyLimit: true });
    await sendAndPersist(env, db, ORG, USER, accountId, base, { dryRun: true, store, enforceDailyLimit: true });

    await expect(
      sendAndPersist(env, db, ORG, USER, accountId, base, { dryRun: true, store, enforceDailyLimit: true }),
    ).rejects.toMatchObject({ code: 'DAILY_LIMIT_REACHED' });

    expect(await store.countSentSince(0)).toBe(2);
  });
});
