/**
 * destroyWorkspaceMail: the mailbox list is the union of the tenant DB's
 * mail_accounts (soft-deleted included) and the master mail_account_registry,
 * every mailbox found gets `destroy()`, the workspace's MailIndex gets
 * `forgetMailData()`, a single mailbox's failure fails the whole call so the
 * caller retries it (clerk.ts via Svix redelivery, the teardown sweep via its
 * own requeue), and an environment without MAILBOX_STORE/MAIL_INDEX configured
 * skips the whole thing without touching either database.
 *
 * The master/tenant databases are the same small in-memory fake-drizzle style
 * `services/workspace-mail.test.ts` uses; MAILBOX_STORE/MAIL_INDEX are plain
 * objects shaped like a `DurableObjectNamespace` (`.jurisdiction('eu').get(...)`)
 * backed by a test-controlled `destroy`/`forgetMailData` function, not the
 * real Durable Object — that machinery is covered by
 * `@weldsuite/mail-domain`'s own tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mailAccountRegistry } from '@weldsuite/db/schema/master';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { mailboxKeyFor } from '@weldsuite/mail-domain/store/object';
import { mailIndexKeyFor } from '@weldsuite/mail-domain/mail-index/client';
import type { MailboxRef } from '@weldsuite/mail-domain/store/types';

const tenantDb = vi.hoisted(() => ({ getter: null as unknown as (...args: unknown[]) => Promise<unknown> }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: (...args: unknown[]) => tenantDb.getter(...args),
}));

import type { Env } from '../index';
import type { MasterDatabase } from '../db';
import { destroyWorkspaceMail } from './workspace-mail-destroy';

const WORKSPACE_ID = 'ws_1';
type Row = Record<string, unknown>;

/** Tables keyed by drizzle table object; `where` is accepted but not evaluated (one workspace per test). */
function fakeDb() {
  const tables = new Map<unknown, Row[]>();
  const rowsFor = (table: unknown) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const result = Promise.resolve(rowsFor(table));
        return Object.assign(result, { where: () => result });
      },
    }),
  };
  return { db, rows: rowsFor };
}

/** A `DurableObjectNamespace`-shaped double for `MAILBOX_STORE`: every mailbox resolves to the same `destroy` function, which can branch on `ref`. */
function fakeMailboxNamespace(destroy: (ref: MailboxRef) => Promise<{ accepted: true }>) {
  return {
    jurisdiction: (j: string) => {
      if (j !== 'eu') throw new Error(`fakeMailboxNamespace: unexpected jurisdiction "${j}"`);
      return { idFromName: (name: string) => name, get: () => ({ destroy }) };
    },
  } as unknown as Env['MAILBOX_STORE'];
}

/** Same idea for `MAIL_INDEX`. */
function fakeMailIndexNamespace(forgetMailData: (workspaceId: string) => Promise<void>) {
  return {
    jurisdiction: (j: string) => {
      if (j !== 'eu') throw new Error(`fakeMailIndexNamespace: unexpected jurisdiction "${j}"`);
      return { idFromName: (name: string) => name, get: () => ({ forgetMailData }) };
    },
  } as unknown as Env['MAIL_INDEX'];
}

