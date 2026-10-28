/**
 * Route-level tests for the directory bump wiring added to `/api/mail-sync`
 * (design doc §6, §9 task D3): every endpoint that changes `syncStatus` must
 * bump the mailbox directory afterwards.
 *
 * Every mutating endpoint here first runs `checkAccountAccess` against the
 * real tenant DB, so these tests seed a real pglite account rather than
 * mocking that check away.
 */

import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

vi.mock('../../services/mail/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mail/sync')>();
  return {
    ...actual,
    beginSync: vi.fn(),
    setSyncStatus: vi.fn(),
  };
});

import { mailSyncRoutes } from './index';
import * as syncService from '../../services/mail/sync';

const USER = 'user_test';

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

let db: Database;
let accountId: string;

function makeApp(workspaceId: string, envOverrides: Partial<Env> = {}) {
  return createTestApp<Env, Variables>('/api/mail-sync', mailSyncRoutes, {
    context: { userId: USER, tenantDb: db, workspaceId, permissions: permissions('*') },
    env: envOverrides,
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  accountId = 'mail_sync_test';
  await db.insert(schema.mailAccounts).values({
    id: accountId,
    name: 'Sync test account',
    email: `${accountId}@test.dev`,
    isShared: true,
  } as typeof schema.mailAccounts.$inferInsert);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('directory bump sites (design §6: sync status changes)', () => {
  it('bumps after POST /accounts/:id/sync-messages', async () => {
    (syncService.beginSync as Mock).mockResolvedValue({ accountId, status: 'syncing' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_sync_messages', { WORKSPACE_CACHE: kv });

    const res = await request(`/api/mail-sync/accounts/${accountId}/sync-messages`, { method: 'POST' });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_sync_messages')).toBe(true);
  });

  it('bumps after POST /accounts/:id/full-sync', async () => {
    (syncService.beginSync as Mock).mockResolvedValue({ accountId, status: 'syncing' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_full_sync', { WORKSPACE_CACHE: kv });

    const res = await request(`/api/mail-sync/accounts/${accountId}/full-sync`, { method: 'POST' });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_full_sync')).toBe(true);
  });

  it('bumps after POST /accounts/:id/force-resync', async () => {
    (syncService.beginSync as Mock).mockResolvedValue({ accountId, status: 'syncing' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_force_resync', { WORKSPACE_CACHE: kv });

    const res = await request(`/api/mail-sync/accounts/${accountId}/force-resync`, { method: 'POST' });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_force_resync')).toBe(true);
  });

  it('bumps after PATCH /accounts/:id/sync-status', async () => {
    (syncService.setSyncStatus as Mock).mockResolvedValue({ id: accountId, status: 'idle' });
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_sync_status', { WORKSPACE_CACHE: kv });

    const res = await request(`/api/mail-sync/accounts/${accountId}/sync-status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'idle' }),
    });
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put' && c.key === 'mbxdirv:ws_sync_status')).toBe(true);
  });

  it('does NOT bump on a read-only GET /accounts/:id/sync-status', async () => {
    const { kv, calls } = fakeKv();
    const { request } = makeApp('ws_sync_status_read', { WORKSPACE_CACHE: kv });

    const res = await request(`/api/mail-sync/accounts/${accountId}/sync-status`);
    expect(res.status).toBe(200);
    await flush();
    expect(calls.some((c) => c.op === 'put')).toBe(false);
  });
});
