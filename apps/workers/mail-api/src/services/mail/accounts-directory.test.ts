/**
 * pglite-backed tests for the directory-served reads and the best-effort
 * mailbox teardown added for object modes (design doc §6, §9 task D3).
 *
 * The list/detail/labels functions here must produce the exact same
 * observable result as their Postgres counterparts in `accounts.ts` for the
 * same seeded data — same ids, same order, same access filtering — since in
 * object modes they replace those functions on the open path.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  getMailAccount,
  getMailAccountLabels,
  listMailAccounts,
  buildDirectoryMailAccess,
  listMailAccountsFromDirectory,
  getMailAccountFromDirectory,
  getMailAccountLabelsFromDirectory,
  filterDirectoryAccounts,
  destroyMailboxObject,
} from './accounts';
import type { MailAccess } from '@weldsuite/mail-domain/store/access';
import type { DirectoryAccount } from '@weldsuite/mail-domain/store/directory';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';

const { mailAccounts, mailLabels, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';
const WORKSPACE_ID = 'ws_directory_test';

let db: Database;

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

async function seedMember(userId: string, role: string) {
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
  } as typeof workspaceMembers.$inferInsert);
}

async function seedAccount(values: Partial<typeof mailAccounts.$inferInsert> = {}): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test account', email: `${id}@test.dev`, ...values });
  return id;
}

async function seedLabel(accountId: string, name = 'Custom') {
  await db.insert(mailLabels).values({
    id: generateId('label'),
    accountId,
    name,
    slug: null,
    isSystem: false,
  } as typeof mailLabels.$inferInsert);
}

/** Builds the `MailAccess` a request in `object`/`object-only` mode would get, for `userId`, against a fresh per-call KV (so every call rebuilds from the current Postgres state rather than serving a stale cached entry across tests). */
async function access(userId: string, isAdmin: boolean): Promise<MailAccess> {
  const env = { WORKSPACE_CACHE: fakeKv() } as unknown as Env;
  return buildDirectoryMailAccess(env, db, WORKSPACE_ID, userId, isAdmin);
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');
}, 60_000);

