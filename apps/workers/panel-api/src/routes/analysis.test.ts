/**
 * Tests for POST /api/panel/insights/explain and /api/panel/metric-tree-values
 * (+ /:id): real tenant and master schemas (pglite), fake Basin and project
 * object, the mock model of `@weldsuite/ai/testing` (answering by prompt)
 * and the real credit wallet, so the Rust backend answers the same tests in
 * conformance mode (each request then runs twice: model calls and Basin
 * statements are per run, `RUNS`).
 *
 * What must not regress:
 *   1. Every statement carries the workspace of the request and the project,
 *      and only definitions of that project (custom events, path rules) reach the SQL.
 *   2. Explain answers the numbers with or without AI; a narrative is charged
 *      once (op `panel_explain`, the model that served), cached after, and
 *      never written when the project switched AI off or the wallet is empty.
 *   3. Metric tree values: one value per node, the change, the correlation of
 *      `influence` nodes; a node whose report is gone or hidden answers an
 *      error, the others still run; a private tree of someone else is a 404.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelExplainResult, PanelMetricTreeValues } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { BASIN_ENV, FakeBasin, FakeProjectState, PROJECT, RUNS, WORKSPACE, memoryKv } from '../test-support/fakes';
import { AI_ENV, aiCharges, emptyWallet, installModel, seedWallet, type ModelCall } from '../test-support/ai';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) as never };
});

const modelCalls: ModelCall[] = [];
let modelFails = false;
/** Every call the mock model answers costs the wallet one credit (a few tokens, the minimum charge). */
const CREDITS_PER_CALL = 1;

import insightsRoutes from './insights';
import metricTreeValuesRoutes from './metric-tree-values';

const { panelProjects, panelAiSummaries, panelCustomEvents, panelPathRules, panelReports, panelMetricTrees } = schema;

const READ = ['panel_reports:read'];
let db: Database;
let master: AnyMasterDatabase;
const basin = new FakeBasin();
const object = new FakeProjectState();

function app(base: string, router: typeof insightsRoutes, grants: string[] = READ, userId = 'user_alice') {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, masterDb: master as unknown as Database, userId, orgId: 'org_alpha', workspaceId: WORKSPACE, clerkOrgId: 'org_alpha' },
    env: { WORKSPACE_CACHE: memoryKv(), PANEL_PROJECT: object.namespace(), PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org', ...BASIN_ENV, ...AI_ENV } as never,
    moduleApiErrors: true,
  });
}
const explain = (body: unknown, grants?: string[]) => app('/api/panel/insights', insightsRoutes, grants).request('/api/panel/insights/explain', json(body));
const values = (path: string, body: unknown, grants?: string[], userId?: string) =>
  app('/api/panel/metric-tree-values', metricTreeValuesRoutes, grants, userId).request(`/api/panel/metric-tree-values${path}`, json(body));

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const SPEC = { kind: 'trends', projectId: PROJECT, dateRange: { preset: '7d' }, series: [{ event: 'Purchase' }] };

