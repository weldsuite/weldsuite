/** Builders for the analytics page tests: query results, saved reports, dashboards, cohorts and the lexicon as the API returns them. */

import type {
  PanelFlowsResult,
  PanelFunnelResult,
  PanelResolvedRange,
  PanelRetentionResult,
  PanelTrendsResult,
  PanelWebResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelCohortDto, PanelDashboardDetailDto, PanelLexiconDto, PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';

export const RANGE: PanelResolvedRange = {
  from: '2026-10-15T00:00:00.000Z',
  to: '2026-11-14T23:59:59.000Z',
  timezone: 'UTC',
  clampedToRetention: false,
  previousFrom: '2026-09-15T00:00:00.000Z',
  previousTo: '2026-10-14T23:59:59.000Z',
};

export const DATA_AS_OF = '2026-11-14T12:30:00.000Z';

const row = (value: string, visitors: number, events = visitors * 2) => ({ value, visitors, events });

export function makeWebResult(overrides: Partial<PanelWebResult> = {}): PanelWebResult {
  return {
    range: RANGE,
    interval: 'day',
    totals: { visitors: 1200, visits: 1500, pageviews: 4200, bounceRate: 0.42, avgVisitDurationSeconds: 83 },
    previousTotals: { visitors: 1000, visits: 1400, pageviews: 3900, bounceRate: 0.45, avgVisitDurationSeconds: 70 },
    series: [
      { bucket: '2026-11-12', visitors: 40, pageviews: 120 },
      { bucket: '2026-11-13', visitors: 55, pageviews: 150 },
    ],
    previousSeries: [
      { bucket: '2026-10-12', visitors: 30, pageviews: 90 },
      { bucket: '2026-10-13', visitors: 35, pageviews: 100 },
    ],
    topPages: [row('/pricing', 500), row('/', 900)],
    entryExitPages: [
      { value: '/', entries: 700, exits: 100 },
      { value: '/checkout', entries: 10, exits: 300 },
    ],
    sources: [row('google.com', 400), row('', 300)],
    utmSources: [row('newsletter', 50)],
    utmMediums: [row('email', 50)],
    utmCampaigns: [row('launch', 50)],
    countries: [row('NL', 600), row('DE', 200)],
    devices: [row('desktop', 800), row('mobile', 400)],
    browsers: [row('Chrome', 700)],
    operatingSystems: [row('Windows', 500)],
    ...overrides,
  };
}

export function makeTrendsResult(overrides: Partial<PanelTrendsResult> = {}): PanelTrendsResult {
  return {
    range: RANGE,
    interval: 'day',
    series: [
      {
        seriesIndex: 0,
        label: 'Signed up',
        breakdownValue: null,
        total: 120,
        points: [
          { bucket: '2026-11-12', value: 50 },
          { bucket: '2026-11-13', value: 70 },
        ],
        previous: { total: 100, points: [{ bucket: '2026-10-12', value: 40 }, { bucket: '2026-10-13', value: 60 }] },
      },
    ],
    ...overrides,
  };
}

export function makeFunnelResult(overrides: Partial<PanelFunnelResult> = {}): PanelFunnelResult {
  return {
    range: RANGE,
    steps: [
      { index: 0, event: '$pageview', label: '$pageview', count: 1000, conversionFromPrevious: 1, conversionFromFirst: 1, droppedOff: 0, avgSecondsFromPrevious: null },
      { index: 1, event: 'Signed up', label: 'Signed up', count: 250, conversionFromPrevious: 0.25, conversionFromFirst: 0.25, droppedOff: 750, avgSecondsFromPrevious: 90 },
    ],
    overallConversion: 0.25,
    breakdowns: null,
    ...overrides,
  };
}

export function makeRetentionResult(overrides: Partial<PanelRetentionResult> = {}): PanelRetentionResult {
  return {
    range: RANGE,
    interval: 'week',
    periods: 2,
    cohorts: [
      { cohort: '2026-10-19', size: 100, counts: [100, 40, 20] },
      { cohort: '2026-10-26', size: 80, counts: [80, 30] },
    ],
    averageRetention: [1, 0.39, 0.2],
    ...overrides,
  };
}

export function makeFlowsResult(overrides: Partial<PanelFlowsResult> = {}): PanelFlowsResult {
  return {
    range: RANGE,
    anchor: '/pricing',
    direction: 'after',
    depth: 2,
    anchorCount: 100,
    paths: [
      { steps: ['/signup', '/welcome'], count: 40 },
      { steps: ['/docs', null], count: 25 },
      { steps: [null, null], count: 20 },
    ],
    ...overrides,
  };
}

export function makeReport(overrides: Partial<PanelReportDto> = {}): PanelReportDto {
  return {
    id: 'wpr_1',
    projectId: 'wpp_1',
    kind: 'trends',
    name: 'Weekly signups',
    description: null,
    spec: { kind: 'trends', series: [{ event: 'Signed up', math: 'total', filters: [] }], interval: 'day', filters: [], compare: false, dateRange: { preset: '30d' }, timezone: 'UTC' },
    ownerUserId: 'user_1',
    visibility: 'private',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    ...overrides,
  };
}

export function makeDashboard(overrides: Partial<PanelDashboardDetailDto> = {}): PanelDashboardDetailDto {
  return {
    id: 'wpd_1',
    projectId: 'wpp_1',
    name: 'Marketing weekly',
    description: null,
    ownerUserId: 'user_1',
    visibility: 'private',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    tiles: [],
    reports: [],
    ...overrides,
  };
}

export function makeCohort(overrides: Partial<PanelCohortDto> = {}): PanelCohortDto {
  return {
    id: 'wpc_1',
    projectId: 'wpp_1',
    name: 'Pro users',
    description: null,
    filter: { match: 'all', conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] },
    ownerUserId: 'user_1',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    ...overrides,
  };
}

export function makeLexicon(overrides: Partial<PanelLexiconDto> = {}): PanelLexiconDto {
  return {
    events: [
      { name: 'Signed up', seen: true, count30d: 120, description: 'A new account', hidden: false, verified: true, definitionId: 'wpl_1' },
      { name: 'Debug ping', seen: true, count30d: 5, description: null, hidden: true, verified: false, definitionId: 'wpl_2' },
      { name: 'Upgraded', seen: true, count30d: 12, description: null, hidden: false, verified: false, definitionId: null },
    ],
    properties: [
      { name: 'plan', seen: true, count30d: null, description: null, hidden: false, verified: false, definitionId: null },
      { name: 'internal_id', seen: true, count30d: null, description: null, hidden: true, verified: false, definitionId: 'wpl_3' },
    ],
    scannedAt: '2026-11-14T11:00:00.000Z',
    ...overrides,
  };
}
