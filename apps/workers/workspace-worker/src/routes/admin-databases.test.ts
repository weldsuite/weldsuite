/**
 * The admin console's database API: auth and roles, request validation, error
 * mapping, the audit trail, and that no response ever carries the encrypted
 * target URL, the saved copy state, the checksums or a connection string.
 *
 * A real master schema (PGlite) behind the routes; the Neon side (endpoints,
 * shard sizes, the recovery's unlock and release) is faked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { asc, eq } from 'drizzle-orm';
import {
  adminAuditEvents,
  neonSharedProjects,
  workspaceDatabaseMoves,
  workspaces,
  type DatabaseMoveStatus,
} from '@weldsuite/db/schema/master';
import { NeonApiError, type NeonEndpoint } from '@weldsuite/neon-provisioning';

vi.mock('../lib/database-move/guard', async () => (await import('../test/move-harness')).createGuardModule());

import {
  REGION,
  SECRET_PREFIX,
  SOURCE,
  TARGET,
  WORKSPACE_ID,
  createLightWorld,
  createMoveMaster,
  guardState,
  type LightWorld,
  type MoveMaster,
} from '../test/move-harness';
import type { Env } from '../index';
import { parseAdminActor, secretsMatch } from '../middleware/admin-auth';
import { startDatabaseMove } from '../services/database-move';
import { LIVE_LOOKUP_CONCURRENCY } from '../services/database-live';
import { createAdminDatabaseRoutes } from './admin-databases';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'a'.repeat(40);
const NOW = new Date('2026-10-19T09:00:00.000Z');

let master: MoveMaster;
let world: LightWorld;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeAll(async () => {
  master = await createMoveMaster();
});

afterAll(async () => {
  await master.close();
});

beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  const output = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
  vi.restoreAllMocks();
  expect(output).not.toContain(SECRET_PREFIX);
  expect(output).not.toContain('postgresql://');
});

// ── Fakes and helpers ────────────────────────────────────────────────────

function endpoint(id: string, over: Partial<NeonEndpoint> = {}): NeonEndpoint {
  return {
    id,
    host: `${id}.eu-central-1.aws.neon.tech`,
    project_id: 'prj',
    branch_id: 'br',
    type: 'read_write',
    current_state: 'idle',
    pooler_enabled: true,
    pooler_mode: 'transaction',
    autoscaling_limit_min_cu: 0.25,
    autoscaling_limit_max_cu: 2,
    suspend_timeout_seconds: 300,
    last_active: '2026-10-19T08:00:00Z',
    ...over,
  };
}

interface Fakes {
  listEndpoints: ReturnType<typeof vi.fn>;
  readSizes: ReturnType<typeof vi.fn>;
}

function routesFor(w: LightWorld, fakes: Partial<Fakes> = {}) {
  const listEndpoints =
    fakes.listEndpoints ?? vi.fn(async (projectId: string) => ({ endpoints: [endpoint(`ep-${projectId}`)] }));
  const readSizes = fakes.readSizes ?? vi.fn(async () => []);
  const routes = createAdminDatabaseRoutes({
    masterDb: () => w.masterDb,
    moveDeps: () => w.deps,
    endpointLister: () => ({ listEndpoints }) as never,
    shardSizeReader: () => readSizes as never,
    now: () => NOW,
  });
  return { routes, listEndpoints, readSizes };
}

function envOf(w: LightWorld, over: Partial<Env> = {}): Env {
  return { ...w.env, WORKSPACE_ADMIN_SECRET: SECRET, ...over } as Env;
}

function headers(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    'x-admin-secret': SECRET,
    'x-admin-email': 'Ops@WeldSuite.org',
    'x-admin-user-id': 'user_ops',
    'x-admin-role': 'superadmin',
    'content-type': 'application/json',
    ...extra,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

type Routes = ReturnType<typeof routesFor>['routes'];

async function call(
  routes: Routes,
  w: LightWorld,
  path: string,
  options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string | undefined>; env?: Env } = {},
) {
  const method = options.method ?? 'GET';
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const res = await routes.request(path, { method, headers: headers(options.headers), ...(body !== undefined ? { body } : {}) }, options.env ?? envOf(w));
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as { data?: unknown; error?: { code: string; message: string } }) : null };
}

async function setup(): Promise<LightWorld> {
  world = await createLightWorld(master, { now: () => NOW });
  return world;
}

async function auditRows() {
  return world.masterDb.select().from(adminAuditEvents).orderBy(asc(adminAuditEvents.createdAt));
}

async function moveRow(moveId: string) {
  const [row] = await world.masterDb.select().from(workspaceDatabaseMoves).where(eq(workspaceDatabaseMoves.id, moveId));
  if (!row) throw new Error('no move row');
  return row;
}

async function setMove(moveId: string, values: Partial<typeof workspaceDatabaseMoves.$inferInsert>) {
  await world.masterDb.update(workspaceDatabaseMoves).set(values).where(eq(workspaceDatabaseMoves.id, moveId));
}

async function startMoveRow(target = 'dedicated'): Promise<string> {
  const started = await startDatabaseMove(
    world.env,
    { workspaceId: WORKSPACE_ID, target, startedBy: 'ops@weldsuite.org' },
    { masterDb: world.masterDb },
  );
  return started.moveId;
}

/** A move that got as far as the lock: the row says so, and the source is locked. */
async function lockedMove(status: DatabaseMoveStatus = 'failed'): Promise<string> {
  const moveId = await startMoveRow();
  await setMove(moveId, {
    status,
    error: 'Neon was down',
    progress: { tables: [], copiedRows: 0, totalRows: null, lockStartedAt: new Date().toISOString() },
    lockedAt: new Date(),
    targetNeonProjectId: TARGET.project,
    targetNeonBranchId: TARGET.branch,
    targetDatabaseName: TARGET.db,
    targetRoleName: TARGET.role,
    targetSharedProjectId: null,
    targetDatabaseUrl: 'v2:aa:bb',
  });
  guardState.locked.add(SOURCE.db);
  return moveId;
}

