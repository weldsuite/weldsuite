import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  addPanelDashboardTileSchema,
  applyPanelDashboardFilters,
  createPanelCohortSchema,
  createPanelDashboardSchema,
  createPanelHeatmapPageSchema,
  createPanelKeySchema,
  createPanelReportSchema,
  favoritePanelSessionSchema,
  generatePanelSessionSummarySchema,
  panelDashboardFiltersSchema,
  panelSetSummarySourceSchema,
  panelSnapshotQuerySchema,
  panelTileTextSchema,
  setPanelDashboardLayoutSchema,
  summarisePanelSetSchema,
  updatePanelCohortSchema,
  updatePanelDashboardSchema,
  updatePanelDashboardTileSchema,
  updatePanelHeatmapPageSchema,
  updatePanelLexiconSchema,
  updatePanelReportSchema,
} from './weldpanel-objects';

/** The issues a parse reports, as `path: message`. Empty when it parses. */
function issuesOf(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const projectId = 'pnp_1';
const TRENDS = { kind: 'trends', projectId, series: [{ event: '$pageview' }] };
const FUNNEL = { kind: 'funnel', projectId, steps: [{ event: 'Viewed' }, { event: 'Bought' }] };
const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const COUNTRY_NL = { source: 'column', field: 'country', operator: 'eq', value: 'NL' };
const MOBILE = { source: 'column', field: 'device_type', operator: 'eq', value: 'mobile' };

describe('reports', () => {
  it('creates a private report from a saveable spec', () => {
    expect(createPanelReportSchema.parse({ projectId, name: ' Visits ', spec: TRENDS })).toMatchObject({
      name: 'Visits',
      visibility: 'private',
      spec: { kind: 'trends' },
    });
    expect(createPanelReportSchema.safeParse({ projectId, name: 'Recordings', spec: { kind: 'sessions', projectId } }).success).toBe(false);
  });

  it('updates at least one field', () => {
    expect(issuesOf(updatePanelReportSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelReportSchema.parse({ visibility: 'workspace' })).toEqual({ visibility: 'workspace' });
  });
});

describe('dashboard filters', () => {
  it('default to no filters, and take a date range and up to ten filters', () => {
    expect(panelDashboardFiltersSchema.parse({})).toEqual({ filters: [] });
    expect(panelDashboardFiltersSchema.parse({ dateRange: { preset: '7d' }, filters: [COUNTRY_NL] })).toEqual({
      dateRange: { preset: '7d' },
      filters: [COUNTRY_NL],
    });
    expect(panelDashboardFiltersSchema.safeParse({ filters: Array.from({ length: 11 }, () => COUNTRY_NL) }).success).toBe(false);
    expect(issuesOf(panelDashboardFiltersSchema, { filters: [{ source: 'column', field: 'country', operator: 'eq' }] })).toEqual([
      'filters.0.value: A value is required',
    ]);
  });

  it('leave the spec as saved when there are none', () => {
    const spec = { ...TRENDS, filters: [COUNTRY_NL] };
    expect(applyPanelDashboardFilters(spec, null)).toBe(spec);
    expect(applyPanelDashboardFilters(spec, undefined)).toBe(spec);
    expect(applyPanelDashboardFilters(spec, { filters: [] })).toEqual(spec);
  });

  it("replace the date range and add the filters to the report's own", () => {
    const spec = { ...TRENDS, dateRange: { preset: '30d' }, filters: [COUNTRY_NL] };
    expect(applyPanelDashboardFilters(spec, { dateRange: { preset: '7d' }, filters: [MOBILE] })).toEqual({
      ...TRENDS,
      dateRange: { preset: '7d' },
      filters: [COUNTRY_NL, MOBILE],
    });
    expect(spec).toEqual({ ...TRENDS, dateRange: { preset: '30d' }, filters: [COUNTRY_NL] });
  });

  it('start from no filters when the spec has none, or none that are a list', () => {
    expect(applyPanelDashboardFilters(TRENDS, { filters: [MOBILE] })).toEqual({ ...TRENDS, filters: [MOBILE] });
    expect(applyPanelDashboardFilters({ ...TRENDS, filters: 'broken' }, { filters: [MOBILE] })).toEqual({ ...TRENDS, filters: [MOBILE] });
    expect(applyPanelDashboardFilters(TRENDS, { dateRange: { preset: '90d' } })).toEqual({ ...TRENDS, dateRange: { preset: '90d' } });
  });
});

describe('dashboards', () => {
  it('creates a private dashboard, with or without filters', () => {
    expect(createPanelDashboardSchema.parse({ projectId, name: 'Overview' })).toEqual({ projectId, name: 'Overview', visibility: 'private' });
    expect(createPanelDashboardSchema.parse({ projectId, name: 'Overview', filters: { dateRange: { preset: '7d' } } }).filters).toEqual({
      dateRange: { preset: '7d' },
      filters: [],
    });
  });

  it('updates at least one field, and clears the filters with null', () => {
    expect(issuesOf(updatePanelDashboardSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelDashboardSchema.parse({ filters: null })).toEqual({ filters: null });
  });
});

describe('dashboard tiles', () => {
  it('adds a report tile, with or without its kind', () => {
    expect(addPanelDashboardTileSchema.parse({ reportId: 'pnr_1', layout: LAYOUT })).toEqual({ reportId: 'pnr_1', layout: LAYOUT });
    expect(addPanelDashboardTileSchema.parse({ kind: 'report', reportId: 'pnr_1', layout: LAYOUT })).toEqual({
      kind: 'report',
      reportId: 'pnr_1',
      layout: LAYOUT,
    });
  });

  it('adds a text tile with trimmed Markdown, never empty', () => {
    expect(addPanelDashboardTileSchema.parse({ kind: 'text', text: '  ## Notes  ', layout: LAYOUT })).toEqual({
      kind: 'text',
      text: '## Notes',
      layout: LAYOUT,
    });
    expect(addPanelDashboardTileSchema.safeParse({ kind: 'text', text: '   ', layout: LAYOUT }).success).toBe(false);
    expect(panelTileTextSchema.safeParse('x'.repeat(5001)).success).toBe(false);
  });

  it('keeps tiles on the 24-column grid', () => {
    expect(addPanelDashboardTileSchema.safeParse({ reportId: 'pnr_1', layout: { ...LAYOUT, x: 24 } }).success).toBe(false);
    expect(addPanelDashboardTileSchema.safeParse({ reportId: 'pnr_1', layout: { ...LAYOUT, w: 25 } }).success).toBe(false);
  });

  it('moves a tile or changes its text, at least one of them', () => {
    expect(issuesOf(updatePanelDashboardTileSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelDashboardTileSchema.parse({ text: 'Updated' })).toEqual({ text: 'Updated' });
    expect(updatePanelDashboardTileSchema.parse({ layout: LAYOUT })).toEqual({ layout: LAYOUT });
  });

  it('replaces every tile place at once', () => {
    expect(setPanelDashboardLayoutSchema.parse({ tiles: [{ id: 'pndt_1', layout: LAYOUT }] })).toEqual({ tiles: [{ id: 'pndt_1', layout: LAYOUT }] });
  });
});

describe('cohorts and the lexicon', () => {
  const filter = { conditions: [{ type: 'performed', event: 'Signed up', withinDays: 30 }] };

  it('creates a cohort and updates at least one field', () => {
    expect(createPanelCohortSchema.parse({ projectId, name: 'New sign-ups', filter }).filter).toMatchObject({ match: 'all' });
    expect(issuesOf(updatePanelCohortSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelCohortSchema.parse({ description: null })).toEqual({ description: null });
  });

  it('changes a description, hidden or verified flag of a name', () => {
    const entry = { projectId, kind: 'event', name: 'Signed up' };
    expect(issuesOf(updatePanelLexiconSchema, entry)).toEqual([': Nothing to update']);
    expect(updatePanelLexiconSchema.parse({ ...entry, description: null })).toEqual({ ...entry, description: null });
    expect(updatePanelLexiconSchema.parse({ ...entry, hidden: true })).toEqual({ ...entry, hidden: true });
    expect(updatePanelLexiconSchema.parse({ ...entry, verified: false })).toEqual({ ...entry, verified: false });
  });
});

describe('sessions', () => {
  it('favourites a session with an optional note', () => {
    expect(favoritePanelSessionSchema.parse({ projectId, note: 'Stuck at checkout' })).toEqual({ projectId, note: 'Stuck at checkout' });
  });

  it('summarises a session, from the cache unless asked again', () => {
    expect(generatePanelSessionSummarySchema.parse({ projectId })).toEqual({ projectId, regenerate: false });
  });

  it('summarises a recordings filter or the people who dropped at a funnel step', () => {
    expect(summarisePanelSetSchema.parse({ projectId, source: { type: 'sessions', spec: { kind: 'sessions', projectId } } })).toMatchObject({
      limit: 20,
      regenerate: false,
    });
    expect(panelSetSummarySourceSchema.safeParse({ type: 'funnel_drop_off', spec: FUNNEL, stepIndex: 1 }).success).toBe(true);
    expect(panelSetSummarySourceSchema.safeParse({ type: 'funnel_drop_off', spec: FUNNEL, stepIndex: 0 }).success).toBe(false);
  });
});

describe('heatmap pages, snapshots and keys', () => {
  it('saves a page group on a path pattern', () => {
    expect(createPanelHeatmapPageSchema.parse({ projectId, name: 'Products', urlPattern: ' /products/* ' })).toEqual({
      projectId,
      name: 'Products',
      urlPattern: '/products/*',
    });
    expect(issuesOf(createPanelHeatmapPageSchema, { projectId, name: 'Products', urlPattern: 'products' })).toEqual(['urlPattern: Start with /']);
    expect(issuesOf(updatePanelHeatmapPageSchema, {})).toEqual([': Nothing to update']);
    expect(updatePanelHeatmapPageSchema.parse({ name: 'Shop' })).toEqual({ name: 'Shop' });
  });

  it('reads a snapshot per device class, and names a secret key', () => {
    expect(panelSnapshotQuerySchema.parse({ deviceClass: 'tablet' })).toEqual({ deviceClass: 'tablet' });
    expect(panelSnapshotQuerySchema.safeParse({ deviceClass: 'watch' }).success).toBe(false);
    expect(createPanelKeySchema.parse({ name: ' Server ' })).toEqual({ name: 'Server' });
  });
});
