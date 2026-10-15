/**
 * App-access reads on a master handle of any driver: the uncached read, and
 * the KV-cached one (key, TTL, and no master handle opened on a hit).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APP_ACCESS_CACHE_TTL_SECONDS,
  appAccessCacheKey,
  getAppAccessFrom,
  readAppAccessFrom,
  type AppAccess,
} from './app-access';
import { masterSchema, type AnyMasterDatabase } from './db';
import { createMasterPgliteDb } from './testing/pglite';

const { workspaces, workspaceAppAccess } = masterSchema;

let master: AnyMasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as AnyMasterDatabase;
  await master.insert(workspaces).values([
    { id: 'ws_aa_1', clerkOrgId: 'org_aa_approved', name: 'Approved', slug: 'ws-aa-1' },
    { id: 'ws_aa_2', clerkOrgId: 'org_aa_nothing', name: 'Nothing', slug: 'ws-aa-2' },
  ]);
  await master.insert(workspaceAppAccess).values({
    id: 'waa_aa_1',
    workspaceId: 'ws_aa_1',
    appCode: 'weldreach',
    status: 'approved',
    limits: { dailySends: 50 },
    billingStatus: 'past_due',
    billingStatusAt: new Date('2026-10-01T10:00:00.000Z'),
  });
}, 60_000);

function fakeCache(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const get = vi.fn(async (key: string) => {
    const v = store.get(key);
    return v === undefined ? null : JSON.parse(v);
  });
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  return { cache: { get, put } as unknown as Pick<KVNamespace, 'get' | 'put'>, get, put, store };
}

describe('readAppAccessFrom', () => {
  it('reads status, limits and billing state of an approved workspace', async () => {
    expect(await readAppAccessFrom(master, 'org_aa_approved', 'weldreach')).toEqual({
      workspaceId: 'ws_aa_1',
      status: 'approved',
      limits: { dailySends: 50 },
      billingStatus: 'past_due',
      billingStatusAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('reports "none" for a workspace that never asked, and no workspace for an unknown org', async () => {
    expect(await readAppAccessFrom(master, 'org_aa_nothing', 'weldreach')).toMatchObject({
      workspaceId: 'ws_aa_2',
      status: 'none',
      limits: {},
      billingStatus: 'none',
      billingStatusAt: null,
    });
    expect(await readAppAccessFrom(master, 'org_aa_missing', 'weldreach')).toMatchObject({ workspaceId: null, status: 'none' });
  });
});

describe('getAppAccessFrom', () => {
  it('reads master on a miss and stores the answer under appaccess:<org>:<app> for 60 s', async () => {
    const { cache, put } = fakeCache();
    const open = vi.fn(() => master);

    const access = await getAppAccessFrom({ cache, master: open }, 'org_aa_approved', 'weldreach');

    expect(access.status).toBe('approved');
    expect(open).toHaveBeenCalledOnce();
    expect(APP_ACCESS_CACHE_TTL_SECONDS).toBe(60);
    expect(put).toHaveBeenCalledWith(appAccessCacheKey('org_aa_approved', 'weldreach'), JSON.stringify(access), {
      expirationTtl: 60,
    });
    expect(appAccessCacheKey('org_aa_approved', 'weldreach')).toBe('appaccess:org_aa_approved:weldreach');
  });

  it('serves a cached entry without opening a master handle', async () => {
    const cached: AppAccess = {
      workspaceId: 'ws_cached',
      status: 'suspended',
      limits: {},
      billingStatus: 'none',
      billingStatusAt: null,
    };
    const { cache } = fakeCache({ [appAccessCacheKey('org_cached', 'weldreach')]: cached });
    const open = vi.fn(() => master);

    expect(await getAppAccessFrom({ cache, master: open }, 'org_cached', 'weldreach')).toEqual(cached);
    expect(open).not.toHaveBeenCalled();
  });

  it('still answers when the cache is down', async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new Error('kv down');
      }),
      put: vi.fn(async () => {
        throw new Error('kv down');
      }),
    } as unknown as Pick<KVNamespace, 'get' | 'put'>;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const access = await getAppAccessFrom({ cache, master: () => master }, 'org_aa_approved', 'weldreach');

    expect(access.status).toBe('approved');
    warn.mockRestore();
  });
});