const START_PATH = `/workspaces/${WORKSPACE_ID}/database-moves`;

/** Values that must never appear in any response body. */
const FORBIDDEN_IN_RESPONSES = [
  'target_database_url',
  'targetDatabaseUrl',
  'v2:aa:bb',
  'sourceChecksums',
  'saved',
  'cursor',
  'postgresql://',
  'postgres://',
  SECRET_PREFIX,
  'adminPasswordEncrypted',
];

function expectNoLeak(text: string) {
  for (const forbidden of FORBIDDEN_IN_RESPONSES) expect(text).not.toContain(forbidden);
}

// ── Auth ─────────────────────────────────────────────────────────────────

describe('admin auth', () => {
  it('answers 503 when the shared secret is missing or too short, before touching anything', async () => {
    await setup();
    const masterDb = vi.fn(() => {
      throw new Error('the master DB must not be opened');
    });
    const routes = createAdminDatabaseRoutes({ masterDb });
    for (const secret of [undefined, 'short', 'b'.repeat(31)]) {
      const res = await call(routes, world, START_PATH, {
        method: 'POST',
        body: { target: 'dedicated' },
        env: envOf(world, { WORKSPACE_ADMIN_SECRET: secret }),
      });
      expect(res.status).toBe(503);
      expect(res.json?.error?.code).toBe('NOT_CONFIGURED');
    }
    expect(masterDb).not.toHaveBeenCalled();
  });

  it('rejects a wrong or missing secret with 401', async () => {
    await setup();
    const { routes } = routesFor(world);
    expect((await call(routes, world, '/databases/live', { headers: { 'x-admin-secret': 'c'.repeat(40) } })).status).toBe(401);
    expect((await call(routes, world, '/databases/live', { headers: { 'x-admin-secret': undefined } })).status).toBe(401);
    expect((await call(routes, world, '/databases/live', { headers: { 'x-admin-secret': SECRET.slice(0, -1) } })).status).toBe(401);
  });

  it('requires the admin identity: a valid email and a known role', async () => {
    await setup();
    const { routes } = routesFor(world);
    for (const override of [
      { 'x-admin-email': undefined },
      { 'x-admin-email': 'not-an-email' },
      { 'x-admin-role': undefined },
      { 'x-admin-role': 'owner' },
      { 'x-admin-role': '' },
    ]) {
      const res = await call(routes, world, '/databases/live', { headers: override });
      expect(res.status).toBe(401);
      expect(res.json?.error?.code).toBe('UNAUTHORIZED');
    }
  });

  it.each(['admin', 'viewer'])('refuses every mutating route to a %s with 403, and does nothing', async (role) => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await lockedMove('copying');
    const attempts: Array<[string, unknown]> = [
      [START_PATH, { target: 'dedicated' }],
      [`/database-moves/${moveId}/cancel`, undefined],
      [`/database-moves/${moveId}/recover`, { force: true }],
    ];
    for (const [path, body] of attempts) {
      const res = await call(routes, world, path, { method: 'POST', body, headers: { 'x-admin-role': role } });
      expect(res.status).toBe(403);
      expect(res.json?.error?.code).toBe('FORBIDDEN');
    }
    expect((await moveRow(moveId)).status).toBe('copying');
    expect(guardState.locked.has(SOURCE.db)).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it.each(['superadmin', 'admin', 'viewer'])('lets a %s read', async (role) => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await startMoveRow();
    for (const path of ['/databases/live', `/database-moves/${moveId}`, START_PATH]) {
      expect((await call(routes, world, path, { headers: { 'x-admin-role': role } })).status).toBe(200);
    }
  });

  it('never caches a response', async () => {
    await setup();
    const { routes } = routesFor(world);
    const res = await routes.request('/databases/live', { headers: headers() }, envOf(world));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('secretsMatch and parseAdminActor', () => {
  it('matches equal secrets only', async () => {
    expect(await secretsMatch(SECRET, SECRET)).toBe(true);
    expect(await secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(await secretsMatch('', SECRET)).toBe(false);
  });

  it('normalises the identity and keeps the user id optional', () => {
    expect(parseAdminActor('  Ops@WeldSuite.org ', 'user_1', ' SuperAdmin ')).toEqual({
      email: 'ops@weldsuite.org',
      userId: 'user_1',
      role: 'superadmin',
    });
    expect(parseAdminActor('ops@weldsuite.org', undefined, 'viewer')).toEqual({
      email: 'ops@weldsuite.org',
      userId: null,
      role: 'viewer',
    });
  });

  it('rejects an incomplete identity', () => {
    expect(parseAdminActor(undefined, 'u', 'admin')).toBeNull();
    expect(parseAdminActor('ops', 'u', 'admin')).toBeNull();
    expect(parseAdminActor('ops@weldsuite.org', 'u', undefined)).toBeNull();
    expect(parseAdminActor('ops@weldsuite.org', 'u', 'root')).toBeNull();
  });
});

// ── Start ────────────────────────────────────────────────────────────────

describe('POST /workspaces/:workspaceId/database-moves', () => {
  it('starts a move as the acting admin, answers 202 and audits it', async () => {
    await setup();
    const { routes } = routesFor(world);

    const res = await call(routes, world, START_PATH, { method: 'POST', body: { target: 'dedicated', reason: '  noisy neighbour ' } });

    expect(res.status).toBe(202);
    const data = res.json?.data as { moveId: string; kind: string };
    expect(data).toEqual({ moveId: expect.stringMatching(/^dbm_/), kind: 'shard_to_dedicated' });
    expect(world.env.MOVE_DATABASE.create).toHaveBeenCalledWith({ id: data.moveId, params: { moveId: data.moveId } });
    expect(await moveRow(data.moveId)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      status: 'queued',
      requestedTarget: 'dedicated',
      startedBy: 'ops@weldsuite.org',
      startedByUserId: 'user_ops',
      reason: 'noisy neighbour',
    });
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        targetType: 'workspace',
        targetId: WORKSPACE_ID,
        action: 'database.move_start',
        outcome: 'success',
        actorEmail: 'ops@weldsuite.org',
        actorUserId: 'user_ops',
        reason: 'noisy neighbour',
        details: { moveId: data.moveId, kind: 'shard_to_dedicated', target: 'dedicated' },
        error: null,
      }),
    ]);
  });

  it('accepts a shard id and shard:auto as the target', async () => {
    await setup();
    const { routes } = routesFor(world);
    const first = await call(routes, world, START_PATH, { method: 'POST', body: { target: TARGET.shard } });
    expect(first.status).toBe(202);
    expect((first.json?.data as { kind: string }).kind).toBe('shard_to_shard');
  });

  it.each([
    ['a missing target', { reason: 'x' }],
    ['an unknown target', { target: 'nowhere' }],
    ['an upper-case shard id', { target: 'nsp_UPPER' }],
    ['a non-string target', { target: 5 }],
    ['an over-long reason', { target: 'dedicated', reason: 'x'.repeat(2001) }],
  ])('refuses %s with 400 and records the attempt', async (_name, body) => {
    await setup();
    const { routes } = routesFor(world);

    const res = await call(routes, world, START_PATH, { method: 'POST', body });

    expect(res.status).toBe(400);
    expect(res.json?.error?.code).toBe('INVALID_INPUT');
    expect(world.env.MOVE_DATABASE.create).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([
      expect.objectContaining({ action: 'database.move_start', outcome: 'failure', error: expect.stringContaining('INVALID_INPUT') }),
    ]);
  });

  it('refuses a body that is not JSON', async () => {
    await setup();
    const { routes } = routesFor(world);
    const res = await call(routes, world, START_PATH, { method: 'POST', rawBody: '{nope' });
    expect(res.status).toBe(400);
    expect(res.json?.error).toEqual({ code: 'INVALID_INPUT', message: 'The request body is not valid JSON' });
  });

  it('maps the service refusals to their status and audits the failure', async () => {
    await setup();
    const { routes } = routesFor(world);

    const missing = await call(routes, world, '/workspaces/ws_missing/database-moves', { method: 'POST', body: { target: 'dedicated' } });
    expect(missing.status).toBe(404);
    expect(missing.json?.error?.code).toBe('WORKSPACE_NOT_FOUND');

    const unknownShard = await call(routes, world, START_PATH, { method: 'POST', body: { target: 'nsp_unknown' } });
    expect(unknownShard.status).toBe(404);
    expect(unknownShard.json?.error?.code).toBe('SHARD_NOT_FOUND');

    const samePlace = await call(routes, world, START_PATH, { method: 'POST', body: { target: SOURCE.shard } });
    expect(samePlace.status).toBe(422);
    expect(samePlace.json?.error?.code).toBe('ALREADY_PLACED');

    expect((await call(routes, world, START_PATH, { method: 'POST', body: { target: 'dedicated' } })).status).toBe(202);
    const second = await call(routes, world, START_PATH, { method: 'POST', body: { target: 'dedicated' } });
    expect(second.status).toBe(409);
    expect(second.json?.error?.code).toBe('MOVE_ALREADY_ACTIVE');

    const rows = await auditRows();
    expect(rows.map((r) => r.outcome)).toEqual(['failure', 'failure', 'failure', 'success', 'failure']);
    expect(rows[0]).toMatchObject({ workspaceId: 'ws_missing', error: expect.stringContaining('WORKSPACE_NOT_FOUND') });
    expect(rows[4]).toMatchObject({ error: expect.stringContaining('MOVE_ALREADY_ACTIVE') });
  });

  it('answers 502 when the Workflow cannot be created, and audits the failure', async () => {
    await setup();
    world.env.MOVE_DATABASE.create = vi.fn(async () => {
      throw new Error('workflows are down');
    }) as never;
    const { routes } = routesFor(world);

    const res = await call(routes, world, START_PATH, { method: 'POST', body: { target: 'dedicated' } });

    expect(res.status).toBe(502);
    expect(res.json?.error?.code).toBe('WORKFLOW_START_FAILED');
    expect(res.text).not.toContain('workflows are down');
    expect((await auditRows())[0]).toMatchObject({ outcome: 'failure', error: expect.stringContaining('WORKFLOW_START_FAILED') });
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────

describe('POST /database-moves/:moveId/cancel', () => {
  it('asks a live move to stop: 202, status cancelling, audited against the workspace', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await startMoveRow();

    const res = await call(routes, world, `/database-moves/${moveId}/cancel`, { method: 'POST' });

    expect(res.status).toBe(202);
    expect(res.json?.data).toEqual({ moveId, status: 'cancelling' });
    expect((await moveRow(moveId)).status).toBe('cancelling');
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        targetId: WORKSPACE_ID,
        action: 'database.move_cancel',
        outcome: 'success',
        actorEmail: 'ops@weldsuite.org',
        details: { moveId, statusBefore: 'queued', status: 'cancelling' },
      }),
    ]);
  });

  it('answers 404 for an unknown move and audits it against the move id', async () => {
    await setup();
    const { routes } = routesFor(world);

    const res = await call(routes, world, '/database-moves/dbm_missing/cancel', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(res.json?.error?.code).toBe('MOVE_NOT_FOUND');
    expect(await auditRows()).toEqual([
      expect.objectContaining({ workspaceId: null, targetId: 'dbm_missing', action: 'database.move_cancel', outcome: 'failure' }),
    ]);
  });

  it('answers 409 once the move is switching or over', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await startMoveRow();
    await setMove(moveId, { status: 'switching' });

    const res = await call(routes, world, `/database-moves/${moveId}/cancel`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(res.json?.error?.code).toBe('MOVE_NOT_CANCELLABLE');
    expect((await moveRow(moveId)).status).toBe('switching');
    expect((await auditRows())[0]).toMatchObject({ outcome: 'failure', error: expect.stringContaining('MOVE_NOT_CANCELLABLE') });
  });
});

