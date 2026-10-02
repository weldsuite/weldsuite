/**
 * POST /api/webhooks/cloudflare-realtime/backfill-recordings: operator-only
 * dispatch of the legacy recording backfill, one workflow per workspace.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { fakeKv, fakeWorkflow, seedMeetingWithSession } from '../../test/fakes';

const state = vi.hoisted(() => ({
  db: null as unknown as Database,
  orgs: [] as Array<string | null>,
  failFor: new Set<string>(),
  tenantCalls: [] as string[],
}));

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  const chain = {
    select: () => chain,
    from: () => chain,
    where: async () => state.orgs.map((clerkOrgId) => ({ clerkOrgId })),
  };
  return {
    ...actual,
    getMasterDb: () => chain,
    getTenantDbForWorkspace: async (_env: unknown, orgId: string) => {
      state.tenantCalls.push(orgId);
      if (state.failFor.has(orgId)) throw new Error(`no database for ${orgId}`);
      return state.db;
    },
  };
});

import { webhooksCloudflareRealtimeRoutes } from './index';
import type { Env, Variables } from '../../types';

const MOUNT = '/api/webhooks/cloudflare-realtime';
const URL_ = `${MOUNT}/backfill-recordings`;

function call(opts: { body?: unknown; auth?: string | null; backfill?: ReturnType<typeof fakeWorkflow> | null; token?: string | null } = {}) {
  const backfill = opts.backfill === undefined ? fakeWorkflow() : opts.backfill;
  const env = {
    ENVIRONMENT: 'test',
    CF_REALTIME_WEBHOOK_TOKEN: opts.token === undefined ? 'operator' : opts.token,
    WORKSPACE_CACHE: fakeKv(),
    ...(backfill ? { MEETING_RECORDING_BACKFILL: backfill } : {}),
  } as unknown as Partial<Env>;
  const { request } = createTestApp<Env, Variables>(MOUNT, webhooksCloudflareRealtimeRoutes, { env });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== null) headers.Authorization = opts.auth ?? 'Bearer operator';
  return {
    backfill,
    res: request(URL_, { method: 'POST', headers, body: JSON.stringify(opts.body ?? {}) }),
  };
}

beforeAll(async () => {
  state.db = (await createPgliteDb()).db;
  // The tenant DB is shared by every org in this test, so legacy rows are seeded once.
  await seedMeetingWithSession(state.db, {
    meetingId: 'meet_bfr1', sessionId: 'msess_bfr1', session: { recordingUrl: 'https://rtk.example/old.mp4', cfAppId: 'rtk_x' },
  });
  await seedMeetingWithSession(state.db, {
    meetingId: 'meet_bfr2', sessionId: 'msess_bfr2', session: { recordingKey: 'rtk_y', cfAppId: 'rtk_y' },
  });
  await seedMeetingWithSession(state.db, {
    meetingId: 'meet_bfr3', sessionId: 'msess_bfr3', session: { recordingUrl: 'https://rtk.example/new.mp4', recordingStatus: 'ready' },
  });
}, 60_000);

beforeEach(() => {
  state.orgs = ['org_a', 'org_b', null];
  state.failFor = new Set();
  state.tenantCalls = [];
});

describe('POST /backfill-recordings', () => {
  it('is operator-only: no bearer, a wrong bearer and an unset secret are all 401', async () => {
    const { backfill, res: none } = call({ auth: null });
    expect((await none).status).toBe(401);
    expect((await call({ auth: 'Bearer nope' }).res).status).toBe(401);
    expect((await call({ token: null }).res).status).toBe(401);
    expect(backfill!.created).toHaveLength(0);
    expect(state.tenantCalls).toHaveLength(0);
  });

  it('dry run counts legacy candidates per active workspace and dispatches nothing', async () => {
    const { backfill, res } = call({ body: { dryRun: true } });
    const body = (await (await res).json()) as { dryRun: boolean; workspaces: number; candidates: number; dispatched: number; results: Array<{ orgId: string; candidates: number }> };
    expect(body).toMatchObject({ ok: true, dryRun: true, workspaces: 2, candidates: 4, dispatched: 0 });
    expect(body.results.map((r) => [r.orgId, r.candidates])).toEqual([['org_a', 2], ['org_b', 2]]);
    expect(backfill!.created).toHaveLength(0);
  });

  it('starts one workflow per workspace that has candidates, with a unique instance id per run', async () => {
    const { backfill, res } = call();
    const body = (await (await res).json()) as { dispatched: number; results: Array<{ orgId: string; instanceId?: string }> };
    expect(body.dispatched).toBe(2);
    expect(backfill!.created.map((c) => c.params)).toEqual([{ orgId: 'org_a' }, { orgId: 'org_b' }]);
    for (const c of backfill!.created) expect(c.id).toMatch(/^bf-org_[ab]-[0-9a-z]+$/);
    expect(backfill!.created[0]!.id).not.toBe(backfill!.created[1]!.id);
  });

  it('can be limited to one workspace without touching the workspace list', async () => {
    const { backfill, res } = call({ body: { orgId: 'org_only' } });
    const body = (await (await res).json()) as { workspaces: number };
    expect(body.workspaces).toBe(1);
    expect(state.tenantCalls).toEqual(['org_only']);
    expect(backfill!.created.map((c) => c.params)).toEqual([{ orgId: 'org_only' }]);
  });

  it('keeps going when one workspace fails and reports it', async () => {
    state.failFor.add('org_a');
    const { backfill, res } = call();
    const body = (await (await res).json()) as { failed: number; dispatched: number; results: Array<{ orgId: string; error?: string }> };
    expect(body).toMatchObject({ failed: 1, dispatched: 1 });
    expect(body.results[0]).toMatchObject({ orgId: 'org_a', error: expect.stringContaining('no database') });
    expect(backfill!.created.map((c) => c.params)).toEqual([{ orgId: 'org_b' }]);
  });

  it('refuses a real run without the workflow binding (a dry run still works) and rejects a bad body', async () => {
    expect((await call({ backfill: null }).res).status).toBe(503);
    expect((await call({ backfill: null, body: { dryRun: true } }).res).status).toBe(200);
    expect((await call({ body: { dryRun: 'yes' } }).res).status).toBe(400);
  });
});
