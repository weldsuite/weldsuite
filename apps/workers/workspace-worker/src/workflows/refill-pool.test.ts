import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../index';
import { LATEST_SCHEMA_VERSION } from '../lib/tenant-migrations';
import { invalidatePoolState, triggerPoolRefill } from './refill-pool';

const { getMasterDb } = vi.hoisted(() => ({ getMasterDb: vi.fn() }));
vi.mock('../db', () => ({ getMasterDb }));

const REGION = 'aws-eu-central-1';
const OTHER_REGION = 'aws-us-east-2';
const REGIONS_KEY = 'refill-pool:regions';
const LOCK_KEY = 'refill-pool:inflight';
const stateKey = (region: string) => `refill-pool:state:${region}`;
const state = (settled: boolean, schemaVersion = LATEST_SCHEMA_VERSION) => ({ schemaVersion, settled });

/** Map-backed stand-in for the WORKSPACE_CACHE KV namespace. */
function createFakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

/** Master DB answering only the shard-region enumeration the trigger runs. */
function createFakeMasterDb(shardRegions: string[]) {
  return {
    selectDistinct: () => ({
      from: () => Promise.resolve(shardRegions.map(region => ({ region }))),
    }),
  };
}

function createEnv(kv: ReturnType<typeof createFakeKv>) {
  const create = vi.fn(async ({ id }: { id: string; params: { region: string } }) => ({ id }));
  const env = {
    WORKSPACE_CACHE: kv,
    REFILL_POOL: { create },
    NEON_API_KEY: 'neon_test',
    NEON_DEFAULT_REGION: REGION,
  } as unknown as Env;
  return { env, create };
}

describe('triggerPoolRefill — cached pool state', () => {
  beforeEach(() => {
    getMasterDb.mockReset();
    getMasterDb.mockReturnValue(createFakeMasterDb([REGION]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bundles a schema version for the cache to compare against', () => {
    // Every case below depends on it; without one the trigger bails before the cache.
    expect(LATEST_SCHEMA_VERSION).toBeTruthy();
  });

  it('skips a settled region without opening the database or taking the lock', async () => {
    const kv = createFakeKv({ [REGIONS_KEY]: [REGION], [stateKey(REGION)]: state(true) });
    const { env, create } = createEnv(kv);

    await triggerPoolRefill(env);

    expect(getMasterDb).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('skips a region backing off after a run that fell short', async () => {
    const kv = createFakeKv({ [REGIONS_KEY]: [REGION], [stateKey(REGION)]: state(false) });
    const { env, create } = createEnv(kv);

    await triggerPoolRefill(env);

    expect(getMasterDb).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('refills a region with no cached state', async () => {
    const kv = createFakeKv({ [REGIONS_KEY]: [REGION] });
    const { env, create } = createEnv(kv);

    await triggerPoolRefill(env);

    expect(getMasterDb).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].params).toEqual({ region: REGION });
    expect(kv.store.has(LOCK_KEY)).toBe(true);
  });

  it.each([true, false])(
    'refills a region whose cached state (settled=%s) predates the deployed schema',
    async (settled) => {
      const kv = createFakeKv({
        [REGIONS_KEY]: [REGION],
        [stateKey(REGION)]: state(settled, '0000_older_schema'),
      });
      const { env, create } = createEnv(kv);

      await triggerPoolRefill(env);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0].params).toEqual({ region: REGION });
    },
  );

  it('refills only the regions that are not backing off', async () => {
    getMasterDb.mockReturnValue(createFakeMasterDb([REGION, OTHER_REGION]));
    const kv = createFakeKv({
      [REGIONS_KEY]: [REGION, OTHER_REGION],
      [stateKey(REGION)]: state(false),
    });
    const { env, create } = createEnv(kv);

    await triggerPoolRefill(env);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].params).toEqual({ region: OTHER_REGION });
  });

  it('releases the lock when every enumerated region turns out to be backing off', async () => {
    // No region index, so the fast path can't vouch for the pool and the
    // regions come from Postgres — where the only one is still backing off.
    const kv = createFakeKv({ [stateKey(REGION)]: state(false) });
    const { env, create } = createEnv(kv);

    await triggerPoolRefill(env);

    expect(getMasterDb).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(kv.store.has(LOCK_KEY)).toBe(false);
  });

  it('refills on the next tick after a warm-slot claim clears the back-off', async () => {
    const kv = createFakeKv({ [REGIONS_KEY]: [REGION], [stateKey(REGION)]: state(false) });
    const { env, create } = createEnv(kv);

    // What services/provisioning.ts does after a workspace claims a warm slot.
    await invalidatePoolState(env);
    await triggerPoolRefill(env);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].params).toEqual({ region: REGION });
  });
});
