/**
 * The internal settlement route PanelUsage calls over the `PANEL_API` service
 * binding. What must not regress: it is served only by the `PanelApiInternal`
 * entrypoint (the worker's public `fetch` answers 404 for it, so no URL on the
 * public host reaches it); it validates its body; it settles and answers with
 * the quota state PanelUsage keeps asking about.
 *
 * The requests go through `createTestApp`, so the Rust backend answers the
 * same tests in conformance mode: the settlement through the internal app the
 * entrypoint serves (`internal()`), the public handler through a passthrough
 * to the whole worker without a session, as index.test.ts does
 * (`deployed()`). The master database (`conformanceMasterDb`) and the KV
 * namespace are shared with Rust; the tenant database is only there because
 * the harness serves one.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { conformanceMasterDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { quotaKvKey } from '@weldsuite/panel-domain/registry';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import worker from './index';
import { PanelApiInternal, internalApp } from './internal';
import type { Env } from './types';

const { plans, workspaces, panelUsageMonthly } = masterSchema;

const PATH = '/internal/panel/usage/settle';
const store = new Map<string, string>();
let db: Database;
let master: AnyMasterDatabase;
let env: Env;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
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

/** The app the `PanelApiInternal` entrypoint serves. */
function internal() {
  return createTestApp('/', internalApp as never, {
    context: { tenantDb: db, masterDb: master as unknown as Database },
    env: env as never,
  });
}

/** The worker's public `fetch`, as a browser reaches it: no session. */
function deployed() {
  const passthrough = new Hono();
  passthrough.all('*', (c) => worker.fetch(c.req.raw, c.env as never));
  return createTestApp('/', passthrough as never, { context: { tenantDb: db, userId: null as never }, env: env as never });
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /internal/panel/usage/settle', () => {
  it('stores the totals and answers with the quota state', async () => {
    const res = await internal().request(PATH, post({ workspaceId: 'ws_internal', month: '2026-11', events: 55_001, recordings: 4 }));

    expect(res.status).toBe(200);
    // No wallet row: the first block cannot be paid, and the events are past the grace.
    expect(await res.json()).toEqual({ month: '2026-11', events: 55_001, recordings: 4, quota: 'events_blocked' });
    const [row] = await master.select().from(panelUsageMonthly).where(eq(panelUsageMonthly.workspaceId, 'ws_internal'));
    expect(row).toMatchObject({ month: '2026-11', events: 55_001, recordings: 4 });
  });

  it('is served by the PanelApiInternal entrypoint', async () => {
    const res = await new PanelApiInternal({} as ExecutionContext, env).fetch(
      new Request(`https://panel-api.internal${PATH}`, post({})),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Invalid settlement' } });
  });

  it('refuses a body that is not a settlement', async () => {
    for (const body of [
      {},
      { workspaceId: 'ws_internal', month: '2026-13', events: 1, recordings: 1 },
      { workspaceId: 'ws_internal', month: '2026-11', events: -1, recordings: 1 },
      { workspaceId: 'ws_internal', month: '2026-11', events: 1.5, recordings: 1 },
      { workspaceId: '', month: '2026-11', events: 1, recordings: 1 },
    ]) {
      const res = await internal().request(PATH, post(body));
      expect(res.status).toBe(400);
    }
    const garbage = await internal().request(PATH, { method: 'POST', body: 'not json' });
    expect(garbage.status).toBe(400);
  });

  it('answers 404 for an unknown workspace and writes no quota state for it', async () => {
    const res = await internal().request(PATH, post({ workspaceId: 'ws_nobody', month: '2026-11', events: 1, recordings: 0 }));
    expect(res.status).toBe(404);
    expect(store.has(quotaKvKey('ws_nobody'))).toBe(false);
  });

  it('is not reachable through the public fetch handler', async () => {
    const res = await deployed().request(PATH, post({ workspaceId: 'ws_internal', month: '2026-11', events: 1, recordings: 0 }));
    expect(res.status).toBe(404);
  });
});
