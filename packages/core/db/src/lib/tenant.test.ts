import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The master DB is replaced by a chainable fake that resolves queued results.
const queue: unknown[][] = [];
const insertSpy = vi.fn();

// Pools are fakes that record how they were opened and closed.
const { pools } = vi.hoisted(() => ({
  pools: [] as Array<{ connectionString: string; ended: boolean; events: string[] }>,
}));

vi.mock('@neondatabase/serverless', () => {
  class Pool {
    connectionString: string;
    ended = false;
    events: string[] = [];
    constructor(options: { connectionString: string }) {
      this.connectionString = options.connectionString;
      pools.push(this);
    }
    on(event: string) {
      this.events.push(event);
      return this;
    }
    end() {
      this.ended = true;
      return Promise.resolve();
    }
  }
  return { Pool, neonConfig: {} };
});

vi.mock('./master', () => {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve(queue.shift() ?? []),
  };
  return {
    masterDb: {
      select: () => chain,
      insert: (...args: unknown[]) => {
        insertSpy(...args);
        throw new Error('getExistingTenantDb must never provision');
      },
    },
  };
});

vi.mock('./neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://fake',
}));

import {
  evictTenantDb,
  getExistingTenantDb,
  getTenantDb,
  getTenantDbByWorkspaceId,
  isTenantNotFoundError,
  TenantNotFoundError,
} from './tenant';

