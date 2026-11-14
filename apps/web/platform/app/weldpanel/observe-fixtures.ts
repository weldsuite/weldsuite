/** Builders for the people, recordings, heatmap, live and usage tests: the shapes the API returns. */

import type {
  PanelActivityEvent,
  PanelKeyDto,
  PanelLiveDto,
  PanelPersonDto,
  PanelPersonProfile,
  PanelSessionDetail,
  PanelUsageDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelHeatmapResult, PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { RANGE } from './analytics-fixtures';

export function makeSession(overrides: Partial<PanelSessionRow> = {}): PanelSessionRow {
  return {
    sessionId: 'ses_1',
    startedAt: '2026-11-14T10:00:00.000Z',
    endedAt: '2026-11-14T10:02:05.000Z',
    durationSeconds: 125,
    pageviews: 4,
    clicks: 12,
    events: 20,
    rageClicks: 0,
    deadClicks: 0,
    quickBacks: 0,
    excessiveScrolls: 0,
    errors: 0,
    entryPage: '/pricing',
    exitPage: '/checkout',
    deviceType: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    country: 'NL',
    distinctId: 'anon_abcdef123456',
    userId: null,
    hasRecording: true,
    chunkCount: 2,
    favorite: false,
    ...overrides,
  };
}

export function makePerson(overrides: Partial<PanelPersonDto> = {}): PanelPersonDto {
  return {
    userId: 'user_42',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    properties: { plan: 'pro', seats: 5, beta: true },
    anonIds: ['anon_abcdef123456'],
    firstSeen: '2026-10-01T09:00:00.000Z',
    lastSeen: '2026-11-14T10:02:05.000Z',
    ...overrides,
  };
}

export function makeActivity(overrides: Partial<PanelActivityEvent> = {}): PanelActivityEvent {
  return {
    eventId: 'evt_1',
    name: '$pageview',
    ts: '2026-11-14T10:00:05.000Z',
    path: '/pricing',
    url: 'https://example.com/pricing',
    title: 'Pricing',
    sessionId: 'ses_1',
    detail: null,
    properties: {},
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<PanelPersonProfile> = {}): PanelPersonProfile {
  return {
    projectId: 'wpp_1',
    person: makePerson(),
    recentEvents: [makeActivity(), makeActivity({ eventId: 'evt_2', name: 'Signed up', path: null, ts: '2026-11-14T10:01:00.000Z' })],
    sessions: [makeSession({ userId: 'user_42' })],
    eventCount90d: 321,
    ...overrides,
  };
}

export function makeSessionDetail(overrides: Partial<PanelSessionDetail> = {}): PanelSessionDetail {
  return {
    projectId: 'wpp_1',
    session: makeSession({ rageClicks: 2, errors: 1 }),
    person: null,
    chunks: [
      { seq: 0, tsStart: '2026-11-14T10:00:00.000Z', tsEnd: '2026-11-14T10:01:00.000Z', bytes: 1000, hasFullSnapshot: true },
      { seq: 1, tsStart: '2026-11-14T10:01:00.000Z', tsEnd: '2026-11-14T10:02:05.000Z', bytes: 800, hasFullSnapshot: false },
    ],
    events: [
      makeActivity(),
      makeActivity({ eventId: 'evt_3', name: '$rageclick', ts: '2026-11-14T10:00:40.000Z', path: '/pricing', detail: 'Buy now' }),
      makeActivity({ eventId: 'evt_4', name: '$exception', ts: '2026-11-14T10:00:50.000Z', detail: 'TypeError: x is undefined' }),
      makeActivity({ eventId: 'evt_5', name: '$pageview', ts: '2026-11-14T10:01:10.000Z', path: '/checkout', url: 'https://example.com/checkout', title: 'Checkout' }),
    ],
    favorite: null,
    summary: null,
    otherSessions: [makeSession({ sessionId: 'ses_0', startedAt: '2026-11-10T08:00:00.000Z' })],
    ...overrides,
  };
}

export function makeHeatmap(overrides: Partial<PanelHeatmapResult> = {}): PanelHeatmapResult {
  return {
    range: RANGE,
    type: 'click',
    deviceClass: 'desktop',
    urlPattern: '/products/*',
    pageviews: 900,
    clicks: 150,
    elements: [
      { selector: '#buy', text: 'Buy now', clicks: 90, share: 0.6, relX: 0.5, relY: 0.5 },
      { selector: '.nav a', text: null, clicks: 60, share: 0.4, relX: 0.3, relY: 0.5 },
    ],
    points: [
      { selector: '#buy', relX: 0.5, relY: 0.5, count: 90 },
      { selector: '.nav a', relX: 0.3, relY: 0.5, count: 60 },
    ],
    scroll: {
      leaves: 400,
      buckets: [
        { depth: 0, reachedShare: 1 },
        { depth: 25, reachedShare: 0.7 },
        { depth: 50, reachedShare: 0.4 },
        { depth: 75, reachedShare: 0.1 },
      ],
    },
    ...overrides,
  };
}

export function makeLive(overrides: Partial<PanelLiveDto> = {}): PanelLiveDto {
  return {
    projectId: 'wpp_1',
    visitors: 2,
    sessions: [
      { sessionId: 's1', distinctId: 'anon_aaaaaa111111', path: '/pricing', title: 'Pricing', country: 'NL', deviceType: 'desktop', ts: '2026-11-14T10:00:00.000Z', startedAt: '2026-11-14T09:58:00.000Z', pageviews: 3 },
      { sessionId: 's2', distinctId: 'anon_bbbbbb222222', path: '/pricing', title: 'Pricing', country: 'DE', deviceType: 'mobile', ts: '2026-11-14T10:00:00.000Z', startedAt: '2026-11-14T09:59:00.000Z', pageviews: 1 },
    ],
    ...overrides,
  };
}

const meter = (used: number, allowance: number, blocks = 0) => ({ used, allowance, blocksCharged: blocks, creditsCharged: blocks * 10 });

export function makeUsage(overrides: Partial<PanelUsageDto> = {}): PanelUsageDto {
  return {
    month: '2026-11',
    planSlug: 'business',
    events: meter(400_000, 1_000_000),
    recordings: meter(1000, 5000),
    quota: 'ok',
    retention: { eventsMonths: 25, recordingsDays: 30, favoritesMonths: 13 },
    projects: [{ projectId: 'wpp_1', name: 'Marketing site', events: 400_000, recordings: 1000 }],
    ...overrides,
  };
}

export function makeKey(overrides: Partial<PanelKeyDto> = {}): PanelKeyDto {
  return {
    id: 'wpkey_1',
    projectId: 'wpp_1',
    name: 'billing-backend',
    prefix: 'wps_ab12',
    createdByUserId: 'user_1',
    createdAt: '2026-11-01T09:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}
