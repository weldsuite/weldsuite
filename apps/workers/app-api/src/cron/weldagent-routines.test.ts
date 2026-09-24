import { describe, it, expect, vi, beforeEach } from 'vitest';

const tenantDbFor = vi.fn(async (_env: unknown, workspaceId: string) => ({ workspaceId }));
const masterWorkspaces = vi.fn(async () => [
  { id: 'ws_1', clerkOrgId: 'org_1' },
  { id: 'ws_2', clerkOrgId: 'org_2' },
  { id: 'ws_3', clerkOrgId: null },
]);

vi.mock('../db', () => ({
  getTenantDbForWorkspace: (env: unknown, id: string) => tenantDbFor(env, id),
  getMasterDb: () => ({
    select: () => ({ from: () => ({ where: () => masterWorkspaces() }) }),
  }),
  masterSchema: { workspaces: { id: 'id', clerkOrgId: 'clerk_org_id', scheduledDeletionAt: 'x' } },
}));

vi.mock('../services/weldagent/parity', () => ({
  listDueCronRoutines: vi.fn(async () => []),
  createRoutineRun: vi.fn(),
  completeRoutineRun: vi.fn(),
  markRoutineScheduled: vi.fn(),
}));

vi.mock('../services/weldagent/jobs', () => ({ enqueueWeldAgentJob: vi.fn() }));

const reindexWorkspace = vi.fn(async () => undefined);
const listDue = vi.fn(async () => ['org_2']);
vi.mock('../lib/weldagent-routine-index', () => ({
  routineIndexSync: (env: { SCHEDULE_INDEX?: unknown }, workspaceId: string) => ({
    d1: env.SCHEDULE_INDEX,
    workspaceId,
  }),
  reindexWorkspaceRoutines: (...args: unknown[]) => reindexWorkspace(...(args as [])),
  listWorkspacesWithDueRoutines: (...args: unknown[]) => listDue(...(args as [])),
}));

import { runWeldAgentRoutineSweep, ROUTINE_INDEX_BACKFILL_KEY } from './weldagent-routines';

function makeEnv(backfilled: boolean, d1: unknown = {}) {
  const kv = new Map<string, string>(backfilled ? [[ROUTINE_INDEX_BACKFILL_KEY, 'done']] : []);
  return {
    SCHEDULE_INDEX: d1,
    WORKSPACE_CACHE: {
      get: vi.fn(async (k: string) => kv.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => void kv.set(k, v)),
    },
    kv,
  };
}

describe('runWeldAgentRoutineSweep', () => {
  beforeEach(() => {
    tenantDbFor.mockClear();
    reindexWorkspace.mockClear();
    listDue.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('opens only tenants with a routine due in the D1 index', async () => {
    const env = makeEnv(true);
    await runWeldAgentRoutineSweep(env as never);
    expect(listDue).toHaveBeenCalledOnce();
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(tenantDbFor).toHaveBeenCalledWith(env, 'org_2');
    expect(reindexWorkspace).toHaveBeenCalledOnce();
  });

  it('back-fills every tenant exactly once, then sets the flag', async () => {
    const env = makeEnv(false);
    await runWeldAgentRoutineSweep(env as never);
    expect(tenantDbFor).toHaveBeenCalledTimes(3);
    expect(env.kv.has(ROUTINE_INDEX_BACKFILL_KEY)).toBe(true);

    tenantDbFor.mockClear();
    await runWeldAgentRoutineSweep(env as never);
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
  });

  it('never falls back to a tenant fan-out when D1 fails', async () => {
    listDue.mockRejectedValueOnce(new Error('no such table'));
    const env = makeEnv(true);
    const result = await runWeldAgentRoutineSweep(env as never);
    expect(result.started).toBe(0);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('skips entirely without the SCHEDULE_INDEX binding', async () => {
    const env = makeEnv(true, null);
    await runWeldAgentRoutineSweep(env as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });
});