describe('listMailAccountsFromDirectory / filterDirectoryAccounts parity with listMailAccounts', () => {
  it('matches the Postgres list for a member (open scope), including access filtering', async () => {
    const shared = await seedAccount({ isShared: true, name: 'Shared inbox' });
    const privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE], name: 'Assignee inbox' });
    const privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: null, name: 'Fallback inbox' });

    const pg = await listMailAccounts(db, MEMBER, { limit: 100 });
    const dirAccess = await access(MEMBER, false);
    const dir = await listMailAccountsFromDirectory(dirAccess, { limit: 100 });

    expect(dir.totalCount).toBe(pg.totalCount);
    expect(dir.data.map((a) => a.id).sort()).toEqual(pg.data.map((a) => a.id).sort());
    expect(dir.data.map((a) => a.id)).toContain(shared);
    expect(dir.data.map((a) => a.id)).not.toContain(privateAssigned);
    expect(dir.data.map((a) => a.id)).not.toContain(privateUnassigned);
  });

  it('matches the Postgres list for an admin in manage scope (every account, no filter)', async () => {
    const pg = await listMailAccounts(db, ADMIN, { limit: 100, scope: 'manage' });
    const dirAccess = await access(ADMIN, true);
    const dir = await listMailAccountsFromDirectory(dirAccess, { limit: 100, scope: 'manage' });

    expect(dir.data.map((a) => a.id).sort()).toEqual(pg.data.map((a) => a.id).sort());
  });

  it('does not widen the list for a member asking for the manage scope', async () => {
    const dirAccess = await access(MEMBER, false);
    const dir = await listMailAccountsFromDirectory(dirAccess, { limit: 100, scope: 'manage' });
    const pg = await listMailAccounts(db, MEMBER, { limit: 100, scope: 'manage' });
    expect(dir.data.map((a) => a.id).sort()).toEqual(pg.data.map((a) => a.id).sort());
  });

  it('lists a private mailbox for its assignee', async () => {
    const dirAccess = await access(ASSIGNEE, false);
    const dir = await listMailAccountsFromDirectory(dirAccess, { limit: 100 });
    const pg = await listMailAccounts(db, ASSIGNEE, { limit: 100 });
    expect(dir.data.map((a) => a.id).sort()).toEqual(pg.data.map((a) => a.id).sort());
  });

  it('matches search/status/provider filtering', async () => {
    const needle = `needle-${generateId('mail')}`;
    const matching = await seedAccount({ isShared: true, name: needle, status: 'active', provider: 'gmail' });
    await seedAccount({ isShared: true, name: 'something else', status: 'active', provider: 'gmail' });

    const filters = { limit: 100, search: needle, status: 'active', provider: 'gmail' };
    const pg = await listMailAccounts(db, ADMIN, filters);
    const dirAccess = await access(ADMIN, true);
    const dir = await listMailAccountsFromDirectory(dirAccess, filters);

    expect(dir.data.map((a) => a.id)).toEqual(pg.data.map((a) => a.id));
    expect(dir.data.map((a) => a.id)).toContain(matching);
  });

  it('matches cursor pagination order and hasMore/cursor', async () => {
    const dirAccess = await access(ADMIN, true);
    const page1Pg = await listMailAccounts(db, ADMIN, { limit: 2, scope: 'manage' });
    const page1Dir = await listMailAccountsFromDirectory(dirAccess, { limit: 2, scope: 'manage' });
    expect(page1Dir.data.map((a) => a.id)).toEqual(page1Pg.data.map((a) => a.id));
    expect(page1Dir.hasMore).toBe(page1Pg.hasMore);
    expect(page1Dir.cursor).toBe(page1Pg.cursor);

    if (page1Pg.hasMore) {
      const page2Pg = await listMailAccounts(db, ADMIN, { limit: 2, scope: 'manage', cursor: page1Pg.cursor! });
      const page2Dir = await listMailAccountsFromDirectory(dirAccess, { limit: 2, scope: 'manage', cursor: page1Dir.cursor! });
      expect(page2Dir.data.map((a) => a.id)).toEqual(page2Pg.data.map((a) => a.id));
    }
  });

  it('filterDirectoryAccounts ignores a cursor id that is not in the accessible set', () => {
    const rows: DirectoryAccount[] = [
      { id: 'mail_a', createdAt: '2024-01-02T00:00:00.000Z' } as DirectoryAccount,
      { id: 'mail_b', createdAt: '2024-01-01T00:00:00.000Z' } as DirectoryAccount,
    ];
    const result = filterDirectoryAccounts(rows, { limit: 10, cursor: 'mail_missing' });
    expect(result.data.map((a) => a.id)).toEqual(['mail_a', 'mail_b']);
  });
});

describe('getMailAccountFromDirectory parity with getMailAccount', () => {
  it('returns the same row Postgres returns for an accessible account', async () => {
    const shared = await seedAccount({ isShared: true });
    const pg = await getMailAccount(db, shared, MEMBER);
    const dirAccess = await access(MEMBER, false);
    const dir = await getMailAccountFromDirectory(dirAccess, shared);
    expect(dir?.id).toBe(pg?.id);
    expect(dir?.email).toBe(pg?.email);
  });

  it('is null for both, covering not-found and no-access the same way', async () => {
    const privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });

    expect(await getMailAccount(db, privateAssigned, MEMBER)).toBeNull();
    const dirAccess = await access(MEMBER, false);
    expect(await getMailAccountFromDirectory(dirAccess, privateAssigned)).toBeNull();

    expect(await getMailAccount(db, 'mail_does_not_exist', ADMIN)).toBeNull();
    const adminAccess = await access(ADMIN, true);
    expect(await getMailAccountFromDirectory(adminAccess, 'mail_does_not_exist')).toBeNull();
  });

  it('falls back to admins for an unassigned private mailbox, same as Postgres', async () => {
    const privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: null });
    const pg = await getMailAccount(db, privateUnassigned, ADMIN);
    const dirAccess = await access(ADMIN, true);
    const dir = await getMailAccountFromDirectory(dirAccess, privateUnassigned);
    expect(dir?.id).toBe(pg?.id);
  });

  it('never returns credential columns (the directory never carries them either)', async () => {
    const withCredentials = await seedAccount({
      isShared: true,
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      apiKey: 'secret-api-key',
      passwordHash: 'secret-password-hash',
      providerConfig: { clientId: 'secret-client-id' },
    });
    const dirAccess = await access(ADMIN, true);
    const row = await getMailAccountFromDirectory(dirAccess, withCredentials);
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('accessToken');
    expect(row).not.toHaveProperty('refreshToken');
    expect(row).not.toHaveProperty('apiKey');
    expect(row).not.toHaveProperty('passwordHash');
    expect(row).not.toHaveProperty('providerConfig');
  });
});

