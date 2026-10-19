/**
 * What the public API caches per workspace: licensed apps and read-only state,
 * read from the licence and the partner on a cache miss.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@weldsuite/db/lib/neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://resolved/tenant',
}));

import { sealCachedDatabaseUrl } from '@weldsuite/db/lib/workspace-url-cache';
import { getWorkspaceDetails } from '../middleware/auth';

const KEY = { v1: 'a'.repeat(64) };
const OTHER_KEY = { v1: 'b'.repeat(64) };

const baseRow = {
  neonProjectId: 'p',
  neonBranchId: 'b',
  neonRoleName: 'r',
  neonDatabaseName: 'd',
  databaseUrl: null,
  clerkOrgId: 'org_1',
  planSlug: 'business',
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
  if (initial !== undefined) store.set('wsx:id:ws_1', JSON.stringify(initial));
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
    const out = await getWorkspaceDetails(kv, fakeMasterDb(baseRow), 'ws_1', 'neon', KEY);
    expect(out).toMatchObject({ licensedApps: null, readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('wsx:id:ws_1')!)).toMatchObject({ licensedApps: null, readOnly: false });
  });

  it('caches the connection string sealed, never in the clear', async () => {
    const { kv, store } = fakeKv();
    const out = await getWorkspaceDetails(kv, fakeMasterDb(baseRow), 'ws_1', 'neon', KEY);
    expect(out?.databaseUrl).toBe('postgres://resolved/tenant');
    expect([...store.keys()]).toEqual(['wsx:id:ws_1']);
    const raw = store.get('wsx:id:ws_1')!;
    expect(raw).not.toContain('postgres');
    expect(JSON.parse(raw)).not.toHaveProperty('databaseUrl');

    // The sealed entry serves the next lookup without the master DB.
    const again = await getWorkspaceDetails(kv, fakeMasterDb(undefined), 'ws_1', 'neon', KEY);
    expect(again).toMatchObject({ databaseUrl: 'postgres://resolved/tenant', tier: 'business' });
    expect(again).not.toHaveProperty('databaseUrlSealed');
  });

  it('caches nothing when there is no encryption key', async () => {
    const { kv, store } = fakeKv();
    const out = await getWorkspaceDetails(kv, fakeMasterDb(baseRow), 'ws_1', 'neon');
    expect(out?.databaseUrl).toBe('postgres://resolved/tenant');
    expect(store.size).toBe(0);
  });

  it('treats a plaintext or foreign-key entry as a miss and re-resolves', async () => {
    const plain = fakeKv({ databaseUrl: 'postgres://evil', tier: 'business' });
    const a = await getWorkspaceDetails(plain.kv, fakeMasterDb(baseRow), 'ws_1', 'neon', KEY);
    expect(a?.databaseUrl).toBe('postgres://resolved/tenant');

    const foreign = fakeKv({
      databaseUrlSealed: await sealCachedDatabaseUrl('postgres://other', OTHER_KEY),
      tier: 'business',
    });
    const b = await getWorkspaceDetails(foreign.kv, fakeMasterDb(baseRow), 'ws_1', 'neon', KEY);
    expect(b?.databaseUrl).toBe('postgres://resolved/tenant');
  });

  it('licenses a partner workspace for its licence apps', async () => {
    const row = { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'active' };
    const out = await getWorkspaceDetails(fakeKv().kv, fakeMasterDb(row), 'ws_1', 'neon', KEY);
    expect(out).toMatchObject({ licensedApps: ['weldcrm'], readOnly: false });
  });

  it('marks a suspended partner\'s workspace read-only', async () => {
    const row = { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'suspended' };
    const { kv, store } = fakeKv();
    const out = await getWorkspaceDetails(kv, fakeMasterDb(row), 'ws_1', 'neon', KEY);
    expect(out).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
    expect(JSON.parse(store.get('wsx:id:ws_1')!)).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
  });

  it('reads an entry cached before the new fields existed as unrestricted and writable', async () => {
    const { kv } = fakeKv({
      databaseUrlSealed: await sealCachedDatabaseUrl('postgres://cached', KEY),
      tier: 'business',
      hasApiAccess: true,
    });
    const out = await getWorkspaceDetails(kv, fakeMasterDb(undefined), 'ws_1', 'neon', KEY);
    expect(out?.databaseUrl).toBe('postgres://cached');
    expect(out?.licensedApps ?? null).toBeNull();
    expect(out?.readOnly ?? false).toBe(false);
  });
});