beforeEach(() => {
  queue.length = 0;
  insertSpy.mockClear();
  pools.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getExistingTenantDb', () => {
  it('throws TenantNotFoundError for an unknown id and never provisions a workspace', async () => {
    // by workspace id, then by clerk org id
    queue.push([], []);
    await expect(getExistingTenantDb('org_unknown')).rejects.toBeInstanceOf(TenantNotFoundError);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('treats an inactive workspace as not found', async () => {
    queue.push([{ workspace: { id: 'ws_1', isActive: false, clerkOrgId: 'org_1' }, plan: null }]);
    await expect(getExistingTenantDb('ws_1')).rejects.toSatisfy(isTenantNotFoundError);
  });
});

describe('isTenantNotFoundError', () => {
  it('recognises the typed error and its duck-typed twin', () => {
    expect(isTenantNotFoundError(new TenantNotFoundError('x'))).toBe(true);
    expect(isTenantNotFoundError({ code: 'TENANT_NOT_FOUND' })).toBe(true);
    expect(isTenantNotFoundError(new Error('boom'))).toBe(false);
    expect(isTenantNotFoundError(null)).toBe(false);
  });
});

describe('getExistingTenantDb · workspace cache', () => {
  const provisioned = {
    id: 'ws_cached',
    clerkOrgId: 'org_cached',
    isActive: true,
    databaseUrl: 'postgres://fake',
    neonProjectId: 'p',
    neonBranchId: 'b',
    neonRoleName: 'r',
    neonDatabaseName: 'd',
  };

  it('serves repeat lookups (by workspace id and by clerk org id) from the cache, not the master DB', async () => {
    queue.push([{ workspace: provisioned, plan: { slug: 'business' } }]);
    const first = await getExistingTenantDb('ws_cached');
    expect(first).toMatchObject({ workspaceId: 'ws_cached', tier: 'business', clerkOrgId: 'org_cached' });

    // The queue is empty now: any master-DB query would resolve [] and throw TenantNotFoundError.
    const again = await getExistingTenantDb('ws_cached');
    expect(again.workspaceId).toBe('ws_cached');
    const byOrg = await getExistingTenantDb('org_cached');
    expect(byOrg).toMatchObject({ workspaceId: 'ws_cached', clerkOrgId: 'org_cached' });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('treats a workspace without a tenant database as not found and does not cache it', async () => {
    const pending = { ...provisioned, id: 'ws_pending', clerkOrgId: 'org_pending', databaseUrl: null, neonProjectId: null };
    queue.push([{ workspace: pending, plan: null }]);
    await expect(getExistingTenantDb('ws_pending')).rejects.toBeInstanceOf(TenantNotFoundError);
    // a second call must query the master DB again (queue is empty -> not found), i.e. nothing was cached
    await expect(getExistingTenantDb('ws_pending')).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it('treats a phantom workspace row for a made-up clerk org id as not found', async () => {
    // What the old auto-provisioning getTenantDb left behind: active, no Neon database.
    const phantom = { id: 'ws_phantom', clerkOrgId: 'org_doesnotexist', isActive: true, databaseUrl: null, neonProjectId: null, neonBranchId: null, neonRoleName: null, neonDatabaseName: null };
    queue.push([], [{ workspace: phantom, plan: null }]);
    await expect(getExistingTenantDb('org_doesnotexist')).rejects.toSatisfy(isTenantNotFoundError);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('tenant pool cache', () => {
  const workspace = (id: string, databaseUrl: string) => ({
    id,
    clerkOrgId: `org_${id}`,
    isActive: true,
    databaseUrl,
    neonProjectId: 'p',
    neonBranchId: 'b',
    neonRoleName: 'r',
    neonDatabaseName: 'd',
  });

  it('reuses one pool while the workspace connection is unchanged', async () => {
    queue.push([{ workspace: workspace('ws_reuse', 'enc:1'), plan: null }]);
    const first = await getTenantDbByWorkspaceId('ws_reuse');
    const second = await getTenantDbByWorkspaceId('ws_reuse');
    expect(second.db).toBe(first.db);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.ended).toBe(false);
  });

  it('handles errors from idle pool clients instead of crashing', async () => {
    queue.push([{ workspace: workspace('ws_errors', 'enc:1'), plan: null }]);
    await getTenantDbByWorkspaceId('ws_errors');
    expect(pools[0]!.events).toContain('error');
  });

  it('closes the old pool and opens a new one when the stored database URL changes', async () => {
    // The workspace-id path caches enc:1; the org path then reads the master DB
    // and finds the database moved (enc:2) for the same workspace.
    queue.push([{ workspace: workspace('ws_moved', 'enc:1'), plan: null }]);
    const before = await getTenantDbByWorkspaceId('ws_moved');
    queue.push([{ workspace: workspace('ws_moved', 'enc:2'), plan: null }]);
    const after = await getTenantDb('org_ws_moved');
    expect(after.db).not.toBe(before.db);
    expect(pools).toHaveLength(2);
    expect(pools[0]!.ended).toBe(true);
    expect(pools[1]!.ended).toBe(false);
  });

  it('recycles a pool older than five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
    queue.push([{ workspace: workspace('ws_old', 'enc:1'), plan: null }]);
    const first = await getTenantDbByWorkspaceId('ws_old');

    vi.setSystemTime(new Date('2026-10-19T10:06:00Z'));
    // The workspace info expired too, so the master DB is read again (unchanged).
    queue.push([{ workspace: workspace('ws_old', 'enc:1'), plan: null }]);
    const second = await getTenantDbByWorkspaceId('ws_old');
    expect(second.db).not.toBe(first.db);
    expect(pools.map((p) => p.ended)).toEqual([true, false]);
  });

  it('evictTenantDb closes the pool and makes the next call read the master DB again', async () => {
    queue.push([{ workspace: workspace('ws_evict', 'enc:1'), plan: null }]);
    await getTenantDbByWorkspaceId('ws_evict');
    evictTenantDb('ws_evict', 'org_ws_evict');
    expect(pools[0]!.ended).toBe(true);

    // Nothing cached any more: with an empty queue the master DB returns no row.
    await expect(getTenantDbByWorkspaceId('ws_evict')).rejects.toThrow('Workspace not found or inactive');
    queue.push([{ workspace: workspace('ws_evict', 'enc:2'), plan: null }]);
    await getTenantDbByWorkspaceId('ws_evict');
    expect(pools).toHaveLength(2);
  });
});
