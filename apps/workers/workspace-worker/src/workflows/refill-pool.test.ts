import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Env } from '../index';
import type { WorkflowStep } from 'cloudflare:workers';
import { LATEST_SCHEMA_VERSION, TenantMigrationError } from '../lib/tenant-migrations';
import { invalidatePoolState, RefillPoolWorkflow, triggerPoolRefill } from './refill-pool';

const { getMasterDb, applyTenantMigrations, dropDatabaseAt } = vi.hoisted(() => ({
  getMasterDb: vi.fn(),
  applyTenantMigrations: vi.fn(),
  dropDatabaseAt: vi.fn(),
}));
vi.mock('../db', () => ({ getMasterDb }));
vi.mock('@weldsuite/neon-provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/neon-provisioning')>()),
  createProvisioningService: () => ({ dropDatabaseAt }),
}));
vi.mock('../lib/tenant-migrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tenant-migrations')>()),
  applyTenantMigrations,
}));
vi.mock('../lib/database-move/neon-sql', () => ({ neonTenantSql: (url: string) => ({ url }) }));

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

const dialect = new PgDialect();

interface FakeSlot {
  id: string;
  databaseUrl: string;
  status: 'available' | 'assigned' | 'error';
  schemaVersion: string | null;
  kind: 'dedicated' | 'shared';
  neonProjectId: string;
  neonBranchId: string | null;
  databaseName: string;
  roleName: string;
  sharedProjectId: string | null;
}

/**
 * Master DB answering what one refill run asks of it about a single slot: the
 * available-slot counts (none; the targets are 0), the stale available slots,
 * and updates, which honour a status guard the way Postgres would.
 */
function createPoolMasterDb(slot: FakeSlot) {
  const updates: Array<{ set: Record<string, unknown>; params: unknown[] }> = [];
  const applyUpdate = (set: Record<string, unknown>, condition: SQL): Array<{ id: string }> => {
    const { params } = dialect.sqlToQuery(condition);
    updates.push({ set, params });
    if (params.includes('available') && slot.status !== 'available') return [];
    Object.assign(slot, set);
    return [{ id: slot.id }];
  };
  const staleSlots = () => {
    if (slot.status !== 'available' || slot.schemaVersion === LATEST_SCHEMA_VERSION) return [];
    const { status: _status, schemaVersion: _schemaVersion, ...row } = slot;
    return [row];
  };
  return {
    updates,
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => ('databaseUrl' in fields
          ? { limit: () => Promise.resolve(staleSlots()) }
          : { groupBy: () => Promise.resolve([]) }),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          let result: Array<{ id: string }> | undefined;
          const run = () => (result ??= applyUpdate(set, condition));
          return {
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              Promise.resolve().then(run).then(resolve, reject),
            returning: () => Promise.resolve().then(run),
          };
        },
      }),
    }),
  };
}