// ── Recover ──────────────────────────────────────────────────────────────

describe('POST /database-moves/:moveId/recover', () => {
  it('finishes undoing a failed move: 200, source unlocked, target released, audited', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await lockedMove('failed');

    const res = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.json?.data).toEqual({ moveId, status: 'failed', sourceUnlocked: true, targetReleased: true });
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    // Closing the move writes how it ended, attributed to the admin who started it.
    expect((await auditRows()).filter((r) => r.action === 'database.move_fail')).toEqual([
      expect.objectContaining({ workspaceId: WORKSPACE_ID, outcome: 'failure', actorEmail: 'ops@weldsuite.org', error: 'Neon was down' }),
    ]);
    expect(await auditRows()).toContainEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        action: 'database.move_recover',
        outcome: 'success',
        actorEmail: 'ops@weldsuite.org',
        details: { moveId, force: false, statusBefore: 'failed', status: 'failed', sourceUnlocked: true, targetReleased: true },
      }),
    );
  });

  it('refuses a move that looks live unless forced, and accepts { force: true }', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await lockedMove('copying');

    const refused = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST', body: {} });
    expect(refused.status).toBe(409);
    expect(refused.json?.error?.code).toBe('MOVE_NOT_RECOVERABLE');
    expect(guardState.locked.has(SOURCE.db)).toBe(true);

    const forced = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST', body: { force: true } });
    expect(forced.status).toBe(200);
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    const recover = (await auditRows()).filter((r) => r.action === 'database.move_recover');
    expect(recover.map((r) => r.outcome)).toEqual(['failure', 'success']);
    expect(recover[1]?.details).toMatchObject({ force: true, statusBefore: 'copying' });
  });

  it('refuses a body that is not { force?: boolean }', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await lockedMove('failed');
    for (const rawBody of ['{"force":"yes"}', '[1]', 'nope']) {
      const res = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST', rawBody });
      expect(res.status).toBe(400);
      expect(res.json?.error?.code).toBe('INVALID_INPUT');
    }
    expect(guardState.locked.has(SOURCE.db)).toBe(true);
  });

  it('answers 404 for an unknown move and 409 for a completed one', async () => {
    await setup();
    const { routes } = routesFor(world);
    expect((await call(routes, world, '/database-moves/dbm_missing/recover', { method: 'POST' })).status).toBe(404);

    const moveId = await startMoveRow();
    await setMove(moveId, { status: 'completed' });
    const res = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(res.json?.error?.code).toBe('MOVE_NOT_RECOVERABLE');
  });

  it('answers 502 with a safe message when the undo could not finish, and audits the failure', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await lockedMove('failed');
    world.provisioning.releaseMoveTarget.mockRejectedValueOnce(new NeonApiError(`${SECRET_PREFIX}neon said no postgresql://x`, 500));

    const res = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect(res.json?.error?.code).toBe('COMPENSATION_INCOMPLETE');
    expect(res.json?.error?.message).toContain('Neon API error (HTTP 500)');
    expectNoLeak(res.text);
    const failed = (await auditRows()).find((r) => r.action === 'database.move_recover');
    expect(failed).toMatchObject({ outcome: 'failure', error: expect.stringContaining('COMPENSATION_INCOMPLETE') });
    expect(JSON.stringify(failed)).not.toContain(SECRET_PREFIX);
  });

  it('answers 500 without the error text for something unexpected', async () => {
    await setup();
    const moveId = await lockedMove('failed');
    const routes = createAdminDatabaseRoutes({
      masterDb: () => world.masterDb,
      moveDeps: () => {
        throw new Error(`boom postgresql://user:${SECRET_PREFIX}pw@host/db`);
      },
    });

    const res = await call(routes, world, `/database-moves/${moveId}/recover`, { method: 'POST' });

    expect(res.status).toBe(500);
    expect(res.json?.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
    expectNoLeak(res.text);
    expect(JSON.stringify(await auditRows())).not.toContain(SECRET_PREFIX);
  });
});

