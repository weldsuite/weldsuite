/**
 * Workspace context resolution: what lands in the `ws:<org>` cache (licensed
 * apps, read-only) and how entries written by older code or other workers read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: { current: Record<string, unknown>[] } = { current: [] };

// A thenable-free fake of the master query: select().from().leftJoin()x2.where().limit().
vi.mock('drizzle-orm/neon-http', () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows.current);
  return { drizzle: () => chain };
});
vi.mock('@neondatabase/serverless', () => ({ neon: () => ({}) }));
vi.mock('@weldsuite/db/lib/neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://resolved/tenant',
}));

import { getWorkspaceContextForOrg } from './db';
import type { DbEnv } from './env';

function makeEnv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    get: vi.fn(async (key: string) => {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  const env = {
    DATABASE_URL_MASTER: 'postgres://master',
    WORKSPACE_CACHE: kv as unknown as KVNamespace,
    NEON_API_KEY: 'k',
  } satisfies DbEnv;
  return { env, kv, store };
}

const baseRow = {
  id: 'ws_1',
  neonProjectId: 'p',
  neonBranchId: 'b',
  neonRoleName: 'r',
  neonDatabaseName: 'd',
  databaseUrl: null,
  isActive: true,
  billingMode: 'direct',
  licenceStatus: null,
  licenceApps: null,
  partnerStatus: null,
};

beforeEach(() => {
  rows.current = [baseRow];
});

describe('getWorkspaceContextForOrg · cache miss', () => {
  it('resolves a direct workspace as unrestricted and caches it', async () => {
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ id: 'ws_1', suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('ws:org_1')!)).toMatchObject({
      licensedApps: null,
      readOnly: false,
      readOnlyReason: null,
    });
  });

  it('carries a partner workspace\'s licence apps and caches them', async () => {
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' },
    ];
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: ['welddesk'], readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('ws:org_1')!)).toMatchObject({ licensedApps: ['welddesk'], readOnly: false });
  });

  it('marks a workspace of a suspended partner read-only', async () => {
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'suspended' },
    ];
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: ['weldcrm'], readOnly: true, readOnlyReason: 'partner_suspended' });
    expect(JSON.parse(store.get('ws:org_1')!)).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
  });

  it('marks a workspace with an inactive licence read-only', async () => {
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'suspended', licenceApps: ['weldcrm'], partnerStatus: 'active' },
    ];
    const ctx = await getWorkspaceContextForOrg(makeEnv().env, 'org_1');
    expect(ctx).toMatchObject({ readOnly: true, readOnlyReason: 'licence_inactive' });
  });

  it('still reports suspension of the workspace itself', async () => {
    rows.current = [{ ...baseRow, isActive: false }];
    const ctx = await getWorkspaceContextForOrg(makeEnv().env, 'org_1');
    expect(ctx.suspended).toBe(true);
  });
});

describe('getWorkspaceContextForOrg · cache hit', () => {
  it('serves a full entry without touching the master DB', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'ws:org_1': {
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: ['welddesk'],
        readOnly: true,
        readOnlyReason: 'partner_suspended',
      },
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ id: 'ws_1', licensedApps: ['welddesk'], readOnly: true, readOnlyReason: 'partner_suspended' });
  });

  it('reads an entry cached before readOnly existed as not read-only', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://cached/t', suspended: false, licensedApps: null },
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: null, readOnly: false, readOnlyReason: null });
  });

  it('keeps an explicit unrestricted entry', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://cached/t', suspended: false, licensedApps: null, readOnly: false },
    });
    expect((await getWorkspaceContextForOrg(env, 'org_1')).licensedApps).toBeNull();
  });

  it('re-resolves an entry another worker wrote without licence info', async () => {
    // Other workers cache only { id, databaseUrl }; it must not let a partner
    // workspace through unrestricted for the whole TTL.
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' },
    ];
    const { env, store } = makeEnv({ 'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://foreign/t' } });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx.licensedApps).toEqual(['welddesk']);
    expect(JSON.parse(store.get('ws:org_1')!).licensedApps).toEqual(['welddesk']);
  });
});
