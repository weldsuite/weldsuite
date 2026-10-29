/**
 * Workspace context resolution: what lands in the `wsx:<org>` cache (licensed
 * apps, read-only, database move), that the connection string is only ever
 * stored sealed, and how entries written by older code or other workers read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { RequestTiming } from './timing';

const rows: { current: Record<string, unknown>[] } = { current: [] };
/** The field map the last master `select()` was given. */
const selected: { current: Record<string, unknown> | null } = { current: null };

// A thenable-free fake of the master query: select().from().leftJoin()x2.where().limit().
vi.mock('drizzle-orm/neon-http', () => {
  const chain: Record<string, unknown> = {};
  chain.select = (fields: Record<string, unknown>) => {
    selected.current = fields;
    return chain;
  };
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows.current);
  return { drizzle: () => chain };
});
// A bare `query`/`transaction` pair: enough for `instrumentNeonClient` (./timing.ts)
// to wrap without crashing when a test passes a `RequestTiming` through.
vi.mock('@neondatabase/serverless', () => ({ neon: () => ({ query: () => ({}), transaction: () => Promise.resolve([]) }) }));
const resolveDatabaseUrl = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'postgres://resolved/tenant'));
vi.mock('@weldsuite/db/lib/neon-resolve', () => ({ resolveDatabaseUrl }));

import { sealCachedDatabaseUrl } from '@weldsuite/db/lib/workspace-url-cache';
import {
  __resetContextMemoryForTests,
  forgetWorkspaceContext,
  getWorkspaceContextForOrg,
  getWorkspaceForOrg,
  legacyWorkspaceCacheKey,
  workspaceCacheKey,
} from './db';
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
  clerkOrgId: 'org_1',
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
  databaseMoveInProgress: false,
};

beforeEach(() => {
  rows.current = [baseRow];
  resolveDatabaseUrl.mockClear();
  selected.current = null;
  // Every test below reuses 'org_1' / 'ws_1' with a fresh env+store; without
  // this, the isolate-level memory cache (db.ts, Task B) would serve one
  // test's resolved promise to the next.
  __resetContextMemoryForTests();
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

describe('getWorkspaceContextForOrg · database move', () => {
  it('marks a workspace with a write-blocking move read-only with reason database_move, and caches it', async () => {
    rows.current = [{ ...baseRow, databaseMoveInProgress: true }];
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ id: 'ws_1', licensedApps: null, readOnly: true, readOnlyReason: 'database_move' });
    expect(JSON.parse(store.get('wsx:org_1')!)).toMatchObject({ readOnly: true, readOnlyReason: 'database_move' });
  });

  it('lets the move outrank a suspended partner and keeps the licensed apps', async () => {
    rows.current = [
      {
        ...baseRow,
        billingMode: 'partner',
        licenceStatus: 'active',
        licenceApps: ['weldcrm'],
        partnerStatus: 'suspended',
        databaseMoveInProgress: true,
      },
    ];
    const ctx = await getWorkspaceContextForOrg(makeEnv().env, 'org_1');
    expect(ctx).toMatchObject({ licensedApps: ['weldcrm'], readOnly: true, readOnlyReason: 'database_move' });
  });

  it('leaves the workspace writable when the row has no move (false, or a row without the column)', async () => {
    for (const row of [baseRow, { ...baseRow, databaseMoveInProgress: undefined }]) {
      rows.current = [row];
      const ctx = await getWorkspaceContextForOrg(makeEnv().env, 'org_1');
      expect(ctx).toMatchObject({ readOnly: false, readOnlyReason: null });
    }
  });

  it('still reports suspension of a workspace that is also moving', async () => {
    rows.current = [{ ...baseRow, isActive: false, databaseMoveInProgress: true }];
    const ctx = await getWorkspaceContextForOrg(makeEnv().env, 'org_1');
    expect(ctx).toMatchObject({ suspended: true, readOnlyReason: 'database_move' });
  });

  it('asks master for the move in the same query, as an EXISTS select field', async () => {
    // The SQL itself is checked in workspace-moving.test.ts and, on a real
    // master schema, in db.pglite.test.ts.
    await getWorkspaceContextForOrg(makeEnv().env, 'org_1');
    const field = selected.current?.databaseMoveInProgress as SQL | undefined;
    expect(field).toBeDefined();
    expect(new PgDialect().sqlToQuery(field!).sql).toContain('exists (');
  });
});