describe('getMailAccountLabelsFromDirectory parity with getMailAccountLabels', () => {
  it('returns the same label names Postgres returns for an accessible account', async () => {
    const shared = await seedAccount({ isShared: true });
    await seedLabel(shared, 'Clients');

    const pg = await getMailAccountLabels(db, shared);
    const dirAccess = await access(MEMBER, false);
    const dir = await getMailAccountLabelsFromDirectory(dirAccess, shared);

    expect(dir?.map((l) => l.name).sort()).toEqual(pg?.map((l) => l.name).sort());
  });

  it('is null (not an empty array) for a private mailbox the caller cannot open', async () => {
    const privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
    await seedLabel(privateAssigned, 'Secret');

    const dirAccess = await access(MEMBER, false);
    expect(await getMailAccountLabelsFromDirectory(dirAccess, privateAssigned)).toBeNull();
  });
});

describe('destroyMailboxObject', () => {
  function fakeMailboxNamespace(destroy: ReturnType<typeof vi.fn>) {
    const stub = { destroy };
    return { jurisdiction: () => ({ idFromName: (n: string) => n, get: () => stub }) } as unknown as Env['MAILBOX_STORE'];
  }

  function fakeMailIndexNamespace(dropMailbox: ReturnType<typeof vi.fn>) {
    const stub = { dropMailbox };
    return { jurisdiction: () => ({ idFromName: (n: string) => n, get: () => stub }) } as unknown as Env['MAIL_INDEX'];
  }

  it('calls destroy on the mailbox stub and dropMailbox on the MailIndex', async () => {
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy), MAIL_INDEX: fakeMailIndexNamespace(dropMailbox) } as unknown as Env;

    await destroyMailboxObject(env, { workspaceId: 'ws_1', accountId: 'mail_1', clerkOrgId: 'org_1' });

    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_1', accountId: 'mail_1' }));
    expect(dropMailbox).toHaveBeenCalledWith('ws_1', 'mail_1');
  });

  it('never throws when the mailbox stub destroy fails — logs and still drops from the index', async () => {
    const destroy = vi.fn().mockRejectedValue(new Error('object unreachable'));
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy), MAIL_INDEX: fakeMailIndexNamespace(dropMailbox) } as unknown as Env;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(destroyMailboxObject(env, { workspaceId: 'ws_1', accountId: 'mail_1' })).resolves.toBeUndefined();
    expect(dropMailbox).toHaveBeenCalledWith('ws_1', 'mail_1');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('never throws when MailIndex.dropMailbox fails', async () => {
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockRejectedValue(new Error('index unreachable'));
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy), MAIL_INDEX: fakeMailIndexNamespace(dropMailbox) } as unknown as Env;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(destroyMailboxObject(env, { workspaceId: 'ws_1', accountId: 'mail_1' })).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('never throws when the MAILBOX_STORE binding is missing (mailboxStubFor throws synchronously)', async () => {
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const env = { MAIL_INDEX: fakeMailIndexNamespace(dropMailbox) } as unknown as Env;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(destroyMailboxObject(env, { workspaceId: 'ws_1', accountId: 'mail_1' })).resolves.toBeUndefined();
    expect(dropMailbox).toHaveBeenCalledWith('ws_1', 'mail_1');
    logged.mockRestore();
  });

  it('skips the MailIndex call (without throwing) when MAIL_INDEX is not bound', async () => {
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const env = { MAILBOX_STORE: fakeMailboxNamespace(destroy) } as unknown as Env;

    await expect(destroyMailboxObject(env, { workspaceId: 'ws_1', accountId: 'mail_1' })).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalled();
  });
});
