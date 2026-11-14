/**
 * GET /api/panel/usage: this month against the plan allowance, on a real
 * master and tenant schema (pglite).
 *
 * What must not regress: `panel_projects:manage` is the permission; the
 * numbers come from the master row and the plan (an unknown plan is Free); the
 * per-project split comes from Basin and is zeros without it; and reading while
 * the collector is blocked settles again, so a top-up lifts the block.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { grantCredits } from '@weldsuite/credits';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { quotaKvKey } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelUsageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master };
});

import usageRoutes from './index';

const { panelProjects } = schema;
const { plans, workspaces, panelUsageMonthly } = masterSchema;

const BASE = '/api/panel/usage';
const NOW = new Date('2026-11-14T10:00:00.000Z');
const MONTH = '2026-11';

let db: Database;
let master: AnyMasterDatabase;
const store = new Map<string, string>();
let counter = 0;

const kv = {
  get: async (key: string) => store.get(key) ?? null,
  put: async (key: string, value: string) => void store.set(key, value),
  delete: async (key: string) => void store.delete(key),
} as unknown as KVNamespace;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  await master.insert(plans).values([
    { id: 'plan_u_free', name: 'Free', slug: 'free', features: {} },
    { id: 'plan_u_scale', name: 'Scale', slug: 'scale', features: {} },
  ]);
}, 120_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store.clear();
  await db.delete(panelProjects);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function workspace(plan: 'free' | 'scale' | null = 'free'): Promise<string> {
  counter += 1;
  const id = `ws_usage_${counter}`;
  await master.insert(workspaces).values({ id, clerkOrgId: `org_usage_${counter}`, name: `Acme ${counter}`, slug: `usage-${counter}`, planId: plan ? `plan_u_${plan}` : null });
  return id;
}

async function project(id: string, name: string, createdAt: Date) {
  await db.insert(panelProjects).values({
    id,
    name,
    token: `wpk_${id}`,
    settings: DEFAULT_PANEL_SETTINGS,
    createdByUserId: 'user_alice',
    createdAt,
    updatedAt: createdAt,
  });
}

const BASIN = { R2_SQL_API_TOKEN: 't', CF_ACCOUNT_ID: 'acc', PANEL_BASIN_BUCKET: 'bucket' };

function app(workspaceId: string, grants: string[] = ['panel_projects:manage'], env: Record<string, unknown> = {}) {
  return createTestApp(BASE, usageRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_x', workspaceId, clerkOrgId: 'org_x' },
    env: { WORKSPACE_CACHE: kv, ...env },
    moduleApiErrors: true,
  });
}

async function get(workspaceId: string, grants?: string[], env?: Record<string, unknown>) {
  const res = await app(workspaceId, grants, env).request(BASE);
  return { res, dto: res.ok ? ((await res.json()) as { data: PanelUsageDto }).data : null };
}

describe('permissions', () => {
  it('needs panel_projects:manage', async () => {
    const ws = await workspace();
    expect((await get(ws, ['panel_projects:read', 'panel_projects:update'])).res.status).toBe(403);
    expect((await get(ws, [])).res.status).toBe(403);
    expect((await get(ws, ['panel_projects:manage'])).res.status).toBe(200);
  });

  it('answers 404 for a workspace the master database does not know', async () => {
    expect((await get('ws_unknown')).res.status).toBe(404);
  });
});

describe('the usage DTO', () => {
  it('shows an empty month on the Free plan with its allowances and retention', async () => {
    const ws = await workspace('free');
    const { dto } = await get(ws);

    expect(dto).toEqual({
      month: MONTH,
      planSlug: 'free',
      events: { used: 0, allowance: 50_000, blocksCharged: 0, creditsCharged: 0 },
      recordings: { used: 0, allowance: 500, blocksCharged: 0, creditsCharged: 0 },
      quota: 'ok',
      retention: { eventsMonths: 12, recordingsDays: 30, favoritesMonths: 13 },
      projects: [],
    });
  });

  it('shows the stored month against the plan: Scale keeps recordings 90 days', async () => {
    const ws = await workspace('scale');
    await master.insert(panelUsageMonthly).values({ id: 'pnu_usage_1', workspaceId: ws, month: MONTH, events: 5_000_100, recordings: 3, eventBlocksCharged: 1, eventCreditsCharged: 10 });
    await grantCredits(master, { workspaceId: ws, amount: 100, type: 'monthly_allocation', description: 'test' });
    const { dto } = await get(ws);

    expect(dto).toMatchObject({
      planSlug: 'scale',
      events: { used: 5_000_100, allowance: 5_000_000, blocksCharged: 1, creditsCharged: 10 },
      recordings: { used: 3, allowance: 25_000, blocksCharged: 0, creditsCharged: 0 },
      quota: 'ok',
      retention: { eventsMonths: 25, recordingsDays: 90, favoritesMonths: 13 },
    });
  });

  it('takes a workspace without a plan as Free', async () => {
    const ws = await workspace(null);
    expect((await get(ws)).dto).toMatchObject({ planSlug: 'free', events: { allowance: 50_000 } });
  });

  it('lists the projects with their names, with zeros when Basin is not configured', async () => {
    const ws = await workspace('free');
    await project('pnp_u_a', 'Docs site', new Date('2026-01-01'));
    await project('pnp_u_b', 'Shop', new Date('2026-02-01'));
    const { dto } = await get(ws);

    expect(dto!.projects).toEqual([
      { projectId: 'pnp_u_a', name: 'Docs site', events: 0, recordings: 0 },
      { projectId: 'pnp_u_b', name: 'Shop', events: 0, recordings: 0 },
    ]);
  });

  it('splits the month per project from Basin, biggest first, scoped to the workspace and the month', async () => {
    const ws = await workspace('free');
    await project('pnp_u_c', 'Docs site', new Date('2026-01-01'));
    await project('pnp_u_d', 'Shop', new Date('2026-02-01'));
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const sql = (JSON.parse(String(init.body)) as { query: string }).query;
      queries.push(sql);
      const rows = sql.includes('replay_chunks') ? [{ project_id: 'pnp_u_c', n: 2 }] : [{ project_id: 'pnp_u_d', n: '900' }, { project_id: 'pnp_u_c', n: 40 }];
      return Response.json({ result: { rows } });
    });

    const { dto } = await get(ws, undefined, BASIN);

    expect(dto!.projects).toEqual([
      { projectId: 'pnp_u_d', name: 'Shop', events: 900, recordings: 0 },
      { projectId: 'pnp_u_c', name: 'Docs site', events: 40, recordings: 2 },
    ]);
    expect(queries).toHaveLength(2);
    for (const sql of queries) {
      expect(sql).toContain(`workspace_id = '${ws}'`);
      expect(sql).toContain("TIMESTAMP '2026-11-01 00:00:00'");
      expect(sql).toContain("TIMESTAMP '2026-12-01 00:00:00'");
    }
  });

  it('shows zeros per project when Basin fails, and still answers', async () => {
    const ws = await workspace('free');
    await project('pnp_u_e', 'Docs site', new Date('2026-01-01'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

    const { res, dto } = await get(ws, undefined, BASIN);

    expect(res.status).toBe(200);
    expect(dto!.projects).toEqual([{ projectId: 'pnp_u_e', name: 'Docs site', events: 0, recordings: 0 }]);
    warn.mockRestore();
  });
});

describe('a blocked workspace', () => {
  it('shows the state the stored numbers and the wallet give', async () => {
    const ws = await workspace('free');
    await master.insert(panelUsageMonthly).values({ id: 'pnu_usage_2', workspaceId: ws, month: MONTH, events: 70_001, recordings: 0 });
    const { dto } = await get(ws);

    expect(dto!.quota).toBe('events_blocked');
    expect(store.get(quotaKvKey(ws))).toBe('events_blocked');
  });

  it('charges the unpaid blocks again after a top-up and lifts the block', async () => {
    const ws = await workspace('free');
    await master.insert(panelUsageMonthly).values({ id: 'pnu_usage_3', workspaceId: ws, month: MONTH, events: 70_001, recordings: 0 });
    store.set(quotaKvKey(ws), 'events_blocked');
    await grantCredits(master, { workspaceId: ws, amount: 100, type: 'purchase', description: 'top-up' });

    const { dto } = await get(ws);

    expect(dto!.quota).toBe('ok');
    expect(dto!.events).toMatchObject({ used: 70_001, blocksCharged: 3, creditsCharged: 30 });
    expect(store.has(quotaKvKey(ws))).toBe(false);
    const [row] = await master.select().from(panelUsageMonthly).where(eq(panelUsageMonthly.workspaceId, ws));
    expect(row).toMatchObject({ eventBlocksCharged: 3 });
  });

  it('does not touch the wallet when nothing is blocked', async () => {
    const ws = await workspace('free');
    await master.insert(panelUsageMonthly).values({ id: 'pnu_usage_4', workspaceId: ws, month: MONTH, events: 10, recordings: 0 });
    await get(ws);
    const [row] = await master.select().from(panelUsageMonthly).where(eq(panelUsageMonthly.workspaceId, ws));
    expect(row).toMatchObject({ eventBlocksCharged: 0 });
    expect(row!.updatedAt).toEqual(row!.createdAt);
  });
});