describe('getWorkspaceContextForOrg · either identifier', () => {
  it('resolves by workspaces.id, caches under that id, and returns both ids', async () => {
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'ws_1');
    expect(ctx).toMatchObject({ id: 'ws_1', clerkOrgId: 'org_1' });
    expect([...store.keys()]).toEqual(['wsx:ws_1']);
    expect(JSON.parse(store.get('wsx:ws_1')!)).toMatchObject({ id: 'ws_1', clerkOrgId: 'org_1' });

    rows.current = [];
    expect(await getWorkspaceForOrg(env, 'ws_1')).toEqual({ id: 'ws_1', clerkOrgId: 'org_1' });
  });

  it('returns both ids when resolved by the Clerk org id', async () => {
    expect(await getWorkspaceForOrg(makeEnv().env, 'org_1')).toEqual({ id: 'ws_1', clerkOrgId: 'org_1' });
  });

  it('keeps a workspace without a Clerk org as such', async () => {
    rows.current = [{ ...baseRow, clerkOrgId: null }];
    expect(await getWorkspaceForOrg(makeEnv().env, 'ws_1')).toEqual({ id: 'ws_1', clerkOrgId: null });
  });

  it('reads the org id of an entry cached before it was stored from the key it sits under', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'wsx:org_1': await stored({ id: 'ws_1', databaseUrl: 'postgres://cached/t', suspended: false, licensedApps: null }),
    });
    expect(await getWorkspaceForOrg(env, 'org_1')).toEqual({ id: 'ws_1', clerkOrgId: 'org_1' });
  });
});

describe('forgetWorkspaceContext', () => {
  it('deletes the entries under every id it is given, and skips missing ones', async () => {
    const { env, store } = makeEnv({
      'wsx:org_1': await stored({ id: 'ws_1', databaseUrl: 'postgres://cached/t', licensedApps: null }),
      'wsx:ws_1': await stored({ id: 'ws_1', databaseUrl: 'postgres://cached/t', licensedApps: null }),
    });
    await forgetWorkspaceContext(env, 'org_1', undefined, 'ws_1', null);
    expect(store.has('wsx:org_1')).toBe(false);
    expect(store.has('wsx:ws_1')).toBe(false);
  });

  it('deletes the sealed wsx:<org> entry and the old plaintext ws:<org> one, and only those', async () => {
    const { env, kv, store } = makeEnv({
      'wsx:org_1': await stored({ id: 'ws_1', databaseUrl: 'postgres://cached/t', licensedApps: null }),
      'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://cached/t', licensedApps: null },
      'wsx:org_2': await stored({ id: 'ws_2', databaseUrl: 'postgres://cached/t2', licensedApps: null }),
    });
    await forgetWorkspaceContext(env, 'org_1');
    expect(kv.delete).toHaveBeenCalledWith(workspaceCacheKey('org_1'));
    expect(kv.delete).toHaveBeenCalledWith(legacyWorkspaceCacheKey('org_1'));
    expect(store.has('wsx:org_1')).toBe(false);
    expect(store.has('ws:org_1')).toBe(false);
    expect(store.has('wsx:org_2')).toBe(true);
  });

  it('never throws when the KV delete fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { WORKSPACE_CACHE: { delete: () => Promise.reject(new Error('kv down')) } as unknown as KVNamespace };
    await expect(forgetWorkspaceContext(env, 'org_1')).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('never throws when there is no binding at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(forgetWorkspaceContext(undefined as never, 'org_1')).resolves.toBeUndefined();
    warn.mockRestore();
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

  it('serves a cached database_move entry as moving, without touching the master DB', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'wsx:org_1': await stored({
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: null,
        readOnly: true,
        readOnlyReason: 'database_move',
      }),
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ readOnly: true, readOnlyReason: 'database_move' });
    expect(selected.current).toBeNull();
  });

  it('serves an entry cached before database moves existed as not moving, from the cache', async () => {
    // Master would say "moving", but the entry is complete and cached: the
    // purge at the start of a move is what makes it re-resolve.
    rows.current = [{ ...baseRow, databaseMoveInProgress: true }];
    const { env, store } = makeEnv({
      'wsx:org_1': await stored({
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: null,
        readOnly: false,
        readOnlyReason: null,
      }),
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ readOnly: false, readOnlyReason: null });
    expect(selected.current).toBeNull();
    expect(JSON.parse(store.get('wsx:org_1')!).readOnly).toBe(false);
  });

  it('re-resolves a purged entry and picks the move up', async () => {
    rows.current = [{ ...baseRow, databaseMoveInProgress: true }];
    const { env, store } = makeEnv({
      'wsx:org_1': await stored({
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: null,
        readOnly: false,
      }),
    });
    await forgetWorkspaceContext(env, 'org_1');
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ readOnly: true, readOnlyReason: 'database_move' });
    expect(JSON.parse(store.get('wsx:org_1')!).readOnlyReason).toBe('database_move');
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

