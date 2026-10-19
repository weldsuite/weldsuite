/**
 * Test harness for the database-move Workflow and its services: a real master
 * schema and two real tenant databases (PGlite), with the Neon API, the lock
 * statements and the Workflow runtime replaced by fakes.
 *
 *  - master: the journaled master migrations on PGlite (`createMoveMaster`), with
 *    a `batch` that runs its queries in order, like neon-http's `db.batch`;
 *  - tenants: the fixture pair from `move-fixture.ts`, reached through `connect`,
 *    which only accepts the database's CURRENT password (a rotated one makes the
 *    old URL fail with 28P01, as on Neon);
 *  - provisioning: a fake of the Neon-side helpers that rotates those passwords;
 *  - guard: `lockDatabase` and friends cannot work on PGlite (one session, no
 *    `pg_stat_activity` backends), so the guard module is replaced by a stateful
 *    fake (`guardState`) via `createGuardModule`;
 *  - step: a Workflow step that memoizes results across runs and retries like
 *    Cloudflare does, with hooks to act between steps.
 *
 * Every secret the fakes hand out starts with `secret-`, so a test can assert
 * that nothing leaked into a log line, a stored error or a step result.
 */

import { vi } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import { encryptField, decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterTestDb } from '@weldsuite/neon-provisioning/test/master-db';
import type { Env } from '../index';
import type { MasterDatabase } from '../db';
import type { SqlParam, SqlRow, TenantSql } from '../lib/database-move/types';
import type { MoveDeps } from '../services/database-move/deps';
import { startDatabaseMove } from '../services/database-move/start';
import { createFixturePair } from './move-fixture';
import { createPgliteTenant, type PgliteTenant } from './pglite-tenant-sql';

export const SECRET_PREFIX = 'secret-';
export const REGION = 'aws-eu-central-1';
export const KEYRING: EncryptionKeyring = { v2: 'ab'.repeat(32) };

export const SOURCE = {
  project: 'prj-src',
  branch: 'br-src',
  db: 'ws_src_db',
  role: 'role_src',
  shard: 'nsp_src',
} as const;

export const TARGET = {
  project: 'prj-target',
  branch: 'br-target',
  db: 'tgt_db',
  role: 'tgt_role',
  shard: 'nsp_target',
} as const;

/** The journal the fixture databases carry (see FIXTURE_SCHEMA_SQL). */
export const FIXTURE_JOURNAL = { count: 2, maxCreatedAt: '1700000100000' } as const;

// ── Master ───────────────────────────────────────────────────────────────

