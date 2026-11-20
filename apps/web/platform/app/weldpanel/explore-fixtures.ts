/** Builders for the analysis page tests (gaps PR): new results, definitions, groups and metric trees as the API returns them. */

import type { PanelExplainResult, PanelMetricTreeValues } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type { PanelComputedPropertyDto, PanelCustomEventDto, PanelMetricTreeDto, PanelPathRuleDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelGroupDto, PanelGroupProfileDto, PanelGroupTypeDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import type {
  PanelFunnelCorrelationResult,
  PanelImpactResult,
  PanelLifecycleResult,
  PanelSignalResult,
  PanelStickinessResult,
  PanelVitalsResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { RANGE } from './analytics-fixtures';

const AT = '2026-11-01T09:00:00.000Z';

export function makeStickinessResult(overrides: Partial<PanelStickinessResult> = {}): PanelStickinessResult {
  return {
    range: RANGE,
    interval: 'day',
    measure: 'intervals',
    total: 150,
    intervalsInRange: 30,
    buckets: [
      { label: '1', from: 1, to: 1, count: 100, share: 0.667 },
      { label: '2', from: 2, to: 2, count: 50, share: 0.333 },
    ],
    ...overrides,
  };
}

export function makeLifecycleResult(overrides: Partial<PanelLifecycleResult> = {}): PanelLifecycleResult {
  return {
    range: RANGE,
    interval: 'week',
    buckets: [{ bucket: '2026-11-02', new: 30, returning: 50, resurrecting: 5, dormant: 12 }],
    totals: { new: 30, returning: 50, resurrecting: 5, dormant: 12 },
    ...overrides,
  };
}

export function makeVitalsResult(overrides: Partial<PanelVitalsResult> = {}): PanelVitalsResult {
  return {
    range: RANGE,
    interval: 'day',
    metric: 'lcp',
    percentile: 'p75',
    unit: 'ms',
    thresholds: { good: 2500, poor: 4000 },
    value: 2340,
    rating: 'good',
    samples: 1200,
    shares: { good: 0.72, needsImprovement: 0.19, poor: 0.09 },
    score: 91,
    series: [
      { bucket: '2026-11-12', value: 2300, samples: 600 },
      { bucket: '2026-11-13', value: 2380, samples: 600 },
    ],
    paths: [{ value: '/pricing', metric: 4600, samples: 80, rating: 'poor' }],
    elements: [{ value: 'img.hero', metric: 3100, samples: 40, rating: 'needs_improvement' }],
    countries: [{ value: 'NL', metric: 2100, samples: 500, rating: 'good' }],
    devices: [{ value: 'mobile', metric: 3000, samples: 400, rating: 'needs_improvement' }],
    ...overrides,
  };
}

export function makeImpactResult(overrides: Partial<PanelImpactResult> = {}): PanelImpactResult {
  return {
    range: RANGE,
    launchDate: '2026-10-20',
    windowDays: 28,
    adoption: [{ bucket: '2026-10-20', newAdopters: 10, adopters: 10, rate: 0.1 }],
    adopters: { users: 120, before: 2, after: 3.5, change: 1.5 },
    nonAdopters: { users: 900, before: 2, after: 2.2, change: 0.2 },
    differenceInDifferences: 1.3,
    relativeImpact: 0.65,
    ...overrides,
  };
}

export function makeSignalResult(overrides: Partial<PanelSignalResult> = {}): PanelSignalResult {
  return {
    range: RANGE,
    goal: 'Upgraded',
    windowDays: 7,
    users: 1000,
    goalUsers: 80,
    goalRate: 0.08,
    candidates: [{ event: 'Invited teammate', didUsers: 200, didGoalRate: 0.25, didNotUsers: 800, didNotGoalRate: 0.0375, lift: 6.67, correlation: 0.31 }],
    ...overrides,
  };
}

export function makeCorrelationResult(overrides: Partial<PanelFunnelCorrelationResult> = {}): PanelFunnelCorrelationResult {
  return {
    range: RANGE,
    converted: 250,
    dropped: 750,
    events: [
      { type: 'event', property: null, value: 'Watched demo', successCount: 120, failureCount: 60, successRateWith: 0.67, successRateWithout: 0.16, oddsRatio: 10.4, correlation: 'positive' },
      { type: 'event', property: null, value: 'Opened pricing', successCount: 20, failureCount: 300, successRateWith: 0.06, successRateWithout: 0.33, oddsRatio: 0.13, correlation: 'negative' },
    ],
    properties: [{ type: 'property', property: 'country', value: 'DE', successCount: 10, failureCount: 200, successRateWith: 0.05, successRateWithout: 0.3, oddsRatio: 0.12, correlation: 'negative' }],
    ...overrides,
  };
}

export function makeExplainResult(overrides: Partial<PanelExplainResult> = {}): PanelExplainResult {
  return {
    current: { from: '2026-10-15T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' },
    baseline: { from: '2026-09-15T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' },
    metric: { label: 'Signed up', current: 120, baseline: 100, change: 20, changePercent: 0.2 },
    dimensions: [
      {
        dimension: 'country',
        explained: 0.8,
        values: [{ value: 'NL', current: 80, baseline: 64, change: 16, changePercent: 0.25, contributionShare: 0.8 }],
      },
    ],
    narrative: null,
    dataAsOf: '2026-11-14T12:30:00.000Z',
    ...overrides,
  };
}

export function makeCustomEvent(overrides: Partial<PanelCustomEventDto> = {}): PanelCustomEventDto {
  return {
    id: 'pnce_1',
    projectId: 'wpp_1',
    name: 'Signed up or invited',
    description: null,
    definition: { match: [{ event: 'Signed up', filters: [] }, { event: 'Invited', filters: [] }] },
    ref: '@pnce_1',
    ownerUserId: 'user_1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeComputedProperty(overrides: Partial<PanelComputedPropertyDto> = {}): PanelComputedPropertyDto {
  return {
    id: 'pncp_1',
    projectId: 'wpp_1',
    name: 'Order value',
    description: null,
    definition: { kind: 'formula', expression: 'price * quantity' },
    ref: '@pncp_1',
    ownerUserId: 'user_1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makePathRule(overrides: Partial<PanelPathRuleDto> = {}): PanelPathRuleDto {
  return {
    id: 'pnpr_1',
    projectId: 'wpp_1',
    position: 0,
    pattern: '^/users/\\d+',
    replacement: '/users/:id',
    description: null,
    createdByUserId: 'user_1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeGroupType(overrides: Partial<PanelGroupTypeDto> = {}): PanelGroupTypeDto {
  return {
    id: 'pngt_1',
    projectId: 'wpp_1',
    groupType: 'company',
    nameSingular: 'Company',
    namePlural: 'Companies',
    crmMatchProperty: 'domain',
    configured: true,
    collecting: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<PanelGroupDto> = {}): PanelGroupDto {
  return {
    groupType: 'company',
    groupKey: 'acme',
    name: 'Acme Inc',
    properties: { plan: 'pro', domain: 'acme.com' },
    firstSeen: AT,
    lastSeen: '2026-11-14T10:00:00.000Z',
    ...overrides,
  };
}

export function makeGroupProfile(overrides: Partial<PanelGroupProfileDto> = {}): PanelGroupProfileDto {
  return {
    projectId: 'wpp_1',
    group: makeGroup(),
    hasProfile: true,
    days: 90,
    recentEvents: [],
    eventCount: 420,
    members: [{ distinctId: 'user_9', lastSeen: '2026-11-14T10:00:00.000Z', eventCount: 33 }],
    memberCount: 1,
    crmCompany: { id: 'cus_1', name: 'Acme Inc', domain: 'acme.com' },
    ...overrides,
  };
}

export function makeMetricTree(overrides: Partial<PanelMetricTreeDto> = {}): PanelMetricTreeDto {
  return {
    id: 'pnmt_1',
    projectId: 'wpp_1',
    name: 'Revenue drivers',
    description: null,
    nodes: [
      { id: 'root', label: 'Revenue', parentId: null, relation: null, metric: { reportId: 'wpr_1' } },
      {
        id: 'n2',
        label: 'Orders',
        parentId: 'root',
        relation: 'product',
        metric: { spec: { kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Ordered', math: 'total', filters: [] }], interval: 'day', compare: false, filters: [], dateRange: { preset: '30d' }, timezone: 'UTC' } },
      },
    ],
    ownerUserId: 'user_1',
    visibility: 'private',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as PanelMetricTreeDto;
}

export function makeMetricTreeValues(overrides: Partial<PanelMetricTreeValues> = {}): PanelMetricTreeValues {
  return {
    range: RANGE,
    nodes: [
      { id: 'root', label: 'Revenue', parentId: null, relation: null, value: 5000, previous: 4000, changePercent: 0.25, correlationWithParent: null, points: [], error: null },
      { id: 'n2', label: 'Orders', parentId: 'root', relation: 'product', value: 100, previous: 90, changePercent: 0.111, correlationWithParent: null, points: [], error: null },
      { id: 'n3', label: 'Old report', parentId: 'root', relation: 'influence', value: null, previous: null, changePercent: null, correlationWithParent: null, points: [], error: 'report_not_found' },
    ],
    dataAsOf: '2026-11-14T12:30:00.000Z',
    ...overrides,
  };
}
