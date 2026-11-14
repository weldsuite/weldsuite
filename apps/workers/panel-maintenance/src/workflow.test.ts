/**
 * The weekly run end to end, with a scripted container: the ledger and the
 * retention go into the spec, the job is polled, the erased ids are released in
 * the project objects only after the rewrite succeeded, and the container is
 * shut down however the run ends.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master };
});

import type { JobStatus } from './container';
import type { Env } from './env';
import type { MaintenanceJobResult, MaintenanceJobSpec } from './spec';
import { MAX_POLLS, PanelMaintenanceWorkflow, POLL_INTERVAL } from './workflow';
import { fakeNamespace, fakeStep, newLedger } from './testing/fakes';

const { plans, workspaces, panelProjectRegistry } = masterSchema;

const RESULT: MaintenanceJobResult = {
  erased: { events: 12, identities: 2, people: 1, replayChunks: 5 },
  expired: { events: 100, replayChunks: 7 },
};

let master: AnyMasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  await master.insert(plans).values({ id: 'plan_w_free', name: 'Free', slug: 'free', features: {} });
  await master.insert(workspaces).values({ id: 'ws_w_a', clerkOrgId: 'org_w_a', name: 'A', slug: 'w-a', planId: 'plan_w_free' });
  await master.insert(panelProjectRegistry).values({ projectId: 'pnp_1', token: 'wpk_w1', workspaceId: 'ws_w_a', status: 'active', allowedDomains: [], settings: {} as never });
}, 120_000);

interface Script {
  /** What `status` answers, in order; the last repeats. */
  statuses: JobStatus[];
  startError?: Error;
}

function setup(script: Script) {
  const ledger = newLedger();
  const specs: MaintenanceJobSpec[] = [];
  const stops: number[] = [];
  let polls = 0;
  const job = {
    start: vi.fn(async (spec: MaintenanceJobSpec) => {
      if (script.startError) throw script.startError;
      specs.push(spec);
      return { jobId: spec.runId };
    }),
    status: vi.fn(async () => script.statuses[Math.min(polls++, script.statuses.length - 1)]!),
    stop: vi.fn(async () => {
      stops.push(1);
    }),
  };
  const cleared: Array<{ projectId: string; ids: string[] }> = [];
  const projects = fakeNamespace((projectId) => ({
    clearErased: vi.fn(async (ids: string[]) => {
      cleared.push({ projectId, ids });
    }),
  }));
  const env = {
    MAINTENANCE_LEDGER: fakeNamespace(() => ledger),
    MAINTENANCE_JOB: fakeNamespace(() => job),
    PANEL_PROJECT: projects,
  } as unknown as Env;
  const workflow = new PanelMaintenanceWorkflow({} as ExecutionContext, env);
  const step = fakeStep();
  const run = () => workflow.run({ payload: {}, timestamp: new Date(), instanceId: 'maintenance-2026-11-15' }, step.step);
  return { ledger, job, specs, stops, cleared, step, run };
}

const QUEUED = new Date('2026-11-10T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T03:00:00.000Z'));
});