/** A Workflow step that runs its callback, retrying per its config like Cloudflare's. */
function createStep(): WorkflowStep {
  return {
    async do(_name: string, a: unknown, b?: unknown): Promise<unknown> {
      const config = (typeof a === 'function' ? undefined : a) as { retries?: { limit: number } } | undefined;
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      let last: unknown;
      for (let attempt = 0; attempt <= (config?.retries?.limit ?? 0); attempt++) {
        try {
          return await fn();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
    sleep: () => Promise.resolve(),
  } as unknown as WorkflowStep;
}

describe('RefillPoolWorkflow — catch-up of stale slots', () => {
  const SLOT_ID = 'dbp_mratz4dtzsm81cn2';
  const failuresKey = `refill-pool:catch-up-failures:${SLOT_ID}`;
  const failsOn = (tag: string) =>
    new TenantMigrationError(tag, 12, {
      cause: Object.assign(new Error('relation "product_variants" already exists'), { code: '42P07' }),
    });

  let slot: FakeSlot;
  let master: ReturnType<typeof createPoolMasterDb>;
  let kv: ReturnType<typeof createFakeKv>;

  /** One cron-started run: a fresh workflow instance with fresh steps. */
  const runRefill = () =>
    new RefillPoolWorkflow({} as never, {
      WORKSPACE_CACHE: kv,
      NEON_DEFAULT_REGION: REGION,
      POOL_TARGET_SHARED: '0',
      POOL_TARGET_DEDICATED: '0',
    } as unknown as Env).run({ payload: { region: REGION }, timestamp: new Date(), instanceId: 'refill' }, createStep());

  const failures = () => JSON.parse(kv.store.get(failuresKey) ?? 'null') as unknown;

  beforeEach(() => {
    slot = {
      id: SLOT_ID,
      databaseUrl: 'postgres://slot',
      status: 'available',
      schemaVersion: '0164_organic_moonstone',
      kind: 'dedicated',
      neonProjectId: 'proj_slot',
      neonBranchId: 'br_main',
      databaseName: 'neondb',
      roleName: 'neondb_owner',
      sharedProjectId: null,
    };
    master = createPoolMasterDb(slot);
    getMasterDb.mockReset();
    getMasterDb.mockReturnValue(master);
    applyTenantMigrations.mockReset();
    dropDatabaseAt.mockReset().mockResolvedValue(undefined);
    kv = createFakeKv();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retires a slot that fails on the same migration three runs in a row, so the next run settles', async () => {
    applyTenantMigrations.mockRejectedValue(failsOn('0165_overjoyed_hellion'));

    for (const count of [1, 2]) {
      expect(await runRefill()).toMatchObject({ caughtUp: 0, settled: false });
      expect(slot.status).toBe('available');
      expect(failures()).toEqual({ tag: '0165_overjoyed_hellion', count });
    }
    // A migration Postgres refused rolled back whole; the step does not retry it, the next run does.
    expect(applyTenantMigrations).toHaveBeenCalledTimes(2);

    expect(await runRefill()).toMatchObject({ caughtUp: 0, settled: false });
    expect(slot.status).toBe('error');
    expect(failures()).toBeNull();
    // Only while still unclaimed: a workspace may have claimed it since find-stale-slots.
    expect(master.updates.find((update) => update.set.status === 'error')?.params).toEqual([SLOT_ID, 'available']);

    // A dedicated slot's database stays for inspection (`pnpm cleanup:pool`).
    expect(dropDatabaseAt).not.toHaveBeenCalled();

    applyTenantMigrations.mockClear();
    expect(await runRefill()).toMatchObject({ caughtUp: 0, settled: true });
    expect(applyTenantMigrations).not.toHaveBeenCalled();
  });

  it('drops a retired shared slot, giving its shard the slot back', async () => {
    Object.assign(slot, {
      kind: 'shared',
      neonProjectId: 'proj_shard',
      databaseName: 'ws_slot',
      roleName: 'ws_slot_owner',
      sharedProjectId: 'nsp_shard',
    });
    applyTenantMigrations.mockRejectedValue(failsOn('0165_overjoyed_hellion'));

    for (let run = 0; run < 3; run++) await runRefill();

    expect(slot.status).toBe('error');
    expect(dropDatabaseAt).toHaveBeenCalledTimes(1);
    expect(dropDatabaseAt).toHaveBeenCalledWith(
      master,
      {
        neonProjectId: 'proj_shard',
        neonBranchId: 'br_main',
        databaseName: 'ws_slot',
        roleName: 'ws_slot_owner',
        sharedProjectId: 'nsp_shard',
        poolId: SLOT_ID,
      },
      { ignoreMissing: true },
    );
  });

  it('never drops a shared slot that lacks its shard id: it would read as a whole project', async () => {
    Object.assign(slot, { kind: 'shared', sharedProjectId: null });
    applyTenantMigrations.mockRejectedValue(failsOn('0165_overjoyed_hellion'));

    for (let run = 0; run < 3; run++) await runRefill();

    expect(slot.status).toBe('error');
    expect(dropDatabaseAt).not.toHaveBeenCalled();
  });

  it('starts the count over when the slot fails on a later migration', async () => {
    applyTenantMigrations
      .mockRejectedValueOnce(failsOn('0165_overjoyed_hellion'))
      .mockRejectedValueOnce(failsOn('0165_overjoyed_hellion'))
      .mockRejectedValueOnce(failsOn('0166_next'));

    for (let run = 0; run < 3; run++) await runRefill();

    expect(slot.status).toBe('available');
    expect(failures()).toEqual({ tag: '0166_next', count: 1 });
  });

  it('clears the count once the slot catches up', async () => {
    applyTenantMigrations
      .mockRejectedValueOnce(failsOn('0165_overjoyed_hellion'))
      .mockResolvedValueOnce({ applied: 2, skipped: 165, remaining: 0 });

    await runRefill();
    expect(failures()).toEqual({ tag: '0165_overjoyed_hellion', count: 1 });

    expect(await runRefill()).toMatchObject({ caughtUp: 1, settled: true });
    expect(slot).toMatchObject({ status: 'available', schemaVersion: LATEST_SCHEMA_VERSION });
    expect(failures()).toBeNull();
  });

  it('counts a slot it gets no answer from, after the step retried it', async () => {
    applyTenantMigrations.mockRejectedValue(new TypeError('fetch failed'));

    expect(await runRefill()).toMatchObject({ caughtUp: 0, settled: false });

    expect(applyTenantMigrations).toHaveBeenCalledTimes(2);
    expect(failures()).toEqual({ tag: null, count: 1 });
  });

  it('retires a slot it gets no answer from only after about a day of runs', async () => {
    applyTenantMigrations.mockRejectedValue(new TypeError('fetch failed'));

    for (let run = 0; run < 3; run++) await runRefill();
    // A Neon blip of a few runs is not the slot's fault.
    expect(slot.status).toBe('available');
    expect(failures()).toEqual({ tag: null, count: 3 });

    kv.store.set(failuresKey, JSON.stringify({ tag: null, count: 47 }));
    await runRefill();
    expect(slot.status).toBe('error');
    expect(failures()).toBeNull();
  });
});
