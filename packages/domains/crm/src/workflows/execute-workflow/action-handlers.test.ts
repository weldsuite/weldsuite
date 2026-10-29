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

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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

// `entity-tables.ts`'s MAIL-009 guard resolves `ctx.tenant.workspaceId` (the
// Clerk org id) to `workspaces.id` via `getWorkspaceForOrg`
// (`@weldsuite/worker-kit/db`), which queries the master DB through a real
// Neon connection. Stubbed here as the identity function — these tests only
// care about the mail-store-mode decision, not workspace resolution.
// `importOriginal` keeps `schema`/`Database`/everything else this file (and
// `entity-tables.ts`, which resolves to the same module) imports real.
const { getWorkspaceForOrgMock } = vi.hoisted(() => ({
  getWorkspaceForOrgMock: vi.fn(async (_env: unknown, ref: string) => ({ id: ref, clerkOrgId: null })),
}));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getWorkspaceForOrg: getWorkspaceForOrgMock };
});

import {
  executeAction,
  type ActionContext,
  type ActionEnv,
} from './action-handlers';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';

let db: Database;
let sharedAccountId: string;
let secondSharedAccountId: string;
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

  secondSharedAccountId = 'mail_shared_seq_test_2';
  await db.insert(schema.mailAccounts).values({
    id: secondSharedAccountId,
    name: 'Shared 2',
    email: 'shared-seq-2@test.dev',
    isShared: true,
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

  it('refuses to create a mail_account that sets a credential column', async () => {
    await expect(
      executeAction(
        'create_record',
        { entity: 'mail_account', data: { name: 'New', email: 'creds-seq@test.dev', accessToken: 'secret' } },
        makeCtx(),
      ),
    ).rejects.toThrow(/accessToken/);
  });

  it('never returns credential columns on create, even when the row has one set directly', async () => {
    // Bypasses the generic-write refusal to prove the *read* side
    // (getEntityColumns) also guards mail_account, independent of the write
    // guard above.
    const id = 'mail_direct_cred_seq_test';
    await db.insert(schema.mailAccounts).values({
      id,
      name: 'Direct',
      email: 'direct-seq@test.dev',
      isShared: true,
      accessToken: 'leaked-token',
    });
    const res = (await executeAction(
      'update_record',
      { entity: 'mail_account', id, data: { name: 'Direct renamed' } },
      makeCtx(),
    )) as { record: Record<string, unknown> };
    expect('accessToken' in res.record).toBe(false);
    expect(res.record.name).toBe('Direct renamed');
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

  // Regression: the WHERE-clause scope only proves the *existing* row started
  // in a shared mailbox; it says nothing about the incoming `data`. Without
  // validating `data` too, this update would move a shared message into
  // someone's private mailbox.
  it('refuses to move a shared mailbox\'s message into a private account', async () => {
    await seedMessage(sharedAccountId, 'seq_upd_move_private');
    await expect(
      executeAction(
        'update_record',
        { entity: 'mail_message', id: 'seq_upd_move_private', data: { accountId: privateAccountId } },
        makeCtx(),
      ),
    ).rejects.toThrow(/shared mailbox/i);
    const [row] = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, 'seq_upd_move_private'));
    expect(row?.accountId).toBe(sharedAccountId);
  });

  it('allows moving a shared mailbox\'s message to another shared account', async () => {
    await seedMessage(sharedAccountId, 'seq_upd_move_shared');
    const res = (await executeAction(
      'update_record',
      { entity: 'mail_message', id: 'seq_upd_move_shared', data: { accountId: secondSharedAccountId } },
      makeCtx(),
    )) as { updated: boolean; record: { accountId: string } };
    expect(res.updated).toBe(true);
    expect(res.record.accountId).toBe(secondSharedAccountId);
  });

  it('refuses to update a mail_account with a credential column, even the caller\'s own', async () => {
    await expect(
      executeAction(
        'update_record',
        { entity: 'mail_account', id: sharedAccountId, data: { passwordHash: 'new-hash' } },
        makeCtx(),
      ),
    ).rejects.toThrow(/passwordHash/);
    const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, sharedAccountId));
    expect(row?.passwordHash).toBeNull();
  });

  // Regression: same gap as the mail_message case above, for mail_account's
  // own `isShared` flag — an update could otherwise make a shared mailbox
  // private.
  it('refuses to make a shared mail_account private', async () => {
    await expect(
      executeAction(
        'update_record',
        { entity: 'mail_account', id: sharedAccountId, data: { isShared: false } },
        makeCtx(),
      ),
    ).rejects.toThrow(/shared mail account/i);
    const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, sharedAccountId));
    expect(row?.isShared).toBe(true);
  });

  it('allows updating a shared mail_account without touching isShared', async () => {
    const res = (await executeAction(
      'update_record',
      { entity: 'mail_account', id: sharedAccountId, data: { name: 'Shared renamed' } },
      makeCtx(),
    )) as { updated: boolean; record: { name: string; isShared: boolean } };
    expect(res.updated).toBe(true);
    expect(res.record.isShared).toBe(true);
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

  it('never returns a mail_account\'s credential columns', async () => {
    const res = (await executeAction('query_data', { entity: 'mail_account' }, makeCtx())) as {
      records: Array<Record<string, unknown>>;
    };
    expect(res.records.length).toBeGreaterThan(0);
    for (const record of res.records) {
      for (const key of ['accessToken', 'refreshToken', 'apiKey', 'passwordHash', 'providerConfig']) {
        expect(key in record, key).toBe(false);
      }
    }
  });
});

