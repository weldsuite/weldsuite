import { describe, it, expect, vi, beforeEach } from 'vitest';

const tenantDbFor = vi.fn(async (_env: unknown, workspaceId: string) => ({ workspaceId }));
const activeWorkspaces = [
  { id: 'ws_1', clerkOrgId: 'org_1' },
  { id: 'ws_2', clerkOrgId: 'org_2' },
  { id: 'ws_3', clerkOrgId: null },
];
// Master reads: the backfill lists every active workspace; the sweep lists
// the active ones among the due ids (the where clause is opaque here, so the
// test filters by the ids the index returned).
let dueIds: string[] = [];
const masterWorkspaces = vi.fn(async (kind: 'backfill' | 'due') =>
  kind === 'backfill'
    ? activeWorkspaces
    : activeWorkspaces.filter((w) => w.clerkOrgId && dueIds.includes(w.clerkOrgId)),
);

vi.mock('../db', () => ({
  getTenantDbForWorkspace: (env: unknown, id: string) => tenantDbFor(env, id),
  getMasterDb: () => ({
    select: (cols: Record<string, unknown>) => ({
      from: () => ({ where: () => masterWorkspaces('id' in cols ? 'due' : 'backfill') }),
    }),
  }),
  masterSchema: { workspaces: { id: 'id', clerkOrgId: 'clerk_org_id', isActive: 'is_active' } },
}));

const replan = vi.fn(async () => ({ scanned: 2, rescheduled: 2, failed: 0 }));
vi.mock('@weldsuite/db/lib/calendar-sync', () => ({
  replanStaleAutoScheduledEvents: (...args: unknown[]) => replan(...(args as [])),
}));

const reindex = vi.fn(async () => true);
const listDue = vi.fn(async () => dueIds);
const computeDueAt = vi.fn(async (): Promise<Date | null> => null);
const writeIndex = vi.fn(async () => undefined);
vi.mock('../lib/calendar-replan-index', () => ({
  calendarReplanIndexSync: (env: { SCHEDULE_INDEX?: unknown }, workspaceId: string) => ({
    d1: env.SCHEDULE_INDEX,
    workspaceId,
  }),
  reindexWorkspaceCalendarReplan: (...args: unknown[]) => reindex(...(args as [])),
  listWorkspacesWithDueCalendarReplan: (...args: unknown[]) => listDue(...(args as [])),
  computeCalendarReplanDueAt: (...args: unknown[]) => computeDueAt(...(args as [])),
  writeCalendarReplanIndex: (...args: unknown[]) => writeIndex(...(args as [])),
}));

import { runCalendarReplanSweep, CALENDAR_REPLAN_INDEX_BACKFILL_KEY } from './calendar-replan';

function makeEnv(backfilled: boolean, d1: unknown = {}) {
  const kv = new Map<string, string>(backfilled ? [[CALENDAR_REPLAN_INDEX_BACKFILL_KEY, 'done']] : []);
  return {
    SCHEDULE_INDEX: d1,
    WORKSPACE_CACHE: {
      get: vi.fn(async (k: string) => kv.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => void kv.set(k, v)),
    },
    kv,
  };
}

describe('runCalendarReplanSweep', () => {
  beforeEach(() => {
    dueIds = ['org_2'];
    for (const fn of [tenantDbFor, replan, reindex, listDue, computeDueAt, writeIndex, masterWorkspaces]) {
      fn.mockClear();
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('opens only tenants with a stale event in the D1 index, then re-indexes them', async () => {
    const env = makeEnv(true);
    const result = await runCalendarReplanSweep(env as never);
    expect(listDue).toHaveBeenCalledOnce();
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(tenantDbFor).toHaveBeenCalledWith(env, 'org_2');
    expect(replan).toHaveBeenCalledOnce();
    expect(reindex).toHaveBeenCalledOnce();
    expect(reindex).toHaveBeenCalledWith({ d1: env.SCHEDULE_INDEX, workspaceId: 'org_2' }, { workspaceId: 'org_2' });
    expect(result.totalRescheduled).toBe(2);
  });

  it('opens no tenant at all when nothing is due', async () => {
    dueIds = [];
    await runCalendarReplanSweep(makeEnv(true) as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
    expect(masterWorkspaces).not.toHaveBeenCalled();
  });

  it('never opens a due workspace that is no longer active', async () => {
    dueIds = ['org_suspended'];
    await runCalendarReplanSweep(makeEnv(true) as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('back-fills every tenant exactly once, then sets the flag', async () => {
    dueIds = [];
    const env = makeEnv(false);
    await runCalendarReplanSweep(env as never);
    expect(tenantDbFor).toHaveBeenCalledTimes(2); // ws_3 has no clerkOrgId
    expect(writeIndex).toHaveBeenCalledTimes(2);
    expect(replan).not.toHaveBeenCalled(); // backfill only indexes
    expect(env.kv.has(CALENDAR_REPLAN_INDEX_BACKFILL_KEY)).toBe(true);

    tenantDbFor.mockClear();
    await runCalendarReplanSweep(env as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('marks an unreadable tenant due now during backfill so the sweep retries it', async () => {
    dueIds = [];
    tenantDbFor.mockRejectedValueOnce(new Error('neon down'));
    const before = Date.now();
    await runCalendarReplanSweep(makeEnv(false) as never);
    const [, workspaceId, dueAt] = writeIndex.mock.calls[0] as unknown as [unknown, string, Date];
    expect(workspaceId).toBe('org_1');
    expect(dueAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('retries the backfill next run when an index write failed', async () => {
    dueIds = [];
    writeIndex.mockRejectedValueOnce(new Error('D1 down'));
    const env = makeEnv(false);
    await runCalendarReplanSweep(env as never);
    expect(env.kv.has(CALENDAR_REPLAN_INDEX_BACKFILL_KEY)).toBe(false);
  });

  it('never falls back to a tenant fan-out when D1 fails', async () => {
    listDue.mockRejectedValueOnce(new Error('no such table'));
    const result = await runCalendarReplanSweep(makeEnv(true) as never);
    expect(result.workspacesScanned).toBe(0);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('skips entirely without the SCHEDULE_INDEX binding', async () => {
    await runCalendarReplanSweep(makeEnv(true, null) as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
    expect(listDue).not.toHaveBeenCalled();
  });
});
