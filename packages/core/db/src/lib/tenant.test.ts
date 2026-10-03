import { describe, it, expect, vi, beforeEach } from 'vitest';

// The master DB is replaced by a chainable fake that resolves queued results.
const queue: unknown[][] = [];
const insertSpy = vi.fn();

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

import { getExistingTenantDb, isTenantNotFoundError, TenantNotFoundError } from './tenant';

beforeEach(() => {
  queue.length = 0;
  insertSpy.mockClear();
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
