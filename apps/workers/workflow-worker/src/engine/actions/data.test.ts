import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleCreateRecord,
  handleUpdateRecord,
  handleDeleteRecord,
  handleQueryData,
  handleTransform,
} from './data';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import type { WorkflowEnv } from '../types';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';

// `entity-tables.ts`'s MAIL-009 guard resolves `ctx.tenant.workspaceId` (the
// Clerk org id) to `workspaces.id` via `getCanonicalWorkspaceId` (`../../db`),
// which queries the master DB. Stubbed here as the identity function — these
// tests only care about the mail-store-mode decision, not workspace
// resolution, which `../../db.test.ts`-style coverage is not worth the
// master-DB test fixture for. `importOriginal` keeps `schema`/`Database`/
// `getTenantDbForWorkspace` real for everything else this file (and
// `entity-tables.ts`, which resolves to the same module) imports.
const { getCanonicalWorkspaceIdMock } = vi.hoisted(() => ({
  getCanonicalWorkspaceIdMock: vi.fn(async (_env: unknown, ref: string) => ref),
}));
vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return { ...actual, getCanonicalWorkspaceId: getCanonicalWorkspaceIdMock };
});

// --- transform: pure, no db -------------------------------------------------

describe('transform', () => {
  const ctx = makeActionContext({ previousResults: { a: 1, b: 2 } });

  it('pick selects the requested fields', async () => {
    const res = await handleTransform({ transform: 'pick', data: { x: 1, y: 2, z: 3 }, fields: ['x', 'z'] }, ctx);
    expect(res).toEqual({ x: 1, z: 3 });
  });

  it('pick defaults data to ctx.previousResults', async () => {
    const res = await handleTransform({ transform: 'pick', fields: ['a'] }, ctx);
    expect(res).toEqual({ a: 1 });
  });

  it('pick throws without a fields array', async () => {
    await expect(handleTransform({ transform: 'pick', data: {} }, ctx)).rejects.toThrow(/fields/i);
  });

  it('map projects a field from each array item', async () => {
    const res = await handleTransform(
      { transform: 'map', source: [{ id: 1 }, { id: 2 }], mapField: 'id' },
      ctx,
    );
    expect(res).toEqual([1, 2]);
  });

  it('map throws when source is not an array', async () => {
    await expect(handleTransform({ transform: 'map', source: {} }, ctx)).rejects.toThrow(/array/i);
  });

  it('filter keeps items whose field equals the value', async () => {
    const res = await handleTransform(
      { transform: 'filter', source: [{ s: 'a' }, { s: 'b' }], filterField: 's', filterValue: 'b' },
      ctx,
    );
    expect(res).toEqual([{ s: 'b' }]);
  });

  it('merge combines objects', async () => {
    const res = await handleTransform({ transform: 'merge', objects: [{ a: 1 }, { b: 2 }] }, ctx);
    expect(res).toEqual({ a: 1, b: 2 });
  });

  it('stringify and parse round-trip', async () => {
    const str = await handleTransform({ transform: 'stringify', data: { a: 1 } }, ctx);
    expect(str).toBe('{"a":1}');
    const parsed = await handleTransform({ transform: 'parse', data: '{"a":1}' }, ctx);
    expect(parsed).toEqual({ a: 1 });
  });
});

// --- record CRUD: pglite ----------------------------------------------------