describe('getCachedWorkspaceUrl · isolate-level memory coalescing (Task B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces back-to-back calls for the same ref into one KV read and one master query', async () => {
    const { env, kv } = makeEnv();
    const [a, b] = await Promise.all([
      getWorkspaceContextForOrg(env, 'org_1'),
      getWorkspaceContextForOrg(env, 'org_1'),
    ]);
    expect(a.id).toBe('ws_1');
    expect(b.id).toBe('ws_1');
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(resolveDatabaseUrl).toHaveBeenCalledTimes(1);
  });

  it('serves a resolved lookup to a later call within the TTL window, with no further KV or master traffic', async () => {
    const { env, kv } = makeEnv();
    await getWorkspaceContextForOrg(env, 'org_1');
    kv.get.mockClear();
    kv.put.mockClear();
    resolveDatabaseUrl.mockClear();

    const ctx = await getWorkspaceContextForOrg(env, 'org_1');

    expect(ctx.id).toBe('ws_1');
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(resolveDatabaseUrl).not.toHaveBeenCalled();
  });

  it('does not record a KV read on a caller\'s own timing when served from memory', async () => {
    const { env } = makeEnv();
    await getWorkspaceContextForOrg(env, 'org_1');

    const timing = new RequestTiming();
    await getWorkspaceContextForOrg(env, 'org_1', timing);

    expect(timing.touchedStorage).toBe(false);
  });

  it('re-resolves once the in-memory window has passed', async () => {
    vi.useFakeTimers();
    const { env, kv } = makeEnv();
    await getWorkspaceContextForOrg(env, 'org_1');
    kv.get.mockClear();

    vi.advanceTimersByTime(11_000);
    await getWorkspaceContextForOrg(env, 'org_1');

    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('never remembers a rejected lookup: the next call retries instead of replaying the failure', async () => {
    rows.current = [];
    const { env } = makeEnv();
    await expect(getWorkspaceContextForOrg(env, 'org_1')).rejects.toThrow('Workspace not found');

    rows.current = [baseRow];
    await expect(getWorkspaceContextForOrg(env, 'org_1')).resolves.toMatchObject({ id: 'ws_1' });
  });

  it('forgetWorkspaceContext drops the in-memory entry immediately, ahead of its own TTL', async () => {
    const { env, kv } = makeEnv();
    await getWorkspaceContextForOrg(env, 'org_1');

    await forgetWorkspaceContext(env, 'org_1');
    kv.get.mockClear();

    await getWorkspaceContextForOrg(env, 'org_1');
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('keeps separate workspaces (and refs) from colliding in the same isolate', async () => {
    rows.current = [{ ...baseRow, id: 'ws_2', clerkOrgId: 'org_2' }];
    const { env: envForOrg2 } = makeEnv();
    const ctx2 = await getWorkspaceContextForOrg(envForOrg2, 'org_2');

    rows.current = [baseRow];
    const { env: envForOrg1 } = makeEnv();
    const ctx1 = await getWorkspaceContextForOrg(envForOrg1, 'org_1');

    expect(ctx2.id).toBe('ws_2');
    expect(ctx1.id).toBe('ws_1');
  });
});
