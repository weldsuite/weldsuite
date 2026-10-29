/**
 * Route-level tests for the object-mode directory wiring added to
 * `/api/mail-accounts` (design doc §6, §9 task D3): mode-aware list/detail,
 * the directory bump after every write, the "no KV in postgres mode" hard
 * rule, and the best-effort mailbox teardown on delete.
 *
 * The mutation service functions are mocked here (the services themselves,
 * and their parity with Postgres, are covered by
 * `services/mail/accounts-access.test.ts` and
 * `services/mail/accounts-directory.test.ts`) — this file only asserts what
 * the ROUTE does once a write succeeds.
 */

import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { Env, Variables } from '../../types';

/**
 * `mail-api` doesn't declare `@weldsuite/feature-flags` as a direct
 * dependency (it only reaches `FlagshipBinding` transitively through
 * `@weldsuite/worker-kit`'s `KitEnv`), so this is a structurally-equivalent
 * local type rather than an import — it satisfies `Env['FLAGSHIP']` the same
 * way at the type-check boundary without adding a dependency this worker
 * doesn't otherwise need.
 */
interface FakeFlagshipBinding {
  getStringValue(key: string, defaultValue: string, context?: Record<string, unknown>): Promise<string>;
  getBooleanValue(key: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean>;
  getNumberValue(key: string, defaultValue: number, context?: Record<string, unknown>): Promise<number>;
  getObjectValue<T>(key: string, defaultValue: T, context?: Record<string, unknown>): Promise<T>;
}

vi.mock('../../services/mail/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mail/accounts')>();
  return {
    ...actual,
    createMailAccount: vi.fn(),
    updateMailAccount: vi.fn(),
    deleteMailAccount: vi.fn(),
    assignMailAccountUsers: vi.fn(),
    triggerAccountSync: vi.fn(),
  };
});

import { mailAccountsRoutes } from './index';
import * as accountsService from '../../services/mail/accounts';

const ADMIN = 'user_admin';

function fakeKv() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'put'; key: string }> = [];
  const kv = {
    get: async (key: string, type?: string) => {
      calls.push({ op: 'get', key });
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      calls.push({ op: 'put', key });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, calls };
}

function fakeFlagship(mode: string): FakeFlagshipBinding {
  return {
    getStringValue: async () => mode,
    getBooleanValue: async (_key, defaultValue) => defaultValue,
    getNumberValue: async (_key, defaultValue) => defaultValue,
    getObjectValue: async (_key, defaultValue) => defaultValue,
  };
}

function fakeMailboxNamespace(destroy: Mock) {
  const stub = { destroy };
  return { jurisdiction: () => ({ idFromName: (n: string) => n, get: () => stub }) } as unknown as Env['MAILBOX_STORE'];
}

function fakeMailIndexNamespace(dropMailbox: Mock) {
  const stub = { dropMailbox };
  return { jurisdiction: () => ({ idFromName: (n: string) => n, get: () => stub }) } as unknown as Env['MAIL_INDEX'];
}

let db: Database;
/** A real, shared, admin-manageable account — `PUT/PATCH /:id` checks `checkAccountManageAccess` against the real tenant DB before ever calling the (mocked) `updateMailAccount`. */
let manageableAccountId: string;

function makeApp(workspaceId: string, envOverrides: Partial<Env> = {}) {
  return createTestApp<Env, Variables>('/api/mail-accounts', mailAccountsRoutes, {
    context: { userId: ADMIN, tenantDb: db, workspaceId, permissions: permissions('*') },
    env: envOverrides,
  });
}