// --- record CRUD on mail_message: MAIL-009 (pglite) -------------------------
//
// Once a workspace's mail reads from the mailbox object (`weldmail-mailbox-store`
// flag = `object` / `object-only`), the Postgres `mail_messages` row the engine's
// table points at is no longer the truth. `assertMailMessageStoreIsPostgres`
// (`./entity-tables.ts`) refuses the generic actions outright for that entity;
// `postgres` and `shadow` (and a worker with no `FLAGSHIP` binding at all) are
// unaffected.

describe('record actions and MAIL-009 (mail store mode guard)', () => {
  beforeEach(() => {
    __resetMailStoreModeCacheForTests();
    getWorkspaceForOrgMock.mockClear();
    getWorkspaceForOrgMock.mockImplementation(async (_env: unknown, ref: string) => ({ id: ref, clerkOrgId: null }));
  });

  function envWithMode(mode: string): ActionEnv {
    // `getWorkspaceForOrg` is mocked above, so the `DbEnv` fields (DATABASE_URL_MASTER,
    // WORKSPACE_CACHE, NEON_API_KEY) it would otherwise need are never read.
    return { FLAGSHIP: { getStringValue: async () => mode } } as unknown as ActionEnv;
  }

  it.each(['postgres', 'shadow'])('%s mode leaves create/update/delete/query on mail_message unchanged', async (mode) => {
    const ctx = makeCtx({ env: envWithMode(mode) });
    const id = `mmsg_mode_${mode}`;
    const created = (await executeAction(
      'create_record',
      { entity: 'mail_message', data: messageInput(sharedAccountId, id) },
      ctx,
    )) as { created: boolean; record: { id: string } };
    expect(created.created).toBe(true);

    const updated = (await executeAction(
      'update_record',
      { entity: 'mail_message', id: created.record.id, data: { subject: 'changed' } },
      ctx,
    )) as { updated: boolean };
    expect(updated.updated).toBe(true);

    const queried = (await executeAction('query_data', { entity: 'mail_message' }, ctx)) as {
      records: Array<{ id: string }>;
    };
    expect(queried.records.map((r) => r.id)).toContain(created.record.id);

    await executeAction('delete_record', { entity: 'mail_message', id: created.record.id, hardDelete: true }, ctx);
    const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, created.record.id));
    expect(rows).toHaveLength(0);
  });

  describe.each(['object', 'object-only'])('%s mode', (mode) => {
    it('refuses create_record on mail_message with a clear error', async () => {
      const ctx = makeCtx({ env: envWithMode(mode) });
      await expect(
        executeAction(
          'create_record',
          { entity: 'mail_message', data: messageInput(sharedAccountId, `mmsg_mode_refused_${mode}`) },
          ctx,
        ),
      ).rejects.toThrow(/mail actions instead/i);
    });

    it('refuses update_record on mail_message with a clear error, without touching the row', async () => {
      const id = `mmsg_mode_update_${mode}`;
      await seedMessage(sharedAccountId, id);
      const ctx = makeCtx({ env: envWithMode(mode) });
      await expect(
        executeAction('update_record', { entity: 'mail_message', id, data: { subject: 'changed' } }, ctx),
      ).rejects.toThrow(/mail actions instead/i);
      const [row] = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(row?.subject).toBe('hi');
    });

    it('refuses delete_record on mail_message with a clear error, without touching the row', async () => {
      const id = `mmsg_mode_delete_${mode}`;
      await seedMessage(sharedAccountId, id);
      const ctx = makeCtx({ env: envWithMode(mode) });
      await expect(
        executeAction('delete_record', { entity: 'mail_message', id, hardDelete: true }, ctx),
      ).rejects.toThrow(/mail actions instead/i);
      const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(rows).toHaveLength(1);
    });

    it('refuses query_data on mail_message with a clear error', async () => {
      const ctx = makeCtx({ env: envWithMode(mode) });
      await expect(executeAction('query_data', { entity: 'mail_message' }, ctx)).rejects.toThrow(
        /mail actions instead/i,
      );
    });

    it('is a no-op for other mail entities (mail_account)', async () => {
      const ctx = makeCtx({ env: envWithMode(mode) });
      await expect(executeAction('query_data', { entity: 'mail_account' }, ctx)).resolves.toBeDefined();
    });
  });

  it('falls back to postgres behaviour when there is no FLAGSHIP binding', async () => {
    const ctx = makeCtx({ env: {} as ActionEnv });
    const res = (await executeAction(
      'create_record',
      { entity: 'mail_message', data: messageInput(sharedAccountId, 'mmsg_mode_no_flagship') },
      ctx,
    )) as { created: boolean };
    expect(res.created).toBe(true);
  });

  it('fails open to postgres behaviour when the workspace id cannot be resolved', async () => {
    getWorkspaceForOrgMock.mockRejectedValueOnce(new Error('workspace lookup unavailable'));
    const ctx = makeCtx({ env: envWithMode('object') });
    const res = (await executeAction(
      'create_record',
      { entity: 'mail_message', data: messageInput(sharedAccountId, 'mmsg_mode_resolve_fails') },
      ctx,
    )) as { created: boolean };
    expect(res.created).toBe(true);
  });
});