describe('record actions (pglite)', () => {
  let db: Database;

  beforeAll(async () => {
    const handle = await createPgliteDb();
    db = handle.db;
  });

  it('create_record inserts and returns the row with a prefixed id', async () => {
    const ctx = makeActionContext({ db });
    const res = (await handleCreateRecord(
      { entity: 'workflow', data: { name: 'created via action' } },
      ctx,
    )) as { created: boolean; record: { id: string; name: string } };

    expect(res.created).toBe(true);
    expect(res.record.id).toMatch(/^wfl_/);

    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, res.record.id));
    expect(row?.name).toBe('created via action');
  });

  it('create_record throws when entity type is missing', async () => {
    await expect(handleCreateRecord({ data: { name: 'x' } }, makeActionContext({ db }))).rejects.toThrow(
      /entity/i,
    );
  });

  it('query_data excludes soft-deleted rows and applies an eq filter', async () => {
    const ctx = makeActionContext({ db });
    const marker = 'qd-marker';
    // one live row via the action, one pre-soft-deleted row inserted directly
    await handleCreateRecord({ entity: 'workflow', data: { name: marker } }, ctx);
    await db.insert(schema.workflows).values({
      id: 'wfl_softdeleted_fixture',
      name: marker,
      deletedAt: new Date(),
    });

    const res = (await handleQueryData({ entity: 'workflow', filters: { name: marker } }, ctx)) as {
      records: Array<{ name: string }>;
      count: number;
    };

    expect(res.count).toBe(1);
    expect(res.records.every((r) => r.name === marker)).toBe(true);
  });

  it('update_record changes fields and throws when the row is missing', async () => {
    const ctx = makeActionContext({ db });
    const created = (await handleCreateRecord(
      { entity: 'workflow', data: { name: 'before' } },
      ctx,
    )) as { record: { id: string } };

    const res = (await handleUpdateRecord(
      { entity: 'workflow', id: created.record.id, data: { name: 'after' } },
      ctx,
    )) as { updated: boolean };
    expect(res.updated).toBe(true);

    const [row] = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, created.record.id));
    expect(row?.name).toBe('after');

    await expect(
      handleUpdateRecord({ entity: 'workflow', id: 'wfl_does_not_exist', data: {} }, ctx),
    ).rejects.toThrow(/not found/i);
  });

  it('delete_record soft-deletes by default and hard-deletes when asked', async () => {
    const ctx = makeActionContext({ db });
    const a = (await handleCreateRecord({ entity: 'workflow', data: { name: 'soft' } }, ctx)) as {
      record: { id: string };
    };
    await handleDeleteRecord({ entity: 'workflow', id: a.record.id }, ctx);
    const [softRow] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, a.record.id));
    expect(softRow?.deletedAt).not.toBeNull();

    const b = (await handleCreateRecord({ entity: 'workflow', data: { name: 'hard' } }, ctx)) as {
      record: { id: string };
    };
    await handleDeleteRecord({ entity: 'workflow', id: b.record.id, hardDelete: true }, ctx);
    const rows = await db.select().from(schema.workflows).where(eq(schema.workflows.id, b.record.id));
    expect(rows).toHaveLength(0);
  });
});

// --- record CRUD on mail entities: MAIL-003 (pglite) ------------------------
//
// A workflow run acts for no member, so it can satisfy neither half of
// MAIL-003 (sharing or per-user assignment). Generic record actions are
// therefore scoped to shared mailboxes only — see `sharedMailboxCondition` /
// `assertMailEntityCreatable` in `../entity-tables.ts`.