export interface MoveMaster {
  db: MasterDatabase;
  /** Runs (once) before the queries of the next `db.batch`, e.g. to change the world mid-switch. */
  hooks: { beforeBatch: (() => Promise<void>) | null };
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createMoveMaster(): Promise<MoveMaster> {
  const base = await createMasterTestDb();
  const hooks: MoveMaster['hooks'] = { beforeBatch: null };
  const db = Object.assign(base.db, {
    async batch(queries: readonly PromiseLike<unknown>[]) {
      const hook = hooks.beforeBatch;
      hooks.beforeBatch = null;
      if (hook) await hook();
      const results: unknown[] = [];
      for (const query of queries) results.push(await query);
      return results;
    },
  }) as unknown as MasterDatabase;
  return {
    db,
    hooks,
    reset: async () => {
      hooks.beforeBatch = null;
      await base.reset();
    },
    close: base.close,
  };
}

// ── Connections ──────────────────────────────────────────────────────────

export function connectionUrl(options: { role: string; password: string; db: string; pooled: boolean }): string {
  const host = options.pooled ? 'ep-fake-pooler.eu-central-1.aws.neon.tech' : 'ep-fake.eu-central-1.aws.neon.tech';
  return `postgresql://${options.role}:${options.password}@${host}/${options.db}?sslmode=require`;
}

interface FakeDatabase {
  sql: TenantSql;
  password: string;
}

export interface Connections {
  databases: Map<string, FakeDatabase>;
  /** Source page reads (statement text and params), in order. */
  sourceReads: Array<{ text: string; params: readonly SqlParam[] }>;
  /** Statements run against the source after the lock (it must stay read-only: only reads). */
  hooks: {
    /** Called with the running insert count on every target page insert; a test can fail it or `await step.crash()`. */
    onTargetInsert: ((count: number) => Promise<void> | void) | null;
    targetInserts: number;
  };
  connect(url: string): TenantSql;
}

function passwordFailure(): Error {
  return Object.assign(new Error('password authentication failed for user "tenant"'), { code: '28P01' });
}

function createConnections(): Connections {
  const databases = new Map<string, FakeDatabase>();
  const sourceReads: Connections['sourceReads'] = [];
  const hooks: Connections['hooks'] = { onTargetInsert: null, targetInserts: 0 };

  const connect = (url: string): TenantSql => {
    const parsed = new URL(url);
    const name = parsed.pathname.slice(1);
    const password = decodeURIComponent(parsed.password);
    const database = databases.get(name);
    if (!database) throw new Error(`no fake database named ${name}`);
    const check = (): void => {
      if (database.password !== password) throw passwordFailure();
    };
    const observe = async (text: string, params?: readonly SqlParam[]): Promise<void> => {
      if (name === SOURCE.db && text.includes('row_to_json(x)')) sourceReads.push({ text, params: params ?? [] });
      if (name === TARGET.db && text.includes('json_to_recordset')) {
        hooks.targetInserts += 1;
        await hooks.onTargetInsert?.(hooks.targetInserts);
      }
    };
    return {
      async query(text, params): Promise<SqlRow[]> {
        check();
        await observe(text, params);
        return database.sql.query(text, params);
      },
      async transaction(statements): Promise<SqlRow[][]> {
        check();
        for (const statement of statements) await observe(statement.text, statement.params);
        return database.sql.transaction(statements);
      },
    };
  };
  return { databases, sourceReads, hooks, connect };
}

// ── Provisioning ─────────────────────────────────────────────────────────

export function createFakeProvisioning(connections: Connections) {
  let rotations = 0;
  return {
    prepareMoveTarget: vi.fn(async (_db: unknown, input: { workspaceId: string; region: string; target: { kind: 'dedicated' | 'shard' } }) => {
      const kind = input.target.kind;
      const password = connections.databases.get(TARGET.db)?.password ?? 'missing';
      return {
        kind,
        neonProjectId: TARGET.project,
        neonBranchId: TARGET.branch,
        databaseName: TARGET.db,
        roleName: TARGET.role,
        sharedProjectId: kind === 'shard' ? TARGET.shard : null,
        region: input.region,
        poolId: null,
        pooledUrl: connectionUrl({ role: TARGET.role, password, db: TARGET.db, pooled: true }),
        directUrl: connectionUrl({ role: TARGET.role, password, db: TARGET.db, pooled: false }),
        schemaVersion: null,
        endpointId: 'ep-target',
      };
    }),
    releaseMoveTarget: vi.fn(async (_db: unknown, _target: unknown) => {}),
    rotateRolePassword: vi.fn(async (coords: { databaseName: string; roleName: string }) => {
      rotations += 1;
      const database = connections.databases.get(coords.databaseName);
      if (!database) throw new Error('unknown database');
      database.password = `${SECRET_PREFIX}rotated-${rotations}`;
      return {
        pooledUrl: connectionUrl({ role: coords.roleName, password: database.password, db: coords.databaseName, pooled: true }),
        directUrl: connectionUrl({ role: coords.roleName, password: database.password, db: coords.databaseName, pooled: false }),
      };
    }),
    restartDedicatedEndpoint: vi.fn(async (_db: unknown, _projectId: string) => {}),
  };
}

export type FakeProvisioning = ReturnType<typeof createFakeProvisioning>;

// ── Guard ────────────────────────────────────────────────────────────────

/** State of the fake guard module: which databases are locked, and what was called. */
export const guardState = {
  locked: new Set<string>(),
  log: [] as string[],
  probe: 'on' as 'on' | 'off',
  reset(): void {
    this.locked.clear();
    this.log.length = 0;
    this.probe = 'on';
  },
};

/** Stands in for `lib/database-move/guard`: same exports, driven by {@link guardState}. */
export function createGuardModule() {
  return {
    currentDatabaseName: async () => 'unused',
    lockDatabase: async (sql: TenantSql, dbName: string) => {
      await sql.query('SELECT 1'); // fails like a real connection when the password is stale
      guardState.log.push(`lock:${dbName}`);
      guardState.locked.add(dbName);
    },
    unlockDatabase: async (sql: TenantSql, dbName: string) => {
      await sql.query('SELECT 1');
      guardState.log.push(`unlock:${dbName}`);
      guardState.locked.delete(dbName);
    },
    probeReadOnly: async (sql: TenantSql) => {
      await sql.query('SELECT 1');
      guardState.log.push('probe');
      return guardState.probe;
    },
    terminateOtherSessions: async (sql: TenantSql) => {
      await sql.query('SELECT 1');
      guardState.log.push('terminate');
      return { found: 0, terminated: 0, failed: 0 };
    },
    countOtherSessions: async () => 0,
  };
}

// ── The world ────────────────────────────────────────────────────────────

/** A database that answers every query with nothing: stands in for a tenant in tests that never read one. */
const EMPTY_TENANT: TenantSql = {
  query: async () => [],
  transaction: async (statements) => statements.map(() => []),
};

export interface LightWorld {
  master: MoveMaster;
  masterDb: MasterDatabase;
  connections: Connections;
  provisioning: FakeProvisioning;
  deps: MoveDeps;
  /** One entry per call of `deps.purgeCaches`. */
  purges: Array<{ workspaceId: string; clerkOrgId: string | null }>;
  migrate: ReturnType<typeof vi.fn>;
  env: Env;
}

export interface MoveWorld extends LightWorld {
  source: PgliteTenant;
  target: PgliteTenant;
  close(): Promise<void>;
}

export interface WorldOptions {
  /** Where the workspace lives now. Default: on shard `nsp_src`; null for a dedicated database. */
  sourceShard?: string | null;
  /** The journal `deps.bundledJournal` reports. Default: the fixture's. */
  bundledJournal?: { count: number; maxCreatedAt: string | null };
  retentionDays?: number;
  /** Fixed clock; default real time. */
  now?: () => Date;
}

export const WORKSPACE_ID = 'ws_1';
export const CLERK_ORG_ID = 'org_1';

/** Seed master with the two shards and a provisioned workspace on the source database. */
async function seedMaster(master: MoveMaster, sourceShard: string | null, sourceUrl: string): Promise<void> {
  const { neonSharedProjects, workspaces } = masterSchema;
  for (const id of [SOURCE.shard, TARGET.shard]) {
    await master.db.insert(neonSharedProjects).values({
      id,
      neonProjectId: id === SOURCE.shard ? SOURCE.project : 'prj-shard-target',
      neonProjectName: `shard ${id}`,
      region: REGION,
      mainBranchId: `br-${id}`,
      status: 'active',
    });
  }
  await master.db.insert(workspaces).values({
    id: WORKSPACE_ID,
    clerkOrgId: CLERK_ORG_ID,
    name: 'Acme',
    slug: 'acme',
    neonProjectId: SOURCE.project,
    neonBranchId: SOURCE.branch,
    neonRoleName: SOURCE.role,
    neonDatabaseName: SOURCE.db,
    neonRegion: REGION,
    sharedProjectId: sourceShard,
    databaseUrl: await encryptField(sourceUrl, KEYRING),
    databaseProvisionedAt: new Date('2026-01-01T00:00:00Z'),
    provisioningStatus: 'ready',
  });
}

async function buildWorld(
  master: MoveMaster,
  options: WorldOptions,
  tenants: { source: TenantSql; target: TenantSql },
): Promise<LightWorld> {
  await master.reset();
  guardState.reset();
  const sourceShard = options.sourceShard === undefined ? SOURCE.shard : options.sourceShard;

  const connections = createConnections();
  connections.databases.set(SOURCE.db, { sql: tenants.source, password: `${SECRET_PREFIX}source-0` });
  connections.databases.set(TARGET.db, { sql: tenants.target, password: `${SECRET_PREFIX}target-0` });

  const sourceUrl = connectionUrl({ role: SOURCE.role, password: `${SECRET_PREFIX}source-0`, db: SOURCE.db, pooled: true });
  await seedMaster(master, sourceShard, sourceUrl);

  const provisioning = createFakeProvisioning(connections);
  const purges: LightWorld['purges'] = [];
  const migrate = vi.fn(async (_url: string, _budget: number) => ({ applied: 0, skipped: FIXTURE_JOURNAL.count, remaining: 0 }));
  const deps: MoveDeps = {
    masterDb: master.db,
    provisioning,
    connect: connections.connect,
    migrate,
    encryptUrl: (url) => encryptField(url, KEYRING),
    decryptUrl: (stored) => (stored.startsWith('postgres') ? Promise.resolve(stored) : decryptField(stored, KEYRING)),
    bundledJournal: options.bundledJournal ?? { ...FIXTURE_JOURNAL },
    purgeCaches: async (target) => {
      purges.push(target);
    },
    retentionDays: options.retentionDays ?? 7,
    defaultRegion: REGION,
    now: options.now ?? (() => new Date()),
  };
  const env = {
    MOVE_DATABASE: { create: vi.fn(async () => ({})) },
    NEON_DEFAULT_REGION: REGION,
  } as unknown as Env;

  return { master, masterDb: master.db, connections, provisioning, deps, purges, migrate, env };
}

/** Master only (plus stub tenants): for the start, cancel and compensation tests. */
export function createLightWorld(master: MoveMaster, options: WorldOptions = {}): Promise<LightWorld> {
  return buildWorld(master, options, { source: EMPTY_TENANT, target: EMPTY_TENANT });
}

/** Master plus the fixture source and target databases: for runs of the Workflow. */
export async function createMoveWorld(master: MoveMaster, options: WorldOptions = {}): Promise<MoveWorld> {
  const { source, target } = await createFixturePair(createPgliteTenant);
  const world = await buildWorld(master, options, { source: source.sql, target: target.sql });
  return {
    ...world,
    source,
    target,
    close: async () => {
      await source.close();
      await target.close();
    },
  };
}

/** Start a move through the real service (validation, row, Workflow create call). Returns the move id. */
export async function startMove(world: LightWorld, target: string): Promise<string> {
  const started = await startDatabaseMove(
    world.env,
    { workspaceId: WORKSPACE_ID, target, startedBy: 'admin@weldsuite.org', reason: 'test' },
    { masterDb: world.masterDb },
  );
  return started.moveId;
}

// ── Workflow step ────────────────────────────────────────────────────────

/** What an `after` hook can do to the simulated instance. */
export interface StepControl {
  /**
   * The instance dies right here: whatever awaits this never continues, and
   * `FakeStep.crashed` resolves. Use it as the last statement of a hook or of
   * a fault injected into a step.
   */
  crash(): Promise<never>;
}

export interface FakeStepOptions {
  /** Called after the named step (a `do` or a `sleep`) finished, before the next one starts. */
  after?: Record<string, (control: StepControl) => Promise<void> | void>;
}

/** What `FakeStep.crashed` resolves to when the simulated instance dies. */
export const CRASHED = Symbol('crashed');

/**
 * A Workflow step that remembers finished steps across `run` calls, like
 * Cloudflare's replay, and retries a failed step per its config (stopping at a
 * `NonRetryableError`).
 *
 * `crash()` simulates the instance dying: whatever awaits it never continues
 * (no catch block runs, as when a Worker is evicted) and `crashed` resolves.
 * The test races `run` against `crashed`, then starts a new `run` with the
 * same step to resume. A step finished before the crash keeps its result; the
 * step the crash hit has none unless the crash came from its `after` hook.
 */
export function createFakeStep(options: FakeStepOptions = {}) {
  const results = new Map<string, unknown>();
  const names: string[] = [];
  const sleeps: Array<{ name: string; duration: string | number }> = [];
  const attempts = new Map<string, number>();
  let signalCrash: (value: typeof CRASHED) => void = () => {};
  const crashed = new Promise<typeof CRASHED>((resolve) => {
    signalCrash = resolve;
  });
  const control: StepControl = {
    crash: () => {
      signalCrash(CRASHED);
      return new Promise<never>(() => {});
    },
  };

  const finish = async (name: string): Promise<void> => {
    await options.after?.[name]?.(control);
  };

  return {
    names,
    sleeps,
    attempts,
    results,
    crashed,
    crash: control.crash,
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      names.push(name);
      if (results.has(name)) return results.get(name);
      const config = (typeof a === 'function' ? undefined : a) as { retries?: { limit: number } } | undefined;
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      const limit = config?.retries?.limit ?? 5;
      let last: unknown;
      for (let attempt = 0; attempt <= limit; attempt++) {
        attempts.set(name, (attempts.get(name) ?? 0) + 1);
        try {
          const value = await fn();
          results.set(name, value);
          await finish(name);
          return value;
        } catch (err) {
          last = err;
          if (err instanceof NonRetryableError) break;
        }
      }
      throw last;
    },
    async sleep(name: string, duration: string | number): Promise<void> {
      names.push(name);
      sleeps.push({ name, duration });
      await finish(name);
    },
  };
}

export type FakeStep = ReturnType<typeof createFakeStep>;
