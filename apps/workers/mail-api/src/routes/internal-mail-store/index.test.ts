import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';

let master: MasterDatabase;
let tenant: Database;

const stub = {
  startBackfill: vi.fn(),
  backfillStatus: vi.fn(),
  runParity: vi.fn(),
  reverseSync: vi.fn(),
  rebuildMailbox: vi.fn(),
  status: vi.fn(),
};

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => master, getTenantDbForWorkspace: async () => tenant };
});

vi.mock('@weldsuite/mail-domain/store/object', () => ({
  mailboxStubFor: () => stub,
}));

import { internalMailStoreRoutes } from './index';
import type { Env } from '../../types';

const { mailAccounts } = schema;

const SECRET = 'x'.repeat(40);
const headers = { 'x-admin-secret': SECRET, 'x-admin-email': 'Ops@WeldSuite.org', 'content-type': 'application/json' };
const env = { OUTBOUND_ADMIN_SECRET: SECRET, MAILBOX_STORE: {} } as unknown as Env;

const WORKSPACE_ID = 'ws_mailstore_admin';
let accountId: string;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master.insert(masterSchema.workspaces).values({ id: WORKSPACE_ID, name: 'Mail store admin test', slug: 'mail-store-admin', clerkOrgId: 'org_mailstore_admin' });

  tenant = (await createPgliteDb()).db;
  accountId = generateId('mail');
  await tenant.insert(mailAccounts).values({ id: accountId, name: 'Admin test mailbox', email: `${accountId}@test.dev`, isShared: true });
}, 60_000);

beforeEach(() => {
  for (const fn of Object.values(stub)) fn.mockReset();
});

function request(path: string, init: RequestInit = {}) {
  return internalMailStoreRoutes.request(path, { headers, ...init }, env);
}

describe('/internal/mail-store auth', () => {
  it('is closed without a configured secret', async () => {
    const res = await internalMailStoreRoutes.request('/status?workspaceId=x&accountId=y', { headers }, { ...env, OUTBOUND_ADMIN_SECRET: 'short' });
    expect(res.status).toBe(503);
  });

  it('refuses a wrong secret and a missing admin identity', async () => {
    expect((await request('/status?workspaceId=x&accountId=y', { headers: { ...headers, 'x-admin-secret': 'y'.repeat(40) } })).status).toBe(401);
    expect((await request('/status?workspaceId=x&accountId=y', { headers: { 'x-admin-secret': SECRET } })).status).toBe(400);
  });
});

describe('/internal/mail-store workspace/account validation', () => {
  it('404s an unknown workspace', async () => {
    const res = await request(`/status?workspaceId=ws_nope&accountId=${accountId}`);
    expect(res.status).toBe(404);
    expect(stub.status).not.toHaveBeenCalled();
  });

  it('404s an unknown mail account in a real workspace', async () => {
    const res = await request(`/status?workspaceId=${WORKSPACE_ID}&accountId=acc_nope`);
    expect(res.status).toBe(404);
    expect(stub.status).not.toHaveBeenCalled();
  });
});

describe('/internal/mail-store backfill', () => {
  it('starts a backfill and returns its state', async () => {
    stub.startBackfill.mockResolvedValue({ state: 'running', phase: 'subscriptions' });
    const res = await request('/backfill', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId, source: 'console' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { state: 'running', phase: 'subscriptions' } });
    expect(stub.startBackfill).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: 'org_mailstore_admin' },
      { force: undefined, source: 'console' },
    );
  });

  it('defaults source to the acting admin when not supplied', async () => {
    stub.startBackfill.mockResolvedValue({ state: 'running' });
    await request('/backfill', { method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId }) });
    expect(stub.startBackfill).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'admin:ops@weldsuite.org' }));
  });

  it('reads backfill status', async () => {
    stub.backfillStatus.mockResolvedValue({ state: 'done' });
    const res = await request(`/backfill?workspaceId=${WORKSPACE_ID}&accountId=${accountId}`);
    expect(await res.json()).toEqual({ data: { state: 'done' } });
  });
});

