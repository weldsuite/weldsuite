/**
 * The read API other workers reach over the PanelApiInternal entrypoint
 * (/internal/panel/v1/:workspaceId/*, for external-api's `/v1/panel` and the
 * MCP server), on real tenant and master schemas (pglite), with the fake
 * Basin and project object, so the Rust backend answers the same tests in
 * conformance mode. Who a call acts for is resolved from the workspace's
 * members, as in production; the workspace lookup is the test's.
 *
 * What must not regress:
 *   1. Read-only: anything outside the allow-list (every write, the by-email
 *      lookup) is a 404 before a handler runs.
 *   2. It acts for someone: a person sees their own private reports and
 *      shared ones; a workspace key sees shared ones only; neither header is a 401.
 *   3. A report's results run its own saved spec.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { BASIN_ENV, FakeBasin, FakeProjectState, memoryKv } from '../test-support/fakes';

const state = vi.hoisted(() => ({ db: null as unknown, master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(state.master) as never,
    getWorkspaceContextForOrg: async (_env: unknown, ref: string) => {
      if (ref !== 'ws_a') throw new Error('Workspace not found');
      return { id: 'ws_a', clerkOrgId: 'org_a', db: conformanceTenantDb(state.db), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null };
    },
  };
});

import internalV1Routes from './internal-v1';

const { panelProjects, panelReports, workspaceMembers } = schema;
let db: Database;
let master: AnyMasterDatabase;
const basin = new FakeBasin();
const object = new FakeProjectState();

const SPEC = { kind: 'trends', projectId: 'pnp_a', series: [{ event: 'Signed up' }] };
const BASE = '/internal/panel/v1';

function call(path: string, headers: Record<string, string> = { 'x-weld-user': 'user_alice' }, init: RequestInit = {}) {
  const app = createTestApp(BASE, internalV1Routes, {
    // The session is the internal API's own (the headers); the test's context only carries the databases.
    context: { tenantDb: db, masterDb: master as unknown as Database, workspaceId: 'ws_a', orgId: 'org_a', clerkOrgId: 'org_a' },
    env: { WORKSPACE_CACHE: memoryKv(), PANEL_PROJECT: object.namespace(), ...BASIN_ENV } as never,
    moduleApiErrors: true,
  });
  return app.request(`${BASE}/ws_a${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.db = db;
  state.master = master;
  // Alice is a member with WeldPanel's read and report permissions; anyone else is no one here.
  await db.insert(workspaceMembers).values({
    id: 'wm_alice',
    userId: 'user_alice',
    role: 'MEMBER',
    permissions: ['panel_projects:read', 'panel_reports:read', 'panel_reports:create', 'panel_reports:delete'],
  });
}, 120_000);

beforeEach(async () => {
  await db.delete(panelReports);
  await db.delete(panelProjects);
  await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  await db.insert(panelReports).values([
    { id: 'pnr_shared', projectId: 'pnp_a', kind: 'trends', name: 'Shared', spec: SPEC, ownerUserId: 'user_bram', visibility: 'workspace' },
    { id: 'pnr_mine', projectId: 'pnp_a', kind: 'trends', name: 'Mine', spec: SPEC, ownerUserId: 'user_alice', visibility: 'private' },
  ]);
  object.reset();
  basin.reset();
  basin.install();
});

describe('who it acts for', () => {
  it('a person sees their private reports and shared ones; a workspace key only shared ones', async () => {
    const person = (await (await call('/reports')).json()) as { data: { id: string }[] };
    expect(person.data.map((r) => r.id).sort()).toEqual(['pnr_mine', 'pnr_shared']);
    const key = (await (await call('/reports', { 'x-weld-workspace-key': 'wak_1' })).json()) as { data: { id: string }[] };
    expect(key.data.map((r) => r.id)).toEqual(['pnr_shared']);
    expect((await call('/reports/pnr_mine', { 'x-weld-workspace-key': 'wak_1' })).status).toBe(404);
  });

  it('a person’s own permissions apply', async () => {
    expect((await call('/reports', { 'x-weld-user': 'user_nobody' })).status).toBe(403);
  });

  it('refuses a call that names no one, and an unknown workspace', async () => {
    expect((await call('/reports', {})).status).toBe(401);
    const app = createTestApp(BASE, internalV1Routes, {
      context: { tenantDb: db, masterDb: master as unknown as Database, workspaceId: 'ws_a', orgId: 'org_a', clerkOrgId: 'org_a' },
      env: { WORKSPACE_CACHE: memoryKv(), PANEL_PROJECT: object.namespace(), ...BASIN_ENV } as never,
      moduleApiErrors: true,
    });
    const res = await app.request(`${BASE}/ws_zzz/reports`, { headers: { 'x-weld-user': 'user_alice' } });
    expect(res.status).toBe(404);
  });
});

describe('read-only', () => {
  it('serves no write, even to someone who could write in the app', async () => {
    expect((await call('/reports', undefined, { method: 'POST', body: JSON.stringify({ projectId: 'pnp_a', name: 'x', spec: SPEC }) })).status).toBe(404);
    expect((await call('/reports/pnr_mine', undefined, { method: 'DELETE' })).status).toBe(404);
    expect((await call('/projects/pnp_a/rotate-token', undefined, { method: 'POST' })).status).toBe(404);
    expect((await call('/people/by-email?email=a@b.c')).status).toBe(404);
    expect((await call('/groups/company/acme?projectId=pnp_a', undefined, { method: 'DELETE' })).status).toBe(404);
    expect((await call('/groups/company/acme/extra')).status).toBe(404);
    expect(await db.select().from(panelReports)).toHaveLength(2);
  });

  it('lists projects', async () => {
    const res = await call('/projects');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string }[] }).data.map((p) => p.id)).toEqual(['pnp_a']);
  });
});

describe('report results', () => {
  it('runs the saved spec, optionally over another preset, in the report’s own scope', async () => {
    const res = await call('/reports/pnr_shared/results?preset=7d');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { kind: string; cached: boolean; dataAsOf: string; result: { range: { from: string; to: string }; series: { label: string }[] } };
    };
    expect(body.data).toMatchObject({ kind: 'trends', cached: false });
    expect(body.data.result.series.map((s) => s.label)).toEqual(['Signed up']);
    // Seven days, today's included.
    const days = (Date.parse(body.data.result.range.to) - Date.parse(body.data.result.range.from)) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThanOrEqual(7);
    expect(basin.sent.length).toBeGreaterThan(0);
    for (const sql of basin.sent) expect(sql).toContain("e.workspace_id = 'ws_a' AND e.project_id = 'pnp_a'");

    expect((await call('/reports/pnr_shared/results?preset=1y')).status).toBe(400);
    expect((await call('/reports/pnr_mine/results', { 'x-weld-workspace-key': 'wak_1' })).status).toBe(404);
  });
});