/** Totals and the browser dimension move; everything else is flat. */
function explainBasin(): void {
  basin.on(/^SELECT COUNT\(CASE WHEN .* AS cur, .* AS base FROM/, [{ cur: 150, base: 100 }]);
  basin.on(/COALESCE\(e\.browser, '\(unknown\)'\) AS value/, [
    { value: 'Safari', cur: 55, base: 10 },
    { value: 'Chrome', cur: 95, base: 90 },
  ]);
  basin.on(/COALESCE\(e\.country, '\(unknown\)'\) AS value/, [
    { value: 'NL', cur: 75, base: 50 },
    { value: 'BE', cur: 75, base: 50 },
  ]);
}

/** Daily rows for every trends statement: the root (`A`) grows 10/day, the child (`B`) follows it. */
function treeBasin(): void {
  basin.on(/date_trunc\('day', e\.ts\) AS bucket/, (sql) => {
    const from = /e\.ts >= TIMESTAMP '(\d{4}-\d{2}-\d{2})/.exec(sql)?.[1] ?? '2026-11-01';
    const factor = sql.includes("e.name = 'B'") ? 2 : 1;
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(Date.parse(`${from}T00:00:00Z`) + (i + 1) * 86_400_000).toISOString().slice(0, 10);
      return { bucket: day, s0_v: (10 + i * 10) * factor + (i % 2) };
    });
  });
  basin.on(/^SELECT COUNT\(CASE WHEN e\.name = 'A'/, (sql) => [{ s0_v: sql.includes('previous') ? 0 : 100 }]);
  basin.on(/^SELECT COUNT\(CASE WHEN e\.name = 'B'/, [{ s0_v: 40 }]);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelAiSummaries, panelCustomEvents, panelPathRules, panelReports, panelMetricTrees, panelProjects]) await db.delete(table);
  await db.insert(panelProjects).values([
    { id: PROJECT, name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
    { id: 'pnp_b', name: 'Other', token: 'wpk_b', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
  ]);
  modelCalls.length = 0;
  modelFails = false;
  await seedWallet(master, WORKSPACE, 'org_alpha', 100);
  object.reset();
  basin.reset();
  basin.install();
  installModel(() => (modelFails ? { status: 500, message: 'provider down' } : { json: { narrative: 'Safari carried most of the rise.' } }), modelCalls);
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/panel/insights/explain', () => {
  it('answers the windows, the change and the dimensions ranked by what explains it, every statement scoped', async () => {
    explainBasin();
    const res = await explain({ projectId: PROJECT, spec: SPEC });
    expect(res.status).toBe(200);
    const body = await data<PanelExplainResult>(res);
    expect(body.metric).toMatchObject({ label: 'Purchase', current: 150, baseline: 100, change: 50, changePercent: 0.5 });
    expect(body.dimensions[0]?.dimension).toBe('browser');
    expect(body.dimensions[0]?.values[0]).toMatchObject({ value: 'Safari', change: 45, contributionShare: 0.9 });
    expect(body.narrative).toBeNull();
    expect(new Date(body.baseline.to).getTime()).toBe(new Date(body.current.from).getTime());
    expect(basin.sent).toHaveLength(8 * RUNS);
    for (const sql of basin.sent) {
      expect(sql).toContain(`e.workspace_id = '${WORKSPACE}' AND e.project_id = '${PROJECT}'`);
      expect(sql).not.toContain('pnp_b');
    }
  });

  it('caches the numbers for a repeat', async () => {
    explainBasin();
    const env = { WORKSPACE_CACHE: memoryKv(), PANEL_PROJECT: object.namespace(), ...BASIN_ENV } as never;
    const one = createTestApp('/api/panel/insights', insightsRoutes, {
      context: { permissions: permissions(...READ), tenantDb: db, masterDb: master as unknown as Database, userId: 'user_alice', orgId: 'org_alpha', workspaceId: WORKSPACE, clerkOrgId: 'org_alpha' },
      env,
      moduleApiErrors: true,
    });
    await one.request('/api/panel/insights/explain', json({ projectId: PROJECT, spec: SPEC }));
    const first = basin.sent.length;
    await one.request('/api/panel/insights/explain', json({ projectId: PROJECT, spec: SPEC }));
    expect(basin.sent).toHaveLength(first);
  });

  it('uses only this project’s path rules and custom events', async () => {
    await db.insert(panelPathRules).values([
      { id: 'pnpr_1', projectId: PROJECT, position: 0, pattern: '^/users/[0-9]+', replacement: '/users/:id', createdByUserId: 'user_alice' },
      { id: 'pnpr_2', projectId: 'pnp_b', position: 0, pattern: '^/other', replacement: '/x', createdByUserId: 'user_alice' },
    ]);
    await db.insert(panelCustomEvents).values([
      { id: 'pnce_buy', projectId: PROJECT, name: 'Bought', definition: { match: [{ event: 'Purchase', filters: [] }, { event: 'Order placed', filters: [] }] }, ownerUserId: 'user_alice' },
      { id: 'pnce_theirs', projectId: 'pnp_b', name: 'Theirs', definition: { match: [{ event: 'Secret', filters: [] }] }, ownerUserId: 'user_alice' },
    ]);
    const res = await explain({ projectId: PROJECT, spec: { ...SPEC, series: [{ event: '@pnce_buy' }] } });
    expect(res.status).toBe(200);
    const all = basin.sent.join('\n');
    expect(all).toContain("regexp_replace(e.path, '^/users/[0-9]+', '/users/:id', 'g')");
    expect(all).toContain("(e.name = 'Order placed')");
    expect(all).not.toContain('/other');

    const theirs = await explain({ projectId: PROJECT, spec: { ...SPEC, series: [{ event: '@pnce_theirs' }] } });
    expect(theirs.status).toBe(400);
  });

  it('refuses what it cannot explain, another project and a missing permission', async () => {
    expect((await explain({ projectId: PROJECT, spec: { ...SPEC, series: [{ event: 'A', math: 'avg', property: 'x' }] } })).status).toBe(400);
    expect((await explain({ projectId: PROJECT, spec: { ...SPEC, series: [{ event: 'A' }, { event: 'B' }] } })).status).toBe(400);
    expect((await explain({ projectId: 'pnp_missing', spec: { ...SPEC, projectId: 'pnp_missing' } })).status).toBe(404);
    expect((await explain({ projectId: PROJECT, spec: SPEC }, [])).status).toBe(403);
  });

  it('writes a narrative once, charged for the model that served, then answers it from the cache', async () => {
    explainBasin();
    const first = await data<PanelExplainResult>(await explain({ projectId: PROJECT, spec: SPEC, narrate: true }));
    expect(first.narrative).toMatchObject({ text: 'Safari carried most of the rise.', creditsCharged: CREDITS_PER_CALL, cached: false });
    expect((await aiCharges(master, WORKSPACE)).map(({ op, modelId, credits }) => ({ op, modelId, credits }))).toEqual([
      { op: 'panel_explain', modelId: first.narrative?.modelId, credits: CREDITS_PER_CALL },
    ]);
    expect(modelCalls[0]?.prompt).toContain('Dimension browser');
    expect(modelCalls[0]?.prompt).toContain('"Safari": 10 -> 55');

    const second = await data<PanelExplainResult>(await explain({ projectId: PROJECT, spec: SPEC, narrate: true }));
    expect(second.narrative).toMatchObject({ cached: true, creditsCharged: 0 });
    expect(modelCalls).toHaveLength(RUNS);
    expect(await aiCharges(master, WORKSPACE)).toHaveLength(1);
  });

  it('keeps the numbers and says why when there can be no narrative', async () => {
    explainBasin();
    await emptyWallet(master, WORKSPACE);
    const broke = await data<PanelExplainResult>(await explain({ projectId: PROJECT, spec: SPEC, narrate: true }));
    expect(broke.narrativeUnavailable).toBe('insufficient_credits');
    expect(broke.metric.current).toBe(150);
    expect(modelCalls).toHaveLength(0);
    await seedWallet(master, WORKSPACE, 'org_alpha', 100);

    modelFails = true;
    const down = await data<PanelExplainResult>(await explain({ projectId: PROJECT, spec: SPEC, narrate: true, regenerate: true }));
    expect(down.narrativeUnavailable).toBe('ai_unavailable');
    modelFails = false;
    const tried = modelCalls.length;
    expect(tried).toBeGreaterThan(0);

    await db.update(panelProjects).set({ settings: { ...DEFAULT_PANEL_SETTINGS, aiEnabled: false } });
    const off = await data<PanelExplainResult>(await explain({ projectId: PROJECT, spec: SPEC, narrate: true }));
    expect(off.narrativeUnavailable).toBe('ai_disabled');
    expect(modelCalls).toHaveLength(tried);
    expect(await aiCharges(master, WORKSPACE)).toHaveLength(0);
  });

});

