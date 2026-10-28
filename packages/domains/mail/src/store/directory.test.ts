/**
 * `store/directory.ts` (task C3): the batched Postgres queries behind the KV
 * mailbox directory, and the versioned cache itself — build on a miss, hit on
 * a repeat read, no credential columns ever, and `bumpMailboxDirectory`
 * invalidating a cached entry.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  bumpMailboxDirectory,
  buildMailDirectory,
  getMailDirectory,
  loadAllDirectoryAccounts,
  loadDirectoryAccountsByIds,
  loadDirectoryLabelsForAccounts,
} from './directory';

const { mailAccounts, mailLabels } = schema;

let db: Database;

async function seedAccount(overrides: Partial<typeof mailAccounts.$inferInsert> = {}): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({
    id,
    name: 'Test account',
    email: `${id}@test.dev`,
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
    apiKey: 'secret-api-key',
    passwordHash: 'secret-password-hash',
    providerConfig: { clientId: 'secret-client-id' },
    isShared: true,
    ...overrides,
  });
  return id;
}

async function seedLabel(accountId: string, overrides: Partial<typeof mailLabels.$inferInsert> = {}): Promise<string> {
  const id = generateId('mlbl');
  await db.insert(mailLabels).values({ id, accountId, name: 'Custom', ...overrides });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('loadAllDirectoryAccounts / loadDirectoryAccountsByIds', () => {
  it('never returns the five credential columns', async () => {
    const accountId = await seedAccount();
    const [account] = await loadDirectoryAccountsByIds(db, [accountId]);
    expect(account).toBeDefined();
    expect(account).not.toHaveProperty('accessToken');
    expect(account).not.toHaveProperty('refreshToken');
    expect(account).not.toHaveProperty('apiKey');
    expect(account).not.toHaveProperty('passwordHash');
    expect(account).not.toHaveProperty('providerConfig');
    // Every other column survives, including isShared/assignedUserIds (design §6).
    expect(account!.isShared).toBe(true);
    expect(account!.email).toBe(`${accountId}@test.dev`);
  });

  it('serialises date columns to ISO strings, not Date instances', async () => {
    const accountId = await seedAccount();
    const [account] = await loadDirectoryAccountsByIds(db, [accountId]);
    expect(typeof account!.createdAt).toBe('string');
    expect(typeof account!.updatedAt).toBe('string');
    expect(() => new Date(account!.createdAt)).not.toThrow();
  });

  it('loadDirectoryAccountsByIds returns [] for an empty id list without querying', async () => {
    await expect(loadDirectoryAccountsByIds(db, [])).resolves.toEqual([]);
  });

  it('excludes soft-deleted accounts', async () => {
    const accountId = await seedAccount({ deletedAt: new Date() });
    const all = await loadAllDirectoryAccounts(db);
    expect(all.map((a) => a.id)).not.toContain(accountId);
  });
});

describe('loadDirectoryLabelsForAccounts', () => {
  it('groups labels by accountId, keeping only the documented fields', async () => {
    const accountId = await seedAccount();
    await seedLabel(accountId, { name: 'Clients', slug: null, isSystem: false, color: '#ff0000', position: 1, aiEnabled: true });
    const byAccount = await loadDirectoryLabelsForAccounts(db, [accountId]);
    expect(byAccount[accountId]).toHaveLength(1);
    expect(byAccount[accountId]![0]).toMatchObject({ name: 'Clients', color: '#ff0000', position: 1, aiEnabled: true });
  });

  it('returns {} for an empty account list without querying', async () => {
    await expect(loadDirectoryLabelsForAccounts(db, [])).resolves.toEqual({});
  });

  it('an account with no labels has no entry at all (not an empty array)', async () => {
    const accountId = await seedAccount();
    const byAccount = await loadDirectoryLabelsForAccounts(db, [accountId]);
    expect(byAccount[accountId]).toBeUndefined();
  });
});

describe('buildMailDirectory', () => {
  it('builds one entry covering every account and its labels', async () => {
    const accountId = await seedAccount();
    await seedLabel(accountId, { name: 'Projects' });
    const entry = await buildMailDirectory(db, () => 1_000);
    expect(entry.v).toBe(1);
    expect(entry.builtAt).toBe(1_000);
    expect(entry.accounts.map((a) => a.id)).toContain(accountId);
    expect(entry.labels[accountId]?.map((l) => l.name)).toContain('Projects');
  });
});

describe('getMailDirectory / bumpMailboxDirectory (KV)', () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      store,
      kv: {
        get: async (key: string, type?: string) => {
          const raw = store.get(key);
          if (raw === undefined) return null;
          return type === 'json' ? JSON.parse(raw) : raw;
        },
        put: async (key: string, value: string) => {
          store.set(key, value);
        },
      } as unknown as KVNamespace,
    };
  }

  it('builds from Postgres on a miss, then serves the cached entry on a hit', async () => {
    const accountId = await seedAccount();
    const { kv } = fakeKv();
    const env = { WORKSPACE_CACHE: kv };
    const workspaceId = `ws_${accountId}`;

    const first = await getMailDirectory(env, workspaceId, db);
    expect(first.accounts.map((a) => a.id)).toContain(accountId);

    // Seed a second account directly in Postgres without bumping the version —
    // the cached entry must NOT see it (that's the whole point of versioning).
    const secondAccountId = await seedAccount();
    const second = await getMailDirectory(env, workspaceId, db);
    expect(second.builtAt).toBe(first.builtAt);
    expect(second.accounts.map((a) => a.id)).not.toContain(secondAccountId);
  });

  it('bumpMailboxDirectory invalidates the cached entry so the next read rebuilds', async () => {
    const accountId = await seedAccount();
    const { kv } = fakeKv();
    const env = { WORKSPACE_CACHE: kv };
    const workspaceId = `ws_${accountId}`;

    const first = await getMailDirectory(env, workspaceId, db);
    expect(first.accounts.map((a) => a.id)).toContain(accountId);

    const secondAccountId = await seedAccount();
    await bumpMailboxDirectory(env, workspaceId);

    const rebuilt = await getMailDirectory(env, workspaceId, db);
    expect(rebuilt.accounts.map((a) => a.id)).toContain(accountId);
    expect(rebuilt.accounts.map((a) => a.id)).toContain(secondAccountId);
  });

  it('a KV read failure falls back to a fresh Postgres build rather than throwing', async () => {
    const accountId = await seedAccount();
    const env = {
      WORKSPACE_CACHE: {
        get: async () => {
          throw new Error('KV unavailable');
        },
        put: async () => undefined,
      } as unknown as KVNamespace,
    };
    const entry = await getMailDirectory(env, `ws_${accountId}`, db);
    expect(entry.accounts.map((a) => a.id)).toContain(accountId);
  });

  it('a KV write failure still returns the freshly built directory', async () => {
    const accountId = await seedAccount();
    const env = {
      WORKSPACE_CACHE: {
        get: async () => null,
        put: async () => {
          throw new Error('KV unavailable');
        },
      } as unknown as KVNamespace,
    };
    const entry = await getMailDirectory(env, `ws_${accountId}`, db);
    expect(entry.accounts.map((a) => a.id)).toContain(accountId);
  });
});
