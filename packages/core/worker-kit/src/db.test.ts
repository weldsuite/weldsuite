/**
 * Workspace context resolution: what lands in the `wsx:<org>` cache (licensed
 * apps, read-only), that the connection string is only ever stored sealed, and
 * how entries written by older code or other workers read.
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
const resolveDatabaseUrl = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'postgres://resolved/tenant'));
vi.mock('@weldsuite/db/lib/neon-resolve', () => ({ resolveDatabaseUrl }));

import { sealCachedDatabaseUrl } from '@weldsuite/db/lib/workspace-url-cache';
import { getWorkspaceContextForOrg } from './db';
import type { DbEnv } from './env';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const TENANT_URL = 'postgres://resolved/tenant';

/** A cache entry as a worker stores it: the URL sealed, never in the clear. */
async function stored(entry: Record<string, unknown> & { databaseUrl: string }, key = KEY) {
  const { databaseUrl, ...rest } = entry;
  return { ...rest, databaseUrlSealed: await sealCachedDatabaseUrl(databaseUrl, key) };
}

function makeEnv(initial: Record<string, unknown> = {}, keys: { v1?: string; v2?: string } | null = { v1: KEY }) {
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
    ...(keys ? { DATABASE_ENCRYPTION_KEY: keys.v1, DATABASE_ENCRYPTION_KEY_V2: keys.v2 } : {}),
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
  resolveDatabaseUrl.mockClear();
});

describe('getWorkspaceContextForOrg · cache miss', () => {
  it('resolves a direct workspace as unrestricted and caches it', async () => {
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ id: 'ws_1', suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('wsx:org_1')!)).toMatchObject({
      licensedApps: null,
      readOnly: false,
      readOnlyReason: null,
    });
  });

  it('caches the connection string sealed, never in the clear, and only under the sealed key', async () => {
    const { env, store, kv } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx.id).toBe('ws_1');
    expect([...store.keys()]).toEqual(['wsx:org_1']);
    const raw = store.get('wsx:org_1')!;
    expect(raw).not.toContain('postgres');
    expect(raw).not.toContain(TENANT_URL);
    expect(JSON.parse(raw)).not.toHaveProperty('databaseUrl');
    expect(JSON.parse(raw).databaseUrlSealed).toEqual(expect.any(String));
    expect(kv.put).toHaveBeenCalledTimes(1);

    // And the sealed entry serves the next lookup without the master DB.
    rows.current = [];
    expect((await getWorkspaceContextForOrg(env, 'org_1')).id).toBe('ws_1');
  });

  it('hands the URL resolver the id of the row it read: the AAD of a v3 database_url', async () => {
    rows.current = [{ ...baseRow, databaseUrl: 'v3:00:00' }];
    const { env } = makeEnv();
    await getWorkspaceContextForOrg(env, 'org_1');
    expect(resolveDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(resolveDatabaseUrl.mock.calls[0]?.[1]).toMatchObject({ id: 'ws_1', databaseUrl: 'v3:00:00' });
  });

  it('caches nothing when the worker has no encryption key', async () => {
    const { env, store, kv } = makeEnv({}, null);
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx.id).toBe('ws_1');
    expect(kv.put).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('carries a partner workspace\'s licence apps and caches them', async () => {
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' },
    ];
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: ['welddesk'], readOnly: false, readOnlyReason: null });
    expect(JSON.parse(store.get('wsx:org_1')!)).toMatchObject({ licensedApps: ['welddesk'], readOnly: false });
  });

  it('marks a workspace of a suspended partner read-only', async () => {
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['weldcrm'], partnerStatus: 'suspended' },
    ];
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: ['weldcrm'], readOnly: true, readOnlyReason: 'partner_suspended' });
    expect(JSON.parse(store.get('wsx:org_1')!)).toMatchObject({ readOnly: true, readOnlyReason: 'partner_suspended' });
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
      'wsx:org_1': await stored({
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: ['welddesk'],
        readOnly: true,
        readOnlyReason: 'partner_suspended',
      }),
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ id: 'ws_1', licensedApps: ['welddesk'], readOnly: true, readOnlyReason: 'partner_suspended' });
  });

  it('reads an entry cached before readOnly existed as not read-only', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'wsx:org_1': await stored({ id: 'ws_1', databaseUrl: 'postgres://cached/t', suspended: false, licensedApps: null }),
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: null, readOnly: false, readOnlyReason: null });
  });

  it('keeps an explicit unrestricted entry', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'wsx:org_1': await stored({
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: null,
        readOnly: false,
      }),
    });
    expect((await getWorkspaceContextForOrg(env, 'org_1')).licensedApps).toBeNull();
  });

  it('re-resolves an entry another worker wrote without licence info', async () => {
    // Other workers cache only { id, databaseUrl }; it must not let a partner
    // workspace through unrestricted for the whole TTL.
    rows.current = [
      { ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' },
    ];
    const { env, store } = makeEnv({ 'wsx:org_1': await stored({ id: 'ws_1', databaseUrl: 'postgres://foreign/t' }) });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx.licensedApps).toEqual(['welddesk']);
    expect(JSON.parse(store.get('wsx:org_1')!).licensedApps).toEqual(['welddesk']);
  });

  it('ignores a plaintext entry under the old ws: key', async () => {
    rows.current = [{ ...baseRow, billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' }];
    const { env } = makeEnv({
      'ws:org_1': { id: 'ws_old', databaseUrl: 'postgres://old/t', suspended: false, licensedApps: null },
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx.id).toBe('ws_1');
    expect(ctx.licensedApps).toEqual(['welddesk']);
  });

  it('treats a plaintext databaseUrl under the sealed key as a miss', async () => {
    const { env, store } = makeEnv({
      'wsx:org_1': { id: 'ws_evil', databaseUrl: 'postgres://evil/t', suspended: false, licensedApps: null },
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx.id).toBe('ws_1');
    expect(store.get('wsx:org_1')).not.toContain('evil');
  });

  it('treats an entry sealed with a key this worker lacks as a miss', async () => {
    const { env } = makeEnv({
      'wsx:org_1': await stored({ id: 'ws_other', databaseUrl: 'postgres://x/t', suspended: false, licensedApps: null }, OTHER_KEY),
    });
    expect((await getWorkspaceContextForOrg(env, 'org_1')).id).toBe('ws_1');
  });
});