describe('/internal/mail-store parity', () => {
  it('returns the report directly when the first call already finishes', async () => {
    stub.runParity.mockResolvedValue({ done: true, scanned: 10, missing: [], extra: [], different: [], cursor: null, repaired: false });
    const res = await request('/parity', { method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { done: boolean; iterations: number } };
    expect(body.data.done).toBe(true);
    expect(body.data.iterations).toBe(1);
    expect(stub.runParity).toHaveBeenCalledTimes(1);
  });

  it('loops to completion across multiple rounds, merging missing/extra/different', async () => {
    stub.runParity
      .mockResolvedValueOnce({ done: false, scanned: 2, missing: ['m1'], extra: [], different: [], cursor: 'm1', repaired: false })
      .mockResolvedValueOnce({ done: true, scanned: 1, missing: ['m2'], extra: ['e1'], different: [{ id: 'd1', reasons: ['labels'] }], cursor: null, repaired: false });

    const res = await request('/parity', { method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId, repair: true, maxRows: 2 }) });
    const body = (await res.json()) as {
      data: { done: boolean; scanned: number; missing: string[]; extra: string[]; different: unknown[]; iterations: number };
    };
    expect(body.data.done).toBe(true);
    expect(body.data.scanned).toBe(3);
    expect(body.data.missing.sort()).toEqual(['m1', 'm2']);
    expect(body.data.extra).toEqual(['e1']);
    expect(body.data.different).toHaveLength(1);
    expect(body.data.iterations).toBe(2);
    expect(stub.runParity).toHaveBeenNthCalledWith(1, expect.anything(), { repair: true, cursor: null, maxRows: 2 });
    expect(stub.runParity).toHaveBeenNthCalledWith(2, expect.anything(), { repair: true, cursor: 'm1', maxRows: 2 });
  });
});

describe('/internal/mail-store reverse-sync', () => {
  it('requires `since`', async () => {
    const res = await request('/reverse-sync', { method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId }) });
    expect(res.status).toBe(400);
  });

  it('loops to completion, summing counts across rounds', async () => {
    stub.reverseSync
      .mockResolvedValueOnce({ done: false, counts: { messagesInserted: 2, messagesUpdated: 0, draftsSynced: 1, subscriptionsSynced: 0 }, cursor: { updatedAt: 1, id: 'm2' } })
      .mockResolvedValueOnce({ done: true, counts: { messagesInserted: 1, messagesUpdated: 1, draftsSynced: 0, subscriptionsSynced: 2 }, cursor: null });

    const since = Date.now() - 60_000;
    const res = await request('/reverse-sync', { method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId, since }) });
    const body = (await res.json()) as { data: { done: boolean; counts: { messagesInserted: number; messagesUpdated: number; draftsSynced: number; subscriptionsSynced: number }; iterations: number } };
    expect(body.data.done).toBe(true);
    expect(body.data.counts).toEqual({ messagesInserted: 3, messagesUpdated: 1, draftsSynced: 1, subscriptionsSynced: 2 });
    expect(body.data.iterations).toBe(2);
  });
});

describe('/internal/mail-store rebuild', () => {
  it('rebuilds the mailbox', async () => {
    stub.rebuildMailbox.mockResolvedValue({ state: 'running', phase: 'subscriptions' });
    const res = await request('/rebuild', { method: 'POST', body: JSON.stringify({ workspaceId: WORKSPACE_ID, accountId }) });
    expect(res.status).toBe(200);
    expect(stub.rebuildMailbox).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, accountId, clerkOrgId: 'org_mailstore_admin' });
  });
});

describe('/internal/mail-store status', () => {
  it('reads one mailbox', async () => {
    stub.status.mockResolvedValue({ ready: true, counts: { messages: 5 } });
    const res = await request(`/status?workspaceId=${WORKSPACE_ID}&accountId=${accountId}`);
    expect(await res.json()).toEqual({ data: { ready: true, counts: { messages: 5 } } });
  });

  it('reads every mailbox of a workspace', async () => {
    stub.status.mockResolvedValue({ ready: true, counts: { messages: 1 } });
    const res = await request(`/status/all?workspaceId=${WORKSPACE_ID}`);
    const body = (await res.json()) as { data: Array<{ accountId: string; status?: unknown; error?: string }> };
    expect(body.data).toEqual([{ accountId, status: { ready: true, counts: { messages: 1 } } }]);
  });

  it('reports a per-mailbox error instead of failing the whole request', async () => {
    stub.status.mockRejectedValue(new Error('boom'));
    const res = await request(`/status/all?workspaceId=${WORKSPACE_ID}`);
    const body = (await res.json()) as { data: Array<{ accountId: string; error?: string }> };
    expect(body.data).toEqual([{ accountId, error: 'boom' }]);
  });
});