/** Flush the microtask/macrotask queue so a `waitUntil`'d promise (fire-and-forget in the test harness) has a chance to settle before assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_admin_test',
    userId: ADMIN,
    email: `${ADMIN}@test.dev`,
    role: 'ADMIN',
  } as typeof schema.workspaceMembers.$inferInsert);
  manageableAccountId = 'mail_route_test';
  await db.insert(schema.mailAccounts).values({
    id: manageableAccountId,
    name: 'Route test account',
    email: `${manageableAccountId}@test.dev`,
    isShared: true,
  } as typeof schema.mailAccounts.$inferInsert);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  __resetMailStoreModeCacheForTests();
});

describe('GET /api/mail-accounts — postgres mode touches no KV', () => {
  it('makes no WORKSPACE_CACHE calls for list or detail', async () => {
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_pg_reads', { WORKSPACE_CACHE: kv });

    await request('/api/mail-accounts');
    await request('/api/mail-accounts/mail_1');
    await request('/api/mail-accounts/mail_1/labels');

    expect(calls).toEqual([]);
  });
});

describe('directory bump sites (design §6)', () => {
  it('bumps after POST / (create)', async () => {
    (accountsService.createMailAccount as Mock).mockResolvedValue({ id: 'mail_1', name: 'Test', email: 'a@b.test' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_bump_create', { WORKSPACE_CACHE: kv });

    const res = await request('/api/mail-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test', email: 'a@b.test', provider: 'imap', authType: 'password' }),
    });
    expect(res.status).toBe(201);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_bump_create')).toBe(true);
  });

  it('bumps after PUT/PATCH /:id (update)', async () => {
    (accountsService.updateMailAccount as Mock).mockResolvedValue({
      before: { id: manageableAccountId, email: 'a@b.test', provider: 'imap', status: 'active' },
      after: { id: manageableAccountId, email: 'a@b.test', provider: 'imap', status: 'active' },
    });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_bump_update', { WORKSPACE_CACHE: kv });

    const res = await request(`/api/mail-accounts/${manageableAccountId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_bump_update')).toBe(true);
  });

  it('bumps after PATCH /:id/sync', async () => {
    (accountsService.triggerAccountSync as Mock).mockResolvedValue({ id: 'mail_1', syncStatus: 'syncing' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_bump_sync', { WORKSPACE_CACHE: kv });

    const res = await request('/api/mail-accounts/mail_1/sync', { method: 'PATCH' });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_bump_sync')).toBe(true);
  });

  it('bumps after PATCH /:id/assign-users', async () => {
    (accountsService.assignMailAccountUsers as Mock).mockResolvedValue({
      id: 'mail_1',
      email: 'a@b.test',
      provider: 'imap',
      status: 'active',
      isShared: false,
      assignedUserIds: [ADMIN],
    });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_bump_assign', { WORKSPACE_CACHE: kv });

    const res = await request('/api/mail-accounts/mail_1/assign-users', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isShared: false, assignedUserIds: [ADMIN] }),
    });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_bump_assign')).toBe(true);
  });

  it('bumps after DELETE /:id', async () => {
    (accountsService.deleteMailAccount as Mock).mockResolvedValue({
      found: true,
      account: { id: 'mail_1', email: 'a@b.test', provider: 'imap', status: 'active' },
    });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_bump_delete', { WORKSPACE_CACHE: kv });

    const res = await request('/api/mail-accounts/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_bump_delete')).toBe(true);
  });
});

describe('DELETE /:id — mailbox teardown in object modes', () => {
  it('destroys the mailbox object and drops it from the MailIndex when the workspace writes the object', async () => {
    (accountsService.deleteMailAccount as Mock).mockResolvedValue({
      found: true,
      account: { id: 'mail_1', email: 'a@b.test', provider: 'imap', status: 'active' },
    });
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const { kv } = fakeKv();
    const { request } = makeApp('ws_destroy', {
      FLAGSHIP: fakeFlagship('object'),
      WORKSPACE_CACHE: kv,
      MAILBOX_STORE: fakeMailboxNamespace(destroy),
      MAIL_INDEX: fakeMailIndexNamespace(dropMailbox),
    });

    const res = await request('/api/mail-accounts/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    await flush();

    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_destroy', accountId: 'mail_1' }));
    expect(dropMailbox).toHaveBeenCalledWith('ws_destroy', 'mail_1');
  });

  it('also tears down in shadow mode (the object is a dual-write secondary there too)', async () => {
    (accountsService.deleteMailAccount as Mock).mockResolvedValue({
      found: true,
      account: { id: 'mail_1', email: 'a@b.test', provider: 'imap', status: 'active' },
    });
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const { kv } = fakeKv();
    const { request } = makeApp('ws_shadow_destroy', {
      FLAGSHIP: fakeFlagship('shadow'),
      WORKSPACE_CACHE: kv,
      MAILBOX_STORE: fakeMailboxNamespace(destroy),
      MAIL_INDEX: fakeMailIndexNamespace(dropMailbox),
    });

    const res = await request('/api/mail-accounts/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    await flush();

    expect(destroy).toHaveBeenCalled();
    expect(dropMailbox).toHaveBeenCalled();
  });

  it('does not touch the mailbox object or the MailIndex in postgres mode', async () => {
    (accountsService.deleteMailAccount as Mock).mockResolvedValue({
      found: true,
      account: { id: 'mail_1', email: 'a@b.test', provider: 'imap', status: 'active' },
    });
    const destroy = vi.fn().mockResolvedValue({ accepted: true });
    const dropMailbox = vi.fn().mockResolvedValue(undefined);
    const { kv } = fakeKv();
    const { request } = makeApp('ws_no_destroy', {
      WORKSPACE_CACHE: kv,
      MAILBOX_STORE: fakeMailboxNamespace(destroy),
      MAIL_INDEX: fakeMailIndexNamespace(dropMailbox),
    });

    const res = await request('/api/mail-accounts/mail_1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    await flush();

    expect(destroy).not.toHaveBeenCalled();
    expect(dropMailbox).not.toHaveBeenCalled();
  });
});