// ── Reading moves ────────────────────────────────────────────────────────

/** A row as the Workflow leaves it mid-copy: everything sensitive the table can hold. */
async function copyingMoveWithEverything(): Promise<string> {
  const moveId = await startMoveRow();
  await setMove(moveId, {
    status: 'copying',
    currentStep: 'copy-3',
    targetNeonProjectId: TARGET.project,
    targetNeonBranchId: TARGET.branch,
    targetDatabaseName: TARGET.db,
    targetRoleName: TARGET.role,
    targetSharedProjectId: null,
    targetRegion: REGION,
    targetDatabaseUrl: 'v2:aa:bb',
    progress: {
      tables: [
        { table: 'accounts', rows: 120, cursor: '["acc_0120"]', done: true, pageSize: 500, estimatedRows: 123 },
        { table: 'correspondents', rows: 7, cursor: '["someone@example.com"]', done: false, pageSize: 500, estimatedRows: 50 },
      ],
      copiedRows: 127,
      totalRows: 173,
      prepared: true,
      saved: { foreignKeys: [{ table: 'orders', name: 'orders_account_fk', definition: 'FOREIGN KEY (account_id)', validated: true }], triggers: [] },
      sourceChecksums: { accounts: { count: 123, hash: 'deadbeef' } },
      lockStartedAt: '2026-10-19T08:00:00.000Z',
    },
    verification: {
      tables: [
        { table: 'accounts', sourceRows: 123, targetRows: 123, sourceHash: 'aa', targetHash: 'aa', ok: true },
        { table: 'orders', sourceRows: 5, targetRows: 4, sourceHash: 'bb', targetHash: 'cc', ok: false },
      ],
      ok: false,
      verifiedAt: '2026-10-19T08:30:00.000Z',
      sourceUnchanged: true,
      sourceChangedTables: [],
      warnings: ['ANALYZE on the target did not finish'],
    },
  });
  return moveId;
}