describe('record actions and MAIL-003 (pglite)', () => {
  let db: Database;
  let sharedAccountId: string;
  let privateAccountId: string;

  beforeAll(async () => {
    const handle = await createPgliteDb();
    db = handle.db;

    sharedAccountId = 'mail_shared_test';
    await db.insert(schema.mailAccounts).values({
      id: sharedAccountId,
      name: 'Shared',
      email: 'shared@test.dev',
      isShared: true,
    });

    privateAccountId = 'mail_private_test';
    await db.insert(schema.mailAccounts).values({
      id: privateAccountId,
      name: 'Private',
      email: 'private@test.dev',
      isShared: false,
      assignedUserIds: ['user_someone'],
    });
  }, 60_000);

  describe('create_record', () => {
    it('refuses a mail_message targeting a private account', async () => {
      await expect(
        handleCreateRecord(
          {
            entity: 'mail_message',
            data: {
              accountId: privateAccountId,
              threadId: 'thread_x',
              messageId: '<x@test.dev>',
              from: { email: 'a@test.dev' },
              to: [{ email: 'b@test.dev' }],
              subject: 'hi',
              sentDate: new Date(),
              labels: [],
            },
          },
          makeActionContext({ db }),
        ),
      ).rejects.toThrow(/shared mailbox/i);
    });

    it('creates a mail_message targeting a shared account', async () => {
      const res = (await handleCreateRecord(
        {
          entity: 'mail_message',
          data: {
            accountId: sharedAccountId,
            threadId: 'thread_y',
            messageId: '<y@test.dev>',
            from: { email: 'a@test.dev' },
            to: [{ email: 'b@test.dev' }],
            subject: 'hi',
            sentDate: new Date(),
            labels: [],
          },
        },
        makeActionContext({ db }),
      )) as { created: boolean; record: { id: string } };
      expect(res.created).toBe(true);
    });

    it('refuses to create a mail_account explicitly marked private', async () => {
      await expect(
        handleCreateRecord(
          { entity: 'mail_account', data: { name: 'New', email: 'new@test.dev', isShared: false } },
          makeActionContext({ db }),
        ),
      ).rejects.toThrow(/shared mail account/i);
    });

    it('creates a mail_account as shared even when isShared is left unset', async () => {
      const res = (await handleCreateRecord(
        { entity: 'mail_account', data: { name: 'New', email: 'new2@test.dev' } },
        makeActionContext({ db }),
      )) as { record: { id: string; isShared: boolean } };
      expect(res.record.isShared).toBe(true);
    });

    it('refuses to create a mail_account that sets a credential column', async () => {
      await expect(
        handleCreateRecord(
          { entity: 'mail_account', data: { name: 'New', email: 'creds@test.dev', accessToken: 'secret' } },
          makeActionContext({ db }),
        ),
      ).rejects.toThrow(/accessToken/);
    });

    it('never returns credential columns on create, even when the row has one set directly', async () => {
      // Bypasses the generic-write refusal to prove the *read* side (getEntityColumns)
      // also guards mail_account, independent of the write guard above.
      const id = 'mail_direct_cred_test';
      await db.insert(schema.mailAccounts).values({
        id,
        name: 'Direct',
        email: 'direct@test.dev',
        isShared: true,
        accessToken: 'leaked-token',
      });
      const res = (await handleUpdateRecord(
        { entity: 'mail_account', id, data: { name: 'Direct renamed' } },
        makeActionContext({ db }),
      )) as { record: Record<string, unknown> };
      expect('accessToken' in res.record).toBe(false);
      expect(res.record.name).toBe('Direct renamed');
    });
  });

  describe('update_record / delete_record', () => {
    async function seedMessage(accountId: string): Promise<string> {
      const id = `mmsg_${Math.random().toString(36).slice(2)}`;
      await db.insert(schema.mailMessages).values({
        id,
        accountId,
        threadId: `thread_${id}`,
        messageId: `<${id}@test.dev>`,
        from: { email: 'a@test.dev' },
        to: [{ email: 'b@test.dev' }],
        subject: 'hi',
        sentDate: new Date(),
        labels: [],
      });
      return id;
    }

    it('cannot update a private mailbox\'s message', async () => {
      const id = await seedMessage(privateAccountId);
      await expect(
        handleUpdateRecord({ entity: 'mail_message', id, data: { subject: 'changed' } }, makeActionContext({ db })),
      ).rejects.toThrow(/not found/i);
      const [row] = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(row?.subject).toBe('hi');
    });

    it('updates a shared mailbox\'s message', async () => {
      const id = await seedMessage(sharedAccountId);
      const res = (await handleUpdateRecord(
        { entity: 'mail_message', id, data: { subject: 'changed' } },
        makeActionContext({ db }),
      )) as { updated: boolean };
      expect(res.updated).toBe(true);
    });

    it('refuses to update a mail_account with a credential column, even the caller\'s own', async () => {
      await expect(
        handleUpdateRecord(
          { entity: 'mail_account', id: sharedAccountId, data: { passwordHash: 'new-hash' } },
          makeActionContext({ db }),
        ),
      ).rejects.toThrow(/passwordHash/);
      const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, sharedAccountId));
      expect(row?.passwordHash).toBeNull();
    });

    it('cannot delete a private mailbox\'s message', async () => {
      const id = await seedMessage(privateAccountId);
      await handleDeleteRecord({ entity: 'mail_message', id, hardDelete: true }, makeActionContext({ db }));
      const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(rows).toHaveLength(1); // untouched, not hard-deleted
    });

    it('deletes a shared mailbox\'s message', async () => {
      const id = await seedMessage(sharedAccountId);
      await handleDeleteRecord({ entity: 'mail_message', id, hardDelete: true }, makeActionContext({ db }));
      const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(rows).toHaveLength(0);
    });
  });

  describe('query_data', () => {
    it('excludes a private mailbox\'s messages from a generic mail_message query', async () => {
      await db.insert(schema.mailMessages).values([
        {
          id: 'mmsg_q_shared',
          accountId: sharedAccountId,
          threadId: 'thread_q_shared',
          messageId: '<q_shared@test.dev>',
          from: { email: 'a@test.dev' },
          to: [{ email: 'b@test.dev' }],
          subject: 'query-shared',
          sentDate: new Date(),
          labels: [],
        },
        {
          id: 'mmsg_q_private',
          accountId: privateAccountId,
          threadId: 'thread_q_private',
          messageId: '<q_private@test.dev>',
          from: { email: 'a@test.dev' },
          to: [{ email: 'b@test.dev' }],
          subject: 'query-private',
          sentDate: new Date(),
          labels: [],
        },
      ]);

      const res = (await handleQueryData({ entity: 'mail_message' }, makeActionContext({ db }))) as {
        records: Array<{ id: string }>;
      };
      const ids = res.records.map((r) => r.id);
      expect(ids).toContain('mmsg_q_shared');
      expect(ids).not.toContain('mmsg_q_private');
    });

    it('excludes a private account from a generic mail_account query', async () => {
      const res = (await handleQueryData({ entity: 'mail_account' }, makeActionContext({ db }))) as {
        records: Array<{ id: string }>;
      };
      const ids = res.records.map((r) => r.id);
      expect(ids).toContain(sharedAccountId);
      expect(ids).not.toContain(privateAccountId);
    });

    it('never returns a mail_account\'s credential columns', async () => {
      const res = (await handleQueryData({ entity: 'mail_account' }, makeActionContext({ db }))) as {
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
});

// --- record CRUD on mail_message: MAIL-009 (pglite) -------------------------
//
// Once a workspace's mail reads from the mailbox object (`weldmail-mailbox-store`
// flag = `object` / `object-only`), the Postgres `mail_messages` row the engine's
// table points at is no longer the truth. `assertMailMessageStoreIsPostgres`
// (`../entity-tables.ts`) refuses the generic actions outright for that entity;
// `postgres` and `shadow` (and a worker with no `FLAGSHIP` binding at all) are
// unaffected.

describe('record actions and MAIL-009 (mail store mode guard, pglite)', () => {
  let db: Database;
  let sharedAccountId: string;

  beforeAll(async () => {
    const handle = await createPgliteDb();
    db = handle.db;

    sharedAccountId = 'mail_mode_shared_test';
    await db.insert(schema.mailAccounts).values({
      id: sharedAccountId,
      name: 'Shared',
      email: 'shared-mode@test.dev',
      isShared: true,
    });
  }, 60_000);

  beforeEach(() => {
    __resetMailStoreModeCacheForTests();
    getCanonicalWorkspaceIdMock.mockClear();
    getCanonicalWorkspaceIdMock.mockImplementation(async (_env: unknown, ref: string) => ref);
  });

  function envWithMode(mode: string): WorkflowEnv {
    return { FLAGSHIP: { getStringValue: async () => mode } } as WorkflowEnv;
  }

  async function seedMessage(): Promise<string> {
    const id = `mmsg_mode_${Math.random().toString(36).slice(2)}`;
    await db.insert(schema.mailMessages).values({
      id,
      accountId: sharedAccountId,
      threadId: `thread_${id}`,
      messageId: `<${id}@test.dev>`,
      from: { email: 'a@test.dev' },
      to: [{ email: 'b@test.dev' }],
      subject: 'hi',
      sentDate: new Date(),
      labels: [],
    });
    return id;
  }

  function messagePayload(id: string) {
    return {
      accountId: sharedAccountId,
      threadId: `thread_${id}`,
      messageId: `<${id}@test.dev>`,
      from: { email: 'a@test.dev' },
      to: [{ email: 'b@test.dev' }],
      subject: 'hi',
      sentDate: new Date(),
      labels: [],
    };
  }

  describe.each(['postgres', 'shadow'])('%s mode', (mode) => {
    it('leaves create/update/delete/query on mail_message unchanged', async () => {
      const ctx = makeActionContext({ db, env: envWithMode(mode) });
      const createId = `mmsg_mode_create_${mode}`;
      const created = (await handleCreateRecord(
        { entity: 'mail_message', data: messagePayload(createId) },
        ctx,
      )) as { created: boolean; record: { id: string } };
      expect(created.created).toBe(true);

      const updated = (await handleUpdateRecord(
        { entity: 'mail_message', id: created.record.id, data: { subject: 'changed' } },
        ctx,
      )) as { updated: boolean };
      expect(updated.updated).toBe(true);

      const queried = (await handleQueryData({ entity: 'mail_message' }, ctx)) as {
        records: Array<{ id: string }>;
      };
      expect(queried.records.map((r) => r.id)).toContain(created.record.id);

      await expect(
        handleDeleteRecord({ entity: 'mail_message', id: created.record.id, hardDelete: true }, ctx),
      ).resolves.toMatchObject({ deleted: true });
    });
  });

  describe.each(['object', 'object-only'])('%s mode', (mode) => {
    it('refuses create_record on mail_message with a clear error', async () => {
      const ctx = makeActionContext({ db, env: envWithMode(mode) });
      await expect(
        handleCreateRecord({ entity: 'mail_message', data: messagePayload('mmsg_mode_refused_create') }, ctx),
      ).rejects.toThrow(/mail actions instead/i);
    });

    it('refuses update_record on mail_message with a clear error, without touching the row', async () => {
      const id = await seedMessage();
      const ctx = makeActionContext({ db, env: envWithMode(mode) });
      await expect(
        handleUpdateRecord({ entity: 'mail_message', id, data: { subject: 'changed' } }, ctx),
      ).rejects.toThrow(/mail actions instead/i);
      const [row] = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(row?.subject).toBe('hi');
    });

    it('refuses delete_record on mail_message with a clear error, without touching the row', async () => {
      const id = await seedMessage();
      const ctx = makeActionContext({ db, env: envWithMode(mode) });
      await expect(
        handleDeleteRecord({ entity: 'mail_message', id, hardDelete: true }, ctx),
      ).rejects.toThrow(/mail actions instead/i);
      const rows = await db.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, id));
      expect(rows).toHaveLength(1);
    });

    it('refuses query_data on mail_message with a clear error', async () => {
      const ctx = makeActionContext({ db, env: envWithMode(mode) });
      await expect(handleQueryData({ entity: 'mail_message' }, ctx)).rejects.toThrow(/mail actions instead/i);
    });

    it('is a no-op for other mail entities (mail_account)', async () => {
      const ctx = makeActionContext({ db, env: envWithMode(mode) });
      await expect(handleQueryData({ entity: 'mail_account' }, ctx)).resolves.toBeDefined();
    });
  });

  it('falls back to postgres behaviour when there is no FLAGSHIP binding', async () => {
    const ctx = makeActionContext({ db, env: {} as WorkflowEnv });
    const id = `mmsg_mode_no_flagship`;
    await expect(
      handleCreateRecord({ entity: 'mail_message', data: messagePayload(id) }, ctx),
    ).resolves.toMatchObject({ created: true });
  });

  it('fails open to postgres behaviour when the workspace id cannot be resolved', async () => {
    getCanonicalWorkspaceIdMock.mockRejectedValueOnce(new Error('workspace lookup unavailable'));
    const ctx = makeActionContext({ db, env: envWithMode('object') });
    const id = `mmsg_mode_resolve_fails`;
    await expect(
      handleCreateRecord({ entity: 'mail_message', data: messagePayload(id) }, ctx),
    ).resolves.toMatchObject({ created: true });
  });
});