const inlineNodes = [
  { id: 'root', label: 'Revenue', parentId: null, relation: null, metric: { spec: { ...SPEC, series: [{ event: 'A' }] } } },
  { id: 'kid', label: 'Orders', parentId: 'root', relation: 'influence', metric: { spec: { ...SPEC, series: [{ event: 'B' }] } } },
];

describe('POST /api/panel/metric-tree-values', () => {
  it('answers each node’s value, the previous period, the change and the correlation with the parent', async () => {
    treeBasin();
    const res = await values('', { projectId: PROJECT, nodes: inlineNodes, dateRange: { preset: '7d' } });
    expect(res.status).toBe(200);
    const body = await data<PanelMetricTreeValues>(res);
    const [root, kid] = body.nodes;
    expect(root).toMatchObject({ id: 'root', value: 100, error: null, correlationWithParent: null });
    expect(kid).toMatchObject({ id: 'kid', value: 40, relation: 'influence', error: null });
    expect(kid?.correlationWithParent).toBeGreaterThan(0.99);
    expect(root?.points.length).toBeGreaterThan(0);
    for (const sql of basin.sent) expect(sql).toContain(`e.workspace_id = '${WORKSPACE}' AND e.project_id = '${PROJECT}'`);
  });

  it('refuses a tree that is not a tree, and a missing permission', async () => {
    expect((await values('', { projectId: PROJECT, nodes: [inlineNodes[1]] })).status).toBe(400);
    expect((await values('', { projectId: PROJECT, nodes: inlineNodes }, [])).status).toBe(403);
    expect((await values('', { projectId: 'pnp_missing', nodes: inlineNodes })).status).toBe(404);
  });
});