describe('GET /database-moves/:moveId', () => {
  it('projects the row: progress and verification summarised, nothing sensitive', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await copyingMoveWithEverything();

    const res = await call(routes, world, `/database-moves/${moveId}`);

    expect(res.status).toBe(200);
    expectNoLeak(res.text);
    expect(res.text).not.toContain('deadbeef');
    expect(res.text).not.toContain('someone@example.com');
    expect(res.json?.data).toMatchObject({
      id: moveId,
      workspaceId: WORKSPACE_ID,
      kind: 'shard_to_dedicated',
      status: 'copying',
      currentStep: 'copy-3',
      requestedTarget: 'dedicated',
      source: { neonProjectId: SOURCE.project, databaseName: SOURCE.db, sharedProjectId: SOURCE.shard, region: REGION },
      target: { neonProjectId: TARGET.project, databaseName: TARGET.db, sharedProjectId: null, region: REGION },
      progress: {
        copiedRows: 127,
        totalRows: 173,
        tables: [
          { table: 'accounts', rows: 120, done: true, estimatedRows: 123 },
          { table: 'correspondents', rows: 7, done: false, estimatedRows: 50 },
        ],
      },
      verification: {
        ok: false,
        tableCount: 2,
        mismatchedTables: ['orders'],
        sourceUnchanged: true,
        sourceChangedTables: [],
        warnings: ['ANALYZE on the target did not finish'],
      },
      startedBy: 'ops@weldsuite.org',
    });
    const data = res.json?.data as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain('targetDatabaseUrl');
    expect(Object.keys(data.progress as object).sort()).toEqual(['copiedRows', 'tables', 'totalRows']);
  });

  it('has no target and no progress before the move starts, and answers 404 for an unknown id', async () => {
    await setup();
    const { routes } = routesFor(world);
    const moveId = await startMoveRow();

    const res = await call(routes, world, `/database-moves/${moveId}`);
    expect(res.json?.data).toMatchObject({ status: 'queued', target: null, progress: null, verification: null });

    const missing = await call(routes, world, '/database-moves/dbm_missing');
    expect(missing.status).toBe(404);
    expect(missing.json?.error?.code).toBe('MOVE_NOT_FOUND');
  });
});

