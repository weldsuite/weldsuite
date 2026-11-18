/**
 * The internal settlement route PanelUsage calls over the `PANEL_API` service
 * binding. What must not regress: it is served only by the `PanelApiInternal`
 * entrypoint (the worker's public `fetch` answers 404 for it, so no URL on the
 * public host reaches it); it validates its body; it settles and answers with
 * the quota state PanelUsage keeps asking about.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { quotaKvKey } from '@weldsuite/panel-domain/registry';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master };
});

import worker from './index';
import { PanelApiInternal, internalApp } from './internal';
import type { Env } from './types';

const { plans, workspaces, panelUsageMonthly } = masterSchema;

const PATH = '/internal/panel/usage/settle';
const store = new Map<string, string>();
let master: AnyMasterDatabase;
let env: Env;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  await master.insert(plans).values({ id: 'plan_i_free', name: 'Free', slug: 'free', features: {} });
  await master.insert(workspaces).values({ id: 'ws_internal', clerkOrgId: 'org_internal', name: 'Internal', slug: 'internal', planId: 'plan_i_free' });
}, 120_000);

beforeEach(() => {
  store.clear();
  env = {
    ENVIRONMENT: 'test',
    WORKSPACE_CACHE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    },
  } as unknown as Env;
});

const post = (body: unknown) =>
  new Request(`https://panel-api.internal${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /internal/panel/usage/settle', () => {
  it('stores the totals and answers with the quota state', async () => {
    const entrypoint = new PanelApiInternal({} as ExecutionContext, env);
    const res = await entrypoint.fetch(post({ workspaceId: 'ws_internal', month: '2026-11', events: 55_001, recordings: 4 }));

    expect(res.status).toBe(200);
    // No wallet row: the first block cannot be paid, and the events are past the grace.
    expect(await res.json()).toEqual({ month: '2026-11', events: 55_001, recordings: 4, quota: 'events_blocked' });
    const [row] = await master.select().from(panelUsageMonthly).where(eq(panelUsageMonthly.workspaceId, 'ws_internal'));
    expect(row).toMatchObject({ month: '2026-11', events: 55_001, recordings: 4 });
  });

  it('refuses a body that is not a settlement', async () => {
    for (const body of [
      {},
      { workspaceId: 'ws_internal', month: '2026-13', events: 1, recordings: 1 },
      { workspaceId: 'ws_internal', month: '2026-11', events: -1, recordings: 1 },
      { workspaceId: 'ws_internal', month: '2026-11', events: 1.5, recordings: 1 },
      { workspaceId: '', month: '2026-11', events: 1, recordings: 1 },
    ]) {
      const res = await internalApp.fetch(post(body), env);
      expect(res.status).toBe(400);
    }
    const garbage = await internalApp.fetch(new Request(`https://x${PATH}`, { method: 'POST', body: 'not json' }), env);
    expect(garbage.status).toBe(400);
  });

  it('answers 404 for an unknown workspace and writes no quota state for it', async () => {
    const res = await internalApp.fetch(post({ workspaceId: 'ws_nobody', month: '2026-11', events: 1, recordings: 0 }), env);
    expect(res.status).toBe(404);
    expect(store.has(quotaKvKey('ws_nobody'))).toBe(false);
  });

  it('is not reachable through the public fetch handler', async () => {
    const res = await worker.fetch(post({ workspaceId: 'ws_internal', month: '2026-11', events: 1, recordings: 0 }), env);
    expect(res.status).toBe(404);
  });
});
