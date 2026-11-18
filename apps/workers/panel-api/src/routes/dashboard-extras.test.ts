/**
 * DB-backed tests (pglite) for dashboard filters, text tiles and templates.
 *
 * What must not regress:
 *   1. Dashboard filters are validated with the query schema, kept off the
 *      entity bus, and applied to every report tile's spec in the detail (the
 *      date range replaced, the filters added); null clears them.
 *   2. Text tiles hold Markdown (≤ 5000), have no report, are always in the
 *      detail, and only they take text changes.
 *   3. Every built-in template yields report specs the query schema accepts,
 *      in English and Dutch, and creating one makes its reports, the
 *      dashboard and the tiles in one go, with events.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type {
  PanelDashboardDetailDto,
  PanelDashboardDto,
  PanelDashboardTileDto,
  PanelReportDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { panelReportSpecSchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PANEL_DASHBOARD_TEMPLATES, type PanelDashboardTemplateDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { Env, Variables } from '../types';
import { DASHBOARD_TEMPLATES, templateLocale, templateReportSpec } from '../services/dashboard-templates';
import { tileSpec } from '../services/dashboard-filters';
import reportsRoutes from './reports';
import dashboardsRoutes from './dashboards';

const { panelProjects, panelReports, panelDashboards, panelDashboardTiles } = schema;

const MEMBER = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const READER = ['panel_reports:read'];

let db: Database;
let events: EntityEventMessage[] = [];
const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

type Router = Hono<{ Bindings: Env; Variables: Variables }>;

function app(base: string, router: Router, userId = 'user_alice', grants: string[] = MEMBER) {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, orgId: 'org_alpha', workspaceId: 'ws_alpha', clerkOrgId: 'org_alpha' },
    env: { ENTITY_EVENTS: queue, PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org' },
  });
}

const reports = (user?: string, grants?: string[]) => app('/api/panel/reports', reportsRoutes, user, grants);
const dashboards = (user?: string, grants?: string[]) => app('/api/panel/dashboards', dashboardsRoutes, user, grants);

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const layout = { x: 0, y: 0, w: 6, h: 4 };
const FILTERS = { dateRange: { preset: '7d' }, filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelDashboardTiles, panelDashboards, panelReports, panelProjects]) await db.delete(table);
  events = [];
  await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Site', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
});

async function newReport(extra: Record<string, unknown> = {}) {
  const spec = {
    kind: 'trends',
    projectId: 'pnp_a',
    dateRange: { preset: '30d' },
    series: [{ event: '$pageview' }],
    filters: [{ source: 'column', field: 'device_type', operator: 'eq', value: 'mobile' }],
  };
  const res = await reports().request('/api/panel/reports', json({ projectId: 'pnp_a', name: 'Visitors', spec, visibility: 'workspace', ...extra }));
  expect(res.status).toBe(201);
  return data<PanelReportDto>(res);
}

describe('dashboard filters', () => {
  it('applies the filters to each report tile in the detail and keeps them off the bus', async () => {
    const report = await newReport();
    const board = await data<PanelDashboardDto>(await dashboards().request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'Dutch visitors', filters: FILTERS })));
    expect(board.filters).toEqual(FILTERS);
    await dashboards().request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: report.id, layout }));

    const detail = await data<PanelDashboardDetailDto>(await dashboards().request(`/api/panel/dashboards/${board.id}`));
    const spec = detail.tiles[0]?.spec as { dateRange: unknown; filters: { field: string }[] };
    expect(spec.dateRange).toEqual({ preset: '7d' });
    expect(spec.filters.map((f) => f.field)).toEqual(['device_type', 'country']);
    // The report itself is unchanged.
    expect((detail.reports[0]?.spec as { dateRange: unknown }).dateRange).toEqual({ preset: '30d' });
    expect(JSON.stringify(events)).not.toContain('"NL"');
  });

  it('validates filters with the query schema and clears them with null', async () => {
    const api = dashboards();
    expect((await api.request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'x', filters: { filters: [{ source: 'event', key: "a'b", operator: 'eq', value: 1 }] } }))).status).toBe(400);
    expect((await api.request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'x', filters: { dateRange: { from: '2026-02-01', to: '2026-01-01' } } }))).status).toBe(400);
    const board = await data<PanelDashboardDto>(await api.request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'x', filters: { filters: [] } })));
    expect(board.filters).toBeNull();

    const set = await data<PanelDashboardDto>(await api.request(`/api/panel/dashboards/${board.id}`, json({ filters: FILTERS }, 'PATCH')));
    expect(set.filters).toEqual(FILTERS);
    const cleared = await data<PanelDashboardDto>(await api.request(`/api/panel/dashboards/${board.id}`, json({ filters: null }, 'PATCH')));
    expect(cleared.filters).toBeNull();
    expect(events.filter((e) => e.action === 'updated')).toHaveLength(2);
  });

  it('gives no spec to a tile whose filters do not combine with the dashboard\'s', () => {
    const many = Array.from({ length: 18 }, () => ({ source: 'column', field: 'country', operator: 'eq', value: 'NL' }));
    const spec = { kind: 'trends', projectId: 'pnp_a', series: [{ event: '$pageview' }], filters: many };
    expect(tileSpec(spec, null)).not.toBeNull();
    const filters = { filters: Array.from({ length: 5 }, () => ({ source: 'column' as const, field: 'os' as const, operator: 'eq' as const, value: 'iOS' })) };
    expect(tileSpec(spec, filters)).toBeNull();
    expect(tileSpec(spec, null, { preset: '90d' })?.dateRange).toEqual({ preset: '90d' });
  });
});

describe('text tiles', () => {
  it('adds, edits and lays out text tiles next to report tiles', async () => {
    const report = await newReport();
    const board = await data<PanelDashboardDto>(await dashboards().request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'Board', visibility: 'workspace' })));
    const api = dashboards();
    const text = await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ kind: 'text', text: '## Notes\nWatch **signups**.', layout }));
    expect(text.status).toBe(201);
    const textTile = await data<PanelDashboardTileDto>(text);
    expect(textTile).toMatchObject({ kind: 'text', reportId: null, text: '## Notes\nWatch **signups**.' });
    const reportTile = await data<PanelDashboardTileDto>(await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ kind: 'report', reportId: report.id, layout })));
    expect(reportTile).toMatchObject({ kind: 'report', reportId: report.id, text: null });

    const edited = await api.request(`/api/panel/dashboards/${board.id}/tiles/${textTile.id}`, json({ text: 'Updated' }, 'PATCH'));
    expect(await data<PanelDashboardTileDto>(edited)).toMatchObject({ text: 'Updated', layout });
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles/${reportTile.id}`, json({ text: 'nope' }, 'PATCH'))).status).toBe(400);
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ kind: 'text', text: 'x'.repeat(5001), layout }))).status).toBe(400);
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ kind: 'text', layout }))).status).toBe(400);

    // Text tiles show for everyone; a report tile only with its report.
    const bob = await data<PanelDashboardDetailDto>(await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}`));
    expect(bob.tiles.map((t) => [t.kind, t.spec === null])).toEqual([
      ['text', true],
      ['report', false],
    ]);
    expect(JSON.stringify(events)).not.toContain('signups');
  });
});

describe('templates', () => {
  it('has the five built-in templates, each yielding report specs the query schema accepts', () => {
    expect(DASHBOARD_TEMPLATES.map((t) => t.id)).toEqual([...PANEL_DASHBOARD_TEMPLATES]);
    for (const template of DASHBOARD_TEMPLATES) {
      for (const tile of template.tiles) {
        if (tile.kind !== 'report') continue;
        const spec = templateReportSpec(tile.report, 'pnp_a');
        expect(spec, `${template.id}: ${tile.report.name.en}`).not.toBeNull();
        expect(panelReportSpecSchema.safeParse(spec).success).toBe(true);
        // Each alternative a template lists parses or is a kind the schema does not have.
        for (const build of tile.report.specs) {
          const candidate = build('pnp_a');
          const parsed = panelReportSpecSchema.safeParse(candidate);
          if (!parsed.success) expect(['vitals', 'stickiness', 'lifecycle']).toContain(candidate.kind);
        }
      }
    }
  });

  it('uses the richer report kinds when the query schema has them', () => {
    const kinds = (id: string) =>
      (DASHBOARD_TEMPLATES.find((t) => t.id === id)?.tiles ?? []).flatMap((t) => (t.kind === 'report' ? [templateReportSpec(t.report, 'pnp_a')?.kind] : []));
    const hasKind = (kind: string) => panelReportSpecSchema.safeParse({ kind, projectId: 'pnp_a', event: '$pageview' }).success;
    if (hasKind('stickiness')) expect(kinds('engagement')).toEqual(['stickiness', 'lifecycle', 'retention']);
    if (hasKind('vitals')) expect(new Set(kinds('performance'))).toEqual(new Set(['vitals']));
  });

  it('picks the language from the request', () => {
    expect(templateLocale(undefined, 'nl-NL,nl;q=0.9,en;q=0.8')).toBe('nl');
    expect(templateLocale(undefined, 'de-DE,fr;q=0.9')).toBe('en');
    expect(templateLocale('en', 'nl')).toBe('en');
  });

  it('lists the templates in the asked language', async () => {
    const en = await data<PanelDashboardTemplateDto[]>(await dashboards('user_alice', READER).request('/api/panel/dashboards/templates'));
    expect(en.map((t) => t.name)).toContain('Website overview');
    const nl = await data<PanelDashboardTemplateDto[]>(await dashboards('user_alice', READER).request('/api/panel/dashboards/templates?locale=nl'));
    expect(nl.find((t) => t.id === 'website-overview')?.name).toBe('Website-overzicht');
    expect(nl.every((t) => t.tiles.every((tile) => tile.kind === 'text' || tile.reportKind !== null))).toBe(true);
  });

  it('creates the reports, the dashboard and its tiles from a template, with events', async () => {
    const res = await dashboards().request(
      '/api/panel/dashboards/from-template',
      json({ projectId: 'pnp_a', template: 'acquisition', visibility: 'workspace', locale: 'nl' }),
    );
    expect(res.status).toBe(201);
    const detail = await data<PanelDashboardDetailDto>(res);
    expect(detail).toMatchObject({ name: 'Acquisitie', template: 'acquisition', visibility: 'workspace' });
    expect(detail.tiles.map((t) => t.kind)).toEqual(['text', 'report', 'report', 'report', 'report']);
    expect(detail.reports.map((r) => r.name).sort()).toEqual(['Bezoekers per UTM-bron', 'Bezoekers per campagne', 'Bezoekers per land', 'Bezoekers per verwijzer'].sort());
    expect(detail.reports.every((r) => r.visibility === 'workspace' && r.ownerUserId === 'user_alice')).toBe(true);
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_report', 'created'],
      ['panel_report', 'created'],
      ['panel_report', 'created'],
      ['panel_report', 'created'],
      ['panel_dashboard', 'created'],
    ]);

    const named = await data<PanelDashboardDetailDto>(
      await dashboards().request('/api/panel/dashboards/from-template', json({ projectId: 'pnp_a', template: 'engagement', name: 'Our engagement' })),
    );
    expect(named).toMatchObject({ name: 'Our engagement', visibility: 'private' });
    expect(named.tiles.every((t) => t.spec !== null)).toBe(true);
  });

  it('refuses unknown templates and projects, and callers without create', async () => {
    const api = dashboards();
    expect((await api.request('/api/panel/dashboards/from-template', json({ projectId: 'pnp_a', template: 'nope' }))).status).toBe(400);
    expect((await api.request('/api/panel/dashboards/from-template', json({ projectId: 'pnp_x', template: 'acquisition' }))).status).toBe(404);
    expect((await dashboards('user_alice', READER).request('/api/panel/dashboards/from-template', json({ projectId: 'pnp_a', template: 'acquisition' }))).status).toBe(403);
    expect(await db.select().from(panelReports)).toHaveLength(0);
  });
});