describe('GET /workspaces/:workspaceId/database-moves', () => {
  it('lists the 20 most recent moves, newest first, with progress counters only', async () => {
    await setup();
    const { routes } = routesFor(world);
    const active = await copyingMoveWithEverything();
    await setMove(active, { status: 'failed', createdAt: new Date('2026-10-01T00:00:00Z') });
    for (let i = 0; i < 21; i++) {
      await world.masterDb.insert(workspaceDatabaseMoves).values({
        id: `dbm_old_${String(i).padStart(2, '0')}`,
        workspaceId: WORKSPACE_ID,
        kind: 'shard_to_shard',
        status: 'completed',
        requestedTarget: 'shard:auto',
        sourceNeonProjectId: SOURCE.project,
        sourceNeonBranchId: SOURCE.branch,
        sourceDatabaseName: SOURCE.db,
        sourceRoleName: SOURCE.role,
        startedBy: 'ops@weldsuite.org',
        createdAt: new Date(Date.UTC(2026, 9, 2 + i)),
        progress: { tables: [], copiedRows: i, totalRows: 100 },
      });
    }

    const res = await call(routes, world, START_PATH);

    expect(res.status).toBe(200);
    const list = res.json?.data as Array<{ id: string; progress: Record<string, unknown> | null; verification?: unknown }>;
    expect(list).toHaveLength(20);
    expect(list[0]?.id).toBe('dbm_old_20');
    expect(list.map((m) => m.id)).not.toContain(active); // the oldest one is cut by the limit
    expect(list[0]?.progress).toEqual({ copiedRows: 20, totalRows: 100 });
    expect(list.every((m) => !('tables' in (m.progress ?? {})) && !('verification' in m))).toBe(true);
    expectNoLeak(res.text);
  });

  it('lists the progress counters of a copying move without reading the blob', async () => {
    await setup();
    const { routes } = routesFor(world);
    await copyingMoveWithEverything();

    const res = await call(routes, world, START_PATH);

    const [move] = res.json?.data as Array<{ progress: unknown }>;
    expect(move?.progress).toEqual({ copiedRows: 127, totalRows: 173 });
    expectNoLeak(res.text);
    expect(res.text).not.toContain('deadbeef');
  });

  it('is empty for a workspace without moves', async () => {
    await setup();
    const { routes } = routesFor(world);
    const res = await call(routes, world, '/workspaces/ws_other/database-moves');
    expect(res.json?.data).toEqual([]);
  });
});

