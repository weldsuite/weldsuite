/**
 * The read API other workers reach over the PanelApiInternal entrypoint
 * (/internal/panel/v1/:workspaceId/*, for external-api's `/v1/panel` and the
 * MCP server), on a real tenant schema (pglite).
 *
 * What must not regress:
 *   1. Read-only: anything outside the allow-list (every write, the by-email
 *      lookup) is a 404 before a handler runs.
 *   2. It acts for someone: a person sees their own private reports and
 *      shared ones; a workspace key sees shared ones only; neither header is a 401.
 *   3. A report's results run its own saved spec.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { ParsedPanelQuerySpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';

const state = vi.hoisted(() => ({ db: null as unknown, ran: [] as unknown[] }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => ({}) as never,
    getWorkspaceContextForOrg: async (_env: unknown, ref: string) => {
      if (ref !== 'ws_a') throw new Error('Workspace not found');
      return { id: 'ws_a', clerkOrgId: 'org_a', db: state.db, suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null };
    },
  };
});
vi.mock('@weldsuite/permissions/server', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/permissions/server')>();
  return {
    ...actual,
    resolveEffectivePermissions: async (_queries: unknown, userId: string) => ({
      permissions: userId === 'user_alice' ? ['panel_projects:read', 'panel_reports:read', 'panel_reports:create', 'panel_reports:delete'] : [],
      role: 'member',
      roleId: null,
      isOwner: false,
    }),
  };
});
vi.mock('../services/query-run', () => ({
  queryRunDeps: () => ({}),
  runCachedQuery: async (_deps: unknown, spec: ParsedPanelQuerySpec) => {
    state.ran.push(spec);
    return { result: { kind: spec.kind, result: { ok: true } }, dataAsOf: '2026-11-16T10:00:00.000Z', cached: false };
  },
}));

import { internalApp } from '../internal';

const { panelProjects, panelReports } = schema;
let db: Database;

const SPEC = { kind: 'trends', projectId: 'pnp_a', series: [{ event: 'Signed up' }] };

function call(path: string, headers: Record<string, string> = { 'x-weld-user': 'user_alice' }, init: RequestInit = {}) {
  return internalApp.request(`/internal/panel/v1/ws_a${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...headers } }, {} as never);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  state.db = db;
}, 120_000);

beforeEach(async () => {
  state.ran = [];
  await db.delete(panelReports);
  await db.delete(panelProjects);
  await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  await db.insert(panelReports).values([
    { id: 'pnr_shared', projectId: 'pnp_a', kind: 'trends', name: 'Shared', spec: SPEC, ownerUserId: 'user_bram', visibility: 'workspace' },
    { id: 'pnr_mine', projectId: 'pnp_a', kind: 'trends', name: 'Mine', spec: SPEC, ownerUserId: 'user_alice', visibility: 'private' },
  ]);
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
    const res = await internalApp.request('/internal/panel/v1/ws_zzz/reports', { headers: { 'x-weld-user': 'user_alice' } }, {} as never);
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
  it('runs the saved spec, optionally over another preset', async () => {
    const res = await call('/reports/pnr_shared/results?preset=7d');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { kind: 'trends', result: { ok: true }, dataAsOf: '2026-11-16T10:00:00.000Z', cached: false } });
    expect(state.ran[0]).toMatchObject({ kind: 'trends', projectId: 'pnp_a', dateRange: { preset: '7d' } });
    expect((await call('/reports/pnr_mine/results', { 'x-weld-workspace-key': 'wak_1' })).status).toBe(404);
  });
});