describe('POST /api/panel/metric-tree-values/:id', () => {
  beforeEach(async () => {
    await db.insert(panelReports).values([
      { id: 'pnr_mine', projectId: PROJECT, kind: 'trends', name: 'Orders', spec: { kind: 'trends', series: [{ event: 'B' }] }, ownerUserId: 'user_alice' },
      { id: 'pnr_hidden', projectId: PROJECT, kind: 'trends', name: 'Hidden', spec: { kind: 'trends', series: [{ event: 'B' }] }, ownerUserId: 'user_bob' },
      { id: 'pnr_funnel', projectId: PROJECT, kind: 'funnel', name: 'Funnel', spec: { kind: 'funnel', steps: [{ event: 'A' }, { event: 'B' }] }, ownerUserId: 'user_alice' },
      { id: 'pnr_other', projectId: 'pnp_b', kind: 'trends', name: 'Theirs', spec: { kind: 'trends', series: [{ event: 'B' }] }, ownerUserId: 'user_alice', visibility: 'workspace' },
    ]);
    await db.insert(panelMetricTrees).values([
      {
        id: 'pnmt_1',
        projectId: PROJECT,
        name: 'North star',
        ownerUserId: 'user_alice',
        nodes: [
          inlineNodes[0],
          { id: 'mine', label: 'Mine', parentId: 'root', relation: 'sum', metric: { reportId: 'pnr_mine' } },
          { id: 'hidden', label: 'Hidden', parentId: 'root', relation: 'sum', metric: { reportId: 'pnr_hidden' } },
          { id: 'funnel', label: 'Funnel', parentId: 'root', relation: 'sum', metric: { reportId: 'pnr_funnel' } },
          { id: 'other', label: 'Other project', parentId: 'root', relation: 'sum', metric: { reportId: 'pnr_other' } },
        ],
      },
      { id: 'pnmt_bob', projectId: PROJECT, name: 'Private', ownerUserId: 'user_bob', nodes: [inlineNodes[0]] },
    ]);
  });

  it('runs the saved nodes; a hidden, missing or non-trends report is an error on its node only', async () => {
    treeBasin();
    const res = await values('/pnmt_1', {});
    expect(res.status).toBe(200);
    const body = await data<PanelMetricTreeValues>(res);
    const byId = Object.fromEntries(body.nodes.map((n) => [n.id, n]));
    expect(byId.root?.value).toBe(100);
    expect(byId.mine).toMatchObject({ value: 40, error: null });
    expect(byId.hidden).toMatchObject({ value: null, error: 'report_not_found' });
    expect(byId.funnel).toMatchObject({ value: null, error: 'not_a_trends_report' });
    expect(byId.other).toMatchObject({ value: null, error: 'report_not_found' });
  });

  it('answers 404 for a private tree of someone else and for an unknown id', async () => {
    expect((await values('/pnmt_bob', {})).status).toBe(404);
    expect((await values('/pnmt_nope', {})).status).toBe(404);
    expect((await values('/pnmt_bob', {}, READ, 'user_bob')).status).toBe(200);
  });
});