beforeEach(() => {
  tenantDb.getter = vi.fn(async () => {
    throw new Error('no tenant DB configured for this test');
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('destroyWorkspaceMail', () => {
  it('destroys every mailbox found across the tenant DB and the master registry, soft-deleted accounts included, and forgets the index', async () => {
    const master = fakeDb();
    master.rows(mailAccountRegistry).push(
      { accountId: 'mail_1' }, // also in the tenant DB
      { accountId: 'mail_3' }, // registry-only: the tenant row is long gone
    );
    const tenant = fakeDb();
    tenant.rows(mailAccounts).push(
      { id: 'mail_1', deletedAt: null },
      { id: 'mail_2', deletedAt: new Date('2026-01-01') }, // soft-deleted
    );
    tenantDb.getter = vi.fn(async () => tenant.db);

    const destroyedRefs: MailboxRef[] = [];
    const destroy = vi.fn(async (ref: MailboxRef) => {
      destroyedRefs.push(ref);
      return { accepted: true as const };
    });
    const forgetMailData = vi.fn(async () => undefined);
    const env = {
      MAILBOX_STORE: fakeMailboxNamespace(destroy),
      MAIL_INDEX: fakeMailIndexNamespace(forgetMailData),
    } as unknown as Env;

    const result = await destroyWorkspaceMail(env, master.db as unknown as MasterDatabase, WORKSPACE_ID);

    expect(result).toEqual({ mailboxCount: 3, destroyed: 3, failedAccountIds: [], indexForgotten: true, skipped: false });
    expect(destroyedRefs.map((r) => r.accountId).sort()).toEqual(['mail_1', 'mail_2', 'mail_3']);
    expect(destroyedRefs.every((r) => r.workspaceId === WORKSPACE_ID)).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(forgetMailData).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID);
  });

  it('falls back to the master registry alone when the tenant database is already gone', async () => {
    const master = fakeDb();
    master.rows(mailAccountRegistry).push({ accountId: 'mail_1' });
    tenantDb.getter = vi.fn(async () => {
      throw new Error('No database configured for workspace: ws_1');
    });

    const destroy = vi.fn(async (ref: MailboxRef) => ({ accepted: true as const }));
    const forgetMailData = vi.fn(async () => undefined);
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy), MAIL_INDEX: fakeMailIndexNamespace(forgetMailData) } as unknown as Env;

    const result = await destroyWorkspaceMail(env, master.db as unknown as MasterDatabase, WORKSPACE_ID);

    expect(result).toEqual({ mailboxCount: 1, destroyed: 1, failedAccountIds: [], indexForgotten: true, skipped: false });
    expect(destroy).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, accountId: 'mail_1' });
  });

  it('throws when a mailbox fails to destroy, and a retry with everything healthy finishes cleanly', async () => {
    const master = fakeDb();
    master.rows(mailAccountRegistry).push({ accountId: 'mail_1' }, { accountId: 'mail_2' });
    tenantDb.getter = vi.fn(async () => fakeDb().db);

    let failMail2 = true;
    const destroy = vi.fn(async (ref: MailboxRef) => {
      if (ref.accountId === 'mail_2' && failMail2) throw new Error('mailbox unreachable');
      return { accepted: true as const };
    });
    const forgetMailData = vi.fn(async () => undefined);
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy), MAIL_INDEX: fakeMailIndexNamespace(forgetMailData) } as unknown as Env;

    await expect(destroyWorkspaceMail(env, master.db as unknown as MasterDatabase, WORKSPACE_ID)).rejects.toThrow(
      /mail teardown incomplete/,
    );
    // The index was still wiped even though a mailbox failed — each stage is independent and idempotent.
    expect(forgetMailData).toHaveBeenCalledTimes(1);

    failMail2 = false;
    const retried = await destroyWorkspaceMail(env, master.db as unknown as MasterDatabase, WORKSPACE_ID);

    expect(retried).toEqual({ mailboxCount: 2, destroyed: 2, failedAccountIds: [], indexForgotten: true, skipped: false });
    expect(destroy).toHaveBeenCalledTimes(4); // 2 from the failed attempt, 2 from the retry
  });

  it('throws when MailIndex.forgetMailData fails, even though every mailbox destroyed cleanly', async () => {
    const master = fakeDb();
    master.rows(mailAccountRegistry).push({ accountId: 'mail_1' });
    tenantDb.getter = vi.fn(async () => fakeDb().db);
    const env = {
      MAILBOX_STORE: fakeMailboxNamespace(async () => ({ accepted: true as const })),
      MAIL_INDEX: fakeMailIndexNamespace(async () => {
        throw new Error('MailIndex unreachable');
      }),
    } as unknown as Env;

    await expect(destroyWorkspaceMail(env, master.db as unknown as MasterDatabase, WORKSPACE_ID)).rejects.toThrow(
      /MailIndex\.forgetMailData failed/,
    );
  });

  it('degrades gracefully when MAILBOX_STORE/MAIL_INDEX are not configured: skips without touching either database', async () => {
    const master = fakeDb();
    const brokenSelect = vi.fn(() => {
      throw new Error('masterDb must not be queried when the mail store is not configured');
    });
    const masterDb = { select: brokenSelect } as unknown as MasterDatabase;
    const env = {} as unknown as Env;

    const result = await destroyWorkspaceMail(env, masterDb, WORKSPACE_ID);

    expect(result).toEqual({ mailboxCount: 0, destroyed: 0, failedAccountIds: [], indexForgotten: false, skipped: true });
    expect(brokenSelect).not.toHaveBeenCalled();
    expect(tenantDb.getter).not.toHaveBeenCalled();
    void master; // unused beyond proving brokenSelect replaces it
  });

  it('still forgets the index when the workspace has no mailboxes left', async () => {
    const master = fakeDb();
    tenantDb.getter = vi.fn(async () => fakeDb().db);
    const destroy = vi.fn();
    const forgetMailData = vi.fn(async () => undefined);
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy), MAIL_INDEX: fakeMailIndexNamespace(forgetMailData) } as unknown as Env;

    const result = await destroyWorkspaceMail(env, master.db as unknown as MasterDatabase, WORKSPACE_ID);

    expect(result).toEqual({ mailboxCount: 0, destroyed: 0, failedAccountIds: [], indexForgotten: true, skipped: false });
    expect(destroy).not.toHaveBeenCalled();
    expect(forgetMailData).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID);
  });
});

// Sanity on the key helpers this module relies on, so a future rename of the
// `mbx:`/`mbxidx:` format in @weldsuite/mail-domain fails here too, not just
// silently addresses the wrong Durable Object.
describe('key helpers', () => {
  it('mailboxKeyFor/mailIndexKeyFor are stable (defence in depth, not this module\'s own logic)', () => {
    expect(mailboxKeyFor({ workspaceId: 'ws_1', accountId: 'mail_1' })).toBe('mbx:ws_1:mail_1');
    expect(mailIndexKeyFor('ws_1')).toBe('mbxidx:ws_1');
  });
});
