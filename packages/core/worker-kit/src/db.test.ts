/**
 * Workspace context resolution: what lands in the `ws:<org>` cache (licensed
 * apps, read-only, database move) and how entries written by older code or other
 * workers read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

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
vi.mock('@neondatabase/serverless', () => ({ neon: () => ({}) }));
vi.mock('@weldsuite/db/lib/neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://resolved/tenant',
}));

import { forgetWorkspaceContext, getWorkspaceContextForOrg, workspaceCacheKey } from './db';
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
  databaseMoveInProgress: false,
};

beforeEach(() => {
  rows.current = [baseRow];
  selected.current = null;
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

describe('getWorkspaceContextForOrg · database move', () => {
  it('marks a workspace with a write-blocking move read-only with reason database_move, and caches it', async () => {
    rows.current = [{ ...baseRow, databaseMoveInProgress: true }];
    const { env, store } = makeEnv();
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ id: 'ws_1', licensedApps: null, readOnly: true, readOnlyReason: 'database_move' });
    expect(JSON.parse(store.get('ws:org_1')!)).toMatchObject({ readOnly: true, readOnlyReason: 'database_move' });
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

describe('forgetWorkspaceContext', () => {
  it('deletes the ws:<org> entry, and only that one', async () => {
    const { env, kv, store } = makeEnv({
      'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://cached/t', licensedApps: null },
      'ws:org_2': { id: 'ws_2', databaseUrl: 'postgres://cached/t2', licensedApps: null },
    });
    await forgetWorkspaceContext(env, 'org_1');
    expect(kv.delete).toHaveBeenCalledWith(workspaceCacheKey('org_1'));
    expect(store.has('ws:org_1')).toBe(false);
    expect(store.has('ws:org_2')).toBe(true);
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

  it('serves a cached database_move entry as moving, without touching the master DB', async () => {
    rows.current = [];
    const { env } = makeEnv({
      'ws:org_1': {
        id: 'ws_1',
        databaseUrl: 'postgres://cached/t',
        suspended: false,
        licensedApps: null,
        readOnly: true,
        readOnlyReason: 'database_move',
      },
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
      'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://cached/t', suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null },
    });
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ readOnly: false, readOnlyReason: null });
    expect(selected.current).toBeNull();
    expect(JSON.parse(store.get('ws:org_1')!).readOnly).toBe(false);
  });

  it('re-resolves a purged entry and picks the move up', async () => {
    rows.current = [{ ...baseRow, databaseMoveInProgress: true }];
    const { env, store } = makeEnv({
      'ws:org_1': { id: 'ws_1', databaseUrl: 'postgres://cached/t', suspended: false, licensedApps: null, readOnly: false },
    });
    await forgetWorkspaceContext(env, 'org_1');
    const ctx = await getWorkspaceContextForOrg(env, 'org_1');
    expect(ctx).toMatchObject({ readOnly: true, readOnlyReason: 'database_move' });
    expect(JSON.parse(store.get('ws:org_1')!).readOnlyReason).toBe('database_move');
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