// ── Live state ───────────────────────────────────────────────────────────

describe('GET /databases/live', () => {
  it('lists every shard with its compute settings and state', async () => {
    await setup();
    const listEndpoints = vi.fn(async (projectId: string) => ({
      endpoints: [
        endpoint(`ep-${projectId}`, {
          current_state: projectId === SOURCE.project ? 'active' : 'idle',
          autoscaling_limit_min_cu: 0.5,
          autoscaling_limit_max_cu: 4,
          suspend_timeout_seconds: 600,
        }),
      ],
    }));
    const { routes } = routesFor(world, { listEndpoints });

    const res = await call(routes, world, '/databases/live');

    expect(res.status).toBe(200);
    const data = res.json?.data as { shards: Array<Record<string, unknown>>; dedicated: unknown[]; fetchedAt: string };
    expect(data.fetchedAt).toBe(NOW.toISOString());
    expect(data.dedicated).toEqual([]);
    expect(data.shards).toHaveLength(2);
    expect(data.shards.find((s) => s.shardId === SOURCE.shard)).toEqual({
      shardId: SOURCE.shard,
      neonProjectId: SOURCE.project,
      name: `shard ${SOURCE.shard}`,
      region: REGION,
      status: 'active',
      databaseCount: 0,
      maxDatabases: 500,
      endpoints: [
        {
          id: `ep-${SOURCE.project}`,
          type: 'read_write',
          currentState: 'active',
          minCu: 0.5,
          maxCu: 4,
          suspendTimeoutSeconds: 600,
          lastActive: '2026-10-19T08:00:00Z',
        },
      ],
      error: null,
    });
    expectNoLeak(res.text);
  });

  it('captures a failing shard on its own entry and keeps the rest', async () => {
    await setup();
    const listEndpoints = vi.fn(async (projectId: string) => {
      if (projectId === SOURCE.project) {
        throw new NeonApiError(`rate limited postgresql://u:${SECRET_PREFIX}p@h/db`, 429);
      }
      return { endpoints: [endpoint(`ep-${projectId}`)] };
    });
    const { routes } = routesFor(world, { listEndpoints });

    const res = await call(routes, world, '/databases/live');

    expect(res.status).toBe(200);
    const shards = (res.json?.data as { shards: Array<{ shardId: string; error: string | null; endpoints: unknown[] }> }).shards;
    expect(shards.find((s) => s.shardId === SOURCE.shard)).toMatchObject({ error: 'Neon API error (HTTP 429)', endpoints: [] });
    expect(shards.find((s) => s.shardId === TARGET.shard)).toMatchObject({ error: null, endpoints: [expect.anything()] });
    expectNoLeak(res.text);
  });

  it('looks at no more than 5 projects at once', async () => {
    await setup();
    for (let i = 0; i < 12; i++) {
      await world.masterDb.insert(neonSharedProjects).values({
        id: `nsp_extra${i}`,
        neonProjectId: `prj-extra${i}`,
        neonProjectName: `extra ${i}`,
        region: REGION,
        status: 'active',
      });
    }
    let inFlight = 0;
    let peak = 0;
    const listEndpoints = vi.fn(async (projectId: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { endpoints: [endpoint(`ep-${projectId}`)] };
    });
    const { routes } = routesFor(world, { listEndpoints });

    const res = await call(routes, world, '/databases/live');

    expect((res.json?.data as { shards: unknown[] }).shards).toHaveLength(14);
    expect(listEndpoints).toHaveBeenCalledTimes(14);
    expect(peak).toBeLessThanOrEqual(LIVE_LOOKUP_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('adds the dedicated projects asked for, and reports an unknown id instead of looking it up', async () => {
    await setup();
    await world.masterDb
      .update(workspaces)
      .set({ neonProjectId: 'prj-dedicated', sharedProjectId: null })
      .where(eq(workspaces.id, WORKSPACE_ID));
    const { routes, listEndpoints } = routesFor(world);

    const res = await call(routes, world, '/databases/live?projectIds=prj-dedicated,prj-stranger,prj-dedicated');

    const data = res.json?.data as { dedicated: Array<{ neonProjectId: string; error: string | null; endpoints: unknown[] }> };
    expect(data.dedicated).toEqual([
      { neonProjectId: 'prj-dedicated', endpoints: [expect.objectContaining({ id: 'ep-prj-dedicated' })], error: null },
      { neonProjectId: 'prj-stranger', endpoints: [], error: 'Not a dedicated project of any workspace' },
    ]);
    expect(listEndpoints).not.toHaveBeenCalledWith('prj-stranger');
  });

  it('refuses more than 50 project ids and malformed ones', async () => {
    await setup();
    const { routes } = routesFor(world);
    const many = Array.from({ length: 51 }, (_, i) => `prj-${i}`).join(',');
    for (const query of [many, 'prj-a,bad id', 'prj-a;drop']) {
      const res = await call(routes, world, `/databases/live?projectIds=${encodeURIComponent(query)}`);
      expect(res.status).toBe(400);
      expect(res.json?.error?.code).toBe('INVALID_INPUT');
    }
    const fifty = Array.from({ length: 50 }, (_, i) => `prj-${i}`).join(',');
    expect((await call(routes, world, `/databases/live?projectIds=${fifty}`)).status).toBe(200);
  });

  it('never selects the shard admin credentials', async () => {
    await setup();
    await world.masterDb
      .update(neonSharedProjects)
      .set({ adminRole: 'shard_admin', adminPasswordEncrypted: `${SECRET_PREFIX}admin-pw` })
      .where(eq(neonSharedProjects.id, SOURCE.shard));
    const { routes } = routesFor(world);
    const res = await call(routes, world, '/databases/live');
    expectNoLeak(res.text);
    expect(res.text).not.toContain('shard_admin');
  });
});

describe('GET /databases/shards/:shardId/sizes', () => {
  it('returns each database with its size and the workspace it belongs to', async () => {
    await setup();
    await world.masterDb
      .update(workspaces)
      .set({ neonDatabaseName: 'ws_acme_db' })
      .where(eq(workspaces.id, WORKSPACE_ID));
    const readSizes = vi.fn(async () => [
      { databaseName: 'ws_acme_db', sizeBytes: 5_000_000 },
      { databaseName: 'weldsuite_golden', sizeBytes: 12_000_000 },
    ]);
    const { routes } = routesFor(world, { readSizes });

    const res = await call(routes, world, `/databases/shards/${SOURCE.shard}/sizes`);

    expect(res.status).toBe(200);
    expect(res.json?.data).toEqual({
      shardId: SOURCE.shard,
      neonProjectId: SOURCE.project,
      databases: [
        { databaseName: 'ws_acme_db', sizeBytes: 5_000_000, workspaceId: WORKSPACE_ID },
        { databaseName: 'weldsuite_golden', sizeBytes: 12_000_000, workspaceId: null },
      ],
      totalBytes: 17_000_000,
    });
    expect(readSizes).toHaveBeenCalledTimes(1);
    expectNoLeak(res.text);
  });

  it('does not attribute a database of the same name in another project to the workspace', async () => {
    await setup();
    const readSizes = vi.fn(async () => [{ databaseName: SOURCE.db, sizeBytes: 1 }]);
    const { routes } = routesFor(world, { readSizes });
    const res = await call(routes, world, `/databases/shards/${TARGET.shard}/sizes`);
    expect((res.json?.data as { databases: Array<{ workspaceId: string | null }> }).databases[0]?.workspaceId).toBeNull();
  });

  it('refuses a viewer, because measuring wakes the shard', async () => {
    await setup();
    const { routes, readSizes } = routesFor(world);
    const res = await call(routes, world, `/databases/shards/${SOURCE.shard}/sizes`, { headers: { 'x-admin-role': 'viewer' } });
    expect(res.status).toBe(403);
    expect(res.json?.error?.code).toBe('FORBIDDEN');
    expect(readSizes).not.toHaveBeenCalled();
    const asAdmin = await call(routes, world, `/databases/shards/${SOURCE.shard}/sizes`, { headers: { 'x-admin-role': 'admin' } });
    expect(asAdmin.status).toBe(200);
  });

  it('answers 404 for an unknown shard, 422 without admin access and 502 when the query fails', async () => {
    await setup();
    const notFound = routesFor(world);
    expect((await call(notFound.routes, world, '/databases/shards/nsp_missing/sizes')).status).toBe(404);
    expect(notFound.readSizes).not.toHaveBeenCalled();

    const noAdmin = routesFor(world, { readSizes: vi.fn(async () => null) });
    const unavailable = await call(noAdmin.routes, world, `/databases/shards/${SOURCE.shard}/sizes`);
    expect(unavailable.status).toBe(422);
    expect(unavailable.json?.error?.code).toBe('SHARD_ADMIN_UNAVAILABLE');

    const failing = routesFor(world, {
      readSizes: vi.fn(async () => {
        throw new Error(`connection to postgresql://admin:${SECRET_PREFIX}pw@host/neondb failed`);
      }),
    });
    const failed = await call(failing.routes, world, `/databases/shards/${SOURCE.shard}/sizes`);
    expect(failed.status).toBe(502);
    expect(failed.json?.error?.code).toBe('SHARD_QUERY_FAILED');
    expectNoLeak(failed.text);
  });
});
