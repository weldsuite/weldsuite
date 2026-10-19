/**
 * What the MCP server caches per workspace: licensed apps and read-only state,
 * read from the licence and the partner on a cache miss.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@weldsuite/db/lib/neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://resolved/tenant',
}));

import { sealCachedDatabaseUrl } from '@weldsuite/db/lib/workspace-url-cache';
import { getWorkspaceForOrg } from './auth';

const KEY = { v1: 'a'.repeat(64) };
const OTHER_KEY = { v1: 'b'.repeat(64) };

const baseRow = {
  id: 'ws_1',
  name: 'Acme',
  planSlug: 'business',
  neonProjectId: 'p',
  neonBranchId: 'b',
  neonRoleName: 'r',
  neonDatabaseName: 'd',
  databaseUrl: null,
  billingMode: 'direct',
  licenceStatus: null,
  licenceApps: null,
  partnerStatus: null,
};

function fakeMasterDb(row: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([row]);
  return chain as never;
}

function fakeKv(initial?: unknown) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set('mcpx:org:org_1', JSON.stringify(initial));
  return {
    kv: {
      get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace,
    store,
  };
}

describe('mcp-server · getWorkspaceForOrg', () => {
  it('leaves a direct workspace unrestricted', async () => {
    const { kv, store } = fakeKv();
    const out = await getWorkspaceForOrg(kv, fakeMasterDb(baseRow), 'org_1', 'neon', KEY);
    expect(out).toMatchObject({ workspaceId: 'ws_1', licensedApps: null, readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('mcpx:org:org_1')!)).toMatchObject({ licensedApps: null, readOnly: false });
  });

  it('caches the connection string sealed, never in the clear', async () => {
    const { kv, store } = fakeKv();
    const out = await getWorkspaceForOrg(kv, fakeMasterDb(baseRow), 'org_1', 'neon', KEY);
    expect(out?.databaseUrl).toBe('postgres://resolved/tenant');
    expect([...store.keys()]).toEqual(['mcpx:org:org_1']);
    const raw = store.get('mcpx:org:org_1')!;
    expect(raw).not.toContain('postgres');
    expect(JSON.parse(raw)).not.toHaveProperty('databaseUrl');

    // The sealed entry serves the next lookup with the URL restored.
    const again = await getWorkspaceForOrg(kv, fakeMasterDb({ ...baseRow, id: 'ws_changed' }), 'org_1', 'neon', KEY);
    expect(again).toMatchObject({ workspaceId: 'ws_1', databaseUrl: 'postgres://resolved/tenant' });
    expect(again).not.toHaveProperty('databaseUrlSealed');
  });

  it('caches nothing when there is no encryption key', async () => {
    const { kv, store } = fakeKv();
    const out = await getWorkspaceForOrg(kv, fakeMasterDb(baseRow), 'org_1', 'neon');
    expect(out?.databaseUrl).toBe('postgres://resolved/tenant');
    expect(store.size).toBe(0);
  });

  it('treats a plaintext or foreign-key entry as a miss and re-resolves', async () => {
    const plain = fakeKv({ workspaceId: 'ws_evil', name: 'x', tier: 'business', databaseUrl: 'postgres://evil' });
    expect((await getWorkspaceForOrg(plain.kv, fakeMasterDb(baseRow), 'org_1', 'neon', KEY))?.workspaceId).toBe('ws_1');

    const foreign = fakeKv({
      workspaceId: 'ws_evil',
      name: 'x',
      tier: 'business',
      databaseUrlSealed: await sealCachedDatabaseUrl('postgres://other', OTHER_KEY),
    });
    expect((await getWorkspaceForOrg(foreign.kv, fakeMasterDb(baseRow), 'org_1', 'neon', KEY))?.workspaceId).toBe('ws_1');
  });

  it('licenses a partner workspace for its licence apps', async () => {
    const row = { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'active' };
    const out = await getWorkspaceForOrg(fakeKv().kv, fakeMasterDb(row), 'org_1', 'neon', KEY);
    expect(out).toMatchObject({ licensedApps: ['weldcrm'], readOnly: false });
  });

  it('marks a suspended partner\'s workspace read-only', async () => {
    const row = { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'suspended' };
    const { kv, store } = fakeKv();
    const out = await getWorkspaceForOrg(kv, fakeMasterDb(row), 'org_1', 'neon', KEY);
    expect(out).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
    expect(JSON.parse(store.get('mcpx:org:org_1')!)).toMatchObject({ readOnly: true });
  });

  it('reads an entry cached before the new fields existed as unrestricted and writable', async () => {
    const { kv } = fakeKv({
      workspaceId: 'ws_1',
      name: 'Acme',
      tier: 'business',
      databaseUrlSealed: await sealCachedDatabaseUrl('postgres://cached', KEY),
    });
    const out = await getWorkspaceForOrg(kv, fakeMasterDb(baseRow), 'org_1', 'neon', KEY);
    expect(out?.databaseUrl).toBe('postgres://cached');
    expect(out?.licensedApps ?? null).toBeNull();
    expect(out?.readOnly ?? false).toBe(false);
  });
});
