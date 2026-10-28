/**
 * pglite-backed tests for the generic `create_record` / `update_record` /
 * `delete_record` / `query_data` actions and MAIL-003.
 *
 * A sequence run (unlike `send_email`, which already resolves a specific
 * account) acts for no workspace member, so it can satisfy neither half of
 * MAIL-003 (sharing or per-user assignment). Generic record actions are
 * therefore scoped to shared mailboxes only — see `sharedMailboxCondition` /
 * `assertMailEntityCreatable` in `./entity-tables.ts`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// `action-handlers.ts` imports `@weldsuite/worker-email` for `send_email`
// (unused by these tests), which imports the Workers-only `cloudflare:email`
// module. Stub it so the file can load under plain Node, same as
// `packages/domains/mail/src/outbound/guard.test.ts`.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import {
  executeAction,
  type ActionContext,
  type ActionEnv,
} from './action-handlers';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
let sharedAccountId: string;
let privateAccountId: string;

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenant: { workspaceId: 'ws_test', userId: 'user_test' },
    executionId: 'wex_test',
    db,
    env: {} as ActionEnv,
    previousResults: {},
    triggerData: {},
    variables: {},
    ...overrides,
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  sharedAccountId = 'mail_shared_seq_test';
  await db.insert(schema.mailAccounts).values({
    id: sharedAccountId,
    name: 'Shared',
    email: 'shared-seq@test.dev',
    isShared: true,
  });

  privateAccountId = 'mail_private_seq_test';
  await db.insert(schema.mailAccounts).values({
    id: privateAccountId,
    name: 'Private',
    email: 'private-seq@test.dev',
    isShared: false,
    assignedUserIds: ['user_someone'],
  });
}, 60_000);

function messageInput(accountId: string, id: string) {
  return {
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'a@test.dev' },
    to: [{ email: 'b@test.dev' }],
    subject: 'hi',
    sentDate: new Date(),
    labels: [],
  };
}

async function seedMessage(accountId: string, id: string) {
  await db.insert(schema.mailMessages).values({ id, ...messageInput(accountId, id) });
}

describe('create_record and MAIL-003', () => {
  it('refuses a mail_message targeting a private account', async () => {
    await expect(
      executeAction('create_record', { entity: 'mail_message', data: messageInput(privateAccountId, 'seq_x') }, makeCtx()),
    ).rejects.toThrow(/shared mailbox/i);
  });

  it('creates a mail_message targeting a shared account', async () => {
    const res = (await executeAction(
      'create_record',
      { entity: 'mail_message', data: messageInput(sharedAccountId, 'seq_y') },
      makeCtx(),
    )) as { created: boolean };
    expect(res.created).toBe(true);
  });

  it('refuses to create a mail_account explicitly marked private', async () => {
    await expect(
      executeAction(
        'create_record',
        { entity: 'mail_account', data: { name: 'New', email: 'new-seq@test.dev', isShared: false } },
        makeCtx(),
      ),
    ).rejects.toThrow(/shared mail account/i);
  });

  it('creates a mail_account as shared even when isShared is left unset', async () => {
    const res = (await executeAction(
      'create_record',
      { entity: 'mail_account', data: { name: 'New', email: 'new-seq-2@test.dev' } },
      makeCtx(),
    )) as { record: { isShared: boolean } };
    expect(res.record.isShared).toBe(true);
  });
});

describe('update_record / delete_record and MAIL-003', () => {
  it('cannot update a private mailbox\'s message', async () => {
    await seedMessage(privateAccountId, 'seq_upd_private');
    await expect(
      executeAction(
        'update_record',
        { entity: 'mail_message', id: 'seq_upd_private', data: { subject: 'changed' } },
        makeCtx(),
      ),
    ).rejects.toThrow(/not found/i);
    const [row] = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, 'seq_upd_private'));
    expect(row?.subject).toBe('hi');
  });

  it('updates a shared mailbox\'s message', async () => {
    await seedMessage(sharedAccountId, 'seq_upd_shared');
    const res = (await executeAction(
      'update_record',
      { entity: 'mail_message', id: 'seq_upd_shared', data: { subject: 'changed' } },
      makeCtx(),
    )) as { updated: boolean };
    expect(res.updated).toBe(true);
  });

  it('cannot hard-delete a private mailbox\'s message', async () => {
    await seedMessage(privateAccountId, 'seq_del_private');
    await executeAction('delete_record', { entity: 'mail_message', id: 'seq_del_private', hardDelete: true }, makeCtx());
    const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, 'seq_del_private'));
    expect(rows).toHaveLength(1);
  });

  it('hard-deletes a shared mailbox\'s message', async () => {
    await seedMessage(sharedAccountId, 'seq_del_shared');
    await executeAction('delete_record', { entity: 'mail_message', id: 'seq_del_shared', hardDelete: true }, makeCtx());
    const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, 'seq_del_shared'));
    expect(rows).toHaveLength(0);
  });
});

describe('query_data and MAIL-003', () => {
  it('excludes a private mailbox\'s messages from a generic mail_message query', async () => {
    await seedMessage(sharedAccountId, 'seq_q_shared');
    await seedMessage(privateAccountId, 'seq_q_private');

    const res = (await executeAction('query_data', { entity: 'mail_message' }, makeCtx())) as {
      records: Array<{ id: string }>;
    };
    const ids = res.records.map((r) => r.id);
    expect(ids).toContain('seq_q_shared');
    expect(ids).not.toContain('seq_q_private');
  });

  it('excludes a private account from a generic mail_account query', async () => {
    const res = (await executeAction('query_data', { entity: 'mail_account' }, makeCtx())) as {
      records: Array<{ id: string }>;
    };
    const ids = res.records.map((r) => r.id);
    expect(ids).toContain(sharedAccountId);
    expect(ids).not.toContain(privateAccountId);
  });
});
