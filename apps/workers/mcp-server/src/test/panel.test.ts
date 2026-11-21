/**
 * The `weldpanel_*` tools: registered with scope `panel:read` on routes the
 * server's `/v1` copy mounts, offered to members who can read WeldPanel
 * reports, people tools gated on `panel_people:read` as in the app, and calls
 * forwarded to panel-api's internal read API (faked here) as the member.
 * Not part of the `mcp-server` conformance suite: the Rust server does not
 * serve WeldPanel.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { createMcpTestApp, currentTenantDb, testSession } from './harness';
import { allTools } from '../tools/registry';
import { apiApp } from '../api/app';
import { canPerform, canUseScope } from '../lib/permissions';
import type { Env } from '../types/env';

vi.mock('../api/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/db')>()),
  createTenantDb: () => currentTenantDb(),
}));

let db: Database;

beforeAll(async () => {
  ({ db } = await createPgliteDb());
});

const panelTools = () => allTools.filter((tool) => tool.name.startsWith('weldpanel_'));

function fakePanel() {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetcher = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      return Response.json({ data: [{ id: 'pnp_a', name: 'Shop' }], pagination: { totalCount: 1, hasMore: false, cursor: null } });
    },
  };
  return { calls, env: { PANEL_INTERNAL: fetcher } as unknown as Partial<Env> };
}

describe('weldpanel tools', () => {
  it('are read tools on panel:read, every path mounted by the /v1 copy', () => {
    const tools = panelTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'weldpanel_get_dashboard',
      'weldpanel_get_group',
      'weldpanel_get_person',
      'weldpanel_get_report',
      'weldpanel_get_report_results',
      'weldpanel_list_cohorts',
      'weldpanel_list_dashboards',
      'weldpanel_list_events',
      'weldpanel_list_groups',
      'weldpanel_list_projects',
      'weldpanel_list_reports',
      'weldpanel_query',
      'weldpanel_search_people',
    ]);
    const mounted = new Set((apiApp.routes as { method: string; path: string }[]).map((r) => `${r.method} ${r.path}`));
    for (const tool of tools) {
      expect(tool.scope).toBe('panel:read');
      expect(tool.method === 'GET' || tool.name === 'weldpanel_query').toBe(true);
      expect(mounted.has(`${tool.method} ${tool.path}`), tool.path).toBe(true);
    }
  });

  it('are offered to members who can read WeldPanel reports, and need the app’s own permission per route', () => {
    expect(canUseScope(['panel_reports:read'], 'panel:read')).toBe(true);
    expect(canUseScope(['customers:read'], 'panel:read')).toBe(false);
    expect(canPerform(['panel_reports:read'], 'panel:read', 'POST', '/v1/panel/query')).toBe(true);
    expect(canPerform(['panel_reports:read'], 'panel:read', 'GET', '/v1/panel/reports')).toBe(true);
    expect(canPerform(['panel_reports:read'], 'panel:read', 'GET', '/v1/panel/people')).toBe(false);
    expect(canPerform(['panel_reports:read', 'panel_people:read'], 'panel:read', 'GET', '/v1/panel/people/:distinctId')).toBe(true);
    expect(canPerform(['panel_reports:read'], 'panel:read', 'GET', '/v1/panel/projects')).toBe(false);
    expect(canPerform(['panel_reports:read'], 'panel:read', 'GET', '/v1/panel/groups/:type/:key')).toBe(false);
    expect(canPerform(['panel_people:read'], 'panel:read', 'GET', '/v1/panel/groups')).toBe(true);
  });

  it('lists them for such a member only', async () => {
    const names = async (permissions: string[]) => {
      const { rpc } = createMcpTestApp({ tenantDb: db, session: testSession({ permissions, role: 'MEMBER' }) });
      const { body } = await rpc('tools/list');
      return (body.result.tools as { name: string }[]).map((t) => t.name).filter((n) => n.startsWith('weldpanel_'));
    };
    expect(await names(['panel_reports:read'])).toHaveLength(13);
    expect(await names(['customers:read'])).toEqual([]);
  });

  it('call panel-api’s read API as the member, the query spec as the body', async () => {
    const panel = fakePanel();
    const { callTool } = createMcpTestApp({ tenantDb: db, env: panel.env });
    const listed = await callTool('weldpanel_list_projects', {});
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain('Shop');
    expect(panel.calls[0]).toMatchObject({ method: 'GET', url: 'https://panel-api.internal/internal/panel/v1/ws_test/projects' });
    expect(panel.calls[0]!.headers['x-weld-user']).toBe('user_test');

    const spec = { kind: 'trends', projectId: 'pnp_a', series: [{ event: '$pageview' }] };
    await callTool('weldpanel_query', { spec });
    expect(panel.calls[1]).toMatchObject({ method: 'POST', body: JSON.stringify(spec) });

    await callTool('weldpanel_search_people', { projectId: 'pnp_a', search: 'ann' });
    expect(panel.calls[2]!.url).toBe('https://panel-api.internal/internal/panel/v1/ws_test/people?projectId=pnp_a&search=ann');
  });

  it('refuses a people tool to a member without WeldPanel people access', async () => {
    const panel = fakePanel();
    const { callTool } = createMcpTestApp({ tenantDb: db, env: panel.env, session: testSession({ permissions: ['panel_reports:read'], role: 'MEMBER' }) });
    const refused = await callTool('weldpanel_search_people', { projectId: 'pnp_a' });
    expect(refused.isError).toBe(true);
    expect(panel.calls).toHaveLength(0);
  });
});
