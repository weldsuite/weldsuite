/**
 * What the public API caches per workspace: licensed apps and read-only state,
 * read from the licence and the partner on a cache miss.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@weldsuite/db/lib/neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://resolved/tenant',
}));

import { getWorkspaceDetails } from '../middleware/auth';

const baseRow = {
  neonProjectId: 'p',
  neonBranchId: 'b',
  neonRoleName: 'r',
  neonDatabaseName: 'd',
  databaseUrl: null,
  clerkOrgId: 'org_1',
  planSlug: 'business',
  hasApiAccess: true,
  billingMode: 'direct',
  licenceStatus: null,
  licenceApps: null,
  partnerStatus: null,
};

function fakeMasterDb(row: Record<string, unknown> | undefined) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(row ? [row] : []);
  return chain as never;
}

function fakeKv(initial?: unknown) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set('ws:ws_1', JSON.stringify(initial));
  return {
    kv: {
      get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace,
    store,
  };
}

describe('external-api · getWorkspaceDetails', () => {
  it('leaves a direct workspace unrestricted', async () => {
    const { kv, store } = fakeKv();
    const out = await getWorkspaceDetails(kv, fakeMasterDb(baseRow), 'ws_1', 'neon');
    expect(out).toMatchObject({ licensedApps: null, readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('ws:ws_1')!)).toMatchObject({ licensedApps: null, readOnly: false });
  });

  it('licenses a partner workspace for its licence apps', async () => {
    const row = { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'active' };
    const out = await getWorkspaceDetails(fakeKv().kv, fakeMasterDb(row), 'ws_1', 'neon');
    expect(out).toMatchObject({ licensedApps: ['weldcrm'], readOnly: false });
  });

  it('marks a suspended partner\'s workspace read-only', async () => {
    const row = { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'suspended' };
    const { kv, store } = fakeKv();
    const out = await getWorkspaceDetails(kv, fakeMasterDb(row), 'ws_1', 'neon');
    expect(out).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
    expect(JSON.parse(store.get('ws:ws_1')!)).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
  });

  it('reads an entry cached before the new fields existed as unrestricted and writable', async () => {
    const { kv } = fakeKv({ databaseUrl: 'postgres://cached', tier: 'business', hasApiAccess: true });
    const out = await getWorkspaceDetails(kv, fakeMasterDb(undefined), 'ws_1', 'neon');
    expect(out?.licensedApps ?? null).toBeNull();
    expect(out?.readOnly ?? false).toBe(false);
  });
});