describe('a successful run', () => {
  it('sends the ledger and the retention to the job, waits for it, then releases the erased ids and empties the ledger', async () => {
    const t = setup({ statuses: [{ state: 'running' }, { state: 'running' }, { state: 'done', result: RESULT }] });
    await t.ledger.addErasure({ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['u1', 'ck_1'] }, QUEUED);

    const summary = await t.run();

    expect(t.specs).toEqual([
      {
        runId: 'maintenance-2026-11-15',
        now: '2026-11-15T03:00:00.000Z',
        erasures: [{ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['ck_1', 'u1'] }],
        retention: [{ months: 12, projectIds: ['pnp_1'] }],
        maxRetentionMonths: 25,
      },
    ]);
    expect(t.step.sleeps).toEqual([`wait 0: ${POLL_INTERVAL}`, `wait 1: ${POLL_INTERVAL}`, `wait 2: ${POLL_INTERVAL}`]);
    expect(t.step.names).toEqual(['plan', 'start', 'poll 0', 'poll 1', 'poll 2', 'finish', 'stop container']);

    expect(t.cleared).toEqual([{ projectId: 'pnp_1', ids: ['ck_1', 'u1'] }]);
    expect(await t.ledger.pending()).toEqual([]);
    expect(t.stops).toHaveLength(1);
    expect(summary).toEqual({ runId: 'maintenance-2026-11-15', erasedProjects: 1, erasedIds: 2, result: RESULT });
    expect((await t.ledger.runs())[0]).toMatchObject({ runId: 'maintenance-2026-11-15', erasedIds: 2 });
  });

  it('still runs retention when nothing is waiting, and releases nothing', async () => {
    const t = setup({ statuses: [{ state: 'done', result: RESULT }] });
    const summary = await t.run();

    expect(t.specs[0]!.erasures).toEqual([]);
    expect(t.cleared).toEqual([]);
    expect(summary).toMatchObject({ erasedProjects: 0, erasedIds: 0 });
  });

  it('leaves an id that was queued again during the run for the next one', async () => {
    const t = setup({ statuses: [{ state: 'running' }, { state: 'done', result: RESULT }] });
    await t.ledger.addErasure({ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['u1', 'u2'] }, QUEUED);
    // While the job runs, the same person is erased again (more of their events arrived).
    t.job.status.mockImplementationOnce(async () => {
      await t.ledger.addErasure({ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['u2'] }, new Date('2026-11-15T03:05:00.000Z'));
      return { state: 'running' };
    });

    await t.run();

    expect(t.cleared).toEqual([{ projectId: 'pnp_1', ids: ['u1'] }]);
    expect(await t.ledger.pending()).toEqual([{ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['u2'], oldest: '2026-11-15T03:05:00.000Z' }]);
  });
});

describe('a run that fails', () => {
  it('keeps the ids waiting, releases nothing and shuts the container down when the job fails', async () => {
    const t = setup({ statuses: [{ state: 'running' }, { state: 'failed', error: 'CommitFailedException: conflict' }] });
    await t.ledger.addErasure({ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['u1'] }, QUEUED);

    await expect(t.run()).rejects.toThrow('The maintenance job failed: CommitFailedException: conflict');

    expect(t.cleared).toEqual([]);
    expect((await t.ledger.pending())[0]!.ids).toEqual(['u1']);
    expect(t.stops).toHaveLength(1);
    expect(t.step.names).toContain('stop container after failure');
    expect(t.step.names).not.toContain('finish');
  });

  it('shuts the container down when the job cannot be started', async () => {
    const t = setup({ statuses: [], startError: new Error('no capacity') });
    await expect(t.run()).rejects.toThrow('no capacity');
    expect(t.stops).toHaveLength(1);
    expect(t.cleared).toEqual([]);
  });

  it('gives up when the job never finishes, after the polling window', async () => {
    const t = setup({ statuses: [{ state: 'running' }] });
    await expect(t.run()).rejects.toThrow('did not finish in time');
    expect(t.job.status).toHaveBeenCalledTimes(MAX_POLLS);
    expect(t.stops).toHaveLength(1);
    expect(t.cleared).toEqual([]);
  });

  it('does not release an id when the project object cannot take it, so the next run repeats it', async () => {
    const t = setup({ statuses: [{ state: 'done', result: RESULT }] });
    await t.ledger.addErasure({ workspaceId: 'ws_w_a', projectId: 'pnp_1', ids: ['u1'] }, QUEUED);
    const stub = (t as unknown as { cleared: unknown }).cleared;
    expect(stub).toEqual([]);
    // Replace the project namespace with one that fails.
    const failing = fakeNamespace(() => ({ clearErased: async () => Promise.reject(new Error('object unavailable')) }));
    const workflow = new PanelMaintenanceWorkflow({} as ExecutionContext, {
      MAINTENANCE_LEDGER: fakeNamespace(() => t.ledger),
      MAINTENANCE_JOB: fakeNamespace(() => t.job),
      PANEL_PROJECT: failing,
    } as unknown as Env);

    await expect(workflow.run({ payload: {}, timestamp: new Date(), instanceId: 'maintenance-2026-11-15' }, fakeStep().step)).rejects.toThrow('object unavailable');
    expect((await t.ledger.pending())[0]!.ids).toEqual(['u1']);
  });
});
